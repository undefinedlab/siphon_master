#!/usr/bin/env python3
"""
Runnable self-check for Sentry redaction in the executor.

    python3 observability_check.py

observability.py claims it strips note secrets before events leave this process. That claim is
the only thing making an external error reporter acceptable in a service that handles spendable
material, so it gets tested rather than trusted.

A leaked (nullifier, secret) pair is user funds. If this file fails, do not set SENTRY_DSN.

Mirrors siphon-app/src/lib/sentryRedaction.check.ts — same cases, same expectations, so the two
halves of the system cannot drift apart silently.
"""
from __future__ import annotations

import sys

from observability import REDACTED, _before_send, scrub, scrub_string

failures: list[str] = []


def check(name: str, cond: bool) -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}")
        failures.append(name)


print("secret-shaped keys are dropped regardless of value")
note = {
    "nullifier": "12345678901234567890",
    "secret": "98765432109876543210",
    "userSalt": "4242",
    "zkp_data": {"pi_a": ["1", "2"]},
    "amount": "1000",
    "label": "555",
    "strategy_id": "42",
}
out = scrub(note)
check("nullifier redacted", out["nullifier"] == REDACTED)
check("secret redacted", out["secret"] == REDACTED)
check("userSalt redacted (matches /salt/)", out["userSalt"] == REDACTED)
check("zkp_data redacted", out["zkp_data"] == REDACTED)
# Non-secret fields must survive or the reports are useless.
check("amount survives", out["amount"] == "1000")
check("label survives", out["label"] == "555")
check("strategy_id survives", out["strategy_id"] == "42")

print("long opaque values are redacted even under an innocent key")
out = scrub({
    "commitment": "0x" + "a" * 64,
    "payload": "A" * 120,
    "note": "ok",
    "wallet": "0x" + "b" * 40,
})
check("long hex redacted", out["commitment"] == REDACTED)
check("long base64 redacted", out["payload"] == REDACTED)
check("wallet address redacted", out["wallet"] == REDACTED)
check("short strings survive", out["note"] == "ok")

print("nested structures are walked")
nested = {"a": {"b": {"c": {"nullifier": "123", "ok": "keep"}}}}
s = str(scrub(nested))
check("nested secret gone", "'123'" not in s)
check("nested safe value kept", "keep" in s)

print("lists of notes")
notes = [{"nullifier": "111", "amount": "5"}, {"nullifier": "222", "amount": "7"}]
s = str(scrub(notes))
check("list secrets gone", "111" not in s and "222" not in s)
check("list safe values kept", "'5'" in s)

print("cycles and deep nesting do not hang or raise")
cyc: dict = {"nullifier": "999"}
cyc["self"] = cyc
s = str(scrub(cyc))
check("cyclic secret gone", "999" not in s)
check("depth cap engaged", "depth-capped" in s)

print("error messages are scrubbed")
msg = f"failed to spend note 0x{'b' * 64} for tag 0x{'c' * 40}"
out_s = scrub_string(msg)
check("commitment in message gone", "b" * 64 not in out_s)
check("message text survives", "failed to spend note" in out_s)

print("the DSN itself is never echoed back")
check("dsn key redacted", scrub({"dsn": "https://key@o1.ingest.sentry.io/1"})["dsn"] == REDACTED)

print("before_send strips frame locals and request bodies")
event = {
    "exception": {
        "values": [{
            "value": f"boom 0x{'d' * 64}",
            "stacktrace": {"frames": [{"vars": {"nullifier": "777", "secret": "888"}}]},
        }]
    },
    "request": {
        "data": {"nullifier": "999"},
        "cookies": {"session": "abc"},
        "url": "https://x/createStrategy?tag=0x" + "e" * 40,
        "headers": {"Authorization": "Bearer sometoken", "User-Agent": "curl"},
    },
    "extra": {"secret": "555", "strategy_id": "42"},
    "breadcrumbs": {"values": [{"message": "spending 0x" + "f" * 64, "data": {"secret": "1"}}]},
}
res = _before_send(event, {})
assert res is not None
blob = str(res)
check("frame vars removed", "vars" not in str(res["exception"]))
check("request body removed", "data" not in res["request"])
check("cookies removed", "cookies" not in res["request"])
check("query string dropped from url", "?" not in res["request"]["url"])
check("authorization header redacted", res["request"]["headers"]["Authorization"] == REDACTED)
check("safe header survives", res["request"]["headers"]["User-Agent"] == "curl")
check("extra secret redacted", res["extra"]["secret"] == REDACTED)
check("extra safe field survives", res["extra"]["strategy_id"] == "42")
check("exception value scrubbed", "d" * 64 not in blob)
check("breadcrumb scrubbed", "f" * 64 not in blob)
check("no raw secrets anywhere in event", "777" not in blob and "888" not in blob)

print("before_send fails CLOSED — a redaction bug drops the event, never sends it raw")


class Exploding(dict):
    def get(self, *a, **k):  # noqa: D102
        raise RuntimeError("boom")


check("malformed event returns None", _before_send(Exploding(), {}) is None)

print()
if failures:
    print(f"FAILED ({len(failures)}): " + ", ".join(failures))
    print("Do NOT enable SENTRY_DSN on the executor until these pass.")
    sys.exit(1)
print("observability_check: OK — secrets redacted, safe fields preserved")
