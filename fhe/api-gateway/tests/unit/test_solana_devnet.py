"""Solana Devnet lane: deployment pins, the deposit transaction, spend validation, ed25519 auth."""
import base64
import hashlib

import base58
import fakeredis
import pytest
from solders.keypair import Keypair
from solders.transaction import Transaction

from app.deps.wallet_sig import canonical_intent_message, check_wallet_intent, check_wallet_sig
from app.errors import BadRequest, Conflict, Unauthorized
from app.services import solana_devnet as sd

WALLET_KP = Keypair()
WALLET = str(WALLET_KP.pubkey())


def test_pdas_match_the_deployment_record():
    # siphon-contracts-v2 solana/DEVNET-DEPLOYMENT.md
    assert str(sd.vault_pda()) == "9ndUc4FN7djmULrsJxKiVhcaxfQciXBRQcFJc9rWQb9G"
    assert str(sd.tree_pda()) == "7c6F4mNgQRSNmit6feAgJLx1HFojNQTnEDiSoc2dEoxn"
    assert str(sd.compliance_pda()) == "42r85DiU5wV1PM2oYy9gt85Z6S8fcihYp1bWvL3xH4cT"


def test_asset_id_is_the_mint_big_endian_mod_p():
    assert sd.asset_id(sd.WSOL) == int.from_bytes(bytes(sd.WSOL), "big") % sd.FIELD
    assert sd.mint_for("sol") == (sd.WSOL, True)
    assert sd.mint_for("USDC") == (sd.usdc_mint(), False)
    with pytest.raises(BadRequest):
        sd.mint_for("ETH")


class FakeRpc:
    def __init__(self, sim_err=None, tx=None):
        self.sim_err, self.tx, self.calls = sim_err, tx, []

    def __call__(self, method, params):
        self.calls.append(method)
        if method == "getLatestBlockhash":
            return {"value": {"blockhash": "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", "lastValidBlockHeight": 77}}
        if method == "simulateTransaction":
            return {"value": {"err": self.sim_err, "logs": ["Program log: Error: InvalidCommitment"] if self.sim_err else []}}
        if method == "getTransaction":
            return self.tx
        raise AssertionError(method)


def test_sol_deposit_wraps_then_deposits_with_the_program_layout(monkeypatch):
    rpc = FakeRpc()
    monkeypatch.setattr(sd, "rpc", rpc)
    plan = sd.deposit_plan(asset="SOL", amount_minor=10_000_000, wallet=WALLET,
                           precommitment="5", user_salt="7", commitment="11")
    tx = Transaction.from_bytes(base64.b64decode(plan["transaction"]))
    keys = tx.message.account_keys
    assert keys[0] == WALLET_KP.pubkey()  # fee payer = the account wallet
    programs = [keys[ix.program_id_index] for ix in tx.message.instructions]
    assert programs == [sd.ATA_PROGRAM, sd.SYSTEM_PROGRAM, sd.TOKEN_PROGRAM, sd.program_id()]
    deposit = tx.message.instructions[-1]
    data = bytes(deposit.data)
    assert data[:8] == hashlib.sha256(b"global:deposit").digest()[:8]
    assert int.from_bytes(data[8:16], "little") == 10_000_000
    assert [sd.from_le(data[o:o + 32]) for o in (16, 48, 80)] == [7, 5, 11]  # salt, pre, commitment
    accounts = [keys[i] for i in deposit.accounts]
    assert accounts[:4] == [WALLET_KP.pubkey(), sd.vault_pda(), sd.tree_pda(), sd.WSOL]
    assert accounts[6] == sd.pda(b"siphon-leaf-v1", sd.le32(11))
    assert plan["deposit_data_sha256"] == hashlib.sha256(data).hexdigest()
    assert rpc.calls == ["getLatestBlockhash", "simulateTransaction"]


def test_a_deposit_the_program_would_reject_never_reaches_the_wallet(monkeypatch):
    monkeypatch.setattr(sd, "rpc", FakeRpc(sim_err={"InstructionError": [0, {"Custom": 6004}]}))
    with pytest.raises(Conflict, match="InvalidCommitment"):
        sd.deposit_plan(asset="USDC", amount_minor=1, wallet=WALLET, precommitment="5", user_salt="7", commitment="12")
    with pytest.raises(BadRequest):
        sd.deposit_plan(asset="USDC", amount_minor=1, wallet=WALLET, precommitment="5", user_salt="0", commitment="1")


def test_a_submitted_deposit_must_be_the_planned_instruction_from_the_wallet(monkeypatch):
    data = b"planned-deposit"
    good = {"transaction": {"message": {
        "accountKeys": [WALLET, str(sd.program_id())],
        "instructions": [{"programIdIndex": 1, "data": base58.b58encode(data).decode()}]}}}
    sig = base58.b58encode(bytes(range(64))).decode()
    monkeypatch.setattr(sd, "rpc", FakeRpc(tx=good))
    sd.validate_submitted_deposit(sig, wallet=WALLET, expected_data_sha256=hashlib.sha256(data).hexdigest())
    with pytest.raises(Conflict):
        sd.validate_submitted_deposit(sig, wallet=WALLET, expected_data_sha256="00" * 32)
    with pytest.raises(Conflict):
        sd.validate_submitted_deposit(sig, wallet=str(Keypair().pubkey()),
                                      expected_data_sha256=hashlib.sha256(data).hexdigest())
    with pytest.raises(BadRequest):
        sd.validate_submitted_deposit("0xabc", wallet=WALLET, expected_data_sha256="00")


