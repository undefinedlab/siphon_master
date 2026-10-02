#!/usr/bin/env python3
"""Private perps on Hyperliquid TESTNET, through the executor's own watcher: open → close → pay.

Runs hyperliquid_watcher's real state machine against a throwaway in-memory DB. The vault + LI.FI
funding leg is mainnet-only, so the funding order is marked DONE by hand with --margin; everything
after it is the production path: per-position sizing, cloid fills, an exit of exactly this
position's size, PnL / fee / funding accounting, and the payout.

  HYPERLIQUID_TESTNET=1 HYPERLIQUID_MASTER_PRIVATE_KEY=0x... \\
    python scripts/e2e_hyperliquid.py --coin ETH --side LONG --margin 12 --leverage 1 [--pay-to 0x...]

Inside the executor image (/opt/hl is HYPERLIQUID_PYTHON there) the key arrives on stdin instead:
  ~/Downloads/siphon-hl-testnet-e2e.sh

The master account needs testnet USDC in its perps balance (app.hyperliquid-testnet.xyz/drip).
Without --pay-to the run stops at PAYOUT_DUE and nothing leaves the account. One run costs about
two taker fees on the notional (~$0.01 at $12).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# Forced, not defaulted: inside the executor container DATABASE_URI is the live strategies DB, and
# this run must never touch it.
os.environ["DATABASE_URI"] = "sqlite://"
for k, v in {"NOTE_DB_URI": "postgresql://e2e:e2e@127.0.0.1:5432/e2e", "SERVER_HMAC_SECRET": "e2e",
             "DB_ALLOW_DEFAULT_KEY": "1"}.items():
    os.environ.setdefault(k, v)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--coin", default="ETH")
    ap.add_argument("--side", default="LONG", choices=("LONG", "SHORT"))
    ap.add_argument("--margin", type=float, default=12.0, help="USDC margin (notional = margin × leverage)")
    ap.add_argument("--leverage", type=int, default=1)
    ap.add_argument("--hold", type=float, default=5.0, help="seconds to hold before closing")
    ap.add_argument("--pay-to", help="address to pay the closed position to on HyperCore (usdSend)")
    args = ap.parse_args()

    import hyperliquid_client as hl

    if not hl.testnet():
        print("refusing: set HYPERLIQUID_TESTNET=1 (this script trades real orders)")
        return 2
    acct = hl.account()
    state = hl.info({"type": "clearinghouseState", "user": acct})
    print(f"account {acct}  perps withdrawable ${float(state.get('withdrawable') or 0):.2f}")

    from flask import Flask
    from database import BridgeOrder, HyperliquidPosition, Strategy, db
    import hyperliquid_watcher as w

    app = Flask(__name__)
    app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", SQLALCHEMY_TRACK_MODIFICATIONS=False)
    db.init_app(app)
    with app.app_context():
        db.create_all()
        user = args.pay_to or acct
        meta = hl.validate_order({"coin": args.coin, "side": args.side, "leverage": args.leverage,
                                  "exit_to": {"to_address": user}}, args.margin, user)
        import json
        strat = Strategy(user_id=user.lower(), strategy_type="HYPERLIQUID", asset_in="USDC",
                         asset_out=meta["coin"], amount=args.margin, recipient_address=user,
                         status="EXECUTED", output_mode="bridge", hl_meta=json.dumps(meta))
        db.session.add(strat)
        db.session.flush()
        db.session.add(BridgeOrder(strategy_id=strat.id, chain_id=8453, token="0x" + "0" * 40,
                                   to_chain_id="1337", to_token="USDC", to_address=acct, min_out="1",
                                   refund_address=user, status="DONE",
                                   amount_out=str(int(args.margin * 10 ** 6))))
        db.session.commit()

        w._adopt()
        pos = HyperliquidPosition.query.one()
        for _ in range(6):
            w._step(pos, {})
            print(f"  {pos.status}  {pos.error or ''}")
            if pos.status not in ("FUNDING", "OPENING"):
                break
            time.sleep(3)
        if pos.status != "OPEN":
            print(f"did not open: {pos.to_dict()}")
            return 1
        print(f"OPEN  {pos.side} {pos.size} {pos.coin} @ {pos.entry_px}  fee ${pos.fees_usd:.4f}")

        time.sleep(args.hold)
        assert w._claim(pos, "OPEN", status="CLOSING", attempts=0, close_reason="user")
        for _ in range(6):
            w._close(pos)
            if pos.status != "CLOSING":
                break
            time.sleep(3)
        print(f"{pos.status}  realized ${pos.realized_pnl:+.4f}  fees ${pos.fees_usd:.4f}  "
              f"funding ${pos.funding_usd or 0:+.4f}  payout {int(pos.payout_usdc or 0) / 1e6:.6f} USDC")
        if pos.status != "PAYOUT_DUE":
            return 1
        if not args.pay_to:
            print("stopping at PAYOUT_DUE (pass --pay-to to send it)")
            return 0
        w._pay(pos)
        print(f"{pos.status}  {pos.payout_ref or pos.error}")
        return 0 if pos.status == "SETTLED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
