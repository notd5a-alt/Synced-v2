"""Tests for the WebSocket signaling relay."""

import json

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.main import app
from backend.signaling import SignalingRoom


class TestSignalingRoom:
    """Unit tests for SignalingRoom logic."""

    def test_room_starts_empty(self):
        room = SignalingRoom()
        assert room.is_full is False
        assert len(room._peers) == 0

    def test_validate_rejects_oversized(self):
        room = SignalingRoom()
        huge = json.dumps({"type": "offer", "data": "x" * 70000})
        assert room._validate(huge) is False

    def test_validate_rejects_invalid_json(self):
        room = SignalingRoom()
        assert room._validate("not json{{{") is False

    def test_validate_rejects_unknown_type(self):
        room = SignalingRoom()
        assert room._validate(json.dumps({"type": "hack"})) is False

    def test_validate_accepts_offer(self):
        room = SignalingRoom()
        assert room._validate(json.dumps({"type": "offer", "sdp": "v=0..."})) is True

    def test_validate_accepts_answer(self):
        room = SignalingRoom()
        assert room._validate(json.dumps({"type": "answer", "sdp": "v=0..."})) is True

    def test_validate_accepts_ice_candidate(self):
        room = SignalingRoom()
        msg = json.dumps({"type": "ice-candidate", "candidate": "a=candidate:..."})
        assert room._validate(msg) is True


class TestSignalingWebSocket:
    """Integration tests using Starlette's TestClient WebSocket support."""

    def test_two_peers_get_peer_joined(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                msg1 = ws1.receive_json()
                msg2 = ws2.receive_json()
                assert msg1["type"] == "peer-joined"
                assert msg2["type"] == "peer-joined"

    def test_offer_relay(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                # Consume peer-joined
                ws1.receive_json()
                ws2.receive_json()

                # Host sends offer → Joiner receives it
                offer = json.dumps({"type": "offer", "sdp": "v=0\r\nfake-sdp"})
                ws1.send_text(offer)
                received = ws2.receive_json()
                assert received["type"] == "offer"
                assert received["sdp"] == "v=0\r\nfake-sdp"

    def test_answer_relay(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                answer = json.dumps({"type": "answer", "sdp": "v=0\r\nanswer-sdp"})
                ws2.send_text(answer)
                received = ws1.receive_json()
                assert received["type"] == "answer"

    def test_ice_candidate_relay(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                ice = json.dumps({"type": "ice-candidate", "candidate": "a=candidate:1 1 udp"})
                ws1.send_text(ice)
                received = ws2.receive_json()
                assert received["type"] == "ice-candidate"

    def test_invalid_role_rejected(self):
        client = TestClient(app)
        # Invalid role should be rejected with close code 4000
        with pytest.raises(Exception):
            with client.websocket_connect("/ws?role=invalid") as ws:
                pass

    def test_duplicate_role_replaces_old(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            # Second host connection replaces the first
            with client.websocket_connect("/ws?role=host") as ws2:
                # ws1 should be closed (replaced)
                with pytest.raises(WebSocketDisconnect):
                    ws1.receive_json()

    def test_invalid_message_silently_dropped(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                # Send invalid message — should not be relayed
                ws1.send_text("not valid json")
                # Send a valid message after
                ws1.send_text(json.dumps({"type": "offer", "sdp": "real"}))
                received = ws2.receive_json()
                assert received["type"] == "offer"
                assert received["sdp"] == "real"

    def test_unknown_type_dropped(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

                ws1.send_text(json.dumps({"type": "hack", "payload": "evil"}))
                # Follow up with valid message to confirm relay still works
                ws1.send_text(json.dumps({"type": "answer", "sdp": "ok"}))
                received = ws2.receive_json()
                assert received["type"] == "answer"

    def test_peer_disconnect_notifies_other(self):
        client = TestClient(app)
        with client.websocket_connect("/ws?role=host") as ws1:
            with client.websocket_connect("/ws?role=join") as ws2:
                ws1.receive_json()
                ws2.receive_json()

            # ws2 context exits (disconnects)
            msg = ws1.receive_json()
            assert msg["type"] == "peer-disconnected"
