"""Polymarket resolution watcher: redeem resolved positions, shield proceeds back to the vault.

Runs inside the scheduler loop (throttled to POLYMARKET_WATCH_INTERVAL_SEC, default 5 min).
Lifecycle per position row:

  OPEN ──(market resolved on CTF)──▶ REDEEMING ──redeem──▶ payout>0 ─bridge─▶ deposit ─▶ SETTLED
                                                  └──────▶ payout=0 (lost) ────────────▶ SETTLED

Proceeds re-enter the strategy's from_chain USDC vault as a private note under the position's
output_precommitment — only the user holds the matching nullifier/secret. A crash between redeem
and settle is recoverable: REDEEMING rows with a recorded payout and no settle_tx retry the
bridge+deposit leg on the next pass.
"""
import json
import os
import threading
import time

from database import db, PolymarketPosition, Strategy
import polymarket_client

DEFAULT_FROM_CHAIN = 8453  # Base — where POLYMARKET strategies are funded from

_CHECK_EVERY_SEC = int(os.environ.get("POLYMARKET_WATCH_INTERVAL_SEC", "300"))
# After a FAK sell (exit), poll the shared escrow balance this long for the fill to settle before
# measuring realized proceeds.
_EXIT_FILL_WAIT_SEC = int(os.environ.get("POLYMARKET_EXIT_FILL_WAIT_SEC", "45"))
_last_check = 0.0
_condition_cache: dict = {}
# The executor's Polygon wallet is shared escrow (v1); redeem and exit both read realized proceeds
# as a balance delta, so serialize those windows to keep concurrent settlements from interleaving.
_settle_lock = threading.Lock()


def _condition_id_for(pos) -> "str | None":
    """poly_meta.condition_id when the frontend supplied it, else a Gamma lookup by token id."""
    strat = Strategy.query.get(pos.strategy_id)
    if strat and strat.poly_meta:
        try:
            cid = (json.loads(strat.poly_meta) or {}).get("condition_id")
            if cid:
                return str(cid)
        except Exception:
            pass
    if pos.token_id in _condition_cache:
        return _condition_cache[pos.token_id]
    cid = polymarket_client.condition_id_for_token(pos.token_id)
    if cid:
        _condition_cache[pos.token_id] = cid
    return cid


def _dest_chain_for(pos) -> int:
    strat = Strategy.query.get(pos.strategy_id)
    return int(getattr(strat, "from_chain", None) or DEFAULT_FROM_CHAIN)


def _bridge_and_deposit(dest_cid: int, payout_wei: int, precommitment) -> "tuple[str, int]":
    """Bridge Polygon USDC.e → dest_cid USDC and re-deposit under `precommitment`. Returns
    (deposit_tx, received_wei). Shared by resolution-settlement and early-exit."""
    from evm_chain_config import get_evm_chain_config
    from evm_executor import get_web3, get_executor_account, deposit_to_vault
    from lifi_executor import bridge_and_wait

    cfg = get_evm_chain_config(dest_cid)
    w3 = get_web3(cfg)
    account = get_executor_account(w3, dest_cid)
    bridge = bridge_and_wait(
        from_chain=str(polymarket_client.POLYGON_CHAIN_ID),
        to_chain=str(dest_cid),
        from_token=polymarket_client.USDC_E_ADDRESS,
        to_token=cfg.usdc,
        from_amount_wei=payout_wei,
        recipient=account.address,
    )
    received = int(bridge.get("received_wei") or 0) or payout_wei
    tx = deposit_to_vault(w3, account, cfg, cfg.usdc, received, int(precommitment))
    return tx, received


def _shield_back(pos, payout_wei: int) -> None:
    """Bridge Polygon USDC.e → from_chain USDC and re-deposit under output_precommitment."""
    dest_cid = _dest_chain_for(pos)
    if not pos.output_precommitment:
        # No shield note on file (shouldn't happen — frontend always sends one). Don't bridge into
        # a note we don't have; leave the proceeds on Polygon and flag loudly.
        print(f"   [PolyWatch] ⚠️ {pos.id} has NO output_precommitment — {payout_wei} USDC.e "
              f"left in executor escrow on Polygon; manual shield required.")
        pos.status = "SETTLED"
        db.session.commit()
        return

    tx, received = _bridge_and_deposit(dest_cid, payout_wei, pos.output_precommitment)
    pos.settle_tx = tx
    pos.status = "SETTLED"
    db.session.commit()
    print(f"   [PolyWatch] ✅ {pos.id} settled: {received} USDC shielded to chain {dest_cid} ({tx})")


