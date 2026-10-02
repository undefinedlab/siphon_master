#!/usr/bin/env python3
"""Runnable self-check for gateway Sentry redaction.

    python3 -m app.observability_check

The gateway holds API keys, wallet signatures and proof payloads. Sentry ships stack-frame locals
by default, so this redaction is the control that makes an external reporter acceptable here.
If this fails, do not set SENTRY_DSN on the gateway.
"""
from __future__ import annotations

import sys

from app.observability import REDACTED, _before_send, scrub, scrub_string

failures: list[str] = []


def check(name: str, cond: bool) -> None:
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        failures.append(name)


check("api_key redacted", scrub({"api_key": "sk_live_x"})["api_key"] == REDACTED)
check("signature redacted", scrub({"signature": "0xdead"})["signature"] == REDACTED)
check("proof redacted", scrub({"proof": [1, 2, 3]})["proof"] == REDACTED)
check("billing_ref redacted", scrub({"billing_ref": "k.h"})["billing_ref"] == REDACTED)
check("nullifier redacted", scrub({"nullifier": "123"})["nullifier"] == REDACTED)
check("amount survives", scrub({"amount_minor": 1000})["amount_minor"] == 1000)
check("status survives", scrub({"status": "PENDING"})["status"] == "PENDING")
check("long hex redacted", scrub({"tx": "0x" + "a" * 64})["tx"] == REDACTED)
check("short value survives", scrub({"chain_id": "8453"})["chain_id"] == "8453")

nested = {"a": {"b": {"api_key": "sk_x", "ok": "keep"}}}
s = str(scrub(nested))
check("nested secret gone", "sk_x" not in s)
check("nested safe kept", "keep" in s)

cyc: dict = {"secret": "9"}
cyc["self"] = cyc
check("cycle handled", "depth-capped" in str(scrub(cyc)))

event = {
    "exception": {"values": [{
        "value": "boom 0x" + "d" * 64,
        "stacktrace": {"frames": [{"vars": {"api_key": "sk_live_secret"}}]},
    }]},
    "request": {
        "data": {"proof": [1]},
        "cookies": {"s": "1"},
        "headers": {"X-Api-Key": "sk_live_x", "Authorization": "Bearer t", "User-Agent": "curl"},
        "url": "https://api.siphon.money/v1/withdrawals?key=" + "a" * 60,
        "query_string": "key=" + "a" * 60,
    },
    "extra": {"pepper": "p", "request_id": "req-1"},
    "breadcrumbs": {"values": [{"message": "sig 0x" + "f" * 64, "data": {"secret": "1"}}]},
}
res = _before_send(event, {})
assert res is not None
blob = str(res)
check("frame vars removed", "sk_live_secret" not in blob)
check("body removed", "data" not in res["request"])
check("cookies removed", "cookies" not in res["request"])
check("query_string removed", "query_string" not in res["request"])
check("url query dropped", "?" not in res["request"]["url"])
check("X-Api-Key redacted", res["request"]["headers"]["X-Api-Key"] == REDACTED)
check("Authorization redacted", res["request"]["headers"]["Authorization"] == REDACTED)
check("User-Agent survives", res["request"]["headers"]["User-Agent"] == "curl")
check("pepper redacted", res["extra"]["pepper"] == REDACTED)
check("request_id survives", res["extra"]["request_id"] == "req-1")
check("exception value scrubbed", "d" * 64 not in blob)
check("breadcrumb scrubbed", "f" * 64 not in blob)


class Exploding(dict):
    def get(self, *a, **k):
        raise RuntimeError("boom")


check("fails closed on malformed event", _before_send(Exploding(), {}) is None)

print()
if failures:
    print(f"FAILED ({len(failures)}): " + ", ".join(failures))
    sys.exit(1)
print("gateway observability_check: OK")
