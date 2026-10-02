import os
import sys

# Tests import trade-executor modules directly (flat module layout, no package).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


import pytest


@pytest.fixture(autouse=True)
def _no_generation_manifest(monkeypatch):
    """Policy tests exercise env-based configuration; the deployment's pinned manifest
    must not leak in from the container environment. Manifest tests opt in explicitly."""
    monkeypatch.delenv("GENERATION_MANIFEST_PATH", raising=False)
    monkeypatch.delenv("GENERATION_MANIFEST_SHA256", raising=False)
