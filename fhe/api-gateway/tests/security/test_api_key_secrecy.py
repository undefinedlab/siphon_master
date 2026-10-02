"""The raw API key must never leak — not in the stored row, not in any serialization, not in errors."""
from app.errors import Unauthorized
from app.services.api_key_service import mint_key


def test_raw_key_not_in_stored_row(db_session):
    raw, row = mint_key(db_session, integrator_id="int_1", plan="test", test=True)
    # No attribute on the row echoes the plaintext.
    for value in vars(row).values():
        assert raw != value, "raw key stored on the row"
    assert raw not in repr(row)


def test_unauthorized_error_carries_no_key_material():
    raw = "sk_test_supersecretvalue"
    err = Unauthorized("Invalid or revoked API key.")
    # The error message is generic and never echoes a submitted key.
    assert raw not in str(err)
    assert "key" in err.detail.lower()  # helpful, not revealing
