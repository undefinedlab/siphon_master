"""Fail-closed policy for strategy-capable vault generations.

The caller may name a generation, but it cannot make that generation active. The
server-owned ACTIVE_VAULT_GENERATION_<chainId> setting is the authority. Rows from
before this field existed therefore fail closed at both creation and execution.
"""
from __future__ import annotations

import logging
import os
import json
from collections.abc import Callable

import generation_manifest

logger = logging.getLogger(__name__)


def _active_generation(chain_id: int) -> str | None:
    env_value = os.getenv(f"ACTIVE_VAULT_GENERATION_{chain_id}", "").strip() or None
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


def _exit_only_generations() -> set[str]:
    env_set = {
        value.strip()
        for value in os.getenv("EXIT_ONLY_VAULT_GENERATIONS", "").split(",")
        if value.strip()
    }
    if not generation_manifest.configured():
        return env_set
    try:
        return env_set | generation_manifest.exit_only_generations()
    except generation_manifest.ManifestError:
        return env_set


def _expected_entrypoint(chain_id: int) -> str:
    """Lower-case Entrypoint the active generation must be bound to; empty denies."""
    env_value = os.getenv(f"ACTIVE_VAULT_ENTRYPOINT_{chain_id}", "").strip().lower()
    if not generation_manifest.configured():
        return env_value
    try:
        manifest_value = (generation_manifest.active_entrypoint(chain_id) or "").strip().lower()
    except generation_manifest.ManifestError as exc:
        logger.error("generation manifest unusable; denying entrypoint for chain %s: %s", chain_id, exc)
        return ""
    if env_value and env_value != manifest_value:
        logger.error(
            "ACTIVE_VAULT_ENTRYPOINT_%s=%s disagrees with manifest %s; denying",
            chain_id, env_value, manifest_value,
        )
        return ""
    return manifest_value


def strategy_chain_id(payload: dict) -> int:
    """The chain a strategy spends ON.

    Strategy.to_dict() emits `from_chain`/`to_chain`, never `chain_id` — reading 'chain_id' alone
    yielded 0 for every real row, so get_evm_chain_config(0) raised and the attested submission
    failed with the nullifiers already claimed. `from_chain` is the shielded side (where the vault
    is), which is what a spend targets; `chain_id` is accepted first only because the tests and
    some internal callers construct dicts that way.
    """
    for key in ("chain_id", "from_chain"):
        raw = payload.get(key)
        if raw not in (None, ""):
            try:
                return int(raw)
            except (TypeError, ValueError):
                continue
    return 0


def _carries_client_proof(payload: dict) -> bool:
    """True if the caller supplied a Groth16 proof — top level, or on any leg.

    Legs matter: a v2 TWAP/grid payload carries no top-level `zk_proof` at all, only per-leg ones,
    so a top-level-only test would read it as attested and wave it past this whole policy.
    """
    if payload.get("zk_proof") or payload.get("zkp_data"):
        return True
    legs = payload.get("legs")
    if isinstance(legs, list):
        return any(
            isinstance(leg, dict) and (leg.get("zk_proof") or leg.get("zkp_data"))
            for leg in legs
        )
    return False


def is_attested_strategy(payload: dict) -> bool:
    """True for an enclave-armed v3 strategy: no client proof AND a VaultKernel on its chain.

    This policy does not apply to those, and NOT as a relaxation: every clause of it is
    v1-Entrypoint-shaped. It matches a caller-named generation against ACTIVE_VAULT_GENERATION_*
    (and, at execution, a proof root the active-generation indexer already knows). A v3 spend has
    neither, so it fails closed however healthy it is. What the policy buys — "funds in a retired
    vault must not arm" — v3 gets structurally instead: the kernel address comes from server
    config, never the request, and the enclave proves against the CURRENT state root, so a note
    from a retired generation is simply not in the tree and cannot produce a valid proof.

    The absence of a proof alone is NOT enough — a pre-upgrade row has no proof either, and
    treating one as attested would skip the very check that exists to reject it. The kernel
    address comes from server config, so this cannot be influenced by the payload.
    """
    if _carries_client_proof(payload):
        return False
    try:
        from evm_chain_config import get_evm_chain_config

        return bool(get_evm_chain_config(strategy_chain_id(payload)).vault_kernel)
    except Exception:
        return False


def _v3_generation_id(payload: dict) -> str | None:
    """The generation an attested strategy belongs to: its VaultKernel.

    `v3-<kernel>` is the same identity the note rows carry in `vault_id`, so a strategy row stays
    joinable to the notes it spends. Taken from server config, never from the payload.
    """
    try:
        from evm_chain_config import get_evm_chain_config

        kernel = get_evm_chain_config(strategy_chain_id(payload)).vault_kernel
    except Exception:
        return None
    return f"v3-{kernel}" if kernel else None


