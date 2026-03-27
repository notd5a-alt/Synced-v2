// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the sidecar child process handle for cleanup on exit.
struct SidecarState(Mutex<Option<CommandChild>>);

const DEFAULT_PORT: u16 = 9876;
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Known sidecar executable names (current and legacy) that are safe to kill.
const KNOWN_SIDECAR_NAMES: &[&str] = &[
    "synced-server",
    "ghostchat-server",
];

/// Quick check: is anything listening on the port?
/// Returns in ~1ms if nothing is there (connection refused).
fn port_in_use(port: u16) -> bool {
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
    TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok()
}

/// Kill any stale **sidecar** process listening on the target port.
/// Only kills processes whose name matches a known sidecar binary — never
/// arbitrary processes that happen to share the port.
///
/// This is called in a background thread so it never blocks app startup.
fn kill_stale_sidecar_on_port(port: u16) {
    // Fast-path: if nothing is listening, skip the expensive netstat/lsof
    if !port_in_use(port) {
        return;
    }

    #[cfg(windows)]
    {
        // Step 1: find PIDs listening on the exact port via netstat
        let output = std::process::Command::new("cmd")
            .args(["/C", "netstat -ano"])
            .output();
        let mut pids: Vec<u32> = Vec::new();
        if let Ok(output) = output {
            let needle = format!(":{port} ");          // trailing space avoids matching :98760
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if !line.contains("LISTENING") || !line.contains(&needle) {
                    continue;
                }
                if let Some(pid_str) = line.split_whitespace().last() {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if pid != 0 && pid != std::process::id() && !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
            }
        }

        // Step 2: for each PID, check the process image name before killing
        let mut killed = false;
        for pid in pids {
            let query = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                .output();
            if let Ok(query) = query {
                let info = String::from_utf8_lossy(&query.stdout).to_lowercase();
                let is_sidecar = KNOWN_SIDECAR_NAMES
                    .iter()
                    .any(|name| info.contains(name));
                if is_sidecar {
                    eprintln!("[tauri] killing stale sidecar (pid {}) on port {}", pid, port);
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/PID", &pid.to_string()])
                        .output();
                    killed = true;
                } else {
                    eprintln!("[tauri] port {} held by non-sidecar process (pid {}), skipping", port, pid);
                }
            }
        }

        // Only sleep if we actually killed something — let the OS reclaim the port
        if killed {
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    #[cfg(unix)]
    {
        // Step 1: find PIDs on the exact port
        let output = std::process::Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
            .output();
        let mut pids: Vec<u32> = Vec::new();
        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            for pid_str in text.split_whitespace() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    if pid != std::process::id() && !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
        }

        // Step 2: check process name via /proc (Linux) or ps (macOS) before killing
        let mut killed = false;
        for pid in pids {
            let name = get_process_name_unix(pid);
            let is_sidecar = KNOWN_SIDECAR_NAMES
                .iter()
                .any(|n| name.contains(n));
            if is_sidecar {
                eprintln!("[tauri] killing stale sidecar (pid {}) on port {}", pid, port);
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .output();
                killed = true;
            } else {
                eprintln!("[tauri] port {} held by non-sidecar process '{}' (pid {}), skipping", port, name, pid);
            }
        }

        // Only sleep if we actually killed something
        if killed {
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

/// Read the process name for a given PID on Unix platforms.
#[cfg(unix)]
fn get_process_name_unix(pid: u32) -> String {
    // Try /proc first (Linux)
    if let Ok(cmdline) = std::fs::read_to_string(format!("/proc/{pid}/cmdline")) {
        let cmd = cmdline.replace('\0', " ");
        return cmd.to_lowercase();
    }
    // Fallback: ps (macOS / BSDs)
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    {
        return String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
    }
    String::new()
}

/// In dev mode (no custom-protocol feature), the user runs the Python backend
/// manually via `python app.py --dev`. In production, we spawn it as a sidecar.
fn is_production() -> bool {
    cfg!(feature = "custom-protocol")
}

/// Parse --port from CLI args, falling back to DEFAULT_PORT.
fn parse_port() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == "--port" {
            if let Some(p) = args.get(i + 1) {
                if let Ok(port) = p.parse::<u16>() {
                    return port;
                }
            }
        }
    }
    DEFAULT_PORT
}

/// Kill the sidecar process if it's still running.
fn kill_sidecar(state: &SidecarState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
            eprintln!("[tauri] sidecar killed");
        }
    }
}

// --- Windows Job Object: auto-kill sidecar when Tauri process exits ---

#[cfg(windows)]
mod job_object {
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, FALSE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// RAII wrapper for a Win32 HANDLE — closes on drop.
    struct SafeHandle(HANDLE);
    unsafe impl Send for SafeHandle {}
    unsafe impl Sync for SafeHandle {}
    impl Drop for SafeHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// Stored via `app.manage()` to keep the Job Object alive for the app's lifetime.
    pub struct JobObjectState(pub Mutex<Option<SafeHandle>>);

