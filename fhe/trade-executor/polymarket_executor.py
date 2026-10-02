"""Polymarket entry executor: shielded Base withdrawal → bridge to Polygon → CLOB order → position.

Structurally identical to a Siphon swap strategy (withdraw → do-a-thing-off-vault → record), reusing
the existing primitives (zk_withdraw_from_vault, execute_lifi_swap, the fee model). Only the middle
step differs: instead of a Uniswap swap, we bridge USDC to Polygon and place a CLOB order. The open
position is recorded in polymarket_positions so the resolution watcher can redeem + shield the
proceeds back to the user's Base vault under output_precommitment.

Invoked only when polymarket_client.is_configured() (guarded in executor_runner) so a note is never
spent / funds never bridged without the ability to place the order.
"""
import json
from decimal import Decimal

from database import db, PolymarketPosition
from evm_chain_config import get_evm_chain_config, POLYGON_CHAIN_ID
from evm_executor import get_web3, get_executor_account, zk_withdraw_from_vault
from lifi_executor import bridge_and_wait
import polymarket_client

USDC_DECIMALS = 6
BASE_CHAIN_ID = 8453


def _proof_from_zkp(zkp_data):
    if not zkp_data:
        return None
    zk = zkp_data if isinstance(zkp_data, dict) else json.loads(zkp_data)
    if zk.get("pA") and zk.get("stateRoot"):
        return zk
    if isinstance(zk.get("proof"), dict) and zk["proof"].get("pA"):
        return zk["proof"]
    return None


def execute_polymarket_entry(strategy, current_price, on_withdraw_confirmed=None):
    """Enter a Polymarket position for a triggered POLYMARKET strategy. Returns the ZK-withdraw tx
    hash (the on-chain, verifiable action) or None on a pre-withdraw failure."""
    sid = strategy["id"]
    meta = strategy.get("poly_meta") or {}
    token_id = meta.get("token_id")
    market_id = meta.get("market_id")
    outcome = meta.get("outcome")
    side = (meta.get("side") or "BUY").upper()
    if not token_id:
        print(f"   [Poly] ❌ strategy {sid} missing poly_meta.token_id")
        return None

    from_cid = int(strategy.get("from_chain") or BASE_CHAIN_ID)  # shielded vault chain (Base)
    base = get_evm_chain_config(from_cid)
    w3 = get_web3(base)
    account = get_executor_account(w3, from_cid)

    amount = strategy.get("amount") or 0
    amount_wei = int(Decimal(str(amount)) * Decimal(10 ** USDC_DECIMALS))
    if amount_wei <= 0:
        print(f"   [Poly] ❌ invalid amount {amount}")
        return None

    proof = _proof_from_zkp(strategy.get("zkp_data"))
    if not proof:
        print(f"   [Poly] ❌ strategy {sid} has no ZK proof")
        return None

    # 1. Shielded withdraw: USDC out of the Base vault → executor wallet. (Nullifier spent here.)
    usdc_base = base.token_address("USDC")
    zk_tx = zk_withdraw_from_vault(
        w3, account, base, usdc_base, account.address, amount_wei, proof,
        # Change note stays owned by the strategy's user, not the executor wallet it withdraws to.
        strategy.get("user_id"),
    )
    if zk_tx and on_withdraw_confirmed:
        try:
            on_withdraw_confirmed(zk_tx)
        except Exception as e:
            print(f"   [Poly] ⚠️ withdraw callback error: {e}")

    # 2. Fill fee — same model as swaps: a flat bps of notional, API rate for gateway orders.
    net_wei = amount_wei
    try:
        from fee_calc import compute_execution_fee_wei
        from fee_ledger import record_fee
        fee_wei = compute_execution_fee_wei(
            amount_wei, USDC_DECIMALS, 1.0, is_api=bool(strategy.get("billing_ref"))
        )
        if fee_wei > 0:
            net_wei = amount_wei - fee_wei
            record_fee(from_cid, "USDC", fee_wei, kind="execution", strategy_id=sid, tx_hash=zk_tx)
            print(f"   [Poly] [Fee] execution fee = {fee_wei} (net {net_wei})")
    except Exception as e:
        print(f"   [Poly] ⚠️ fee skipped: {e}")

    # Record the position (OPEN) BEFORE bridging so any later failure is reconcilable (funds + txs
    # are traceable from this row).
    entry_odds = (float(current_price) / 100.0) if current_price else None  # percent → probability
    pos = PolymarketPosition(
        strategy_id=sid,
        user_id=strategy.get("user_id"),
        market_id=str(market_id or ""),
        token_id=str(token_id),
        outcome=outcome,
        side=side,
        entry_odds=entry_odds,
        cost_usdc=str(net_wei),
        output_precommitment=strategy.get("output_precommitment"),
        status="OPEN",
    )
    db.session.add(pos)
    db.session.commit()

    # 3. Bridge Base USDC → Polygon USDC (LiFi) and WAIT for the funds to actually land on Polygon.
    #    A bridge is async: the source tx confirming ≠ funds on the destination chain, so we poll
    #    LiFi /status until DONE before placing the order (else it fails on "no funds").
    #    Recipient MUST be whoever signs the order (and later redeems): in TEE mode that's the
    #    CVM order-signer's address, otherwise the local Polygon executor. Using the signer's
    #    address (not a locally-derived key) keeps bridge→order→redeem on one address.
    poly = get_evm_chain_config(POLYGON_CHAIN_ID)
    poly_recipient = polymarket_client.executor_polygon_address()
    bridge = bridge_and_wait(
        from_chain=str(from_cid),
        to_chain=str(POLYGON_CHAIN_ID),
        from_token=usdc_base,
        to_token=poly.usdc,
        from_amount_wei=net_wei,
        recipient=poly_recipient,
    )
    pos.bridge_tx = bridge.get("src_tx")
    db.session.commit()

    # 4. Place the CLOB order (buy the outcome token near the current odds). Size from the amount
    #    that ACTUALLY arrived on Polygon (net of bridge fees/slippage), not the pre-bridge amount.
    received_wei = bridge.get("received_wei") or net_wei
    price = entry_odds if entry_odds else 0.5
    size_usdc = received_wei / (10 ** USDC_DECIMALS)
    order = polymarket_client.place_order(str(token_id), side, price, size_usdc)
    pos.entry_tx = str(order.get("order_id") or "")
    pos.shares = str(order.get("shares") or "")
    db.session.commit()

    print(f"   [Poly] ✅ entry for {sid}: order={pos.entry_tx} bridge={pos.bridge_tx}")
    # The strategy's tx_hash is the ZK withdraw — the on-chain, verifiable action.
    return zk_tx
