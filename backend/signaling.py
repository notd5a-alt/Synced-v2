from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import time
import uuid
from typing import Dict

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("synced.signaling")

MAX_MESSAGE_SIZE = 65536  # 64 KB
MAX_ROOMS = int(os.environ.get("SYNCED_MAX_ROOMS", 100))           # Cap total rooms
MAX_PEERS_PER_ROOM = int(os.environ.get("SYNCED_MAX_PEERS", 8))    # Max peers per room
HEARTBEAT_INTERVAL = int(os.environ.get("SYNCED_HEARTBEAT_INTERVAL", 30))   # seconds between pings
HEARTBEAT_TIMEOUT = int(os.environ.get("SYNCED_HEARTBEAT_TIMEOUT", 300))   # close if no pong within this many seconds
                          # (Chrome throttles background tabs to ~1 timer/min)
IDLE_TIMEOUT = int(os.environ.get("SYNCED_IDLE_TIMEOUT", 1800))       # close if no signaling messages in 30 minutes
WS_ACCEPT_TIMEOUT = 10    # H1: seconds to wait for WebSocket handshake
ALLOWED_TYPES = {"offer", "answer", "ice-candidate", "ping", "pong", "screen-sharing"}

ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 32 chars, no ambiguous 0/O/1/l/I
ROOM_CODE_LENGTH = 6

# Rate limiting: token bucket per peer
RATE_LIMIT = int(os.environ.get("SYNCED_RATE_LIMIT", 100))          # messages per second
RATE_BURST = int(os.environ.get("SYNCED_RATE_BURST", 200))          # max burst size

# Per-IP connection limiting
MAX_CONNECTIONS_PER_IP = int(os.environ.get("SYNCED_MAX_CONNECTIONS_PER_IP", 10))  # increased for multi-peer


class _TokenBucket:
    """Simple token bucket rate limiter."""

    __slots__ = ("_rate", "_burst", "_tokens", "_last")

    def __init__(self, rate: float = RATE_LIMIT, burst: int = RATE_BURST):
        self._rate = rate
        self._burst = burst
        self._tokens = float(burst)
        self._last = time.monotonic()

    def consume(self) -> bool:
        """Try to consume one token. Returns True if allowed, False if throttled."""
        now = time.monotonic()
        elapsed = max(0.0, now - self._last)  # clamp negative (defensive)
        self._last = now
        self._tokens = min(self._burst, self._tokens + elapsed * self._rate)
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False


