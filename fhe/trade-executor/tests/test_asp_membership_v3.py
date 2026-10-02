"""A v3 chain screens its labels against the v2 ASP, not the v1 one.

The v1 and v2 ASPs are separate services with separate databases, so asking the v1 ASP about a
label minted by the v3 admit bus answers "not a member" for every label that has ever existed —
which reached the dapp as a blanket 403 "ASP label rejected" on every v3 arm.
"""
import asp_membership

V3_CHAIN = 11155111
V1_CHAIN = 8453
LABEL = "7581607540310496181811092806820121719083236977231033336979363785211239096477"


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def json(self):
        return self._payload


def _capture(monkeypatch, payload, status=200):
    """Record where the membership check actually went."""
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen["url"] = url
        seen["params"] = params
        seen["auth"] = (headers or {}).get("Authorization")
        return _Resp(payload, status)

    monkeypatch.setattr(asp_membership.requests, "get", fake_get)
    return seen


def _v3_env(monkeypatch):
    monkeypatch.setenv("ASP_V2_URL", "http://aspv2:5056")
    monkeypatch.setenv("ASP_V2_SCREEN_TOKEN", "v2-screen-token")
    monkeypatch.setattr(asp_membership, "_is_v3_chain", lambda chain_id: chain_id == V3_CHAIN)


def test_v3_label_is_screened_against_the_v2_asp(monkeypatch):
    _v3_env(monkeypatch)
    seen = _capture(monkeypatch, {"admitted": True, "revoked": False, "member": True})

    ok, reason = asp_membership.assert_label_in_asp(LABEL, chain_id=V3_CHAIN)

    assert ok, reason
    assert seen["url"] == "http://aspv2:5056/set/member"
    assert seen["params"] == {"label": LABEL}
    assert seen["auth"] == "Bearer v2-screen-token"


def test_v3_revoked_label_is_rejected_even_when_admitted(monkeypatch):
    """`member` mirrors `admitted` in the v2 ASP, so revocation has to be read on its own."""
    _v3_env(monkeypatch)
    _capture(monkeypatch, {"admitted": True, "revoked": True, "member": True})

    ok, reason = asp_membership.assert_label_in_asp(LABEL, chain_id=V3_CHAIN)

    assert not ok
    assert "revoked" in reason


def test_v3_label_not_yet_admitted_is_rejected(monkeypatch):
    _v3_env(monkeypatch)
    _capture(monkeypatch, {"admitted": False, "revoked": False, "member": False})

    ok, reason = asp_membership.assert_label_in_asp(LABEL, chain_id=V3_CHAIN)

    assert not ok
    assert "admit bus" in reason


def test_v3_fails_closed_when_the_v2_asp_is_unconfigured(monkeypatch):
    monkeypatch.delenv("ASP_V2_URL", raising=False)
    monkeypatch.setattr(asp_membership, "_is_v3_chain", lambda chain_id: chain_id == V3_CHAIN)
    monkeypatch.setattr(asp_membership, "_FAIL_CLOSED", True)

    ok, reason = asp_membership.assert_label_in_asp(LABEL, chain_id=V3_CHAIN)

    assert not ok
    assert "ASP_V2_URL" in reason


def test_v1_chain_still_screens_against_the_v1_asp(monkeypatch):
    """The v3 branch must not capture chains that have no VaultKernel."""
    monkeypatch.setattr(asp_membership, "_is_v3_chain", lambda chain_id: chain_id == V3_CHAIN)
    monkeypatch.setattr(asp_membership, "_ASP_URL", "http://asp:5055")
    monkeypatch.setattr(asp_membership, "_REQUIRE_ONCHAIN_ROOT", False)
    seen = _capture(monkeypatch, {"member": True})

    ok, reason = asp_membership.assert_label_in_asp(LABEL, chain_id=V1_CHAIN)

    assert ok, reason
    assert seen["url"] == "http://asp:5055/set/member"
