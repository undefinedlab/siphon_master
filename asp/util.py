"""Small shared helpers (no hop graph)."""
from __future__ import annotations

import re

from solana_chain_ids import is_solana_chain_id

_EVM_ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")
# Base58 pubkey (no 0/O/I/l); length covers ed25519 pubkeys as base58.
_SOL_PUBKEY = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


def normalize_address(address: str | None) -> str | None:
    """Normalize an EVM 0x address (lowercase)."""
    if not address:
        return None
    addr = address.strip().lower()
    if not _EVM_ADDR.match(addr):
        return None
    return addr


def normalize_solana_pubkey(address: str | None) -> str | None:
    """Normalize a Solana depositor pubkey (base58; case-preserving)."""
    if not address:
        return None
    addr = address.strip()
    if not _SOL_PUBKEY.match(addr):
        return None
    return addr


def normalize_depositor(address: str | None, chain_id: int | None = None) -> str | None:
    """Chain-aware depositor identity for ASP /screen."""
    if chain_id is not None and is_solana_chain_id(chain_id):
        return normalize_solana_pubkey(address)
    return normalize_address(address)
