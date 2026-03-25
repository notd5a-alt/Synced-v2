import pytest
from httpx import AsyncClient, ASGITransport

from backend.main import app
from backend.signaling import SignalingRoom, room


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
def reset_room():
    """Reset the global room between tests."""
    room._peers.clear()
    yield
    room._peers.clear()


@pytest.fixture
def fresh_room():
    return SignalingRoom()
