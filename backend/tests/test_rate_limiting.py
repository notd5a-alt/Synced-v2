"""Tests for rate limiting, per-IP connection limits, and config validation."""

import asyncio
import json
import os
import time

import pytest
from starlette.testclient import TestClient

from backend.main import app
from backend.signaling import (
    _TokenBucket,
    RoomManager,
    _env_int,
    MAX_CONNECTIONS_PER_IP,
)


# ---------------------------------------------------------------------------
# _env_int safe parsing
# ---------------------------------------------------------------------------
class TestEnvInt:
    """Tests for the _env_int helper."""

    def test_returns_default_when_unset(self):
        key = "SYNCED_TEST_UNSET_VAR_123456"
        os.environ.pop(key, None)
        assert _env_int(key, 42) == 42

    def test_parses_valid_int(self):
        key = "SYNCED_TEST_VALID_INT"
        os.environ[key] = "99"
        try:
            assert _env_int(key, 0) == 99
        finally:
            del os.environ[key]

    def test_falls_back_on_invalid_value(self):
        key = "SYNCED_TEST_INVALID_INT"
        os.environ[key] = "not-a-number"
        try:
            assert _env_int(key, 50) == 50
        finally:
            del os.environ[key]

    def test_falls_back_on_empty_string(self):
        key = "SYNCED_TEST_EMPTY_INT"
        os.environ[key] = ""
        try:
            assert _env_int(key, 7) == 7
        finally:
            del os.environ[key]

    def test_falls_back_on_float_string(self):
        key = "SYNCED_TEST_FLOAT_INT"
        os.environ[key] = "3.14"
        try:
            assert _env_int(key, 10) == 10
        finally:
            del os.environ[key]


# ---------------------------------------------------------------------------
# TokenBucket edge cases
# ---------------------------------------------------------------------------
class TestTokenBucketAdvanced:
    """Additional edge-case tests for _TokenBucket."""

    def test_zero_rate_never_refills(self):
        bucket = _TokenBucket(rate=0, burst=2)
        assert bucket.consume() is True
        assert bucket.consume() is True
        assert bucket.consume() is False
        time.sleep(0.05)
        assert bucket.consume() is False

    def test_burst_one(self):
        bucket = _TokenBucket(rate=1000, burst=1)
        assert bucket.consume() is True
        assert bucket.consume() is False

    def test_large_burst_allows_many(self):
        bucket = _TokenBucket(rate=1, burst=100)
        allowed = sum(1 for _ in range(200) if bucket.consume())
        assert allowed == 100

    def test_refill_does_not_exceed_burst(self):
        bucket = _TokenBucket(rate=10000, burst=5)
        # Drain it
        for _ in range(5):
            bucket.consume()
        # Wait long enough to refill way more than burst
        time.sleep(0.1)
        # Should still only get burst tokens
        allowed = sum(1 for _ in range(10) if bucket.consume())
        assert allowed == 5

    def test_rapid_consume_and_refill(self):
        bucket = _TokenBucket(rate=100, burst=5)
        # Drain
        for _ in range(5):
            bucket.consume()
        assert bucket.consume() is False
        # Wait 50ms → ~5 tokens at 100/s
        time.sleep(0.06)
        assert bucket.consume() is True


