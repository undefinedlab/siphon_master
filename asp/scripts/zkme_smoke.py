#!/usr/bin/env python3
"""Smoke-test zkMe KYT credentials and optional live ASP /screen."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env.local")
load_dotenv(ROOT / ".env.production")
load_dotenv(ROOT / ".env")

import config
from zkme import ZkMeUnavailable, get_api_status, is_configured, screen_address


def main() -> int:
    parser = argparse.ArgumentParser(description="zkMe KYT smoke test")
    parser.add_argument(
        "--address",
        default="0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        help="EVM address to score (default: vitalik.eth)",
    )
    parser.add_argument("--chain-id", type=int, default=8453, help="Chain ID (default: 8453 Base)")
    parser.add_argument("--asp-url", default=os.getenv("ASP_URL", ""), help="Optional ASP base URL")
    parser.add_argument("--asp-token", default=os.getenv("ASP_SCREEN_TOKEN", ""), help="ASP bearer token")
    args = parser.parse_args()

    if not is_configured():
        print("FAIL: ZKME_MCH_NO / ZKME_API_KEY not set", file=sys.stderr)
        return 1

    try:
        status = get_api_status()
        print("zkMe status OK")
        print(f"  support_api ({len(status.support_api)}): {', '.join(status.support_api)}")
        print(f"  support_coin: {len(status.support_coin)} assets")
        for coin in ("ETH", "ETH-Base", "USDC-Base"):
            print(f"    {coin}: {'yes' if coin in status.support_coin else 'no'}")
    except ZkMeUnavailable as exc:
        print(f"FAIL: zkMe status: {exc}", file=sys.stderr)
        return 1

    try:
        result = screen_address(args.address, args.chain_id)
        print(
            f"risk score={result.risk_score} level={result.risk_level} "
            f"decision={result.decision}"
        )
    except ZkMeUnavailable as exc:
        print(f"FAIL: zkMe risk score: {exc}", file=sys.stderr)
        return 1

    asp_url = (args.asp_url or "").rstrip("/")
    if asp_url and args.asp_token:
        import urllib.request

        body = json.dumps(
            {
                "chainId": args.chain_id,
                "depositor": args.address.lower(),
            }
        ).encode()
        req = urllib.request.Request(
            f"{asp_url}/screen",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {args.asp_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read())
                print(f"ASP /screen HTTP {resp.status} decision={payload.get('decision')}")
                deps = payload.get("deps") or {}
                print(f"  deps.zkme={deps.get('zkme')} kytEntitlement={deps.get('kytEntitlement')}")
        except Exception as exc:
            print(f"WARN: ASP /screen: {exc}", file=sys.stderr)

    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
