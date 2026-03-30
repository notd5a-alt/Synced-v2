import { useState, useEffect, useCallback, useRef } from "react";

interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

interface UseUpdaterResult {
  updateAvailable: boolean;
  updateInfo: UpdateInfo | null;
  installing: boolean;
  progress: number; // 0-100
  error: string | null;
  dismissed: boolean;
  install: () => void;
  dismiss: () => void;
  checkNow: () => void;
}

/** How often to poll for updates (30 minutes). */
const CHECK_INTERVAL = 30 * 60 * 1000;

/**
 * Detects whether we're running inside a Tauri webview.
 * The `__TAURI_INTERNALS__` global is injected by Tauri's IPC layer.
 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Hook that checks for app updates via tauri-plugin-updater.
 * Gracefully no-ops in browser (non-Tauri) environments.
 */
export default function useUpdater(): UseUpdaterResult {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Store the Update object for later install
  const updateRef = useRef<any>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkForUpdate = useCallback(async () => {
    if (!isTauri()) return;

    try {
      // Dynamic import — only loads in Tauri environment
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();

      if (update) {
        updateRef.current = update;
        setUpdateAvailable(true);
        setUpdateInfo({
          version: update.version,
          body: update.body ?? undefined,
          date: update.date ?? undefined,
        });
        setError(null);
        // Un-dismiss when a new version is found
        setDismissed(false);
      } else {
        updateRef.current = null;
        setUpdateAvailable(false);
        setUpdateInfo(null);
      }
    } catch (err) {
      console.warn("[updater] check failed:", err);
      setError(err instanceof Error ? err.message : "Update check failed");
    }
  }, []);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update || installing) return;

    setInstalling(true);
    setProgress(0);
    setError(null);

    try {
      let totalSize = 0;
      let downloaded = 0;

      await update.downloadAndInstall((event: any) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalSize = event.data.contentLength;
        }
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (totalSize > 0) {
            setProgress(Math.min(100, Math.round((downloaded / totalSize) * 100)));
          }
        }
        if (event.event === "Finished") {
          setProgress(100);
        }
      });

      // Relaunch the app
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.error("[updater] install failed:", err);
      setError(err instanceof Error ? err.message : "Update install failed");
      setInstalling(false);
    }
  }, [installing]);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  // Check on mount + periodically
  useEffect(() => {
    if (!isTauri()) return;

    // Delay initial check by 5s to avoid blocking startup
    const timeout = setTimeout(() => {
      checkForUpdate();
      intervalRef.current = setInterval(checkForUpdate, CHECK_INTERVAL);
    }, 5000);

    return () => {
      clearTimeout(timeout);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [checkForUpdate]);

  return {
    updateAvailable,
    updateInfo,
    installing,
    progress,
    error,
    dismissed,
    install,
    dismiss,
    checkNow: checkForUpdate,
  };
}
