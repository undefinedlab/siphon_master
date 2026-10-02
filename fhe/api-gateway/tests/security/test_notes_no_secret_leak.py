"""GET /v1/notes must never serialize note secrets — ciphertext, iv, or any decrypted material."""
from app.schemas.notes import NoteView
from app.services import note_service


class _FakeNote:
    wallet = "0xaaa"
    commitment = "0xc1"
    nullifier_hash = "0xn1"
    chain_id = 8453
    asset = "ETH"
    spent = "false"
    ciphertext = "TOP_SECRET_CIPHERTEXT"
    iv = "TOP_SECRET_IV"


def test_noteview_schema_has_no_secret_fields():
    fields = set(NoteView.model_fields.keys())
    assert "ciphertext" not in fields
    assert "iv" not in fields
    assert fields == {"commitment", "nullifier_hash", "chain_id", "asset", "spent"}


def test_service_output_omits_secrets(monkeypatch):
    monkeypatch.setattr(note_service, "_fetch_notes", lambda wallet: [_FakeNote()])
    out = note_service.list_notes("0xaaa")
    blob = str(out)
    assert "TOP_SECRET_CIPHERTEXT" not in blob
    assert "TOP_SECRET_IV" not in blob
    assert out["notes"][0]["commitment"] == "0xc1"
