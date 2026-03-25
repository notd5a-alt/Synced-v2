"""GhostChat – zero-trust P2P desktop chat."""
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
    parser.add_argument("--dev", action="store_true", help="Dev mode: skip pywebview")
    args = parser.parse_args()

    # Tell the backend which port we're on
    import backend.main as backend_main
    backend_main.server_port = args.port

    # Start uvicorn in a daemon thread
    server_thread = threading.Thread(
        target=uvicorn.run,
        args=("backend.main:app",),
        kwargs={"host": "0.0.0.0", "port": args.port, "log_level": "warning"},
        daemon=True,
    )
    server_thread.start()

    local_url = f"http://localhost:{args.port}"
    _wait_for_server(local_url)

    if args.dev:
        print(f"GhostChat backend running at {local_url}")
        print("Start the Vite dev server: cd frontend && npm run dev")
        try:
            server_thread.join()
        except KeyboardInterrupt:
            pass
    else:
        import webview
        window = webview.create_window(
            "GhostChat",
            local_url,
            width=960,
            height=700,
            min_size=(640, 480),
        )
        webview.start()


if __name__ == "__main__":
    main()