def exit_position(pos, fraction: float = 1.0, new_precommitment: "str | None" = None) -> dict:
    """Close a position early by SELLING its outcome shares on the CLOB (before resolution), then
    shielding the proceeds back to the user's vault.

      full  (fraction>=1): sell all shares → shield to the position's own output_precommitment,
                           status → CLOSED.
      partial (0<frac<1):  sell that fraction → shield to a FRESH `new_precommitment` (the original
                           note is reserved for the remainder), position stays OPEN with fewer shares.

    Share accounting is best-effort: FAK fills what the book offers now, and proceeds are the
    shared-escrow balance delta. Any shares that didn't fill remain held (logged).
    """
    if pos.status != "OPEN":
        raise RuntimeError(f"position {pos.id} is {pos.status}, not OPEN — cannot exit")
    if not polymarket_client.is_configured():
        raise RuntimeError("Polymarket not configured — cannot exit")

    fraction = max(0.0, min(1.0, float(fraction)))
    if fraction <= 0:
        raise RuntimeError("fraction must be > 0")
    total_shares = float(pos.shares or 0)
    if total_shares <= 0:
        raise RuntimeError(f"position {pos.id} has no shares to sell")

    is_full = fraction >= 1.0
    precommitment = pos.output_precommitment if is_full else new_precommitment
    if not precommitment:
        raise RuntimeError("partial close requires a fresh output_precommitment")
    shares_to_sell = total_shares if is_full else total_shares * fraction

    with _settle_lock:
        addr = polymarket_client.executor_polygon_address()
        before = polymarket_client.usdc_e_balance(addr)
        price = polymarket_client.market_price(pos.token_id, "SELL")
        order = polymarket_client.sell_shares(pos.token_id, price, shares_to_sell)

        # FAK fills against the resting book ~immediately, but settlement to USDC.e can lag a beat.
        proceeds = 0
        deadline = time.time() + _EXIT_FILL_WAIT_SEC
        while time.time() < deadline:
            proceeds = max(0, polymarket_client.usdc_e_balance(addr) - before)
            if proceeds > 0:
                break
            time.sleep(3)
        if proceeds <= 0:
            raise RuntimeError(
                f"exit sell for {pos.id} did not fill within {_EXIT_FILL_WAIT_SEC}s "
                f"(order {order.get('order_id')}); position left OPEN")

        # The shares are SOLD from here on — persist that fact BEFORE the slow bridge leg, so a
        # crash mid-bridge can't leave the row claiming shares the escrow no longer holds.
        #   full:    flip into REDEEMING with the payout recorded — exactly the state the watcher's
        #            existing crash-recovery resumes from (retry bridge+deposit, never re-sell).
        #   partial: shrink shares/cost now; the sold portion's proceeds ride the bridge next.
        if is_full:
            pos.status = "REDEEMING"
            pos.redeem_tx = str(order.get("order_id") or "")  # the liquidating sell order
            pos.payout_usdc = str(proceeds)
        else:
            remaining = max(0.0, total_shares - shares_to_sell)
            pos.shares = str(remaining)
            pos.cost_usdc = str(int(float(pos.cost_usdc or 0) * (1.0 - fraction)))
            # status stays OPEN — the remainder can resolve or be closed later.
        db.session.commit()

        dest_cid = _dest_chain_for(pos)
        try:
            settle_tx, received = _bridge_and_deposit(dest_cid, proceeds, precommitment)
        except Exception:
            if not is_full:
                # The share reduction above is already committed (it reflects reality). The sold
                # portion's proceeds sit in escrow with no pending row — flag for manual shield.
                print(f"   [PolyWatch] ⚠️ partial exit for {pos.id}: sold {shares_to_sell:.2f} "
                      f"shares but shielding failed — {proceeds} USDC.e parked in Polygon escrow "
                      f"under precommitment {precommitment}; manual shield required.")
            raise

    if is_full:
        pos.status = "CLOSED"
        pos.settle_tx = settle_tx
    db.session.commit()
    print(f"   [PolyWatch] ✅ {pos.id} {'closed' if is_full else 'partially closed'}: "
          f"sold {shares_to_sell:.2f} shares → {received} USDC shielded to chain {dest_cid} ({settle_tx})")
    return {
        "position_id": pos.id,
        "status": pos.status,
        "sold_shares": shares_to_sell,
        "proceeds_usdc_e": proceeds,
        "shielded_wei": received,
        "settle_tx": settle_tx,
        "order_id": order.get("order_id"),
    }


def _process_one(pos) -> None:
    cid = _condition_id_for(pos)
    if not cid:
        return

    if pos.status == "OPEN":
        if not polymarket_client.is_resolved(cid):
            return
        addr = polymarket_client.executor_polygon_address()
        before = polymarket_client.usdc_e_balance(addr)
        pos.status = "REDEEMING"
        db.session.commit()

        pos.redeem_tx = polymarket_client.redeem_positions(cid, pos.token_id)
        payout = max(0, polymarket_client.usdc_e_balance(addr) - before)
        pos.payout_usdc = str(payout)
        db.session.commit()

        if payout == 0:
            pos.status = "SETTLED"  # outcome lost — shares burned for nothing to shield
            db.session.commit()
            print(f"   [PolyWatch] {pos.id} resolved against us — settled with payout 0.")
            return
        _shield_back(pos, payout)

    elif pos.status == "REDEEMING":
        # Crash recovery: redeemed but never shielded → retry the bridge+deposit leg only.
        payout = int(pos.payout_usdc or 0)
        if pos.redeem_tx and payout > 0 and not pos.settle_tx:
            _shield_back(pos, payout)


def process_open_positions() -> None:
    """Called every scheduler cycle; internally throttled. Cheap when nothing is open."""
    global _last_check
    now = time.time()
    if now - _last_check < _CHECK_EVERY_SEC:
        return
    _last_check = now

    if not polymarket_client.is_configured():
        return
    rows = PolymarketPosition.query.filter(
        PolymarketPosition.status.in_(("OPEN", "REDEEMING"))
    ).all()
    if not rows:
        return
    print(f"[PolyWatch] Checking {len(rows)} open position(s) for resolution…")
    for pos in rows:
        try:
            _process_one(pos)
        except Exception as e:
            db.session.rollback()
            print(f"   [PolyWatch] ⚠️ {pos.id}: {e}")