def generation_decision(payload: dict, validator: Callable[[dict], dict] | None = None) -> dict:
    """The one entry point both gates use: exempt attested v3 strategies, else run `validator`.

    Both branches return the same ok/code/generation_id shape. They did not once — the exempt
    branch returned a bare {"ok": True} and the arming path 500'd on KeyError('generation_id')
    writing the strategy row.
    """
    if is_attested_strategy(payload):
        return {"ok": True, "code": None, "generation_id": _v3_generation_id(payload)}
    return (validator or validate_strategy_generation)(payload)


def validate_strategy_generation(payload: dict) -> dict:
    """Return a stable policy decision for create-time and execution-time checks."""
    raw_chain = payload.get("from_chain", payload.get("chain_id"))
    try:
        chain_id = int(raw_chain)
    except (TypeError, ValueError):
        return {"ok": False, "code": "VAULT_GENERATION_UNAVAILABLE", "generation_id": None}

    generation = str(payload.get("vault_generation_id") or "").strip()
    if not generation:
        return {"ok": False, "code": "VAULT_GENERATION_REQUIRED", "generation_id": None}

    active = _active_generation(chain_id)
    if not active:
        return {
            "ok": False,
            "code": "VAULT_GENERATION_UNAVAILABLE",
            "generation_id": generation,
        }
    if generation != active:
        code = (
            "VAULT_EXIT_ONLY"
            if generation in _exit_only_generations()
            else "VAULT_GENERATION_NOT_ACTIVE"
        )
        return {"ok": False, "code": code, "generation_id": generation}
    return {"ok": True, "code": None, "generation_id": generation}


def _proofs(payload: dict) -> list[dict] | None:
    legs = payload.get("legs")
    if isinstance(legs, list) and legs:
        proofs: list[dict] = []
        for leg in legs:
            if not isinstance(leg, dict):
                return None
            proof = leg.get("zk_proof") or leg.get("zkp_data")
            if isinstance(proof, str):
                try:
                    proof = json.loads(proof)
                except (TypeError, ValueError):
                    return None
            if not isinstance(proof, dict):
                return None
            proofs.append(proof)
        return proofs
    proof = payload.get("zk_proof") or payload.get("zkp_data")
    if isinstance(proof, str):
        try:
            proof = json.loads(proof)
        except (TypeError, ValueError):
            proof = None
    return [proof] if isinstance(proof, dict) else None


def validate_strategy_provenance(
    payload: dict,
    *,
    configured_entrypoint: str | None = None,
    root_lookup: Callable[[int, str, str], bool] | None = None,
) -> dict:
    """Bind the claimed generation to the configured vault and an indexed proof root."""
    decision = validate_strategy_generation(payload)
    if not decision["ok"]:
        return decision
    chain_id = int(payload.get("from_chain", payload.get("chain_id")))
    generation = decision["generation_id"]

    if os.getenv(f"INDEXER_VAULT_GENERATION_{chain_id}", "").strip() != generation:
        return {"ok": False, "code": "VAULT_INDEXER_GENERATION_MISMATCH", "generation_id": generation}

    expected_entrypoint = _expected_entrypoint(chain_id)
    if configured_entrypoint is None:
        from evm_chain_config import get_evm_chain_config
        configured_entrypoint = get_evm_chain_config(chain_id).entrypoint
    if not expected_entrypoint or expected_entrypoint != str(configured_entrypoint).strip().lower():
        return {"ok": False, "code": "VAULT_ENTRYPOINT_MISMATCH", "generation_id": generation}

    proofs = _proofs(payload)
    if not proofs:
        return {"ok": False, "code": "VAULT_PROOF_ROOT_UNKNOWN", "generation_id": generation}
    asset = str(payload.get("asset_in") or "").upper()
    if root_lookup is None:
        from vault_index import is_known_root
        root_lookup = is_known_root
    for proof in proofs:
        root = str(proof.get("stateRoot") or "").strip()
        if not root or not root_lookup(chain_id, asset, root):
            return {"ok": False, "code": "VAULT_PROOF_ROOT_UNKNOWN", "generation_id": generation}
    return decision


def strategy_generation_message(code: str) -> str:
    messages = {
        "VAULT_GENERATION_REQUIRED": (
            "vault_generation_id is required; older or unclassified funds cannot run strategies"
        ),
        "VAULT_EXIT_ONLY": (
            "These funds are in an older vault. Withdraw them and deposit into the current "
            "vault before creating an automation."
        ),
        "VAULT_GENERATION_NOT_ACTIVE": "The selected vault generation is not strategy-capable.",
        "VAULT_GENERATION_UNAVAILABLE": "No active strategy vault is configured for this chain.",
        "VAULT_INDEXER_GENERATION_MISMATCH": "The active vault and indexer generation do not match.",
        "VAULT_ENTRYPOINT_MISMATCH": "The active generation is not bound to the configured Entrypoint.",
        "VAULT_PROOF_ROOT_UNKNOWN": "The strategy proof root is not known by the active-generation indexer.",
    }
    return messages.get(code, "Vault generation rejected.")
