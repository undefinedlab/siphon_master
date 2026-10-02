"""_is_key_mismatch must fire ONLY on the decryptor's stale-generation error, so a stranded
strategy gets quarantined (funds returned) while transient/other decryptor errors keep retrying."""
from scheduler import _is_key_mismatch


def test_matches_decryptor_mismatch_error():
    # Exact string the decryptor returns on value>1 (decryptor/src/main.rs).
    assert _is_key_mismatch("client key mismatch (non-boolean result); re-upload the current client key")


def test_ignores_transient_and_absent_errors():
    for err in (
        None, "", "HTTP 502", "no client key for user (upload it after attestation)",
        "DECRYPTOR_URL not configured", "missing triggered field",
    ):
        assert not _is_key_mismatch(err), err
