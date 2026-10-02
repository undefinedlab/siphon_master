"""Keeper correctness. Two classes of failure matter and both are silent.

1. A hash that disagrees with the circuit mints commitments no proof can reproduce — funds deposited
   and permanently unwithdrawable. Guarded by pinned vectors and the nested-scheme test.
2. A response that carries `nullifier`/`secret` puts spendable material in the gateway's database,
   logs and backups, defeating the entire point of enclave custody.

Run:  python -m pytest test_keeper.py -q
"""
import hashlib
import json

import pytest

import app as keeper_app
import derive
import poseidon


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("KEEPER_MASTER_KEY", "dev-master")
    monkeypatch.setenv("SIPHON_ENV", "dev")
    keeper_app._master_cache.clear()
    keeper_app.AUTH_TOKEN = ""
    keeper_app.IS_PROD = False
    keeper_app.app.config["TESTING"] = True
    return keeper_app.app.test_client()


MASTER = hashlib.sha256(b"dev-master").digest()


# --- derivation -------------------------------------------------------------------------------

def test_derivation_is_deterministic():
    """The whole recoverability claim rests on this."""
    assert derive.note_secrets(MASTER, "a", 0) == derive.note_secrets(MASTER, "a", 0)


def test_accounts_and_indices_are_independent():
    n_a0, s_a0 = derive.note_secrets(MASTER, "a", 0)
    n_a1, _ = derive.note_secrets(MASTER, "a", 1)
    n_b0, _ = derive.note_secrets(MASTER, "b", 0)
    assert len({n_a0, n_a1, n_b0}) == 3
    assert n_a0 != s_a0  # domain separation between the two fields of one note


def test_derived_values_are_valid_field_elements():
    for i in range(25):
        n, s = derive.note_secrets(MASTER, "acct", i)
        assert 0 < n < derive.FIELD_SIZE
        assert 0 < s < derive.FIELD_SIZE


def test_different_master_yields_different_notes():
    other = hashlib.sha256(b"other-master").digest()
    assert derive.note_secrets(MASTER, "a", 0) != derive.note_secrets(other, "a", 0)


def test_fingerprint_is_stable_and_account_scoped():
    assert derive.account_fingerprint(MASTER, "a") == derive.account_fingerprint(MASTER, "a")
    assert derive.account_fingerprint(MASTER, "a") != derive.account_fingerprint(MASTER, "b")


# --- hashing ----------------------------------------------------------------------------------

def test_poseidon_matches_pinned_vectors():
    poseidon.self_test()


def test_nullifier_hash_is_arity_one():
    """withdrawal.circom:83 uses Poseidon(1). Hashing with arity 2 would produce a nullifierHash
    the circuit rejects, making the note unspendable."""
    assert poseidon.nullifier_hash(1) == poseidon.poseidon([1])
    assert poseidon.nullifier_hash(1) != poseidon.poseidon2(1, 0)


def test_commitment_is_the_nested_scheme():
    """commitment = Poseidon(Poseidon(amount, label), precommitment) — commitment.circom."""
    amount, label, pre = 500, 42, 99
    assert poseidon.commitment_hash(amount, label, pre) == poseidon.poseidon2(
        poseidon.poseidon2(amount, label), pre
    )
    # A flat Poseidon(amount, label, precommitment) is a DIFFERENT value — guard the mistake.
    assert poseidon.commitment_hash(amount, label, pre) != poseidon.poseidon([amount, label, pre])


# --- the secret boundary ----------------------------------------------------------------------

def test_allocate_never_returns_secret_material(client):
    r = client.post("/notes/allocate", json={
        "account_ref": "acct-1", "index": 0, "amount": 1000, "scope": 1234, "nonce": 1})
    assert r.status_code == 200
    body = json.dumps(r.get_json())
    assert "nullifier_hash" in r.get_json()
    for banned in ("secret", '"nullifier"'):
        assert banned not in body, f"keeper leaked {banned}"


def test_public_filter_rejects_secret_fields():
    """The enforcement point itself — a future edit that adds a secret field must raise."""
    with pytest.raises(RuntimeError):
        keeper_app._public({"precommitment": "1", "nullifier": "2"})


