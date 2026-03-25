"""GhostChat – zero-trust P2P desktop chat.

Development entry point. Starts the FastAPI backend server.
For production, use Tauri which spawns backend/sidecar_entry.py as a sidecar.
"""
from __future__ import annotations

import argparse
import threading
import time
import urllib.request

import uvicorn


def _wait_for_server(url: str, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError(f"Server failed to start at {url}")


def main():
    parser = argparse.ArgumentParser(description="GhostChat")
    parser.add_argument("--port", type=int, default=9876)
    parser.add_argument("--dev", action="store_true", help="Dev mode (default, kept for compat)")
    args = parser.parse_args()

    import backend.main as backend_main
    backend_main.server_port = args.port

    server_thread = threading.Thread(
        target=uvicorn.run,
        args=("backend.main:app",),
        kwargs={"host": "0.0.0.0", "port": args.port, "log_level": "info"},
        daemon=True,
    )
    server_thread.start()

    local_url = f"http://localhost:{args.port}"
    _wait_for_server(local_url)

    print(f"GhostChat backend running at {local_url}")
    print("Start the Vite dev server: cd frontend && npm run dev")
    print("Or use Tauri dev:          cargo tauri dev")
    try:
        server_thread.join()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
