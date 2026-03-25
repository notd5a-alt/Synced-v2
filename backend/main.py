from __future__ import annotations

import asyncio
import os
import socket
from pathlib import Path

from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from backend.signaling import manager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start the room cleanup task
    cleanup_task = asyncio.create_task(manager.cleanup_loop(60))
    yield
    # Cleanup task will be cancelled on shutdown
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)

# Will be set by app.py at startup
server_port: int = 9876


def get_local_ip() -> str:
    """Best-effort LAN IP detection."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


@app.get("/api/info")
async def info():
    return {"ip": get_local_ip(), "port": server_port}


@app.get("/api/debug")
async def debug(room_id: str = "default"):
    """Debug endpoint — shows signaling room state."""
    room = await manager.get_room(room_id)
    return {
        "room_id": room_id,
        "peers": list(room._peers.keys()),
        "is_full": room.is_full,
        "peer_count": len(room._peers),
    }


@app.get("/api/ice-config")
async def ice_config():
    servers = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ]
    turn_url = os.environ.get("TURN_URL")
    turn_user = os.environ.get("TURN_USERNAME")
    turn_cred = os.environ.get("TURN_CREDENTIAL")
    if turn_url and turn_user and turn_cred:
        servers.append({
            "urls": turn_url,
            "username": turn_user,
            "credential": turn_cred,
        })
    else:
        # Free Open Relay TURN servers as fallback for symmetric NAT traversal
        servers.append({
            "urls": [
                "turn:openrelay.metered.ca:80",
                "turn:openrelay.metered.ca:443",
                "turns:openrelay.metered.ca:443",
            ],
            "username": "openrelayproject",
            "credential": "openrelayproject",
        })
    return {"iceServers": servers}


@app.websocket("/ws")
@app.websocket("/ws/{room_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str = "default", role: str = "host", token: str | None = None):
    room = await manager.get_room(room_id)
    await room.handle(ws, role, token)


# Mount static files last (catch-all).
# When running inside a PyInstaller bundle, __file__ points to a temp dir,
# so we also check sys._MEIPASS (PyInstaller's extraction root).
import sys

static_dir = Path(__file__).parent / "static"
if not static_dir.is_dir() and hasattr(sys, "_MEIPASS"):
    static_dir = Path(sys._MEIPASS) / "backend" / "static"

if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
