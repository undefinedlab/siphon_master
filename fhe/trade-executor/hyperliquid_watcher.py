"""Private perp positions: fund → open → watch → close → pay out.

A HYPERLIQUID strategy fires like any payout strategy (executor_runner._execute_attested_leg): the
enclave proves a WITHDRAW of the margin to this executor, and its BridgeOrder carries the USDC to
the executor's HyperCore account (hyperliquid_client.funding_payout) — via LI.FI from Base, or via
CoreDepositWallet from HyperEVM Testnet (998, Option A). This module takes it from there, one
HyperliquidPosition per fired strategy.

HyperliquidPosition.status:
  FUNDING     fired; the bridge order is moving the margin to Hyperliquid
  OPENING     margin landed (BridgeOrder.amount_out); entry IOC under cloid(id, "open", attempts)
  OPEN        filled — size, entry px and fee recorded; take profit / stop loss / GUARD watched
  CLOSING     exit IOC for the remaining size under cloid(id, "close", attempts); partials retry
  PAYOUT_DUE  owed margin + PnL − fees − funding (or the margin back, if it never opened)
  PAYING      payout signed and sent; only its response moves it on
  SETTLED     paid to payout_address on HyperCore (usdSend) or Arbitrum (withdraw3)
  REFUNDED    the bridge could not route; bridge_payout refunded the margin on the vault chain
  REVIEW      ambiguous — an operator decides. Never retried by code: retrying could pay twice.

Every user's margin sits in ONE Hyperliquid account, so nothing here acts on the account's
position: an exit is an opposite IOC of exactly this position's size (never market_close, which
closes the account's NET position), and payouts are computed from this position's own fills.

Crash safety: an order's cloid is written (as `attempts`) before the order is sent and its fills
are recorded in the same commit that bumps `attempts`, so a restarted executor looks the order up
by cloid instead of sending a second one.
"""
from __future__ import annotations

import math
import os
import threading
import time
from datetime import datetime, timezone

from database import BridgeOrder, HyperliquidPosition, Strategy, db
import hyperliquid_client as hl

# Close when equity falls to this share of margin. hyperliquid_client.leverage_cap keeps that
# above Hyperliquid's maintenance margin, so the shared account is never liquidated for one user.
GUARD = 0.30
# Entry attempts before the margin is paid back unopened (IOC found no fill within slippage).
MAX_OPEN_ATTEMPTS = 5
MAX_PAY_ATTEMPTS = 3
TAKER_FEE = float(os.environ.get("HYPERLIQUID_TAKER_FEE", "0.00045"))  # when fills lag the order
USDC = 10 ** 6
ACTIVE = ("FUNDING", "OPENING", "OPEN", "CLOSING", "PAYOUT_DUE", "PAYING")
_WATCH_INTERVAL = float(os.environ.get("HYPERLIQUID_WATCH_INTERVAL_SEC", "15"))
_last = [0.0]
# The scheduler thread and /hyperliquid/exit both drive positions; one at a time.
_lock = threading.RLock()


def _ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


def _sign(pos) -> int:
    return 1 if pos.side == "LONG" else -1


def _margin_usd(pos) -> float:
    return int(pos.margin_usdc or 0) / USDC


def _claim(pos, frm: str, **fields) -> bool:
    """Atomic status transition — the watcher and the exit route cannot both take a position."""
    n = HyperliquidPosition.query.filter_by(id=pos.id, status=frm).update(
        {**fields, "updated_at": datetime.utcnow()})
    db.session.commit()
    db.session.refresh(pos)
    return n == 1


def _owe(pos, amount_usd: float, error: str | None = None) -> None:
    pos.payout_usdc = str(max(0, math.floor(amount_usd * USDC)))
    pos.status, pos.attempts, pos.error = "PAYOUT_DUE", 0, error
    pos.closed_at = datetime.utcnow()


def _fill_from(res: dict, since_ms: int, order_cloid: str) -> dict:
    """Fills of an order just sent; the order's own response stands in while fills lag."""
    fill = hl.order_fills(order_cloid, since_ms)
    if fill["sz"] > 0:
        return fill
    sz, px = float(res["filled_sz"]), float(res["avg_px"])
    return {"status": "filled", "sz": sz, "avg_px": px, "fee": sz * px * TAKER_FEE}


# ── steps ───────────────────────────────────────────────────────────────────────────────────────

