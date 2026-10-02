#!/usr/bin/env python3
"""E2E bootstrap: faucet (devnet) → Jupiter SOL/USDC limit plan/craft.

Usage:
  # Devnet faucet only
  set SOLANA_NETWORK=devnet
  python scripts/e2e_jupiter_limit_sol_usdc.py --faucet --pubkey <base58>

  # Craft Jupiter Trigger limit (needs JUPITER_API_KEY + typically mainnet funds)
  set JUPITER_API_KEY=...
  python scripts/e2e_jupiter_limit_sol_usdc.py --craft --pubkey <base58> --amount 100000000 --price 200 --side LIMIT_SELL

Honest physics: faucet = Solana RPC airdrop (not mainnet). Jupiter Trigger = public
mainnet API — not a Siphon private vault spend.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Allow running from trade-executor root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    p = argparse.ArgumentParser(description="Siphon Solana faucet + Jupiter SOL/USDC limit bootstrap")
    p.add_argument("--pubkey", required=True, help="Phantom / wallet base58 pubkey")
    p.add_argument("--faucet", action="store_true", help="Request 1 SOL airdrop (devnet/testnet)")
    p.add_argument("--craft", action="store_true", help="Craft Jupiter Trigger deposit for limit order")
    p.add_argument("--amount", type=int, default=100_000_000, help="Base units (lamports or USDC 1e6)")
    p.add_argument("--price", type=float, default=200.0, help="Trigger USD price for SOL")
    p.add_argument("--side", default="LIMIT_SELL", choices=["LIMIT_SELL", "LIMIT_BUY"])
    p.add_argument("--lamports", type=int, default=1_000_000_000, help="Airdrop size")
    args = p.parse_args()

    if not args.faucet and not args.craft:
        p.error("Specify --faucet and/or --craft")

    out = {"pubkey": args.pubkey}

    if args.faucet:
        from solana_faucet import request_sol_airdrop

        out["faucet"] = request_sol_airdrop(args.pubkey, args.lamports)
        print(json.dumps({"faucet": out["faucet"]}, indent=2))

    if args.craft:
        from jupiter_solana import craft_trigger_limit_deposit, describe_sol_usdc_limit_plan

        plan = describe_sol_usdc_limit_plan(
            amount=args.amount,
            trigger_price_usd=args.price,
            side=args.side,
            user_pubkey=args.pubkey,
        )
        craft = craft_trigger_limit_deposit(
            user_pubkey=args.pubkey, amount=args.amount, side=args.side
        )
        out["plan"] = plan
        out["craft"] = {
            "requestId": craft.get("requestId") or craft.get("depositRequestId"),
            "keys": sorted(craft.keys()),
            "hasTransaction": bool(
                craft.get("transaction")
                or craft.get("tx")
                or craft.get("serializedTransaction")
            ),
        }
        print(json.dumps({"plan": plan, "craft": out["craft"]}, indent=2))
        print(
            "\nNext: sign craft.transaction with Phantom, then POST /solana/jupiter/limit/submit"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
