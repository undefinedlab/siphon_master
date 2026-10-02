"""Withdraw-to-any-chain: forward a relayed vault payout to another chain through LI.FI.

The user proves an ordinary WITHDRAW whose payee is THIS executor and posts it with a bridge order
(/bridgeWithdraw). The executor relays the spend, measures what actually arrived from the spend
receipt, and bridges exactly that — or refunds it on the source chain when the hop cannot be made
at the price the user accepted. The executor's own float is never the source: every amount moved
here is read from the order's own spend receipt.

A strategy can carry the same order as its `payout`: the enclave-armed leg is a WITHDRAW to this
executor, and when it fires executor_runner writes the BridgeOrder and hands it to the same worker.
Those payouts may arrive as native ETH (the kernel unwraps WETH), not just USDC.

This replaces /vault/bridge/execute as the user path. That route bridged whatever amount the caller
named out of the executor wallet with no proof behind it, so anyone could drain the float.

BridgeOrder.status:
  RELAYING    row written, spend being relayed (spend_tx stored before broadcast)
  RECEIVED    spend mined; amount_in = what the receipt paid the executor (USDC or native ETH)
  BRIDGING    in the worker; bridge_tx stored before broadcast
  SENT        LI.FI source tx broadcast; polling until the destination lands
  DONE        LI.FI reports DONE
  REFUND_DUE  the hop could not be made (no route, below min_out, source tx reverted)
  REFUNDING   refund_tx stored before broadcast
  REFUNDED    amount_in returned to refund_address on the source chain
  FAILED      nothing reached the executor (spend rejected or reverted) — nothing to return
  REVIEW      ambiguous (funds left but LI.FI says FAILED/REFUNDED, or a tx vanished): operator
"""
from __future__ import annotations

import os
import re
import time
from datetime import datetime, timedelta

import base58

SOLANA_LIFI_ID = 1151111081099710
# LI.FI's native-coin address. An ETH note's withdraw arrives as native ETH: the kernel unwraps WETH.
NATIVE = "0x0000000000000000000000000000000000000000"
ZCASH_LIFI_ID = 20000000000005

# LI.FI chain id → destination address format. EVM-format chains share one address space, so the
# user's own EVM address works on every one of them (HyperCore 1337 included).
DEST_CHAINS = {
    1: "evm", 10: "evm", 137: "evm", 8453: "evm", 42161: "evm",
    999: "evm",     # HyperEVM
    1337: "evm",    # Hyperliquid core (USDC lands in the perps/spot account)
    4217: "evm",    # Tempo
    SOLANA_LIFI_ID: "solana",
    ZCASH_LIFI_ID: "zcash",
}

# The LI.FI diamond. A quote whose tx or approval targets anything else is refused: the approval is
# the one thing that lets a contract pull the executor's USDC.
LIFI_DIAMOND = os.getenv("LIFI_DIAMOND", "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE").lower()
# Below this the hop's own gas (approve + bridge, paid by the executor) is not worth it.
MIN_AMOUNT = int(os.getenv("BRIDGE_MIN_UNITS", "1000000"))  # 1 USDC
# Strategy payouts are quoted when the order fires, with nobody to accept the price. The floor is
# the oracle value of what was withdrawn, less the order's slippage and this allowance for route fees.
FIRE_FEE_ALLOWANCE_BPS = int(os.getenv("BRIDGE_FIRE_FEE_BPS", "300"))
# Smallest payout worth the executor's gas, for native orders whose amount is in wei.
MIN_USD = float(os.getenv("BRIDGE_MIN_USD", "1"))
# Destination tokens priced at $1 rather than by LI.FI's own number.
STABLES = {"USDC", "USDC.E", "USDBC", "USDT", "USDT0"}
QUOTE_ATTEMPTS = 3          # re-quotes before refunding
QUOTE_RETRY_GAP = timedelta(seconds=60)
POLL_EVERY = timedelta(seconds=20)
ORPHAN_AFTER = timedelta(minutes=15)   # a RELAYING row older than this lost its request thread
TX_LOST_AFTER = timedelta(minutes=30)
LIFI_GIVE_UP = timedelta(hours=3)

_TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
_EVM = re.compile(r"^0x[0-9a-fA-F]{40}$")
_TOKEN = re.compile(r"^[A-Za-z0-9]{1,64}$")
_UNIFIED_ZEC = re.compile(r"^u1[02-9ac-hj-np-z]{60,}$")
_ERC20_ABI = [
    {"name": "approve", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "s", "type": "address"}, {"name": "a", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"name": "allowance", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "o", "type": "address"}, {"name": "s", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "transfer", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "to", "type": "address"}, {"name": "a", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
]


# ── order validation ─────────────────────────────────────────────────────────────────────────

def _zcash_transparent(addr: str) -> bool:
    try:
        raw = base58.b58decode_check(addr)
    except Exception:
        return False
    return len(raw) == 22 and raw[:2] in (b"\x1c\xb8", b"\x1c\xbd")  # t1 (P2PKH) / t3 (P2SH)


def valid_destination(to_chain_id: int, addr: str) -> bool:
    kind = DEST_CHAINS.get(int(to_chain_id))
    if kind == "evm":
        return bool(_EVM.match(addr))
    if kind == "solana":
        try:
            return len(base58.b58decode(addr)) == 32
        except Exception:
            return False
    if kind == "zcash":
        # LI.FI's own quote is the authority on unified addresses (it needs an Orchard receiver);
        # this only stops obvious junk before a quote round-trip.
        return _zcash_transparent(addr) or bool(_UNIFIED_ZEC.match(addr))
    return False


def parse_destination(raw: dict, chain_id: int) -> dict:
    """Validate where an order pays and refunds. Raises ValueError with a user-facing message."""
    if not isinstance(raw, dict):
        raise ValueError("bridge order required")
    try:
        to_chain = int(raw.get("to_chain_id"))
    except (TypeError, ValueError):
        raise ValueError("to_chain_id must be an integer")
    if to_chain not in DEST_CHAINS:
        raise ValueError(f"unsupported destination chain {to_chain}")
    if to_chain == int(chain_id):
        raise ValueError("destination is the source chain — use a plain withdraw")
    to_address = str(raw.get("to_address") or "").strip()
    if not valid_destination(to_chain, to_address):
        raise ValueError(f"invalid {DEST_CHAINS[to_chain]} address for chain {to_chain}")
    to_token = str(raw.get("to_token") or "USDC").strip()
    if not _TOKEN.match(to_token):
        raise ValueError("invalid to_token")
    refund = str(raw.get("refund_address") or "").strip()
    if not _EVM.match(refund):
        raise ValueError("refund_address must be an EVM address on the source chain")
    return {"to_chain_id": to_chain, "to_address": to_address, "to_token": to_token, "refund_address": refund}


def parse_order(raw: dict, chain_id: int, native: bool = False) -> dict:
    """Validate a client bridge order. Raises ValueError with a user-facing message.

    `native` (quotes only): the amount is wei, so the caller enforces the floor in USD instead.
    """
    dest = parse_destination(raw, chain_id)
    try:
        amount = int(str(raw.get("amount") or "0"))
        min_out = int(str(raw.get("min_out") or "0"))
    except (TypeError, ValueError):
        raise ValueError("amount and min_out must be integers")
    if not native and amount < MIN_AMOUNT:
        raise ValueError(f"amount below the bridge minimum ({MIN_AMOUNT} base units)")
    if min_out <= 0:
        raise ValueError("min_out must be positive — it is the user's slippage bound")
    return {**dest, "amount": amount, "min_out": min_out}


def parse_payout(raw: dict, chain_id: int) -> dict:
    """Validate a strategy's payout: the destination plus the slippage it may lose at fire time."""
    dest = parse_destination(raw, chain_id)
    try:
        slippage = int(100 if raw.get("slippage_bps") is None else raw["slippage_bps"])
    except (TypeError, ValueError):
        raise ValueError("slippage_bps must be an integer")
    if not 1 <= slippage <= 1000:
        raise ValueError("slippage_bps must be between 1 and 1000")
    return {**dest, "slippage_bps": slippage}


def screen_order(order: dict, chain_id: int) -> str | None:
    """Sanctions-screen the addresses that can receive funds. Returns an error or None.

    EVM-format destinations are screened on the source chain's oracle: the Chainalysis list is
    address-keyed, and the executor always has a working RPC for its own chain. Solana and Zcash
    addresses have no on-chain oracle; the bridge (Relay / NEAR Intents) screens those.
    """
    from address_validator import check_sanctions, validate_recipient

    ok, why = validate_recipient(order["refund_address"], str(chain_id))
    if not ok:
        return f"refund address: {why}"
    if DEST_CHAINS[order["to_chain_id"]] == "evm":
        hit, why = check_sanctions(order["to_address"], str(chain_id))
        if hit:
            return f"destination: {why}"
    return None


# ── LI.FI ──────────────────────────────────────────────────────────────────────────────────────

def _usdc(chain_id: int) -> str:
    from evm_chain_config import get_evm_chain_config

    usdc = get_evm_chain_config(chain_id).usdc
    if not usdc:
        raise RuntimeError(f"no USDC configured for chain {chain_id}")
    return usdc


def source_token(chain_id: int, symbol: str | None) -> str:
    """What a withdraw of `symbol` pays the executor: native ETH for an ETH note, else USDC."""
    sym = str(symbol or "USDC").upper()
    if sym in ("ETH", "WETH"):
        return NATIVE
    if sym != "USDC":
        raise ValueError(f"payouts support ETH and USDC, not {symbol}")
    return _usdc(chain_id)


def uses_hyperevm_core_deposit(chain_id: int, to_chain_id: int) -> bool:
    """HyperEVM (998/999) → HyperCore: CoreDepositWallet, not LI.FI."""
    import hyperevm_bridge

    return hyperevm_bridge.is_hyperevm_chain(int(chain_id)) and int(to_chain_id) == 1337


def _core_deposit_quote(chain_id: int, amount: int, order: dict, from_address: str,
                        from_token: str) -> dict:
    """Synthetic quote for fire_min_out / BridgeOrder bookkeeping (1:1 USDC, no LI.FI fee)."""
    return {
        "tool": "CoreDepositWallet",
        "toolDetails": {"name": "CoreDepositWallet"},
        "action": {
            "fromChainId": int(chain_id),
            "toChainId": int(order["to_chain_id"]),
            "fromToken": {"address": from_token},
            "fromAddress": from_address,
            "toAddress": order["to_address"],
            "toToken": {"address": "USDC", "symbol": "USDC", "decimals": 6, "priceUSD": "1"},
        },
        "estimate": {
            "fromAmount": str(int(amount)),
            "toAmount": str(int(amount)),
            "toAmountMin": str(int(amount)),
            "feeCosts": [],
            "executionDuration": 5,
            "approvalAddress": None,
        },
        # Placeholder — _bridge_core_deposit never sends this tx.
        "transactionRequest": {"to": "0x0000000000000000000000000000000000000001", "data": "0x",
                               "chainId": int(chain_id), "value": "0"},
    }


def get_quote(chain_id: int, amount: int, order: dict, from_address: str,
              from_token: str | None = None) -> dict:
    token = from_token or _usdc(chain_id)
    if uses_hyperevm_core_deposit(chain_id, order["to_chain_id"]):
        return _core_deposit_quote(chain_id, amount, order, from_address, token)

    from lifi_executor import get_lifi_quote

    return get_lifi_quote(
        from_chain=str(chain_id),
        to_chain=str(order["to_chain_id"]),
        from_token=token,
        to_token=order["to_token"],
        from_amount=int(amount),
        from_address=from_address,
        to_address=order["to_address"],
    )


def _int(v) -> int:
    v = str(v if v is not None else "0").strip()
    return int(v, 16) if v.lower().startswith("0x") else int(v or "0")


def _same_addr(a, b, kind: str) -> bool:
    a, b = str(a or ""), str(b or "")
    return a.lower() == b.lower() if kind == "evm" else a == b


def check_quote(q: dict, *, chain_id: int, amount: int, min_out: int, order: dict,
                from_address: str, from_token: str) -> str | None:
    """Why this quote must not be executed, or None. Every check guards the executor's wallet.

    ponytail: trusts LI.FI's `action` block to describe its own calldata; decoding the diamond's
    BridgeData (receiver, destinationChainId, sendingAssetId, minAmount) per bridge facet would
    close that last gap. The exact approval bounds a lying response to one order's amount.
    """
    tx = q.get("transactionRequest") or {}
    est = q.get("estimate") or {}
    act = q.get("action") or {}
    kind = DEST_CHAINS.get(int(order["to_chain_id"]), "evm")
    if _int(act.get("fromChainId")) != int(chain_id) or _int(act.get("toChainId")) != int(order["to_chain_id"]):
        return "quote is for another chain pair"
    if not _same_addr((act.get("fromToken") or {}).get("address"), from_token, "evm"):
        return "quote spends another token"
    if not _same_addr(act.get("fromAddress"), from_address, "evm"):
        return "quote is from another sender"
    if not _same_addr(act.get("toAddress"), order["to_address"], kind):
        return f"quote pays {act.get('toAddress')}, not the order's destination"
    if not tx.get("to") or not tx.get("data"):
        return "quote has no transaction"
    if str(tx["to"]).lower() != LIFI_DIAMOND:
        return f"quote targets {tx['to']}, not the LI.FI diamond"
    if str(est.get("approvalAddress") or LIFI_DIAMOND).lower() != LIFI_DIAMOND:
        return f"quote approves {est.get('approvalAddress')}, not the LI.FI diamond"
    # A native order sends exactly its own amount; anything more is a fee paid from the float.
    if _int(tx.get("value")) != (int(amount) if str(from_token).lower() == NATIVE else 0):
        return "route needs native value — the executor does not pay bridge fees from its float"
    if tx.get("chainId") is not None and _int(tx["chainId"]) != int(chain_id):
        return "quote is for another source chain"
    if _int(est.get("fromAmount")) != int(amount):
        return "quote fromAmount differs from the payout"
    if _int(est.get("toAmountMin")) < int(min_out):
        return f"best route delivers {est.get('toAmountMin')} < min_out {min_out}"
    return None


def summarize(q: dict) -> dict:
    est = q.get("estimate") or {}
    tok = (q.get("action") or {}).get("toToken") or {}
    return {
        "tool": (q.get("toolDetails") or {}).get("name") or q.get("tool"),
        "toAmount": est.get("toAmount"),
        "toAmountMin": est.get("toAmountMin"),
        "durationSec": est.get("executionDuration"),
        "feeUsd": round(sum(float(f.get("amountUSD") or 0) for f in est.get("feeCosts") or []), 4),
        "toToken": {k: tok.get(k) for k in ("address", "symbol", "decimals")},
    }


def fire_min_out(q: dict, amount_in_usd: float, slippage_bps: int) -> int:
    """A fired strategy's slippage floor, in destination base units.

    Nobody is there to accept a price, so the floor comes from the oracle value of what was
    withdrawn. Stablecoins are priced at $1; anything else (ZEC) by LI.FI's own token price.
    """
    tok = (q.get("action") or {}).get("toToken") or {}
    px = 1.0 if str(tok.get("symbol") or "").upper() in STABLES else float(tok.get("priceUSD") or 0)
    if px <= 0 or amount_in_usd <= 0:
        raise ValueError("cannot price this payout")
    keep = 1 - (int(slippage_bps) + FIRE_FEE_ALLOWANCE_BPS) / 10_000
    return int(amount_in_usd * keep / px * 10 ** int(tok.get("decimals") or 0))


def fire_check(chain_id: int, payout: dict, strategy: dict, from_address: str) -> dict:
    """Before proving a fired payout: does a route clear the floor right now?

    Raises ValueError when not, and the leg stays armed. Runs BEFORE the enclave proves, so a
    destination with no route at this size does not cost a Groth16 proof every tick.
    Returns what the order needs once the proof says exactly how much it withdraws.
    """
    from decimal import Decimal

    from oracle import _fetch_spot

    token = source_token(chain_id, strategy.get("asset_in"))
    native = token == NATIVE
    decimals = 18 if native else 6
    price = _fetch_spot("ETH" if native else "USDC")
    if not price:
        raise ValueError("no trusted price for the input asset")
    amount = int(Decimal(str(strategy["amount"])) * 10 ** decimals)
    q = get_quote(chain_id, amount, payout, from_address, from_token=token)
    floor = fire_min_out(q, amount / 10 ** decimals * price, payout["slippage_bps"])
    # CoreDeposit is not a LI.FI diamond quote — skip diamond checks.
    if not uses_hyperevm_core_deposit(chain_id, payout["to_chain_id"]):
        why = check_quote(q, chain_id=chain_id, amount=amount, min_out=floor, order=payout,
                          from_address=from_address, from_token=token)
        if why:
            raise ValueError(why)
    elif int(q.get("estimate", {}).get("toAmountMin") or 0) < floor:
        raise ValueError(f"CoreDeposit delivers below floor {floor}")
    return {"token": token, "decimals": decimals, "price": price, "quote": q}


def _event_topic(sig: str) -> str:
    from web3 import Web3

    return Web3.keccak(text=sig).hex().removeprefix("0x")


def _native_received(receipt, chain_id: int, payee: str) -> int:
    """Native ETH a kernel WITHDRAW paid: its AssetsUnshielded amounts. Native sends leave no log.

    0 if the kernel fell back to WETH for this payee — then the executor holds WETH, not ETH, and
    bridging native would spend the float. The executor is an EOA, so that cannot happen; if it
    does, the order goes to REVIEW.
    """
    from evm_chain_config import get_evm_chain_config

    cfg = get_evm_chain_config(chain_id)
    kernel, weth = cfg.vault_kernel.lower(), cfg.weth.lower()
    unshielded = _event_topic("AssetsUnshielded(address,uint256,uint256)")
    fell_back = _event_topic("NativePayoutFellBackToWeth(address,uint256)")
    want = payee.lower()[2:].rjust(64, "0")
    total = 0
    for log in receipt["logs"]:
        if str(log["address"]).lower() != kernel:
            continue
        topics = [t.hex() if hasattr(t, "hex") else str(t) for t in log["topics"]]
        topics = [t.removeprefix("0x").lower() for t in topics]
        if len(topics) < 2:
            continue
        data = log["data"]
        amount = int(data.hex() if hasattr(data, "hex") else data, 16)
        if topics[0] == fell_back and topics[1] == want:
            return 0
        if (topics[0] == unshielded and len(topics) == 3 and topics[1][-40:] == weth[2:]
                and int(topics[2], 16) == 0):
            total += amount
    return total


def payout_received(receipt, token: str, payee: str, chain_id: int | None = None) -> int:
    """Sum of `token` Transfers to `payee` in a receipt — what the spend actually paid."""
    if token.lower() == NATIVE:
        return _native_received(receipt, int(chain_id), payee)
    tok = token.lower()
    want = payee.lower()[2:].rjust(64, "0")
    total = 0
    for log in receipt["logs"]:
        topics = [t.hex() if hasattr(t, "hex") else str(t) for t in log["topics"]]
        topics = [t[2:] if t.startswith("0x") else t for t in topics]
        if (str(log["address"]).lower() == tok and len(topics) == 3
                and topics[0] == _TRANSFER_TOPIC and topics[2].lower() == want):
            data = log["data"]
            total += int(data.hex() if hasattr(data, "hex") else data, 16)
    return total


# ── worker ─────────────────────────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.utcnow()


def _save(o, **fields) -> None:
    from database import db

    for k, v in fields.items():
        setattr(o, k, v)
    db.session.commit()


def _claim(o, frm: str, to: str) -> bool:
    """Atomic status transition — a second worker (or a stale read) cannot take the same order."""
    from database import BridgeOrder, db

    n = BridgeOrder.query.filter_by(id=o.id, status=frm).update({"status": to, "updated_at": _now()})
    db.session.commit()
    if n == 1:
        db.session.refresh(o)
    return n == 1


def _transition(o, frm: str, **fields) -> bool:
    """Write `fields` only if the row is still in `frm` — never from a stale in-memory object."""
    from database import BridgeOrder, db

    n = BridgeOrder.query.filter_by(id=o.id, status=frm).update({**fields, "updated_at": _now()})
    db.session.commit()
    db.session.refresh(o)
    return n == 1


def _chain(chain_id: int):
    from evm_chain_config import get_evm_chain_config
    from evm_executor import get_executor_account, get_web3

    cfg = get_evm_chain_config(chain_id)
    w3 = get_web3(cfg)
    return w3, get_executor_account(w3, chain_id)


def _receipt(w3, tx_hash: str):
    """Receipt, or None when the node says the tx is unknown. Any other RPC failure (429, 403
    out-of-credit, timeout) raises: treating it as "not mined" once wrote mined payouts off."""
    from web3.exceptions import TransactionNotFound

    try:
        return w3.eth.get_transaction_receipt(tx_hash)
    except TransactionNotFound:
        return None


def mark_received(o, w3, receipt, payee: str) -> None:
    """Spend mined: record what it actually paid. Shared by the request path and orphan recovery."""
    if receipt["status"] != 1:
        _transition(o, "RELAYING", status="FAILED", error="spend reverted — nothing reached the executor")
        return
    got = payout_received(receipt, o.token, payee, o.chain_id)
    if got <= 0:
        # The route checks the proof's asset and amount, so this should be unreachable; if it is
        # reached, something was paid that this code cannot see — a human must look.
        _transition(o, "RELAYING", status="REVIEW", error="spend mined but paid the executor nothing")
        return
    _transition(o, "RELAYING", status="RECEIVED", amount_in=str(got), error=None)


def _recover_relaying(o) -> None:
    if _now() - o.created_at < ORPHAN_AFTER:
        return  # the request thread may still be relaying it
    if not o.spend_tx:
        _save(o, status="FAILED", error="spend was never broadcast")
        return
    w3, acct = _chain(o.chain_id)
    r = _receipt(w3, o.spend_tx)
    if r is None:
        if _now() - o.created_at > TX_LOST_AFTER:
            # Unknown is not "never mined": it may land later, or a lagging node may not see it.
            _transition(o, "RELAYING", status="REVIEW", error="spend tx not found after 30 min")
        return
    mark_received(o, w3, r, acct.address)


def _bridge_core_deposit(o) -> None:
    """HyperEVM USDC → HyperCore via CoreDepositWallet (Option A private perps funding)."""
    from evm_executor import send_tx
    import hyperevm_bridge

    amount = int(o.amount_in)
    if amount <= 0:
        raise _NoRoute("nothing to deposit to HyperCore")
    if str(o.token).lower() == NATIVE:
        raise _NoRoute("CoreDeposit needs USDC, not native")
    w3, acct = _chain(o.chain_id)
    tx = hyperevm_bridge.deposit_usdc_to_core(
        w3, acct, int(o.chain_id), amount, to_perps=True, send_tx=send_tx,
    )
    tx_hash = _hex(tx) if not isinstance(tx, str) else (tx if tx.startswith("0x") else "0x" + tx)
    # 1:1 credit on HyperCore for the depositing executor address (must match HL master).
    _save(o, status="DONE", tool="CoreDepositWallet", bridge_tx=tx_hash, sent_at=_now(),
          dest_tx=tx_hash, amount_out=str(amount), error=None)


def _bridge(o) -> None:
    if not _claim(o, "RECEIVED", "BRIDGING"):
        return
    from evm_executor import send_tx

    amount = int(o.amount_in)
    w3, acct = _chain(o.chain_id)
    order = {"to_chain_id": int(o.to_chain_id), "to_token": o.to_token, "to_address": o.to_address}
    native = o.token.lower() == NATIVE
    try:
        if uses_hyperevm_core_deposit(o.chain_id, o.to_chain_id):
            _bridge_core_deposit(o)
            return
        q = get_quote(o.chain_id, amount, order, acct.address, from_token=o.token)
        why = check_quote(q, chain_id=o.chain_id, amount=amount, min_out=int(o.min_out),
                          order=order, from_address=acct.address, from_token=o.token)
        if why:
            raise _NoRoute(why)
        tx_req = q["transactionRequest"]
        spender = w3.to_checksum_address(LIFI_DIAMOND)
        from lifi_executor import APPROVE_LOCK
        # One LI.FI approve→send at a time: strategy legs (lifi_executor) approve the same diamond
        # for the same token, and interleaving would overwrite each other's allowance.
        with APPROVE_LOCK:
            # SET the allowance to exactly this order (approve overwrites, never adds), so an
            # approval left over from an earlier order can never be pulled by this tx. Native ETH
            # needs none: the order's own amount rides as the tx value.
            if not native:
                usdc = w3.eth.contract(address=w3.to_checksum_address(o.token), abi=_ERC20_ABI)
                if usdc.functions.allowance(acct.address, spender).call() != amount:
                    send_tx(w3, acct, usdc.functions.approve(spender, amount).build_transaction(
                        {"from": acct.address, "chainId": o.chain_id}), label="bridge_approve")
            gas = tx_req.get("gasLimit")
            send_tx(w3, acct, {
                "from": acct.address,
                "to": w3.to_checksum_address(tx_req["to"]),
                "data": tx_req["data"],
                "value": amount if native else 0,
                "chainId": o.chain_id,
                "gas": _int(gas) if gas else 0,
            }, label="lifi_bridge", on_prepared=lambda h, _raw: _save(o, bridge_tx=_hex(h), sent_at=_now()))
        tool = (q.get("toolDetails") or {}).get("name") or q.get("tool")
        _save(o, status="SENT", tool=tool, error=None)
    except Exception as exc:
        if o.bridge_tx:
            # Broadcast happened; the receipt decides (reverted → refund, mined → LI.FI status).
            _save(o, status="SENT", error=str(exc)[:500])
            return
        attempts = (o.attempts or 0) + 1
        nxt = "REFUND_DUE" if attempts >= QUOTE_ATTEMPTS else "RECEIVED"
        _save(o, status=nxt, attempts=attempts, error=str(exc)[:500])


class _NoRoute(Exception):
    pass


def _hex(h) -> str:
    s = h.hex() if hasattr(h, "hex") else str(h)
    return s if s.startswith("0x") else "0x" + s


def _poll(o) -> None:
    if _now() - o.updated_at < POLL_EVERY:
        return
    from lifi_executor import get_lifi_status

    w3, _acct = _chain(o.chain_id)
    r = _receipt(w3, o.bridge_tx)
    if r is None:
        if _now() - (o.sent_at or o.created_at) > TX_LOST_AFTER:
            _save(o, status="REVIEW", error="bridge tx not found on chain")
        else:
            _save(o, updated_at=_now())  # spaces the checks by POLL_EVERY
        return
    if r["status"] != 1:
        _save(o, status="REFUND_DUE", error="bridge tx reverted — funds still in the executor")
        return
    try:
        st = get_lifi_status(o.bridge_tx, o.chain_id, o.to_chain_id)
    except Exception as exc:
        _save(o, updated_at=_now(), error=f"status poll: {exc}"[:500])
        return
    status = str(st.get("status") or "").upper()
    sub = str(st.get("substatus") or "").upper()
    recv = st.get("receiving") or {}
    if status == "DONE" and sub != "REFUNDED":
        _save(o, status="DONE", dest_tx=recv.get("txHash"), amount_out=str(recv.get("amount") or ""),
              error=None if sub in ("", "COMPLETED") else sub)
    elif status in ("FAILED", "INVALID") or sub == "REFUNDED":
        # The source tx moved the funds; whether they came back to the executor is the bridge's
        # call. Refunding on LI.FI's word alone could pay the user twice — an operator checks.
        _save(o, status="REVIEW", error=f"LI.FI {status}/{sub}: {st.get('substatusMessage') or ''}"[:500])
    elif _now() - (o.sent_at or o.created_at) > LIFI_GIVE_UP:
        _save(o, status="REVIEW", error=f"LI.FI still {status or 'NOT_FOUND'} after {LIFI_GIVE_UP}")
    else:
        _save(o, updated_at=_now())


def _refund(o) -> None:
    if o.status == "REFUNDING":
        if not o.refund_tx:
            _save(o, status="REFUND_DUE")  # orphan: claimed but never signed
            return
        w3, _acct = _chain(o.chain_id)
        r = _receipt(w3, o.refund_tx)
        if r is None:
            if _now() - o.updated_at > TX_LOST_AFTER:
                _save(o, status="REVIEW", error="refund tx not found on chain")
            return
        _save(o, status="REFUNDED" if r["status"] == 1 else "REFUND_DUE",
              refund_tx=o.refund_tx if r["status"] == 1 else None)
        return
    if not _claim(o, "REFUND_DUE", "REFUNDING"):
        return
    from evm_executor import send_tx

    w3, acct = _chain(o.chain_id)
    if o.token.lower() == NATIVE:
        try:
            send_tx(w3, acct, {"from": acct.address, "to": w3.to_checksum_address(o.refund_address),
                               "value": int(o.amount_in), "chainId": o.chain_id},
                    label="bridge_refund", on_prepared=lambda h, _raw: _save(o, refund_tx=_hex(h)))
            _save(o, status="REFUNDED")
        except Exception as exc:
            _save(o, **({"error": str(exc)[:500]} if o.refund_tx else
                        {"status": "REFUND_DUE", "error": str(exc)[:500]}))
        return
    usdc = w3.eth.contract(address=w3.to_checksum_address(o.token), abi=_ERC20_ABI)
    spender = w3.to_checksum_address(LIFI_DIAMOND)
    try:
        from lifi_executor import APPROVE_LOCK
        with APPROVE_LOCK:
            # A refunded order never bridges; leave the diamond no allowance to pull later.
            if usdc.functions.allowance(acct.address, spender).call() == int(o.amount_in):
                send_tx(w3, acct, usdc.functions.approve(spender, 0).build_transaction(
                    {"from": acct.address, "chainId": o.chain_id}), label="bridge_unapprove")
    except Exception as exc:
        print(f"[bridge] order {o.id}: allowance reset failed (refunding anyway): {exc}")
    try:
        send_tx(w3, acct, usdc.functions.transfer(
            w3.to_checksum_address(o.refund_address), int(o.amount_in),
        ).build_transaction({"from": acct.address, "chainId": o.chain_id}),
            label="bridge_refund", on_prepared=lambda h, _raw: _save(o, refund_tx=_hex(h)))
        _save(o, status="REFUNDED")
    except Exception as exc:
        if o.refund_tx:
            _save(o, error=str(exc)[:500])  # stays REFUNDING; the receipt decides next pass
        else:
            _save(o, status="REFUND_DUE", error=str(exc)[:500])


_last_run = [0.0]


def process_bridge_orders(min_interval: float = 5.0) -> None:
    """One pass over open orders. Called from the scheduler loop (single worker), so a row in
    BRIDGING/REFUNDING without its tx hash at the start of a pass belongs to a dead process."""
    if time.monotonic() - _last_run[0] < min_interval:
        return
    _last_run[0] = time.monotonic()
    from database import BridgeOrder, db

    open_rows = BridgeOrder.query.filter(BridgeOrder.status.in_(
        ["RELAYING", "RECEIVED", "BRIDGING", "SENT", "REFUND_DUE", "REFUNDING"])).all()
    for o in open_rows:
        try:
            if o.status == "RELAYING":
                _recover_relaying(o)
            elif o.status == "BRIDGING":
                _save(o, status="SENT" if o.bridge_tx else "RECEIVED")
            elif o.status == "RECEIVED":
                # Space re-quotes so a brief LI.FI hiccup does not burn all attempts in seconds.
                if o.attempts and _now() - o.updated_at < QUOTE_RETRY_GAP:
                    continue
                _bridge(o)
            elif o.status == "SENT":
                _poll(o)
            else:
                _refund(o)
        except Exception as exc:
            db.session.rollback()
            print(f"[bridge] order {o.id} {o.status}: {exc}")