def _publics(action=0, count=1, amount=500, asset=None):
    p = ["0"] * 25
    p[0], p[1], p[5], p[16] = str(action), str(count), str(amount), "5"
    p[9] = "12345"
    p[17] = str(asset if asset is not None else sd.asset_id(sd.usdc_mint()))
    return p


def test_withdraw_package_binds_amount_asset_and_derives_nullifiers():
    pkg = sd.spend_package({"public_inputs": _publics(), "proof_hex": "ab" * 256, "circuit_index": 0},
                           asset="USDC", amount_minor=500)
    assert pkg["nullifiers_hex"] == [sd.le32(12345).hex()]
    assert pkg["mint"] == str(sd.usdc_mint()) and len(bytes.fromhex(pkg["binder_hex"])) == 32
    for bad in (
        dict(amount_minor=501),                                    # policy approved a different amount
        dict(asset="SOL"),                                         # different asset
    ):
        with pytest.raises(BadRequest):
            sd.spend_package({"public_inputs": _publics(), "proof_hex": "ab" * 256, "circuit_index": 0},
                             **{"asset": "USDC", "amount_minor": 500, **bad})
    with pytest.raises(BadRequest):  # withdraw2 proof under the withdraw1 verifier
        sd.spend_package({"public_inputs": _publics(count=2), "proof_hex": "ab" * 256, "circuit_index": 0},
                         asset="USDC", amount_minor=500)
    with pytest.raises(BadRequest):  # a split is not a payout
        sd.spend_package({"public_inputs": _publics(action=3), "proof_hex": "ab" * 256, "circuit_index": 0},
                         asset="USDC", amount_minor=500)


def test_split_package_takes_eight_slices():
    pkg = sd.spend_package({"public_inputs": _publics(action=3, amount=0), "proof_hex": "cd" * 256, "circuit_index": 12},
                           split_commitments=["1", "2"] + ["0"] * 6)
    assert pkg["split_commitments_hex"][0] == sd.le32(1).hex() and "mint" not in pkg
    with pytest.raises(BadRequest):
        sd.spend_package({"public_inputs": _publics(action=0), "proof_hex": "cd" * 256, "circuit_index": 12},
                         split_commitments=["0"] * 8)


def _sign(kp: Keypair, message: str) -> str:
    return base64.b64encode(bytes(kp.sign_message(message.encode()))).decode()


def test_solana_wallet_signs_the_v2_intent_with_ed25519():
    import time

    r = fakeredis.FakeStrictRedis(decode_responses=True)
    ts = str(int(time.time()))
    body = {"chain_id": 900002, "x": [1, {"b": 2, "a": 1}]}
    msg = canonical_intent_message(chain_id=900002, timestamp=ts, nonce="n1", method="POST", path="/v1/p", body=body)
    common = dict(timestamp=ts, chain_id=900002, method="POST", path="/v1/p", body=body)
    assert check_wallet_intent(r, wallet=WALLET, signature=_sign(WALLET_KP, msg), nonce="n1", **common) == WALLET
    with pytest.raises(Unauthorized):  # another key cannot speak for this wallet
        check_wallet_intent(r, wallet=WALLET, signature=_sign(Keypair(), msg), nonce="n2", **common)
    with pytest.raises(Unauthorized):  # base58 is case-sensitive: a lowercased address is another key
        check_wallet_intent(r, wallet=WALLET.lower(), signature=_sign(WALLET_KP, msg), nonce="n3", **common)


def test_solana_wallet_signs_the_v1_read_message():
    import time

    r = fakeredis.FakeStrictRedis(decode_responses=True)
    ts = str(int(time.time()))
    sig = _sign(WALLET_KP, f"Siphon API v1:900002:{ts}")
    assert check_wallet_sig(r, wallet=WALLET, signature=sig, timestamp=ts, chain_id=900002) == WALLET


@pytest.mark.asyncio
async def test_path_chain_reads_verify_a_real_signature(monkeypatch):
    """The witness/label routes carry the chain in the PATH; the read signature must bind it."""
    import time

    from fastapi import Request
    from httpx import ASGITransport, AsyncClient

    from app.deps.api_key import verify_api_key
    from app.main import create_app

    redis = fakeredis.FakeStrictRedis(decode_responses=True)
    monkeypatch.setattr("app.deps.rate_limit.get_redis", lambda: redis)
    monkeypatch.setattr("app.repository.redis_client.get_redis", lambda: redis)

    class Asp:
        def set_read(self, what, params, caller=None):
            return {"admitted": True, "revoked": False}

    monkeypatch.setattr("app.routers.v5.asp", lambda _c: Asp())

    def key(request: Request):
        request.state.api_key_id, request.state.sandbox, request.state.devnet_only = "k", False, False
        return object()

    app = create_app(start_reconciler=False)
    app.dependency_overrides[verify_api_key] = key
    ts = str(int(time.time()))
    headers = {"X-Wallet-Address": WALLET, "X-Timestamp": ts, "X-Nonce": "n1",
               "X-Signature": _sign(WALLET_KP, f"Siphon API v1:900002:{ts}:n1")}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        ok = await c.get("/v1/chains/900002/compliance/labels/42", headers=headers)
        other = await c.get("/v1/chains/900002/compliance/labels/42", headers={**headers, "X-Nonce": "n2",
            "X-Signature": _sign(WALLET_KP, f"Siphon API v1:8453:{ts}:n2")})
    assert ok.status_code == 200, ok.text
    assert other.status_code == 401  # signed for another chain
