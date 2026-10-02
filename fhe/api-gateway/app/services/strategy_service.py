"""Strategy discovery + validation (semantic/shape only — no metering, no executor mutation).

The functions catalog is static (agent discovery). validate() is a free dry-run: it checks the
strategy type is known, an encrypted bound is present for bounded types, and amount/chain are sane —
before any state change. It never writes usage_events and never calls the executor.
"""

# Frontend strategy types (mapped to engine types by the executor at fire time — see CLAUDE.md §8).
_TYPES = {
    "LIMIT_SELL": {"bounds": ("encrypted_upper_bound",),
                   "params_schema": {"encrypted_upper_bound": "hex ciphertext (limit price, cents)"}},
    "LIMIT_BUY": {"bounds": ("encrypted_lower_bound",),
                  "params_schema": {"encrypted_lower_bound": "hex ciphertext (limit price, cents)"}},
    "TWAP": {"bounds": (), "params_schema": {"legs": "int", "interval_sec": "int"}},
    "DCA": {"bounds": (), "params_schema": {"legs": "int", "interval_sec": "int"}},
    "RANGE_GRID": {"bounds": (), "params_schema": {"grid_levels": "int", "legs": "array"}},
}


# Executor status -> gateway lifecycle name (spec §6.1). PENDING/ARMED both present as "armed"
# (the gateway lifecycle collapses the executor's pre-fire states to one caller-facing name).
_STATUS_MAP = {
    "PENDING": "armed",
    "ARMED": "armed",
    "EXECUTING": "executing",
    "EXECUTED": "executed",
    "PARTIALLY_EXECUTED": "partially_executed",
    "ABORTED": "aborted",
    "EXPIRED": "expired",
    "FAILED": "failed",
    "SETTLED": "settled",
}


def lifecycle_status(executor_status: str | None) -> str:
    """Map an executor status to its gateway lifecycle name (unknown -> lowercased passthrough)."""
    if not executor_status:
        return "unknown"
    return _STATUS_MAP.get(executor_status.upper(), executor_status.lower())


def functions_catalog() -> dict:
    """Static catalog of strategy types + their param schemas (agent discovery)."""
    return {
        "types": [{"name": name, "params_schema": meta["params_schema"]}
                  for name, meta in _TYPES.items()]
    }


def validate(payload: dict) -> dict:
    """Semantic + shape validation. Returns {valid: bool, errors: [...]}. No side effects."""
    errors: list[str] = []
    st = payload.get("strategy_type")
    if st not in _TYPES:
        errors.append(f"unknown strategy_type '{st}'; expected one of {sorted(_TYPES)}")
        return {"valid": False, "errors": errors}

    # bounded types (LIMIT_*) require at least one encrypted bound present
    required_bounds = _TYPES[st]["bounds"]
    if required_bounds and not any(payload.get(b) for b in required_bounds):
        errors.append(f"{st} requires an encrypted bound ({' or '.join(required_bounds)})")

    amount = payload.get("amount")
    if not isinstance(amount, (int, float)) or amount <= 0:
        errors.append("amount must be a positive number")

    if not payload.get("chain_id"):
        errors.append("chain_id is required")

    if payload.get("chain_id"):
        from app.services.vault_generation import validate_strategy_generation, rejection_message
        decision = validate_strategy_generation(
            int(payload["chain_id"]), payload.get("vault_generation_id")
        )
        if not decision["valid"]:
            errors.append(f"{decision['code']}: {rejection_message(decision['code'])}")

    return {"valid": not errors, "errors": errors}
