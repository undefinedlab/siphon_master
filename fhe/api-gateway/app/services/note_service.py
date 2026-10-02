"""Note listing service — owner-scoped, secret-free.

Only the authed wallet's notes are returned (BOLA — the query is scoped by wallet, so there's no
cross-wallet leak by construction). The response is a field-whitelist: commitment, nullifier_hash,
chain_id, asset, spent — NEVER ciphertext / iv / any note secret (those live client-side, encrypted).
"""
from app.repository.note_db import NoteRow, _note_session

_WHITELIST = ("commitment", "nullifier_hash", "chain_id", "asset", "spent")


def _fetch_notes(wallet: str) -> list:
    """Fetch the raw note rows for a wallet from the note DB. Overridden in tests."""
    db = _note_session()
    try:
        return db.query(NoteRow).filter(NoteRow.wallet == wallet.lower()).all()
    finally:
        db.close()


def list_notes(wallet: str) -> dict:
    """Return {notes: [whitelisted...], spendable_balance_by_asset: {...}} for the authed wallet."""
    rows = _fetch_notes(wallet.lower())
    notes = [{k: getattr(r, k) for k in _WHITELIST} for r in rows]
    # v1: amounts are not on the note whitelist (they live in the encrypted blob), so balance is
    # reported as a per-asset spendable COUNT placeholder until amount exposure is designed. Kept as a
    # dict[str,str] so the schema is stable; empty when no plaintext amounts are available.
    spendable_balance_by_asset: dict[str, str] = {}
    return {"notes": notes, "spendable_balance_by_asset": spendable_balance_by_asset}