def test_reconstruct_never_returns_secret_material(client):
    r = client.post("/notes/reconstruct", json={"account_ref": "acct-1", "start": 0, "count": 3})
    assert r.status_code == 200
    body = json.dumps(r.get_json())
    assert "secret" not in body and '"nullifier"' not in body
    assert len(r.get_json()["notes"]) == 3


# --- API behaviour ----------------------------------------------------------------------------

def test_allocate_is_idempotent(client):
    payload = {"account_ref": "acct-1", "index": 4, "amount": 777, "scope": 9, "nonce": 2}
    a = client.post("/notes/allocate", json=payload).get_json()
    b = client.post("/notes/allocate", json=payload).get_json()
    assert a == b, "a retried deposit must not mint a divergent note"


def test_reconstruct_matches_allocate(client):
    """Disaster recovery must reproduce exactly what allocation produced."""
    alloc = client.post("/notes/allocate", json={
        "account_ref": "acct-9", "index": 2, "amount": 55, "label": 7}).get_json()
    rec = client.post("/notes/reconstruct", json={
        "account_ref": "acct-9", "start": 2, "count": 1, "amount": 55, "label": 7}).get_json()
    note = rec["notes"][0]
    assert note["precommitment"] == alloc["precommitment"]
    assert note["commitment"] == alloc["commitment"]
    assert note["nullifier_hash"] == alloc["nullifier_hash"]


def test_allocate_rejects_bad_input(client):
    assert client.post("/notes/allocate", json={"index": 0, "amount": 1}).status_code == 400
    assert client.post("/notes/allocate", json={
        "account_ref": "a", "index": 0, "amount": 0, "label": 1}).status_code == 400
    assert client.post("/notes/allocate", json={
        "account_ref": "a", "index": 0, "amount": 10}).status_code == 400  # no label/scope+nonce


def test_env_master_key_refused_in_production(monkeypatch):
    monkeypatch.setenv("KEEPER_MASTER_KEY", "x")
    keeper_app._master_cache.clear()
    monkeypatch.setattr(keeper_app, "IS_PROD", True)
    with pytest.raises(RuntimeError, match="production"):
        keeper_app._master()
    keeper_app._master_cache.clear()


# --- master key continuity (the catastrophic-and-silent failure) ------------------------------

def _reset():
    keeper_app._master_cache.clear()
    keeper_app._master_source.clear()


def test_imported_secret_is_preferred_over_kms(monkeypatch):
    """The imported secret survives an app_id change; a KMS-derived key does not."""
    _reset()
    secret = "0x" + "ab" * 32
    monkeypatch.setenv("KEEPER_MASTER_SECRET", secret)
    monkeypatch.setenv("KEEPER_MASTER_KEY", "dev-master")  # lower precedence
    monkeypatch.setattr(keeper_app, "IS_PROD", False)

    master, source = keeper_app._load_master()
    assert source == "imported-cvm-secret"
    assert master == bytes.fromhex("ab" * 32)
    _reset()


def test_imported_secret_requires_attested_tee_in_production(monkeypatch):
    """Outside a TEE an 'encrypted CVM secret' is just a plaintext env var on the host."""
    _reset()
    monkeypatch.setenv("KEEPER_MASTER_SECRET", "0x" + "cd" * 32)
    monkeypatch.setattr(keeper_app, "IS_PROD", True)
    monkeypatch.setattr(keeper_app, "_in_tee", lambda: (False, "no dstack socket"))

    with pytest.raises(RuntimeError, match="cannot attest"):
        keeper_app._load_master()

    monkeypatch.setattr(keeper_app, "_in_tee", lambda: (True, "attested"))
    _master, source = keeper_app._load_master()
    assert source == "imported-cvm-secret"
    _reset()


def test_malformed_or_short_secret_rejected(monkeypatch):
    _reset()
    monkeypatch.setattr(keeper_app, "IS_PROD", False)

    monkeypatch.setenv("KEEPER_MASTER_SECRET", "not-hex!!")
    with pytest.raises(RuntimeError, match="hex"):
        keeper_app._load_master()

    monkeypatch.setenv("KEEPER_MASTER_SECRET", "0x" + "ab" * 16)  # 16 bytes
    with pytest.raises(RuntimeError, match="at least 32"):
        keeper_app._load_master()
    _reset()


