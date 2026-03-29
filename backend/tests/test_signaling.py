"""Tests for the WebSocket signaling relay."""

import json

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.main import app
from backend.signaling import SignalingRoom, _TokenBucket


def _create_room(client: TestClient) -> tuple[str, str]:
    """Create a room via the API and return (room_code, token)."""
    resp = client.post("/api/rooms")
    assert resp.status_code == 200
    data = resp.json()
    return data["room_code"], data["token"]


def _connect_and_get_id(ws) -> str:
    """Read the assigned-id message and return the peerId."""
    msg = ws.receive_json()
    assert msg["type"] == "assigned-id"
    assert "peerId" in msg
    return msg["peerId"]


class TestSignalingRoom:
    """Unit tests for SignalingRoom logic."""

    def test_room_starts_empty(self):
        room = SignalingRoom("test")
        assert room.is_full is False
        assert room.peer_count == 0

    def test_room_default_max_peers(self):
        room = SignalingRoom("test")
        assert room.max_peers == 8

    def test_room_custom_max_peers(self):
        room = SignalingRoom("test", max_peers=4)
        assert room.max_peers == 4

    def test_validate_rejects_oversized(self):
        room = SignalingRoom("test")
        huge = json.dumps({"type": "offer", "data": "x" * 70000})
        assert room._validate(huge) is None

    def test_validate_rejects_invalid_json(self):
        room = SignalingRoom("test")
        assert room._validate("not json{{{") is None

    def test_validate_rejects_unknown_type(self):
        room = SignalingRoom("test")
        assert room._validate(json.dumps({"type": "hack"})) is None

    def test_validate_accepts_offer(self):
        room = SignalingRoom("test")
        result = room._validate(json.dumps({"type": "offer", "sdp": "v=0..."}))
        assert result is not None
        assert result["type"] == "offer"

    def test_validate_accepts_answer(self):
        room = SignalingRoom("test")
        result = room._validate(json.dumps({"type": "answer", "sdp": "v=0..."}))
        assert result is not None
        assert result["type"] == "answer"

    def test_validate_accepts_ice_candidate(self):
        room = SignalingRoom("test")
        msg = json.dumps({"type": "ice-candidate", "candidate": "a=candidate:..."})
        result = room._validate(msg)
        assert result is not None
        assert result["type"] == "ice-candidate"


class TestTokenBucket:
    """Unit tests for the rate limiter."""

    def test_allows_up_to_burst(self):
        bucket = _TokenBucket(rate=100, burst=10)
        allowed = sum(1 for _ in range(15) if bucket.consume())
        assert allowed == 10  # burst size

    def test_refills_over_time(self):
        import time
        bucket = _TokenBucket(rate=1000, burst=5)
        # Drain the bucket
        for _ in range(5):
            bucket.consume()
        assert bucket.consume() is False
        # Wait for refill
        time.sleep(0.01)  # 10ms at 1000/s = ~10 tokens
        assert bucket.consume() is True

    def test_rejects_when_empty(self):
        bucket = _TokenBucket(rate=10, burst=2)
        assert bucket.consume() is True
        assert bucket.consume() is True
        assert bucket.consume() is False


