"""Siphon-assigned Solana chain ids for ASP (not EVM / not genesis hashes).

Must stay aligned with:
  siphon-app/src/lib/chains/registry.ts
  siphon-fhe/trade-executor/solana_runtime.py
  siphon-asp-v2/docs/SOLANA-CHAIN-IDS.md
"""

from __future__ import annotations

SOLANA_MAINNET_CHAIN_ID = 900_001
SOLANA_DEVNET_CHAIN_ID = 900_002

SOLANA_CHAIN_IDS = frozenset({SOLANA_MAINNET_CHAIN_ID, SOLANA_DEVNET_CHAIN_ID})

PROFILE_ID = "solana-v1"


def is_solana_chain_id(chain_id) -> bool:
    try:
        return int(chain_id) in SOLANA_CHAIN_IDS
    except (TypeError, ValueError):
        return False