    /// Assign a child process to a Job Object with KILL_ON_JOB_CLOSE.
    /// When the Tauri process exits (even via crash), Windows kills all processes in the job.
    pub fn assign_child_to_job(child_pid: u32) -> Option<JobObjectState> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() || job == INVALID_HANDLE_VALUE {
                eprintln!("[tauri] failed to create job object");
                return None;
            }

            // Configure: kill all processes in job when last handle closes
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set_ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set_ok == 0 {
                eprintln!("[tauri] failed to set job object info");
                CloseHandle(job);
                return None;
            }

            // Open child process and assign to job
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_ALL_ACCESS};
            let child_handle = OpenProcess(PROCESS_ALL_ACCESS, FALSE, child_pid);
            if child_handle.is_null() || child_handle == INVALID_HANDLE_VALUE {
                eprintln!("[tauri] failed to open child process {}", child_pid);
                CloseHandle(job);
                return None;
            }

            let assign_ok = AssignProcessToJobObject(job, child_handle);
            CloseHandle(child_handle);

            if assign_ok == 0 {
                eprintln!("[tauri] failed to assign process to job object");
                CloseHandle(job);
                return None;
            }

            eprintln!("[tauri] child pid {} assigned to job object (KILL_ON_JOB_CLOSE)", child_pid);
            Some(JobObjectState(Mutex::new(Some(SafeHandle(job)))))
        }
    }
}

