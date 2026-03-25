from __future__ import annotations

import json
import logging

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("ghostchat.signaling")

MAX_MESSAGE_SIZE = 65536  # 64 KB
ALLOWED_TYPES = {"offer", "answer", "ice-candidate"}
VALID_ROLES = {"host", "join"}


class SignalingRoom:
    """Pairs exactly two WebSocket peers (host + join) and relays messages between them."""

    def __init__(self):
        self._peers: dict[str, WebSocket] = {}  # role -> WebSocket

    @property
    def is_full(self) -> bool:
        return "host" in self._peers and "join" in self._peers

    def _other(self, ws: WebSocket) -> WebSocket | None:
        for peer in self._peers.values():
            if peer is not ws:
                return peer
        return None

    async def connect(self, ws: WebSocket, role: str) -> bool:
        """Add a peer by role. Duplicate role replaces the old connection."""
        if role not in VALID_ROLES:
            return False

        # If this role already has a connection, close the old one
        if role in self._peers:
            old = self._peers[role]
            logger.info("replacing stale %s connection", role)
            try:
                await old.close(code=4001, reason="Replaced by new connection")
            except Exception:
                pass
            del self._peers[role]

        await ws.accept()
        self._peers[role] = ws
        logger.info("peer connected (%s, %d/2 in room)", role, len(self._peers))

        # Notify both sides when both roles are filled
        if self.is_full:
            for peer in self._peers.values():
                await peer.send_json({"type": "peer-joined"})
        return True

    async def disconnect(self, ws: WebSocket):
        role_to_remove = None
        for role, peer in self._peers.items():
            if peer is ws:
                role_to_remove = role
                break
        if role_to_remove:
            del self._peers[role_to_remove]
            logger.info("peer disconnected (%s, %d/2 in room)", role_to_remove, len(self._peers))
            other = next(iter(self._peers.values()), None)
            if other:
                try:
                    await other.send_json({"type": "peer-disconnected"})
                except Exception:
                    pass

    def _validate(self, data: str) -> bool:
        """Check message size and structure."""
        if len(data) > MAX_MESSAGE_SIZE:
            logger.warning("message too large (%d bytes), dropping", len(data))
            return False
        try:
            msg = json.loads(data)
        except (json.JSONDecodeError, TypeError):
            logger.warning("invalid JSON, dropping")
            return False
        msg_type = msg.get("type")
        if msg_type not in ALLOWED_TYPES:
            logger.warning("unknown message type %r, dropping", msg_type)
            return False
        return True

    async def relay(self, ws: WebSocket, data: str):
        """Forward a validated message from one peer to the other."""
        other = self._other(ws)
        if other:
            try:
                await other.send_text(data)
            except WebSocketDisconnect:
                logger.warning("relay failed, peer disconnected")
                await self.disconnect(other)
            except Exception as e:
                logger.warning("relay send failed: %s", e)

    async def handle(self, ws: WebSocket, role: str):
        """Full lifecycle: connect, relay messages, handle disconnect."""
        accepted = await self.connect(ws, role)
        if not accepted:
            await ws.close(code=4000, reason="Invalid role")
            return
        try:
            while True:
                data = await ws.receive_text()
                if self._validate(data):
                    await self.relay(ws, data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error("signaling handler error: %s", e)
        finally:
            try:
                await self.disconnect(ws)
            except Exception as e:
                logger.error("disconnect cleanup failed: %s", e)


# Single global room (1-on-1 app)
room = SignalingRoom()
