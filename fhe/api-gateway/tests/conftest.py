"""Shared test fixtures.

db_session: an in-memory SQLite database with the gateway schema created (JSONB degrades to JSON via
the model's variant). Sufficient for model + service tests; the live-Postgres migration apply is a
separate deploy-time gate. fake_redis: an in-process fakeredis, injected in place of the real client.
"""
import fakeredis
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.repository.models import Base


@pytest.fixture
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    db = Session()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(engine)


@pytest.fixture
def fake_redis(monkeypatch):
    r = fakeredis.FakeStrictRedis(decode_responses=True)
    # Any module that calls get_redis() gets the fake during the test.
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: r)
    return r


@pytest.fixture(autouse=True)
def _no_generation_manifest(monkeypatch):
    """Policy tests exercise env-based configuration; the deployment's pinned manifest
    must not leak in from the container environment. Manifest tests opt in explicitly."""
    monkeypatch.delenv("GENERATION_MANIFEST_PATH", raising=False)
    monkeypatch.delenv("GENERATION_MANIFEST_SHA256", raising=False)