def test_fingerprint_mismatch_refuses_to_start(monkeypatch):
    """The whole point: a changed master must be a LOUD startup failure, not silent bad notes."""
    _reset()
    master = bytes.fromhex("11" * 32)
    monkeypatch.setenv("KEEPER_EXPECTED_MASTER_FINGERPRINT", "0" * 32)

    with pytest.raises(RuntimeError, match="CONTINUITY FAILURE"):
        keeper_app._assert_continuity(master, "imported-cvm-secret")

    # Matching fingerprint passes.
    monkeypatch.setenv(
        "KEEPER_EXPECTED_MASTER_FINGERPRINT", keeper_app.master_fingerprint(master)
    )
    keeper_app._assert_continuity(master, "imported-cvm-secret")
    _reset()


def test_fingerprint_is_stable_and_key_specific():
    a, b = bytes.fromhex("11" * 32), bytes.fromhex("22" * 32)
    assert keeper_app.master_fingerprint(a) == keeper_app.master_fingerprint(a)
    assert keeper_app.master_fingerprint(a) != keeper_app.master_fingerprint(b)


def test_generate_master_fingerprint_matches_the_service():
    """The generator prints the value you pin — a mismatch would brick every deploy."""
    import generate_master

    master = bytes.fromhex("7f" * 32)
    assert generate_master.master_fingerprint(master) == keeper_app.master_fingerprint(master)


def test_app_id_change_with_kms_master_is_fatal(monkeypatch):
    """KMS keys are app_id-bound, so this combination means every note is already underivable."""
    _reset()
    monkeypatch.delenv("KEEPER_EXPECTED_MASTER_FINGERPRINT", raising=False)
    monkeypatch.setenv("KEEPER_EXPECTED_APP_ID", "app-old")
    monkeypatch.setattr(keeper_app, "_app_id", lambda: "app-new")

    with pytest.raises(RuntimeError, match="app_id changed"):
        keeper_app._assert_continuity(b"x" * 32, "kms-app-id-bound")

    # Imported master survives an app_id change — warn, do not fail.
    keeper_app._assert_continuity(b"x" * 32, "imported-cvm-secret")
    _reset()


def test_auth_denies_by_default_in_production(monkeypatch, client):
    """An empty token must never mean 'open' — a misconfigured deploy would expose derivation."""
    monkeypatch.setattr(keeper_app, "AUTH_TOKEN", "")
    monkeypatch.setattr(keeper_app, "IS_PROD", True)
    assert client.post("/notes/allocate", json={"account_ref": "a"}).status_code == 401


# --- the master secret must not leak through stdout ---------------------------------------------

def test_generator_never_prints_the_secret(tmp_path, capsys):
    """Regression guard. An earlier version printed the key AND a ready-to-paste
    `phala cvms env set … KEEPER_MASTER_SECRET=0x…`, which leaks it into shell history, argv (visible
    in `ps`), terminal scrollback and CI logs — for the one key that can never be rotated without
    stranding every note derived from it."""
    import re
    import generate_master

    out = tmp_path / "m.secret"
    generate_master.main.__globals__["argparse"]  # keep the import honest
    import sys
    argv = sys.argv
    sys.argv = ["generate_master.py", "--out", str(out)]
    try:
        assert generate_master.main() == 0
    finally:
        sys.argv = argv

    printed = capsys.readouterr().out
    assert not re.search(r"0x[0-9a-f]{64}", printed), "generator printed the master secret"
    assert "KEEPER_MASTER_SECRET=0x" not in printed

    # ...but it did write it, at 0600, and the fingerprint it printed matches the file.
    import stat as _stat
    assert _stat.S_IMODE(out.stat().st_mode) == 0o600
    master = bytes.fromhex(out.read_text().strip().removeprefix("0x"))
    assert generate_master.master_fingerprint(master) in printed


def test_generator_refuses_to_overwrite(tmp_path):
    """Overwriting a master already in use would strand every note derived from it."""
    import sys
    import generate_master

    out = tmp_path / "m.secret"
    out.write_text("0x" + "11" * 32)
    argv = sys.argv
    sys.argv = ["generate_master.py", "--out", str(out)]
    try:
        assert generate_master.main() == 1
    finally:
        sys.argv = argv
    assert out.read_text() == "0x" + "11" * 32  # untouched