class SignalingRoom:
    """Manages up to MAX_PEERS_PER_ROOM WebSocket peers and relays messages between them."""

    def __init__(self, room_id: str, max_peers: int = MAX_PEERS_PER_ROOM):
        self.room_id = room_id
        self.max_peers = min(max_peers, MAX_PEERS_PER_ROOM)
        self._peers: Dict[str, WebSocket] = {}  # peerId -> WebSocket
        self._peer_order: list[str] = []         # join order (first = room creator)
        self._room_token: str = ""               # shared room token — required for all connections
        self._last_pong: Dict[str, float] = {}   # peerId -> timestamp
        self._last_activity: float = time.monotonic()  # updated on real signaling messages
        self._lock = asyncio.Lock()

    @property
    def is_full(self) -> bool:
        return len(self._peers) >= self.max_peers

    @property
    def peer_count(self) -> int:
        return len(self._peers)

    async def connect(self, ws: WebSocket, token: str | None = None) -> str | None:
        """Add a peer. Returns assigned peerId on success, None on failure.

        Token must match the room token set at creation.
        """
        # Accept WebSocket before acquiring lock to avoid blocking other peers
        # H1: Timeout prevents Slowloris-style attacks on the handshake
        try:
            await asyncio.wait_for(ws.accept(), timeout=WS_ACCEPT_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("[%s] WebSocket accept timeout", self.room_id)
            return None

        async with self._lock:
            # Enforce room token — every connection must present it
            if self._room_token and token != self._room_token:
                logger.warning("[%s] rejected peer: invalid room token", self.room_id)
                try:
                    await ws.close(code=4000, reason="Invalid token")
                except Exception as e:
                    logger.debug("[%s] close after token rejection failed: %s", self.room_id, e)
                return None

            # Reject if room is full
            if self.is_full:
                logger.warning("[%s] rejected peer: room full (%d/%d)", self.room_id, len(self._peers), self.max_peers)
                try:
                    await ws.close(code=4004, reason="Room full")
                except Exception as e:
                    logger.debug("[%s] close after room full rejection failed: %s", self.room_id, e)
                return None

            # Assign a unique peer ID
            peer_id = str(uuid.uuid4())

            # Collect existing peer IDs before adding new peer
            existing_peer_ids = list(self._peers.keys())

            self._peers[peer_id] = ws
            self._peer_order.append(peer_id)
            self._last_pong[peer_id] = time.monotonic()

            logger.info("[%s] peer %s connected (%d/%d in room)",
                        self.room_id, peer_id[:8], len(self._peers), self.max_peers)

            # Send assigned-id to the new peer
            try:
                await ws.send_json({"type": "assigned-id", "peerId": peer_id})
            except Exception as e:
                logger.warning("[%s] failed to send assigned-id to %s: %s", self.room_id, peer_id[:8], e)

            # Send room-state to the new peer (list of already-connected peers)
            if existing_peer_ids:
                try:
                    await ws.send_json({"type": "room-state", "peers": existing_peer_ids})
                except Exception as e:
                    logger.warning("[%s] failed to send room-state to %s: %s", self.room_id, peer_id[:8], e)

            # Notify all existing peers that a new peer joined
            for existing_id, existing_ws in list(self._peers.items()):
                if existing_id == peer_id:
                    continue
                try:
                    await existing_ws.send_json({"type": "peer-joined", "peerId": peer_id})
                except Exception as e:
                    logger.warning("[%s] failed to send peer-joined to %s: %s", self.room_id, existing_id[:8], e)

        return peer_id

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            peer_id_to_remove = None
            for peer_id, peer in self._peers.items():
                if peer is ws:
                    peer_id_to_remove = peer_id
                    break
            if peer_id_to_remove:
                del self._peers[peer_id_to_remove]
                self._last_pong.pop(peer_id_to_remove, None)
                if peer_id_to_remove in self._peer_order:
                    self._peer_order.remove(peer_id_to_remove)
                logger.info("[%s] peer %s disconnected (%d/%d in room)",
                            self.room_id, peer_id_to_remove[:8], len(self._peers), self.max_peers)

                # Notify all remaining peers
                for remaining_ws in list(self._peers.values()):
                    try:
                        await remaining_ws.send_json({"type": "peer-disconnected", "peerId": peer_id_to_remove})
                    except Exception as e:
                        logger.debug("[%s] failed to send peer-disconnected: %s", self.room_id, e)

    def _get_peer_id(self, ws: WebSocket) -> str | None:
        """Return the peerId for a given WebSocket, or None."""
        for peer_id, peer in self._peers.items():
            if peer is ws:
                return peer_id
        return None

    def _validate(self, data: str) -> dict | None:
        """Check message size and structure. Returns parsed dict or None."""
        if len(data) > MAX_MESSAGE_SIZE:
            logger.warning("[%s] message too large (%d bytes), dropping", self.room_id, len(data))
            return None
        try:
            msg = json.loads(data)
        except (json.JSONDecodeError, TypeError):
            logger.warning("[%s] invalid JSON, dropping", self.room_id)
            return None
        msg_type = msg.get("type")
        if msg_type not in ALLOWED_TYPES:
            logger.warning("[%s] unknown message type %r, dropping", self.room_id, msg_type)
            return None
        return msg

    async def relay(self, ws: WebSocket, data: str, msg: dict, sender_id: str):
        """Forward a validated message. Routes by 'to' field or broadcasts."""
        msg_type = msg.get("type")
        target_id = msg.get("to")

        # Stamp the sender's peerId into the message (prevents spoofing)
        msg["from"] = sender_id
        stamped_data = json.dumps(msg)

        # Collect targets inside lock, send outside to prevent deadlock
        targets: list[tuple[str, WebSocket]] = []
        async with self._lock:
            if target_id:
                # Targeted relay: send to specific peer
                target_ws = self._peers.get(target_id)
                if target_ws:
                    targets.append((target_id, target_ws))
                else:
                    logger.warning("[%s] relay: target peer %s not found", self.room_id, target_id[:8] if target_id else "?")
            else:
                # Broadcast: send to all peers except sender
                for pid, pws in self._peers.items():
                    if pws is not ws:
                        targets.append((pid, pws))

        disconnect_peers: list[WebSocket] = []
        for tid, tws in targets:
            try:
                logger.info("[%s] relaying %s from %s to %s", self.room_id, msg_type, sender_id[:8], tid[:8])
                await tws.send_text(stamped_data)
            except WebSocketDisconnect:
                logger.warning("[%s] relay failed, peer %s disconnected", self.room_id, tid[:8])
                disconnect_peers.append(tws)
            except Exception as e:
                logger.warning("[%s] relay send to %s failed: %s", self.room_id, tid[:8], e)

        for dws in disconnect_peers:
            await self.disconnect(dws)

    async def handle(self, ws: WebSocket, token: str | None = None):
        """Full lifecycle: connect, relay messages, handle disconnect."""
        peer_id = await self.connect(ws, token)
        if not peer_id:
            # connect() may have already closed the socket
            try:
                await ws.close(code=4000, reason="Connection rejected")
            except Exception as e:
                logger.debug("[%s] close after rejection failed: %s", self.room_id, e)
            return

        # Start a heartbeat task for this connection
        heartbeat_task = asyncio.create_task(self._heartbeat(ws, peer_id))
        bucket = _TokenBucket()
        throttle_warnings = 0

        try:
            while True:
                # M1: Timeout on receive as safety net
                try:
                    data = await asyncio.wait_for(
                        ws.receive_text(),
                        timeout=HEARTBEAT_TIMEOUT + HEARTBEAT_INTERVAL + 10,
                    )
                except asyncio.TimeoutError:
                    logger.warning("[%s] receive timeout for %s, closing", self.room_id, peer_id[:8])
                    await ws.close(code=4009, reason="Receive timeout")
                    return
                if not bucket.consume():
                    throttle_warnings += 1
                    if throttle_warnings == 1:
                        logger.warning("[%s] rate limiting %s (>%d msg/s)", self.room_id, peer_id[:8], RATE_LIMIT)
                    if throttle_warnings >= 500:
                        logger.warning("[%s] closing %s: sustained rate limit abuse (%d dropped)",
                                       self.room_id, peer_id[:8], throttle_warnings)
                        await ws.close(code=4008, reason="Rate limit exceeded")
                        return
                    continue
                throttle_warnings = 0
                msg = self._validate(data)
                if msg is not None:
                    msg_type = msg.get("type")
                    if msg_type in {"offer", "answer", "ice-candidate", "screen-sharing"}:
                        self._last_activity = time.monotonic()
                        await self.relay(ws, data, msg, peer_id)
                    elif msg_type == "pong":
                        # Update pong timestamp for heartbeat timeout detection
                        async with self._lock:
                            if peer_id in self._last_pong:
                                self._last_pong[peer_id] = time.monotonic()
                    # pings are consumed here, not relayed
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("[%s] signaling handler error: %s", self.room_id, e)
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            try:
                await self.disconnect(ws)
            except Exception as e:
                logger.error("[%s] disconnect cleanup failed: %s", self.room_id, e)

    async def _heartbeat(self, ws: WebSocket, peer_id: str):
        """Periodically send a ping and close connection if no pong received."""
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                # Check for pong timeout entirely under lock to prevent race
                # with pong arriving between read and close
                timed_out = False
                async with self._lock:
                    last = self._last_pong.get(peer_id, 0)
                    if time.monotonic() - last > HEARTBEAT_TIMEOUT:
                        timed_out = True
                if timed_out:
                    logger.warning("[%s] heartbeat timeout for %s (no pong in %ds), closing",
                                   self.room_id, peer_id[:8], HEARTBEAT_TIMEOUT)
                    try:
                        await ws.close(code=4002, reason="Heartbeat timeout")
                    except Exception as e:
                        logger.debug("[%s] close after heartbeat timeout failed: %s", self.room_id, e)
                    return
                # Check for room-level idle timeout (no real signaling messages)
                if time.monotonic() - self._last_activity > IDLE_TIMEOUT:
                    logger.warning("[%s] idle timeout for %s (no signaling activity in %ds), closing",
                                   self.room_id, peer_id[:8], IDLE_TIMEOUT)
                    try:
                        await ws.close(code=4007, reason="Idle timeout")
                    except Exception as e:
                        logger.debug("[%s] close after idle timeout failed: %s", self.room_id, e)
                    return
                # Send ping
                await ws.send_json({"type": "ping"})
        except asyncio.CancelledError:
            raise  # H4: Let cancellation propagate cleanly
        except Exception as e:
            logger.debug("[%s] heartbeat loop ended for %s: %s", self.room_id, peer_id[:8], e)


class RoomManager:
    """Manages multiple signaling rooms."""

    def __init__(self):
        self._rooms: Dict[str, SignalingRoom] = {}
        self._lock = asyncio.Lock()
        self._ip_connections: Dict[str, int] = {}  # IP -> active connection count
        self._ip_lock = asyncio.Lock()

    async def create_room(self, max_peers: int = MAX_PEERS_PER_ROOM) -> tuple[str, str]:
        """Generate a unique room code, a room token, and pre-create the room.

        Returns (room_code, room_token). The token must be presented by all
        peers when connecting via WebSocket to prevent room hijacking.
        """
        async with self._lock:
            if len(self._rooms) >= MAX_ROOMS:
                raise RoomLimitError(f"Maximum rooms ({MAX_ROOMS}) reached")
            for _ in range(100):  # retry on collision
                code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH))
                if code not in self._rooms:
                    token = secrets.token_urlsafe(32)
                    room = SignalingRoom(code, max_peers=max_peers)
                    room._room_token = token
                    self._rooms[code] = room
                    logger.info("Created room %s (max_peers=%d, %d total rooms)", code, room.max_peers, len(self._rooms))
                    return code, token
            raise RoomLimitError("Could not generate unique room code")

    async def room_exists(self, room_id: str) -> tuple[bool, bool]:
        """Returns (exists, joinable). Joinable = exists and not full."""
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return False, False
            return True, not room.is_full

    async def room_info(self, room_id: str) -> tuple[bool, bool, str, int, int]:
        """Returns (exists, joinable, token, peer_count, max_peers).

        Token is returned only if joinable.
        """
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return False, False, "", 0, 0
            joinable = not room.is_full
            return True, joinable, room._room_token if joinable else "", room.peer_count, room.max_peers

    async def get_room(self, room_id: str) -> SignalingRoom | None:
        """Return an existing room, or None if it doesn't exist.

        Rooms must be created via create_room() — the WS endpoint should
        not auto-create rooms, which would allow attackers to fill the room
        cap or enumerate codes.
        """
        async with self._lock:
            return self._rooms.get(room_id)

    async def acquire_ip(self, ip: str) -> bool:
        """Increment connection count for an IP. Returns False if over limit."""
        async with self._ip_lock:
            count = self._ip_connections.get(ip, 0)
            if count >= MAX_CONNECTIONS_PER_IP:
                return False
            self._ip_connections[ip] = count + 1
            return True

    async def release_ip(self, ip: str) -> None:
        """Decrement connection count for an IP."""
        async with self._ip_lock:
            count = self._ip_connections.get(ip, 0)
            if count <= 0:
                # M2: Underflow guard — log and bail if release without acquire
                logger.warning("release_ip called for %s with count=%d, ignoring", ip, count)
                self._ip_connections.pop(ip, None)
                return
            if count <= 1:
                self._ip_connections.pop(ip, None)
            else:
                self._ip_connections[ip] = count - 1

    async def remove_empty_rooms(self):
        """Cleanup task to remove rooms with no peers.

        Holds both manager lock AND room lock when deleting to prevent a race
        where a peer (holding an existing room ref) calls connect() between
        our empty check and the deletion.
        """
        async with self._lock:
            empty_rooms: list[str] = []
            for rid, r in list(self._rooms.items()):
                async with r._lock:
                    if not r._peers:
                        # Delete while still holding room lock so no connect()
                        # can sneak in between check and removal
                        empty_rooms.append(rid)
                        del self._rooms[rid]
            if empty_rooms:
                logger.info("Cleaning up %d empty rooms: %s", len(empty_rooms), empty_rooms)

    async def cleanup_loop(self, interval: int = 60):
        """Infinite loop to periodically remove empty rooms."""
        while True:
            await asyncio.sleep(interval)
            await self.remove_empty_rooms()


class RoomLimitError(Exception):
    """Raised when the maximum number of rooms is reached."""
    pass


# Global room manager
manager = RoomManager()
