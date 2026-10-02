"""Business-API policy for exit-only and strategy-ready vault generations.

When the checksum-pinned generation manifest is configured it is the authority;
environment values may only agree with it. Manifest failure or env drift denies.
"""
from __future__ import annotations

import logging
import os

from app.services import generation_manifest

logger = logging.getLogger(__name__)


def _env_active(chain_id: int) -> str | None:
    value = os.getenv(f"ACTIVE_VAULT_GENERATION_{int(chain_id)}", "").strip()
    return value or None


def _env_exit_only() -> set[str]:
    return {
        value.strip()
        for value in os.getenv("EXIT_ONLY_VAULT_GENERATIONS", "").split(",")
        if value.strip()
    }


def _active(chain_id: int) -> str | None:
    env_value = _env_active(chain_id)
    if not generation_manifest.configured():
        return env_value
    try:
        manifest_value = generation_manifest.active_generation(chain_id)
    except generation_manifest.ManifestError as exc:
        logger.error("generation manifest unusable; denying chain %s: %s", chain_id, exc)
        return None
    if env_value and env_value != manifest_value:
        logger.error(
            "ACTIVE_VAULT_GENERATION_%s=%s disagrees with manifest %s; denying",
            chain_id, env_value, manifest_value,
        )
        return None
    return manifest_value


def _exit_only() -> set[str]:
    env_set = _env_exit_only()
    if not generation_manifest.configured():
        return env_set
    try:
        return env_set | generation_manifest.exit_only_generations()
    except generation_manifest.ManifestError:
        return env_set


def validate_strategy_generation(chain_id: int, generation_id: str | None) -> dict:
    generation = str(generation_id or "").strip()
    if not generation:
        return {"valid": False, "code": "VAULT_GENERATION_REQUIRED"}
    active = _active(chain_id)
    if not active:
        return {"valid": False, "code": "VAULT_GENERATION_UNAVAILABLE"}
    if generation != active:
        return {
            "valid": False,
            "code": "VAULT_EXIT_ONLY" if generation in _exit_only() else "VAULT_GENERATION_NOT_ACTIVE",
        }
    return {"valid": True, "code": None}


def resolve_deposit_generation(chain_id: int) -> dict:
    """Resolve deposits entirely from server configuration; clients cannot select an old vault."""
    active = _active(chain_id)
    if not active:
        return {"valid": False, "code": "VAULT_GENERATION_UNAVAILABLE", "generation_id": None}
    if active in _exit_only():
        return {"valid": False, "code": "VAULT_EXIT_ONLY", "generation_id": None}
    return {"valid": True, "code": None, "generation_id": active}


def rejection_message(code: str) -> str:
    return {
        "VAULT_GENERATION_REQUIRED": "vault_generation_id is required.",
        "VAULT_EXIT_ONLY": (
            "These funds are in an older vault. Withdraw them and deposit into the current "
            "vault before creating an automation."
        ),
        "VAULT_GENERATION_NOT_ACTIVE": "The selected vault generation is not strategy-capable.",
        "VAULT_GENERATION_UNAVAILABLE": "No active strategy vault is configured for this chain.",
    }.get(code, "Vault generation rejected.")
