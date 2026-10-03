"""Session bootstrap — force sqlite for unit tests unless overridden."""
from __future__ import annotations

import json
import os

# Must run before other aspv2 imports in collection.
os.environ.setdefault("ASP_DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("ASP_REQUIRE_SEEDED_LISTS", "0")
os.environ.setdefault("ASP_REQUIRE_AUTH", "0")
os.environ.setdefault("ASP_ENV", "development")
os.environ.setdefault("ASP_SCREEN_TOKEN", "test-screen-token")
os.environ.setdefault("ASP_PENDING_SALT_KEY", "test-pending-salt-key")

import config

FIXTURES = config.ZKV2_FIXTURES


import pytest


@pytest.fixture(scope="session")
def poseidon_ready():
    from core.poseidon import hash2

    hash2(0, 0)


def load_json(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())
