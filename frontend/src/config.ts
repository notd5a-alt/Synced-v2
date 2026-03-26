/**
 * Signaling server URL resolution.
 *
 * Priority:
 *  1. VITE_SIGNALING_URL build-time env var (baked into the SPA)
 *  2. localStorage "synced_signaling_url" (user-configured)
 *  3. window.location.origin (same-origin — backward compat with local mode)
 */

export function getSignalingBaseUrl(): string {
  const envUrl = import.meta.env.VITE_SIGNALING_URL;
  if (envUrl) return (envUrl as string).replace(/\/+$/, "");

  const stored = localStorage.getItem("synced_signaling_url");
  if (stored) return stored.replace(/\/+$/, "");

  return window.location.origin;
}

/** HTTP(S) base URL for REST API calls. */
export function getApiBaseUrl(): string {
  return getSignalingBaseUrl().replace(/^ws(s?):/i, "http$1:");
}

/** WS(S) base URL for WebSocket connections. */
export function getWsBaseUrl(): string {
  return getSignalingBaseUrl().replace(/^http(s?):/i, "ws$1:");
}
