from __future__ import annotations

import asyncio
import logging
import os
import socket
import traceback
from pathlib import Path

from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from backend.signaling import manager, RoomLimitError

logger = logging.getLogger("synced.server")

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


# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    cleanup_task = asyncio.create_task(manager.cleanup_loop(60))
    yield
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)

# Security headers
app.add_middleware(SecurityHeadersMiddleware)

# CORS — allow localhost, LAN, and configured external origins
_lan_ip = None
_extra_origins_raw = os.environ.get("SYNCED_ALLOWED_ORIGINS", "").strip()
_allow_all_origins = _extra_origins_raw == "*"

def _get_allowed_origins() -> list[str]:
    global _lan_ip
    if _allow_all_origins:
        return ["*"]
    if _lan_ip is None:
        _lan_ip = get_local_ip()
    origins = [
        "http://localhost:9876",
        "http://127.0.0.1:9876",
        f"http://{_lan_ip}:9876",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        f"http://{_lan_ip}:5173",
        "https://localhost:5173",
        "https://127.0.0.1:5173",
        f"https://{_lan_ip}:5173",
        "tauri://localhost",
    ]
    if _extra_origins_raw:
        for o in _extra_origins_raw.split(","):
            o = o.strip().rstrip("/")
            if o and o not in origins:
                origins.append(o)
    return origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_allowed_origins(),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Global exception handler — never leak stack traces
# ---------------------------------------------------------------------------
@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception on %s %s:\n%s",
                 request.method, request.url.path, traceback.format_exc())
    return JSONResponse(status_code=500, content={"error": "internal server error"})


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------
@app.get("/api/info")
async def info():
    return {"ip": get_local_ip(), "port": server_port}


@app.post("/api/rooms")
async def create_room():
    """Create a new room and return a short room code."""
    try:
        code = await manager.create_room()
        return {"room_code": code}
    except RoomLimitError:
        return JSONResponse(status_code=503, content={"error": "Server at capacity"})


@app.get("/api/rooms/{code}")
async def check_room(code: str):
    """Check if a room exists and is joinable."""
    exists, joinable = await manager.room_exists(code.upper())
    return {"exists": exists, "joinable": joinable}


@app.get("/api/debug")
async def debug(room_id: str = "default"):
    """Debug endpoint — only available when SYNCED_DEBUG=1."""
    if os.environ.get("SYNCED_DEBUG") != "1":
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
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
    # No public TURN fallback — for zero-trust, TURN must be self-hosted.
    # Without TURN, peers behind symmetric NAT may fail to connect directly.
    return {"iceServers": servers}


# ---------------------------------------------------------------------------
# WebSocket origin validation
# ---------------------------------------------------------------------------
_ALLOWED_WS_ORIGINS: set[str] | None = None

def _get_allowed_ws_origins() -> set[str]:
    global _ALLOWED_WS_ORIGINS
    if _ALLOWED_WS_ORIGINS is None:
        if _allow_all_origins:
            _ALLOWED_WS_ORIGINS = set()  # empty = skip check (handled below)
            return _ALLOWED_WS_ORIGINS
        lan = get_local_ip()
        _ALLOWED_WS_ORIGINS = {
            f"http://localhost:{server_port}",
            f"http://127.0.0.1:{server_port}",
            f"http://{lan}:{server_port}",
            # Vite dev server
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            f"http://{lan}:5173",
            "https://localhost:5173",
            "https://127.0.0.1:5173",
            f"https://{lan}:5173",
            # Tauri
            "tauri://localhost",
        }
        if _extra_origins_raw:
            for o in _extra_origins_raw.split(","):
                o = o.strip().rstrip("/")
                if o:
                    _ALLOWED_WS_ORIGINS.add(o)
    return _ALLOWED_WS_ORIGINS


@app.websocket("/ws")
@app.websocket("/ws/{room_id}")
async def websocket_endpoint(ws: WebSocket, room_id: str = "default", role: str = "host", token: str | None = None):
    # Validate origin — browsers always send Origin on WS handshakes
    origin = (ws.headers.get("origin") or "").rstrip("/")
    if not _allow_all_origins:
        allowed = _get_allowed_ws_origins()
        if not origin:
            logger.debug("WebSocket connection with no Origin header (non-browser client)")
        elif origin not in allowed:
            logger.warning("Rejected WebSocket from origin %r (allowed: %s)", origin, allowed)
            # Must accept before close — Starlette raises RuntimeError on close of unaccepted WS
            await ws.accept()
            await ws.close(code=4003, reason="Forbidden origin")
            return

    try:
        room = await manager.get_room(room_id)
    except RoomLimitError:
        logger.warning("Room limit reached, rejecting WebSocket for room %s", room_id)
        await ws.close(code=4004, reason="Server at capacity")
        return
    await room.handle(ws, role, token)


# ---------------------------------------------------------------------------
# Static files (catch-all, must be last)
# ---------------------------------------------------------------------------
import sys

static_dir = Path(__file__).parent / "static"
if not static_dir.is_dir() and hasattr(sys, "_MEIPASS"):
    static_dir = Path(sys._MEIPASS) / "backend" / "static"

if static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
