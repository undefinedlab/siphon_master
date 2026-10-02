"""Immutable routing for withdrawal-only vault generations.

Legacy proof payloads must never be allowed to choose their destination contract.
The generation and chain pair is resolved against this server-owned allowlist and
only the RPC URL/token metadata is inherited from normal chain configuration.
"""
from __future__ import annotations

from dataclasses import replace

from evm_chain_config import EvmChainConfig, get_evm_chain_config


_LEGACY_ENTRYPOINTS: dict[tuple[int, str], str] = {
    (8453, "base-legacy-2026-07"): "0x5433995fc5a0459E5ad7f2A81561384887F37174",
    (11155111, "sepolia-soft-era"): "0xE5126A49D1bb93957b4B2F63BCB05a1F8EA9e705",
}


def resolve_legacy_vault(chain_id: int, generation_id: str) -> EvmChainConfig:
    """Resolve an approved legacy vault without accepting a client-supplied address."""
    generation = str(generation_id or "").strip()
    entrypoint = _LEGACY_ENTRYPOINTS.get((int(chain_id), generation))
    if not entrypoint:
        raise ValueError(
            f"chain {chain_id} / generation '{generation}' is not an approved legacy exit vault"
        )
    chain = get_evm_chain_config(chain_id)
    return replace(
        chain,
        name=f"{chain.name} legacy exit",
        entrypoint=entrypoint,
    )