def _adopt() -> None:
    """Give every fired HYPERLIQUID strategy its position, keyed to the order funding it."""
    import json

    fired = (db.session.query(Strategy, BridgeOrder)
             .join(BridgeOrder, BridgeOrder.strategy_id == Strategy.id)
             .outerjoin(HyperliquidPosition, HyperliquidPosition.strategy_id == Strategy.id)
             .filter(Strategy.strategy_type == "HYPERLIQUID", BridgeOrder.status != "FAILED",
                     HyperliquidPosition.id.is_(None))
             .all())
    seen = set()
    for strat, order in fired:
        if strat.id in seen:
            continue
        seen.add(strat.id)
        meta = json.loads(strat.hl_meta or "{}")
        exit_to = meta["exit_to"]
        db.session.add(HyperliquidPosition(
            strategy_id=strat.id, bridge_order_id=order.id, user_id=(strat.user_id or "").lower(),
            coin=meta["coin"], side=meta["side"], leverage=int(meta["leverage"]),
            take_profit_px=meta.get("take_profit_px"), stop_loss_px=meta.get("stop_loss_px"),
            payout_chain=int(exit_to["to_chain_id"]), payout_address=exit_to["to_address"],
            status="FUNDING",
        ))
    db.session.commit()


def _fund(pos) -> None:
    o = BridgeOrder.query.get(pos.bridge_order_id)
    if o is None:
        pos.status, pos.error = "REVIEW", "funding order is gone"
    elif o.status == "DONE":
        if int(o.amount_out or 0) <= 0:
            pos.status, pos.error = "REVIEW", "funding order DONE with no delivered amount"
        else:
            pos.margin_usdc, pos.status = str(int(o.amount_out)), "OPENING"
    elif o.status == "REFUNDED":
        pos.status = "REFUNDED"
    elif o.status == "FAILED":
        # The spend reverted: nothing left the vault and the strategy re-arms. Drop this row so
        # the order its next fire writes is adopted instead.
        db.session.delete(pos)
    elif o.status == "REVIEW":
        pos.status, pos.error = "REVIEW", f"funding order REVIEW: {o.error or ''}"[:500]
    db.session.commit()


def _open(pos) -> None:
    since = _ms(pos.created_at)
    oc = hl.cloid(pos.id, "open", pos.attempts)
    fill = hl.order_fills(oc, since)
    if fill["status"] == "unknownOid":
        mark = hl.mark_px(pos.coin)
        if not mark:
            return
        size = hl.round_size(pos.coin, _margin_usd(pos) * pos.leverage / mark)
        if size * mark < 10:
            # Bridge fees took it under Hyperliquid's $10 minimum: nothing to open, hand it back.
            _owe(pos, _margin_usd(pos), "position under Hyperliquid's $10 minimum after bridge fees")
            db.session.commit()
            return
        res = hl.place_order(pos.coin, is_buy=pos.side == "LONG", size=size, order_cloid=oc)
        fill = {"status": "rejected", "sz": 0.0} if "rejected" in res else _fill_from(res, since, oc)
        pos.error = res.get("rejected")
    elif fill["status"] == "filled" and fill["sz"] <= 0:
        return  # filled, fills not visible yet — read them next tick
    if fill["sz"] > 0:
        pos.size = pos.entry_size = fill["sz"]
        pos.entry_px, pos.fees_usd = fill["avg_px"], fill["fee"]
        pos.status, pos.opened_at, pos.attempts, pos.error = "OPEN", datetime.utcnow(), 0, None
    else:
        pos.attempts += 1
        if pos.attempts >= MAX_OPEN_ATTEMPTS:
            _owe(pos, _margin_usd(pos), f"entry did not fill after {pos.attempts} tries: {pos.error or ''}")
    db.session.commit()


def equity(pos, mark: float) -> float:
    """What the position is worth now: margin + unrealized PnL − fees paid so far."""
    return _margin_usd(pos) + _sign(pos) * pos.size * (mark - pos.entry_px) - pos.fees_usd


def _exit_reason(pos, mark: float) -> str | None:
    up = pos.side == "LONG"
    if pos.take_profit_px and (mark >= pos.take_profit_px if up else mark <= pos.take_profit_px):
        return "tp"
    if pos.stop_loss_px and (mark <= pos.stop_loss_px if up else mark >= pos.stop_loss_px):
        return "sl"
    if equity(pos, mark) <= GUARD * _margin_usd(pos):
        return "guard"
    return None


