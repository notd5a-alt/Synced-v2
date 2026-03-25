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
const POLL_INTERVAL: Duration = Duration::from_millis(200);

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
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
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
            if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
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
            if job == 0 || job == INVALID_HANDLE_VALUE {
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
            let child_handle = OpenProcess(PROCESS_ALL_ACCESS, 0, child_pid);
            if child_handle == 0 || child_handle == INVALID_HANDLE_VALUE {
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

fn main() {
    let port = parse_port();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            if is_production() {
                // Production: spawn the Python sidecar (FastAPI backend)
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

            // Poll until the backend is ready in a background task to avoid blocking the main thread
            tauri::async_runtime::spawn(async move {
                let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
                let deadline = Instant::now() + SIDECAR_TIMEOUT;
                let mut ready = false;

                while Instant::now() < deadline {
                    if TcpStream::connect_timeout(&addr, POLL_INTERVAL).is_ok() {
                        ready = true;
                        break;
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }

                if !ready {
                    eprintln!("ERROR: backend not reachable on port {} within {:?}", port, SIDECAR_TIMEOUT);
                    return;
                }

                // In production, navigate to the backend (devUrl handles this in dev mode)
                if is_production() {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let url: tauri::Url = format!("http://localhost:{}", port).parse().unwrap();
                        let _ = window.navigate(url);
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
