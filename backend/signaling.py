from __future__ import annotations

import json
import logging

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger("ghostchat.signaling")

MAX_MESSAGE_SIZE = 65536  # 64 KB
ALLOWED_TYPES = {"offer", "answer", "ice-candidate"}


class SignalingRoom:
    """Pairs exactly two WebSocket peers and relays messages between them."""

    def __init__(self):
        self._peers: list[WebSocket] = []

    @property
    def is_full(self) -> bool:
        return len(self._peers) >= 2

    def _other(self, ws: WebSocket) -> WebSocket | None:
        for peer in self._peers:
            if peer is not ws:
                return peer
        return None

    async def connect(self, ws: WebSocket) -> bool:
        """Add a peer. Returns False if room is full."""
        if self.is_full:
            return False
        await ws.accept()
        # Re-check after await to guard against concurrent coroutines
        if self.is_full:
            await ws.close(code=4000, reason="Room is full")
            return False
        self._peers.append(ws)

        # Notify both sides when the second peer joins
        if len(self._peers) == 2:
            for peer in self._peers:
                await peer.send_json({"type": "peer-joined"})
        return True

    async def disconnect(self, ws: WebSocket):
        if ws in self._peers:
            self._peers.remove(ws)
            other = self._other(ws)
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

    async def handle(self, ws: WebSocket):
        """Full lifecycle: connect, relay messages, handle disconnect."""
        accepted = await self.connect(ws)
        if not accepted:
            await ws.close(code=4000, reason="Room is full")
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