/// Inject a loading spinner into the webview via JavaScript.
/// Called after the initial frontendDist page loads (which may show briefly).
fn show_loading_page(window: &tauri::WebviewWindow) {
    let _ = window.eval(r#"
        document.documentElement.innerHTML = '<head><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:#00ff00;font-family:monospace;flex-direction:column;gap:16px}.s{width:32px;height:32px;border:3px solid #003300;border-top-color:#00ff00;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.t{font-size:14px;opacity:.7}</style></head><body><div class="s"></div><div class="t">Starting Synced...</div></body>';
    "#);
}

/// Check if running in central mode (signaling server is hosted externally).
/// Set SYNCED_SIGNALING_URL env var to skip sidecar spawn.
fn is_central_mode() -> bool {
    std::env::var("SYNCED_SIGNALING_URL")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

fn main() {
    let port = parse_port();
    let central = is_central_mode();

    // WebView2 GPU workaround — Surface Laptop Studio (and other hybrid-GPU Windows
    // machines) can show a black screen when WebView2 uses hardware-accelerated compositing.
    // Fully disable GPU rendering in WebView2 to force software rendering.
    // Users can override by setting WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS themselves.
    #[cfg(windows)]
    {
        if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_err() {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--disable-gpu --disable-gpu-compositing --disable-gpu-rasterization --disable-gpu-sandbox",
            );
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let app_handle = app.handle().clone();

            if central {
                // Central mode: no sidecar needed — signaling is remote
                eprintln!("[tauri] Central mode — signaling URL: {}", std::env::var("SYNCED_SIGNALING_URL").unwrap_or_default());
                app.manage(SidecarState(Mutex::new(None)));
                // No polling needed — the frontend handles connecting to the remote server.
                // frontendDist (backend/static/) is served directly by Tauri's asset protocol.
                return Ok(());
            }

            if is_production() {
                // Kill any stale sidecar in a background thread — don't block startup.
                // The sidecar spawn below will retry connecting even if the port is
                // briefly occupied; the polling loop handles the race.
                let stale_port = port;
                std::thread::spawn(move || {
                    kill_stale_sidecar_on_port(stale_port);
                });

                // Spawn the Python sidecar (FastAPI backend) immediately
                let sidecar_cmd = app
                    .shell()
                    .sidecar("synced-server")
                    .expect("failed to create sidecar command")
                    .args(["--port", &port.to_string()]);

                let (mut rx, child) = sidecar_cmd
                    .spawn()
                    .expect("failed to spawn synced-server sidecar");

                // On Windows, assign sidecar to a Job Object so it's auto-killed
                // if the Tauri process exits (even via crash or Task Manager kill)
                #[cfg(windows)]
                {
                    let pid = child.pid();
                    if let Some(job_state) = job_object::assign_child_to_job(pid) {
                        app.manage(job_state);
                    }
                }

                // Store child handle for explicit cleanup
                app.manage(SidecarState(Mutex::new(Some(child))));

                // Log sidecar output in background
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                let text = String::from_utf8_lossy(&line);
                                eprintln!("[sidecar] {}", text.trim());
                            }
                            CommandEvent::Stderr(line) => {
                                let text = String::from_utf8_lossy(&line);
                                eprintln!("[sidecar:err] {}", text.trim());
                            }
                            CommandEvent::Terminated(payload) => {
                                eprintln!(
                                    "[sidecar] terminated with code {:?}, signal {:?}",
                                    payload.code, payload.signal
                                );
                            }
                            _ => {}
                        }
                    }
                });
            } else {
                // Dev mode: no sidecar — user runs `python app.py --dev` separately
                eprintln!("[tauri:dev] Expecting backend already running on port {}", port);
                app.manage(SidecarState(Mutex::new(None)));
            }

            // Poll until the backend is ready (async — doesn't block the main thread)
            tauri::async_runtime::spawn(async move {
                let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
                let deadline = Instant::now() + SIDECAR_TIMEOUT;
                let mut ready = false;
                let mut shown_loading = false;

                while Instant::now() < deadline {
                    if TcpStream::connect_timeout(&addr, Duration::from_millis(50)).is_ok() {
                        ready = true;
                        break;
                    }

                    // After the first poll failure, inject a loading spinner
                    // (the frontendDist HTML has loaded by now so DOM exists)
                    if !shown_loading && is_production() {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            show_loading_page(&window);
                        }
                        shown_loading = true;
                    }

                    // Use tokio sleep so we don't block the async runtime thread
                    tokio::time::sleep(POLL_INTERVAL).await;
                }

                if !ready {
                    eprintln!("ERROR: backend not reachable on port {} within {:?}", port, SIDECAR_TIMEOUT);
                    // Show error in the window so the user knows what happened
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval(r#"
                            document.documentElement.innerHTML = '<head><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:#ff4444;font-family:monospace;flex-direction:column;gap:8px}</style></head><body><h2>Startup Error</h2><p>Backend failed to start within 15 seconds.</p><p>Please restart the app.</p></body>';
                        "#);
                    }
                    return;
                }

                // Navigate to the backend
                if is_production() {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        eprintln!("[tauri] backend ready — navigating to http://localhost:{}", port);
                        let url: tauri::Url = format!("http://localhost:{}", port).parse().unwrap();
                        let _ = window.navigate(url);

                        // Health check: after 5 seconds, verify the page loaded and React mounted.
                        // Collects diagnostic info to help debug black-screen issues.
                        let health_window = window.clone();
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        let _ = health_window.eval(r#"
                            (function() {
                                var root = document.getElementById('root');
                                var rootChildren = root ? root.children.length : -1;
                                var bodyText = document.body ? document.body.innerText.substring(0, 200) : '(no body)';
                                var title = document.title || '(no title)';
                                var url = location.href;
                                var errors = [];

                                // Collect any JS errors that occurred
                                window.__syncedDiagErrors = window.__syncedDiagErrors || [];
                                errors = window.__syncedDiagErrors;

                                // Check which resources loaded/failed
                                var resources = '';
                                try {
                                    var entries = performance.getEntriesByType('resource');
                                    resources = entries.map(function(e) {
                                        return e.name.replace(url, '') + ' (' + Math.round(e.duration) + 'ms)';
                                    }).join('\n  ');
                                } catch(e) { resources = '(unavailable)'; }

                                // List script tags
                                var scripts = Array.from(document.querySelectorAll('script')).map(function(s) {
                                    return (s.type || 'classic') + ': ' + (s.src || '(inline)');
                                }).join('\n  ');

                                var diag = 'URL: ' + url + '\nTitle: ' + title + '\nRoot children: ' + rootChildren + '\nBody: ' + bodyText;
                                if (scripts) diag += '\nScripts:\n  ' + scripts;
                                if (resources) diag += '\nResources:\n  ' + resources;
                                if (errors.length > 0) diag += '\nErrors: ' + errors.join('; ');

                                // If root is empty or missing, the app failed to render
                                if (rootChildren <= 0) {
                                    document.documentElement.innerHTML = '<head><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:#ff8800;font-family:monospace;flex-direction:column;gap:12px;padding:24px;text-align:center}pre{background:#1a1a1a;padding:12px;border-radius:4px;text-align:left;font-size:11px;max-width:90vw;overflow:auto;color:#aaa;white-space:pre-wrap}</style></head><body><h2>Synced failed to start</h2><p>The backend is running but the UI did not load.</p><pre>' + diag.replace(/</g,'&lt;') + '</pre><button onclick="location.reload()" style="margin-top:8px;padding:8px 24px;border:1px solid #ff8800;background:transparent;color:#ff8800;cursor:pointer;font-family:monospace;text-transform:uppercase">[ RELOAD ]</button></body>';
                                }
                            })();
                        "#);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Redundant early cleanup — also kills sidecar on window destroy
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<SidecarState>() {
                    kill_sidecar(&state);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // RunEvent::Exit is the canonical app-level exit hook in Tauri v2.
    // It fires regardless of how the app was closed (Alt+F4, taskbar, system shutdown, etc.)
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                kill_sidecar(&state);
            }
        }
    });
}