class TestSignalingWebSocket:
    """Integration tests using Starlette's TestClient WebSocket support."""

    def test_peer_gets_assigned_id(self):
        """First message to a connecting peer is assigned-id."""
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            peer_id = _connect_and_get_id(ws1)
            assert len(peer_id) == 36  # UUID format

    def test_two_peers_get_peer_joined(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            peer1_id = _connect_and_get_id(ws1)

            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                peer2_id = _connect_and_get_id(ws2)

                # ws2 gets room-state with peer1
                room_state = ws2.receive_json()
                assert room_state["type"] == "room-state"
                assert peer1_id in room_state["peers"]

                # ws1 gets peer-joined for peer2
                msg1 = ws1.receive_json()
                assert msg1["type"] == "peer-joined"
                assert msg1["peerId"] == peer2_id

    def test_three_peers_all_notified(self):
        """Three peers connect; each gets appropriate notifications."""
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            peer1_id = _connect_and_get_id(ws1)

            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                peer2_id = _connect_and_get_id(ws2)
                # ws2 gets room-state, ws1 gets peer-joined
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined for peer2

                with client.websocket_connect(f"/ws/{code}?token={token}") as ws3:
                    peer3_id = _connect_and_get_id(ws3)

                    # ws3 gets room-state with peer1 and peer2
                    room_state = ws3.receive_json()
                    assert room_state["type"] == "room-state"
                    assert set(room_state["peers"]) == {peer1_id, peer2_id}

                    # ws1 and ws2 both get peer-joined for peer3
                    msg1 = ws1.receive_json()
                    assert msg1["type"] == "peer-joined"
                    assert msg1["peerId"] == peer3_id

                    msg2 = ws2.receive_json()
                    assert msg2["type"] == "peer-joined"
                    assert msg2["peerId"] == peer3_id

    def test_offer_relay_with_from_stamped(self):
        """Relay stamps 'from' with sender's peerId."""
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            peer1_id = _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                offer = json.dumps({"type": "offer", "sdp": "v=0\r\nfake-sdp"})
                ws1.send_text(offer)
                received = ws2.receive_json()
                assert received["type"] == "offer"
                assert received["sdp"] == "v=0\r\nfake-sdp"
                assert received["from"] == peer1_id

    def test_targeted_relay(self):
        """Message with 'to' field reaches only the target peer."""
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            peer1_id = _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                peer2_id = _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                with client.websocket_connect(f"/ws/{code}?token={token}") as ws3:
                    peer3_id = _connect_and_get_id(ws3)
                    ws3.receive_json()  # room-state
                    ws1.receive_json()  # peer-joined for peer3
                    ws2.receive_json()  # peer-joined for peer3

                    # ws1 sends offer targeted at ws2 only
                    offer = json.dumps({"type": "offer", "sdp": "targeted", "to": peer2_id})
                    ws1.send_text(offer)
                    received = ws2.receive_json()
                    assert received["type"] == "offer"
                    assert received["from"] == peer1_id

                    # ws3 should NOT get this message — send a follow-up to verify
                    ws1.send_text(json.dumps({"type": "offer", "sdp": "broadcast"}))
                    # ws3 should get only the broadcast, not the targeted one
                    msg3 = ws3.receive_json()
                    assert msg3["sdp"] == "broadcast"

    def test_broadcast_relay(self):
        """Message without 'to' reaches all other peers."""
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                with client.websocket_connect(f"/ws/{code}?token={token}") as ws3:
                    _connect_and_get_id(ws3)
                    ws3.receive_json()  # room-state
                    ws1.receive_json()  # peer-joined for peer3
                    ws2.receive_json()  # peer-joined for peer3

                    # ws1 broadcasts an offer (no 'to' field)
                    offer = json.dumps({"type": "offer", "sdp": "broadcast"})
                    ws1.send_text(offer)

                    received2 = ws2.receive_json()
                    received3 = ws3.receive_json()
                    assert received2["type"] == "offer"
                    assert received3["type"] == "offer"

    def test_answer_relay(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                answer = json.dumps({"type": "answer", "sdp": "v=0\r\nanswer-sdp"})
                ws2.send_text(answer)
                received = ws1.receive_json()
                assert received["type"] == "answer"

    def test_ice_candidate_relay(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                ice = json.dumps({"type": "ice-candidate", "candidate": "a=candidate:1 1 udp"})
                ws1.send_text(ice)
                received = ws2.receive_json()
                assert received["type"] == "ice-candidate"

    def test_invalid_message_silently_dropped(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                ws1.send_text("not valid json")
                ws1.send_text(json.dumps({"type": "offer", "sdp": "real"}))
                received = ws2.receive_json()
                assert received["type"] == "offer"
                assert received["sdp"] == "real"

    def test_unknown_type_dropped(self):
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                ws1.send_text(json.dumps({"type": "hack", "payload": "evil"}))
                ws1.send_text(json.dumps({"type": "answer", "sdp": "ok"}))
                received = ws2.receive_json()
                assert received["type"] == "answer"

    def test_peer_disconnect_notifies_others(self):
        """When one peer disconnects, all remaining peers receive peer-disconnected."""
        import time
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                peer2_id = _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined
                ws2.close()
                time.sleep(0.5)

            # Read messages, skipping pings, looking for peer-disconnected
            found = False
            for _ in range(5):
                try:
                    msg = ws1.receive_json()
                except Exception:
                    break
                if msg["type"] == "ping":
                    ws1.send_json({"type": "pong"})
                    continue
                if msg["type"] == "peer-disconnected":
                    assert msg["peerId"] == peer2_id
                    found = True
                    break
            assert found, "Expected peer-disconnected notification"

    def test_token_protection(self):
        """Connections with wrong token are rejected."""
        client = TestClient(app)
        code, token = _create_room(client)
        # Peer connects with correct token
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            _connect_and_get_id(ws1)
            # Another peer with WRONG token — should be rejected
            with client.websocket_connect(f"/ws/{code}?token=wrong") as ws2:
                with pytest.raises(Exception):
                    ws2.receive_json()

    def test_room_not_found_rejected(self):
        """Connecting to a non-existent room is rejected."""
        client = TestClient(app)
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/NONEXIST?token=x") as ws:
                ws.receive_json()

    def test_room_full_rejected(self):
        """Room rejects connections when at capacity."""
        client = TestClient(app)
        # Create room with max_peers=2
        resp = client.post("/api/rooms?max_peers=2")
        data = resp.json()
        code, token = data["room_code"], data["token"]

        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                # Third peer should be rejected
                with client.websocket_connect(f"/ws/{code}?token={token}") as ws3:
                    with pytest.raises(Exception):
                        ws3.receive_json()

    def test_from_field_cannot_be_spoofed(self):
        """Server stamps 'from' field — client's value is overwritten."""
        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws1:
            peer1_id = _connect_and_get_id(ws1)
            with client.websocket_connect(f"/ws/{code}?token={token}") as ws2:
                _connect_and_get_id(ws2)
                ws2.receive_json()  # room-state
                ws1.receive_json()  # peer-joined

                # Try to spoof 'from' field
                spoofed = json.dumps({"type": "offer", "sdp": "test", "from": "fake-peer-id"})
                ws1.send_text(spoofed)
                received = ws2.receive_json()
                # Server should have overwritten 'from' with actual peer1_id
                assert received["from"] == peer1_id

    def test_room_cleanup(self):
        from backend.signaling import manager
        import asyncio

        client = TestClient(app)
        code, token = _create_room(client)
        with client.websocket_connect(f"/ws/{code}?token={token}") as ws:
            _connect_and_get_id(ws)

        # Room should be in manager initially (empty but exists after disconnect)
        assert code in manager._rooms

        # Run cleanup manually
        asyncio.run(manager.remove_empty_rooms())

        # Room should be gone
        assert code not in manager._rooms
