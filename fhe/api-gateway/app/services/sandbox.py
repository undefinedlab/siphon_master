"""Sandbox — deterministic fixtures for `sk_test_` keys.

Every business evaluates an API by building a prototype on a Friday afternoon. If that requires
testnet ETH, a funded wallet, and a two-minute deposit wait, they leave before they see the product.
A `sk_test_` key runs the full request path — auth, policy, subaccounts, metering, operations,
webhooks — against fixtures instead of chain and executor.

Two rules keep the sandbox honest:

* **Same code path.** Sandbox short-circuits only the *downstream* (chain, executor, sanctions
  oracle). Auth, ownership checks, policy evaluation, ledger writes and state transitions are the
  real ones, so a prototype that works here exercised the logic that matters.
* **Deterministic.** Ids and tx hashes derive from a hash of the inputs, so the same request yields
  the same result on every run and tests can assert exact values.

`X-Simulate` forces an outcome, which is the part integrators actually need: you cannot build error
handling against an API that only ever succeeds.
"""
from __future__ import annotations

import hashlib

from fastapi import Request

from app.errors import (
    AspUnavailable,
    Conflict,
    DownstreamUnavailable,
    InsufficientQuota,
    ProofFailed,
    Sanctioned,
    TransactionFailed,
)

SIMULATE_HEADER = "X-Simulate"

# Scenario -> the error it forces. `success` and `slow` are handled inline.
_SCENARIOS: dict[str, type[Exception]] = {
    "sanctioned": Sanctioned,
    "insufficient_quota": InsufficientQuota,
    "asp_unavailable": AspUnavailable,
    "downstream_unavailable": DownstreamUnavailable,
    "proof_failed": ProofFailed,
    "transaction_failed": TransactionFailed,
    "conflict": Conflict,
}

SCENARIOS = sorted(set(_SCENARIOS) | {"success", "pending", "failed"})


def is_sandbox_key(raw_or_plan: str | None) -> bool:
    """A key is sandbox if its plan is `test`. Callers pass ApiKey.plan."""
    return (raw_or_plan or "").lower() == "test"


def is_sandbox_request(request: Request) -> bool:
    return bool(getattr(request.state, "sandbox", False))


def scenario(request: Request) -> str | None:
    v = (request.headers.get(SIMULATE_HEADER) or "").strip().lower()
    return v or None


def apply_scenario(request: Request) -> str | None:
    """Raise the forced error for `X-Simulate`, if any. Returns the scenario name otherwise.

    Only honoured for sandbox keys — a production key sending `X-Simulate` is ignored outright, so
    the header can never be used to induce a failure against real funds.
    """
    if not is_sandbox_request(request):
        return None

    name = scenario(request)
    if not name or name in ("success", "pending", "failed"):
        return name

    exc = _SCENARIOS.get(name)
    if exc is None:
        from app.errors import BadRequest

        raise BadRequest(f"Unknown {SIMULATE_HEADER} scenario '{name}'. Known: {SCENARIOS}")
    raise exc(f"Simulated '{name}' (sandbox).")


def _digest(*parts: object) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()


def fake_wallet(api_key_id: str) -> str:
    """The deterministic wallet a sandbox key acts as.

    A sandbox integrator has no funded wallet and no reason to produce EIP-191 signatures — the
    signature authorizes moving REAL funds, and in sandbox nothing moves. Requiring one would make
    the whole point of `sk_test_` unreachable (which it was, until this existed). Stable per key so
    ownership checks and operation history behave exactly as they will in production.
    """
    return "0x" + _digest("wallet", api_key_id)[:40]


def fake_tx_hash(*parts: object) -> str:
    """Deterministic 32-byte tx hash for a sandbox operation."""
    return "0x" + _digest("tx", *parts)[:64]


def fake_note_commitment(*parts: object) -> str:
    return "0x" + _digest("note", *parts)[:64]


def fake_receipt(chain_id: int, tx_hash: str) -> dict:
    """A mined, successful receipt — sandbox confirmations are instant by design."""
    block = int(_digest("block", chain_id, tx_hash)[:8], 16) % 10_000_000
    return {
        "status": 1,
        "transactionHash": tx_hash,
        "blockNumber": block,
        "chainId": chain_id,
        "confirmations": 12,
    }


def fake_anonymity_set(chain_id: int, asset: str) -> int:
    """Stable per (chain, asset) so a `min_anonymity_set` policy is testable both ways.

    USDC lands high and ETH deliberately lands low, so an integrator can exercise the pass AND the
    fail branch of a privacy policy without waiting for real pool conditions.
    """
    if str(asset).upper() == "ETH":
        return 7
    return 128


def fake_pool_state(chain_id: int, asset: str) -> dict:
    return {
        "chain_id": chain_id,
        "asset": str(asset).upper(),
        "anonymity_set": fake_anonymity_set(chain_id, asset),
        "leaf_count": fake_anonymity_set(chain_id, asset) * 2,
        "asp_root": "0x" + _digest("asproot", chain_id, asset)[:64],
        "asp_root_stale": False,
        "source": "sandbox",
    }


def fake_attestation_digest(chain_id: int) -> str:
    return _digest("attestation", chain_id)[:64]


def fake_list_version() -> str:
    return "sandbox-ofac-2026-08-01"