# ---------------------------------------------------------------------------
# Per-IP connection limiting (unit tests on RoomManager)
# ---------------------------------------------------------------------------
class TestIPConnectionLimits:
    """Tests for per-IP connection throttling in RoomManager."""

    def test_acquire_within_limit(self):
        mgr = RoomManager()
        for _ in range(MAX_CONNECTIONS_PER_IP):
            assert asyncio.run(mgr.acquire_ip("1.2.3.4")) is True

    def test_acquire_exceeds_limit(self):
        mgr = RoomManager()
        for _ in range(MAX_CONNECTIONS_PER_IP):
            asyncio.run(mgr.acquire_ip("1.2.3.4"))
        assert asyncio.run(mgr.acquire_ip("1.2.3.4")) is False

    def test_release_allows_reacquire(self):
        mgr = RoomManager()
        for _ in range(MAX_CONNECTIONS_PER_IP):
            asyncio.run(mgr.acquire_ip("1.2.3.4"))
        assert asyncio.run(mgr.acquire_ip("1.2.3.4")) is False
        asyncio.run(mgr.release_ip("1.2.3.4"))
        assert asyncio.run(mgr.acquire_ip("1.2.3.4")) is True

    def test_different_ips_independent(self):
        mgr = RoomManager()
        for _ in range(MAX_CONNECTIONS_PER_IP):
            asyncio.run(mgr.acquire_ip("1.1.1.1"))
        # Different IP should still work
        assert asyncio.run(mgr.acquire_ip("2.2.2.2")) is True

    def test_release_underflow_guard(self):
        """Releasing an IP with no active connections shouldn't crash."""
        mgr = RoomManager()
        # Should not raise
        asyncio.run(mgr.release_ip("9.9.9.9"))

    def test_release_cleans_up_zero_count(self):
        mgr = RoomManager()
        asyncio.run(mgr.acquire_ip("5.5.5.5"))
        asyncio.run(mgr.release_ip("5.5.5.5"))
        # Internal dict should have removed the entry
        assert "5.5.5.5" not in mgr._ip_connections


# ---------------------------------------------------------------------------
# Room creation stress test
# ---------------------------------------------------------------------------
class TestRoomStress:
    """Tests for rapid room creation/destruction."""

    def test_create_many_rooms(self):
        client = TestClient(app)
        codes = []
        for _ in range(10):
            resp = client.post("/api/rooms")
            assert resp.status_code == 200
            codes.append(resp.json()["room_code"])
        # All codes should be unique
        assert len(set(codes)) == 10

    def test_room_codes_are_valid_format(self):
        import re
        client = TestClient(app)
        pattern = re.compile(r"^[A-HJKL-NP-Z2-9]{6}$")
        for _ in range(5):
            resp = client.post("/api/rooms")
            code = resp.json()["room_code"]
            assert pattern.match(code), f"Invalid room code format: {code}"

    def test_check_nonexistent_room(self):
        client = TestClient(app)
        resp = client.get("/api/rooms/ZZZZZZ")
        data = resp.json()
        assert data["exists"] is False
        assert data["joinable"] is False

    def test_room_joinable_after_creation(self):
        client = TestClient(app)
        resp = client.post("/api/rooms")
        code = resp.json()["room_code"]
        check = client.get(f"/api/rooms/{code}")
        data = check.json()
        assert data["exists"] is True
        assert data["joinable"] is True
        assert "token" in data


# ---------------------------------------------------------------------------
# Message validation edge cases
# ---------------------------------------------------------------------------
class TestMessageValidation:
    """Tests for edge cases in message validation."""

    def test_oversized_message_dropped(self):
        """Messages exceeding MAX_MESSAGE_SIZE are dropped silently."""
        from backend.signaling import SignalingRoom
        room = SignalingRoom("test")
        # 70KB message should be rejected
        huge = json.dumps({"type": "offer", "data": "x" * 70000})
        assert room._validate(huge) is None

    def test_set_meta_accepted(self):
        from backend.signaling import SignalingRoom
        room = SignalingRoom("test")
        msg = json.dumps({"type": "set-meta", "name": "Alice"})
        result = room._validate(msg)
        assert result is not None
        assert result["type"] == "set-meta"

    def test_screen_sharing_accepted(self):
        from backend.signaling import SignalingRoom
        room = SignalingRoom("test")
        msg = json.dumps({"type": "screen-sharing", "active": True})
        result = room._validate(msg)
        assert result is not None

    def test_ping_pong_accepted(self):
        from backend.signaling import SignalingRoom
        room = SignalingRoom("test")
        assert room._validate(json.dumps({"type": "ping"})) is not None
        assert room._validate(json.dumps({"type": "pong"})) is not None
