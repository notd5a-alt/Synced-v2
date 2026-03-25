from __future__ import annotations

import os
import socket
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

from backend.signaling import room

app = FastAPI()

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
    return {"iceServers": servers}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await room.handle(ws)


# Mount static files last (catch-all)
static_dir = Path(__file__).parent / "static"
if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
