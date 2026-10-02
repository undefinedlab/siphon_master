"""hasClientKey must carry the decryptor token, or the decryptor answers has_key=false for everyone."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import decryptor_client as D


class _Resp:
    ok = True

    def json(self):
        return {"has_key": True}


def test_has_client_key_sends_the_decryptor_token(monkeypatch):
    seen = {}
    monkeypatch.setattr(D, "DECRYPTOR_URL", "http://decryptor:5002")
    monkeypatch.setattr(D, "DECRYPTOR_AUTH_TOKEN", "tok")
    monkeypatch.setattr(D.requests, "get", lambda url, **kw: seen.update(url=url, **kw) or _Resp())
    pk = "8swKxeR65G3iT5ReeMV8DYYLtd6TmuAJ81FzrLWxJ2r9"
    assert D.has_client_key(pk) is True
    assert seen["headers"] == {"X-Decryptor-Token": "tok"}
    # Solana base58 is case-sensitive — must not fold the path segment.
    assert seen["url"].endswith(f"/hasClientKey/{pk}")
