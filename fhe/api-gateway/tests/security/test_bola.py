"""Object-level authorization (OWASP API1 BOLA) — the top risk for this API.

require_owner returns 404 (never 403) on an ownership mismatch, so a caller can't even confirm the
object exists. Enforced in the service layer.
"""
import pytest

from app.deps.authz import require_owner
from app.errors import NotFound


def test_matching_owner_passes():
    require_owner("0xAbCdEf0000000000000000000000000000000001",
                  "0xabcdef0000000000000000000000000000000001")  # case-insensitive


def test_wrong_owner_raises_not_found():
    with pytest.raises(NotFound):
        require_owner("0xAAA0000000000000000000000000000000000001",
                      "0xBBB0000000000000000000000000000000000002")


def test_missing_owner_raises_not_found():
    with pytest.raises(NotFound):
        require_owner(None, "0xabc0000000000000000000000000000000000001")