def _close(pos) -> None:
    since = _ms(pos.opened_at or pos.created_at)
    oc = hl.cloid(pos.id, "close", pos.attempts)
    fill = hl.order_fills(oc, since)
    if fill["status"] == "unknownOid":
        size = hl.round_size(pos.coin, pos.size)
        fill = {"sz": 0.0}
        if size > 0:
            res = hl.place_order(pos.coin, is_buy=pos.side == "SHORT", size=size, order_cloid=oc)
            if "rejected" in res:
                pos.error = res["rejected"]
            else:
                fill = _fill_from(res, since, oc)
    elif fill["status"] == "filled" and fill["sz"] <= 0:
        return
    if fill["sz"] > 0:
        pos.realized_pnl += _sign(pos) * fill["sz"] * (fill["avg_px"] - pos.entry_px)
        pos.fees_usd += fill["fee"]
        pos.size = max(0.0, pos.size - fill["sz"])
    pos.attempts += 1  # the next order (if any) gets a fresh cloid
    if hl.round_size(pos.coin, pos.size) <= 0:
        pos.funding_usd = hl.funding_usd(pos.coin, pos.side, pos.entry_size, pos.entry_px,
                                         _ms(pos.opened_at or pos.created_at), int(time.time() * 1000))
        _owe(pos, _margin_usd(pos) + pos.realized_pnl - pos.fees_usd - pos.funding_usd)
    db.session.commit()


def _pay(pos) -> None:
    if not _claim(pos, "PAYOUT_DUE", status="PAYING"):
        return
    amount = int(pos.payout_usdc or 0) / USDC
    if amount < 0.01:
        pos.status, pos.payout_ref = "SETTLED", "nothing owed"
        db.session.commit()
        return
    via = pos.payout_chain
    if via == hl.ARBITRUM_CHAIN_ID and amount <= hl.WITHDRAW_FEE_USD + 1:
        via = hl.HYPERLIQUID_LIFI_ID  # a withdraw3 would eat most of it; same address on HyperCore
    try:
        if via == hl.HYPERLIQUID_LIFI_ID:
            hl.send_usd(amount, pos.payout_address)
        else:
            hl.withdraw(amount, pos.payout_address)
    except hl.HyperliquidNotConfigured as exc:
        pos.status, pos.error = "PAYOUT_DUE", str(exc)[:500]  # nothing was signed
    except Exception as exc:
        msg = str(exc)
        if msg.startswith("hyperliquid refused"):
            # Hyperliquid answered and refused: nothing moved, so trying again is safe.
            pos.attempts += 1
            pos.status = "PAYOUT_DUE" if pos.attempts < MAX_PAY_ATTEMPTS else "REVIEW"
        else:
            pos.status = "REVIEW"  # unknown whether it was sent — check the ledger, never re-send
        pos.error = msg[:500]
    else:
        tag = "usdSend" if via == hl.HYPERLIQUID_LIFI_ID else "withdraw3"
        pos.status, pos.payout_chain, pos.error = "SETTLED", via, None
        pos.payout_ref = f"{tag} {amount:.6f} @ {datetime.utcnow().isoformat()}Z"
    db.session.commit()


def _step(pos, mids: dict) -> None:
    start = pos.status
    if start == "PAYING":
        # Only a dead process leaves this: the payout may or may not have gone out.
        pos.status, pos.error = "REVIEW", "payout was in flight when the executor stopped — check the ledger"
        db.session.commit()
        return
    if pos.status == "FUNDING":
        _fund(pos)
    if pos.status == "OPENING":
        _open(pos)
    elif pos.status == "OPEN":
        mark = mids.get(pos.coin.upper())
        reason = _exit_reason(pos, mark) if mark else None
        if reason and _claim(pos, "OPEN", status="CLOSING", attempts=0, close_reason=reason):
            print(f"[HL] {pos.id} {reason} @ {mark} — closing")
            _close(pos)
    elif pos.status == "CLOSING":
        _close(pos)
    if pos.status == "PAYOUT_DUE":
        _pay(pos)


def process_open_positions() -> None:
    """One pass over live positions. Called each scheduler tick; throttled."""
    if not hl.is_configured() or time.monotonic() - _last[0] < _WATCH_INTERVAL:
        return
    _last[0] = time.monotonic()
    with _lock:
        _adopt()
        rows = HyperliquidPosition.query.filter(HyperliquidPosition.status.in_(ACTIVE)).all()
        if not rows:
            return
        try:
            mids = hl.all_mids() if any(p.status == "OPEN" for p in rows) else {}
        except Exception as exc:
            print(f"[HL] mids unavailable: {exc}")
            mids = {}
        for pos in rows:
            try:
                _step(pos, mids)
            except Exception as exc:
                db.session.rollback()
                print(f"[HL] position {pos.id} {pos.status}: {exc}")


def exit_position(pos) -> dict:
    """Close an OPEN position now (the user's Close button) and pay it out."""
    with _lock:
        if not _claim(pos, "OPEN", status="CLOSING", attempts=0, close_reason="user"):
            raise RuntimeError(f"position is {pos.status}, not OPEN")
        _close(pos)
        if pos.status == "PAYOUT_DUE":
            _pay(pos)
        return pos.to_dict()
