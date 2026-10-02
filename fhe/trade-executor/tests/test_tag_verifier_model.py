"""TagVerifier must be importable from note_db.

wallet_auth does `from note_db import NoteSession, TagVerifier` in four places, but the model was
never declared on Base. The import therefore raised ImportError at call time, which meant:

  * POST /auth/tag-bind answered 500 — "bind failed: cannot import name 'TagVerifier' from
    'note_db'" — for every caller, in production;
  * _lookup_tag_verifier swallowed the same ImportError in its bare `except` and returned None, so
    tag auth silently degraded instead of failing loudly.

A plain import test is the regression guard: nothing else in the suite imports the model, so
deleting it again would go unnoticed until a user hit connect.
"""
import os
import tempfile

import pytest


@pytest.fixture()
def note_db(monkeypatch):
    """note_db reads NOTE_DB_URI at import time and raises without it, so point it at a temp
    sqlite file and import fresh."""
    tmp = os.path.join(tempfile.mkdtemp(), "notes.db")
    monkeypatch.setenv("NOTE_DB_URI", f"sqlite:///{tmp}")
    import importlib

    mod = importlib.import_module("note_db")
    mod = importlib.reload(mod)
    mod.init_note_db()
    return mod


def test_tag_verifier_is_importable_from_note_db(note_db):
    # The exact import wallet_auth performs. This is the whole bug.
    from note_db import TagVerifier  # noqa: F401

    assert hasattr(note_db, "TagVerifier")
    assert note_db.TagVerifier.__tablename__ == "tag_verifiers"


def test_bind_round_trips_and_first_bind_wins(note_db):
    tag, token_hash, other = "0xabc123", "a" * 64, "b" * 64

    session = note_db.NoteSession()
    session.add(note_db.TagVerifier(tag=tag, token_hash=token_hash))
    session.commit()

    row = session.query(note_db.TagVerifier).filter_by(tag=tag).first()
    assert row is not None, "lookup returned None — the silent-swallow failure mode"
    assert row.token_hash == token_hash

    # tag is the primary key, so a second bind cannot quietly add a competing row. The
    # handler's 409 depends on there being exactly one row to compare against.
    assert session.query(note_db.TagVerifier).filter_by(tag=tag).count() == 1
    assert row.token_hash != other

    # An unbound tag reads as absent rather than raising.
    assert session.query(note_db.TagVerifier).filter_by(tag="0xunbound").first() is None
