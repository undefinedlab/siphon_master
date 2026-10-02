"""Withdraw-to-any-chain (bridge_payout + /bridgeWithdraw).

The money rule under test: the executor only ever moves, to the destination or back to the user,
the amount its OWN relayed spend paid in — never its float, never a caller-named amount.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta

import base58
import pytest

from test_fhe_key_blob import _install_note_db_stub, _write_headers  # noqa: F401  (fixture helpers)

EXEC = "0x5830A431E6866B8F8a605625b0713D8190FB06bA"
USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"
USER = "0x57fBC5C7e1A40134eC3cE2fe06EBD26d9C7267A2"
SOL_ADDR = "8xueCcQRMhKo5CtppfmxXar2LuVaHfiiN3VzhxepqNEg"
ZEC_T1 = base58.b58encode_check(b"\x1c\xb8" + b"\x11" * 20).decode()


@pytest.fixture(scope="module")
def A():
    os.environ.setdefault("DATABASE_URI", "sqlite://")
    os.environ.setdefault("API_TOKEN", "test-token")
    os.environ.setdefault("ENFORCE_WRITE_CHALLENGE", "1")
    os.environ.setdefault("DB_ALLOW_DEFAULT_KEY", "1")  # in-memory sqlite only
    os.environ.setdefault("NOTE_DB_URI", "postgresql://stub/notes")  # note_db is stubbed below
    os.environ.setdefault("SERVER_HMAC_SECRET", "test-only")
    _install_note_db_stub()
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import app as A

    A.app.config["TESTING"] = True
    A.app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite://"
    return A


@pytest.fixture
def ctx(A):
    with A.app.app_context():
        A.db.drop_all()
        A.db.create_all()
        yield A


import bridge_payout as bp  # noqa: E402  (after sys.path is set by conftest)


# ── order validation ───────────────────────────────────────────────────────────────────────────

def _order(**over):
    o = {"to_chain_id": 1, "to_address": USER, "amount": "5000000", "min_out": "4900000",
         "refund_address": USER}
    o.update(over)
    return o


@pytest.mark.parametrize("chain,addr", [
    (1, USER), (1337, USER), (4217, USER), (999, USER), (42161, USER),
    (bp.SOLANA_LIFI_ID, SOL_ADDR), (bp.ZCASH_LIFI_ID, ZEC_T1),
])
def test_accepts_each_destination_family(chain, addr):
    assert bp.parse_order(_order(to_chain_id=chain, to_address=addr), 8453)["to_chain_id"] == chain


def test_hyperevm_core_deposit_quote_is_synthetic():
    """Option A: 998 → 1337 skips LI.FI and quotes 1:1 CoreDeposit."""
    assert bp.uses_hyperevm_core_deposit(998, 1337)
    assert bp.uses_hyperevm_core_deposit(999, 1337)
    assert not bp.uses_hyperevm_core_deposit(8453, 1337)
    assert not bp.uses_hyperevm_core_deposit(998, 42161)
    q = bp.get_quote(998, 5_000_000, {"to_chain_id": 1337, "to_token": "USDC", "to_address": USER},
                     USER, from_token="0x2B3370eE501B4a559b57D449569354196457D8Ab")
    assert q["tool"] == "CoreDepositWallet"
    assert q["estimate"]["toAmountMin"] == "5000000"


@pytest.mark.parametrize("over,msg", [
    ({"to_chain_id": 8453}, "source chain"),
    ({"to_chain_id": 56}, "unsupported"),
    ({"to_address": SOL_ADDR}, "invalid evm"),
    ({"to_chain_id": bp.SOLANA_LIFI_ID, "to_address": USER}, "invalid solana"),
    ({"to_chain_id": bp.ZCASH_LIFI_ID, "to_address": "t1VYVMriXVm7QDRdVQKWxamgEgVXGKSCsXX"}, "invalid zcash"),
    ({"amount": "999999"}, "minimum"),
    ({"min_out": "0"}, "min_out"),
    ({"refund_address": SOL_ADDR}, "refund_address"),
    ({"to_token": "0x../../x"}, "to_token"),
])
def test_rejects_bad_orders(over, msg):
    with pytest.raises(ValueError, match=msg):
        bp.parse_order(_order(**over), 8453)


# ── quote checks: everything that could make the executor pay from its own wallet ───────────────

def _quote(**over):
    q = {
        "tool": "across",
        "transactionRequest": {"to": DIAMOND, "data": "0xdead", "value": "0x0", "chainId": 8453,
                               "gasLimit": "0x30d40"},
        "estimate": {"fromAmount": "5000000", "toAmount": "4990000", "toAmountMin": "4950000",
                     "approvalAddress": DIAMOND},
        "action": {"fromChainId": 8453, "toChainId": 1, "fromAddress": EXEC, "toAddress": USER,
                   "fromToken": {"address": USDC}},
    }
    for k, v in over.items():
        section, key = k.split("__")
        q[section][key] = v
    return q


QC = dict(chain_id=8453, amount=5_000_000, min_out=4_900_000,
          order={"to_chain_id": 1, "to_address": USER}, from_address=EXEC, from_token=USDC)


def test_good_quote_passes():
    assert bp.check_quote(_quote(), **QC) is None


@pytest.mark.parametrize("over,msg", [
    ({"transactionRequest__to": "0x" + "ee" * 20}, "not the LI.FI diamond"),
    ({"estimate__approvalAddress": "0x" + "ee" * 20}, "approves"),
    ({"transactionRequest__value": "0x1"}, "native value"),
    ({"transactionRequest__chainId": 1}, "another source chain"),
    ({"estimate__fromAmount": "9000000"}, "fromAmount"),
    ({"estimate__toAmountMin": "4000000"}, "min_out"),
    ({"transactionRequest__data": ""}, "no transaction"),
    ({"transactionRequest__value": "0100"}, "native value"),           # decimal with leading 0
    ({"action__toAddress": "0x" + "ee" * 20}, "not the order's destination"),
    ({"action__toChainId": 10}, "chain pair"),
    ({"action__fromAddress": "0x" + "ee" * 20}, "another sender"),
    ({"action__fromToken": {"address": "0x" + "ee" * 20}}, "another token"),
])
def test_bad_quotes_are_refused(over, msg):
    assert msg in bp.check_quote(_quote(**over), **QC)


def test_solana_destination_is_compared_exactly():
    order = {"to_chain_id": bp.SOLANA_LIFI_ID, "to_address": SOL_ADDR}
    q = _quote(action__toChainId=bp.SOLANA_LIFI_ID, action__toAddress=SOL_ADDR.lower())
    assert "destination" in bp.check_quote(q, **{**QC, "order": order})


def _log(token, to, value):
    return {"address": token, "topics": ["0x" + bp._TRANSFER_TOPIC, "0x" + "00" * 32,
                                         "0x" + to.lower()[2:].rjust(64, "0")],
            "data": hex(value)}


def test_payout_counts_only_usdc_sent_to_the_executor():
    receipt = {"status": 1, "logs": [
        _log(USDC, EXEC, 5_000_000),
        _log(USDC, USER, 7_000_000),                # someone else's transfer in the same tx
        _log("0x" + "ab" * 20, EXEC, 9_000_000),    # another token to the executor
    ]}
    assert bp.payout_received(receipt, USDC, EXEC) == 5_000_000


# ── the worker state machine ────────────────────────────────────────────────────────────────────

class FakeW3:
    def __init__(self, receipts):
        self.receipts = receipts
        self.rpc_down = False
        self.sent = []  # (label, tx)

        class _Eth:
            def get_transaction_receipt(_, h):
                if self.rpc_down:
                    raise ConnectionError("429 Too Many Requests")
                if h not in self.receipts:
                    from web3.exceptions import TransactionNotFound
                    raise TransactionNotFound(h)
                return self.receipts[h]

            def contract(_, address, abi):
                return FakeToken(self)

        self.eth = _Eth()

    @staticmethod
    def to_checksum_address(a):
        return a


class FakeToken:
    def __init__(self, w3):
        self.w3 = w3
        self.allowance = 0

        class _F:
            def allowance(_, o, s):
                return _Call(self.allowance)

            def approve(_, s, a):
                return _Tx({"fn": "approve", "spender": s, "amount": a})

            def transfer(_, to, a):
                return _Tx({"fn": "transfer", "to": to, "amount": a})

        self.functions = _F()


class _Call:
    def __init__(self, v):
        self.v = v

    def call(self):
        return self.v


class _Tx:
    def __init__(self, d):
        self.d = d

    def build_transaction(self, extra):
        return {**self.d, **extra}


class Acct:
    address = EXEC


@pytest.fixture
def chain(monkeypatch):
    w3 = FakeW3({})
    monkeypatch.setattr(bp, "_chain", lambda cid: (w3, Acct()))

    def send_tx(w3_, acct, tx, label="", on_prepared=None, **_):
        h = "0x" + f"{len(w3.sent) + 1:064x}"
        if on_prepared:
            on_prepared(h, "raw")
        w3.sent.append((label, tx))
        w3.receipts[h] = {"status": 1, "logs": []}
        return h

    import evm_executor
    monkeypatch.setattr(evm_executor, "send_tx", send_tx)
    return w3


def _row(ctx, **over):
    from database import BridgeOrder

    fields = dict(chain_id=8453, token=USDC, to_chain_id="1", to_token="USDC", to_address=USER,
                  min_out="4900000", refund_address=USER, status="RECEIVED", amount_in="5000000")
    fields.update(over)
    row = BridgeOrder(**fields)
    ctx.db.session.add(row)
    ctx.db.session.commit()
    return row


def _run(row):
    bp._last_run[0] = 0.0
    bp.process_bridge_orders()
    from database import BridgeOrder
    return BridgeOrder.query.get(row.id)


def test_received_order_is_bridged_with_an_exact_approval(ctx, chain, monkeypatch):
    monkeypatch.setattr(bp, "get_quote", lambda *a, **k: _quote())
    o = _run(_row(ctx))
    assert o.status == "SENT" and o.bridge_tx
    (l1, approve), (l2, bridge) = chain.sent
    assert (l1, approve["fn"], approve["amount"], approve["spender"]) == ("bridge_approve", "approve", 5_000_000, DIAMOND.lower())
    assert l2 == "lifi_bridge" and bridge["value"] == 0 and bridge["to"] == DIAMOND


def test_bad_price_retries_then_refunds_exactly_what_came_in(ctx, chain, monkeypatch):
    monkeypatch.setattr(bp, "get_quote", lambda *a, **k: _quote(estimate__toAmountMin="1"))
    row = _row(ctx)
    from database import BridgeOrder
    for _ in range(bp.QUOTE_ATTEMPTS):
        o = _run(row)
        # re-quotes are spaced by QUOTE_RETRY_GAP; age the row past it
        BridgeOrder.query.filter_by(id=row.id).update({"updated_at": datetime.utcnow() - timedelta(minutes=2)})
        ctx.db.session.commit()
    assert o.status == "REFUND_DUE" and not chain.sent
    o = _run(row)
    assert o.status == "REFUNDED" and o.refund_tx
    [(label, tx)] = chain.sent
    assert (label, tx["fn"], tx["to"], tx["amount"]) == ("bridge_refund", "transfer", USER, 5_000_000)


def test_crash_after_broadcast_is_never_refunded_blind(ctx, chain, monkeypatch):
    monkeypatch.setattr(bp, "get_quote", lambda *a, **k: _quote())
    import evm_executor
    real = evm_executor.send_tx

    def dies_after_broadcast(w3_, acct, tx, label="", on_prepared=None, **k):
        h = real(w3_, acct, tx, label=label, on_prepared=on_prepared)
        if label == "lifi_bridge":
            raise TimeoutError("receipt wait timed out")
        return h

    monkeypatch.setattr(evm_executor, "send_tx", dies_after_broadcast)
    o = _run(_row(ctx))
    assert o.status == "SENT" and o.bridge_tx  # the receipt decides, not the exception


def test_sent_order_with_reverted_bridge_tx_becomes_refundable(ctx, chain):
    row = _row(ctx, status="SENT", bridge_tx="0xb1", updated_at=datetime.utcnow() - timedelta(minutes=5))
    chain.receipts["0xb1"] = {"status": 0, "logs": []}
    assert _run(row).status == "REFUND_DUE"


@pytest.mark.parametrize("lifi,want", [
    ({"status": "DONE", "substatus": "COMPLETED", "receiving": {"txHash": "0xd", "amount": "4990000"}}, "DONE"),
    ({"status": "DONE", "substatus": "REFUNDED"}, "REVIEW"),
    ({"status": "FAILED", "substatus": "UNKNOWN_ERROR"}, "REVIEW"),
    ({"status": "PENDING"}, "SENT"),
])
def test_lifi_status_mapping(ctx, chain, monkeypatch, lifi, want):
    import lifi_executor
    monkeypatch.setattr(lifi_executor, "get_lifi_status", lambda *a, **k: lifi)
    row = _row(ctx, status="SENT", bridge_tx="0xb1", updated_at=datetime.utcnow() - timedelta(minutes=5))
    chain.receipts["0xb1"] = {"status": 1, "logs": []}
    o = _run(row)
    assert o.status == want
    if want == "DONE":
        assert (o.dest_tx, o.amount_out) == ("0xd", "4990000")


def test_orphans_from_a_dead_process_resume_safely(ctx, chain):
    bridging = _row(ctx, status="BRIDGING")            # claimed, never signed
    refunding = _row(ctx, status="REFUNDING")          # claimed, never signed
    sent = _row(ctx, status="BRIDGING", bridge_tx="0xb2")  # signed: must NOT go back for a re-send
    assert _run(bridging).status == "RECEIVED"           # never signed → safe to quote again
    from database import BridgeOrder
    assert BridgeOrder.query.get(refunding.id).status == "REFUND_DUE"
    assert BridgeOrder.query.get(sent.id).status == "SENT"
    assert chain.sent == []


def test_orphaned_relay_is_settled_from_the_spend_receipt(ctx, chain):
    old = datetime.utcnow() - timedelta(minutes=20)
    row = _row(ctx, status="RELAYING", amount_in=None, spend_tx="0x5", created_at=old)
    chain.receipts["0x5"] = {"status": 1, "logs": [_log(USDC, EXEC, 3_000_000)]}
    o = _run(row)
    assert o.status in ("RECEIVED", "BRIDGING", "SENT", "REFUND_DUE") and o.amount_in == "3000000"


def test_young_relaying_row_is_left_to_its_request(ctx, chain):
    row = _row(ctx, status="RELAYING", amount_in=None, spend_tx=None)
    assert _run(row).status == "RELAYING"


# ── the route ───────────────────────────────────────────────────────────────────────────────────

def _body(payee=EXEC, action=0, amount=5_000_000, asset=USDC, **bridge):
    pis = [action] + [0] * 24
    pis[5], pis[17] = str(amount), str(int(asset, 16))
    return {
        "chain_id": 8453,
        "public_inputs": pis,
        "proof": [0] * 8,
        "compliancePublicInputs": [0] * 5,
        "complianceProof": [0] * 8,
        "extra": {"rawPayee": payee},
        "bridge": _order(**bridge),
    }


@pytest.fixture
def route(ctx, monkeypatch, chain):
    import app as A
    monkeypatch.setattr(A, "_bridge_executor", lambda cid: (chain, Acct()))
    monkeypatch.setattr(bp, "screen_order", lambda *a: None)
    monkeypatch.setattr(bp, "_usdc", lambda cid: USDC)
    monkeypatch.setattr(bp, "get_quote", lambda *a, **k: _quote())
    return A.app.test_client()


def _post(client, body):
    from eth_account import Account
    return client.post("/bridgeWithdraw", json=body, headers=_write_headers(Account.create()))


def test_route_refuses_a_proof_that_does_not_pay_the_executor(route, monkeypatch):
    import app as A
    monkeypatch.setattr(A, "_relay_spend", lambda *a, **k: pytest.fail("relayed a foreign payee"))
    r = _post(route, _body(payee=USER))
    assert r.status_code == 400 and "must pay the executor" in r.get_json()["error"]


def test_route_refuses_non_withdraw_actions(route):
    assert _post(route, _body(action=2)).status_code == 400


def test_route_rejects_before_relaying_when_the_price_is_short(route, monkeypatch):
    import app as A
    from database import BridgeOrder
    monkeypatch.setattr(bp, "get_quote", lambda *a, **k: _quote(estimate__toAmountMin="1"))
    monkeypatch.setattr(A, "_relay_spend", lambda *a, **k: pytest.fail("relayed despite a bad price"))
    r = _post(route, _body())
    assert r.status_code == 422 and BridgeOrder.query.count() == 0


def test_route_records_the_order_before_broadcast_and_measures_the_payout(route, monkeypatch, chain):
    import app as A
    from flask import jsonify

    def fake_relay(data, wallet, on_prepared=None):
        on_prepared("0x" + "5" * 64, "raw")
        from database import BridgeOrder
        assert BridgeOrder.query.one().spend_tx == "0x" + "5" * 64  # durable before "broadcast"
        chain.receipts["0x" + "5" * 64] = {"status": 1, "logs": [_log(USDC, EXEC, 5_000_000)]}
        return jsonify({"status": "submitted", "tx_hash": "0x" + "5" * 64}), 200

    monkeypatch.setattr(A, "_relay_spend", fake_relay)
    r = _post(route, _body())
    assert r.status_code == 200, r.get_json()
    j = r.get_json()
    assert j["order"]["status"] == "RECEIVED" and j["order"]["amount_in"] == "5000000"


def test_relay_rejection_closes_the_order(route, monkeypatch):
    import app as A
    from flask import jsonify
    monkeypatch.setattr(A, "_relay_spend", lambda *a, **k: (jsonify({"error": "tx would revert"}), 400))
    r = _post(route, _body())
    from database import BridgeOrder
    assert r.status_code == 400 and BridgeOrder.query.one().status == "FAILED"


def test_float_bridge_route_is_admin_only(route):
    r = route.post("/vault/bridge/execute", json={"from_chain_id": 8453, "to_chain_id": 42161,
                                                  "amount": "1", "asset": "ETH", "recipient": USER})
    assert r.status_code in (401, 503)


def test_solana_open_path_cannot_authorise_relays(route, monkeypatch):
    monkeypatch.setenv("SOLANA_DEVNET_ARM_OPEN", "1")
    r = route.post("/relaySpend", json={"chain_id": 8453}, headers={"X-Solana-Address": SOL_ADDR})
    assert r.status_code == 401


# ── audit regressions (H1, H2, M1, M2, L2) ───────────────────────────────────────────────────────

def test_rpc_outage_never_writes_off_a_mined_payout(ctx, chain):
    old = datetime.utcnow() - timedelta(hours=2)
    row = _row(ctx, status="RELAYING", amount_in=None, spend_tx="0x5", created_at=old)
    chain.rpc_down = True
    assert _run(row).status == "RELAYING"          # error ≠ "not mined": retried, not FAILED
    chain.rpc_down = False
    assert _run(row).status == "REVIEW"            # genuinely unknown after 30 min: a human looks


@pytest.mark.parametrize("over,msg", [
    ({"asset": "0x" + "ab" * 20}, "USDC notes only"),
    ({"amount": 1}, "proof's withdrawn amount"),
])
def test_route_checks_the_order_against_the_proof(route, monkeypatch, over, msg):
    import app as A
    monkeypatch.setattr(A, "_relay_spend", lambda *a, **k: pytest.fail("relayed a mismatched proof"))
    r = _post(route, _body(**over))
    assert r.status_code == 400 and msg in r.get_json()["error"]


def test_stale_request_thread_cannot_rewind_a_bridged_order(ctx, chain):
    from database import BridgeOrder
    row = _row(ctx, status="RELAYING", amount_in=None, spend_tx="0x5")
    stale = BridgeOrder.query.get(row.id)
    BridgeOrder.query.filter_by(id=row.id).update({"status": "SENT", "bridge_tx": "0xb1"})
    ctx.db.session.commit()
    bp.mark_received(stale, chain, {"status": 1, "logs": [_log(USDC, EXEC, 5_000_000)]}, EXEC)
    o = BridgeOrder.query.get(row.id)
    assert (o.status, o.bridge_tx) == ("SENT", "0xb1")


def test_plain_relay_refuses_a_payout_to_the_executor(route, monkeypatch, chain):
    import app as A
    import evm_executor
    monkeypatch.setattr(A, "get_web3", lambda *a: chain, raising=False)
    monkeypatch.setattr(evm_executor, "get_web3", lambda *a: chain)
    monkeypatch.setattr(evm_executor, "get_executor_account", lambda *a: Acct())
    monkeypatch.setattr(evm_executor, "vault_kernel_spend", lambda *a, **k: pytest.fail("relayed bare"))
    import evm_chain_config
    monkeypatch.setattr(evm_chain_config, "get_evm_chain_config",
                        lambda cid: type("C", (), {"vault_kernel": "0x" + "ab" * 20, "chain_id": cid})())
    from eth_account import Account
    body = {k: v for k, v in _body().items() if k != "bridge"}
    monkeypatch.setattr(A, "validate_recipient", lambda *a: (True, ""))
    r = route.post("/relaySpend", json=body, headers=_write_headers(Account.create()))
    assert r.status_code == 400 and "/bridgeWithdraw" in r.get_json()["error"]


def test_admin_refund_refuses_a_second_refund(ctx, monkeypatch):
    monkeypatch.setenv("ADMIN_API_TOKEN", "adm")
    row = _row(ctx, status="REVIEW", refund_tx="0xr1")
    r = ctx.app.test_client().post(f"/admin/bridgeOrders/{row.id}/refund", headers={"X-ADMIN-TOKEN": "adm"})
    assert r.status_code == 409


def test_no_route_error_does_not_echo_the_lifi_url(monkeypatch):
    """LI.FI's 404 carries the full quote URL (user + executor addresses) — never return it."""
    import app as A
    import bridge_payout as B

    monkeypatch.setattr(A, "_bridge_executor", lambda chain_id: (None, type("Acct", (), {"address": "0x" + "22" * 20})()))
    monkeypatch.setattr(B, "get_quote", lambda *a, **k: (_ for _ in ()).throw(
        RuntimeError("404 Client Error for url: https://li.quest/v1/quote?toAddress=t1secret")))
    r = A.app.test_client().post("/bridgeQuote", json={"chain_id": 8453, "bridge": {
        "to_chain_id": 42161, "to_address": "0x" + "33" * 20, "to_token": "USDC",
        "amount": "5000000", "min_out": "1", "refund_address": "0x" + "44" * 20}})
    assert r.status_code == 422
    assert "li.quest" not in r.get_data(as_text=True) and "t1secret" not in r.get_data(as_text=True)
