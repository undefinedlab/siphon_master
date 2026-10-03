"""Solana deposit verification scaffold.

Phase 2 validates wire identifiers and deployment allowlists. Transaction
confirmation/parsing is deliberately pending until the program IDL is fixed.
"""
from __future__ import annotations

import os
from typing import Any

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_INDEX = {char: index for index, char in enumerate(_BASE58_ALPHABET)}


def _decode_base58(value: str, *, field: str, expected_bytes: int) -> bytes:
    text = (value or "").strip()
    if not text:
        raise ValueError(f"{field} required")
    number = 0
    try:
        for char in text:
            number = number * 58 + _BASE58_INDEX[char]
    except KeyError as exc:
        raise ValueError(f"{field} must be base58") from exc
    decoded = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    decoded = b"\x00" * (len(text) - len(text.lstrip("1"))) + decoded
    if len(decoded) != expected_bytes:
        raise ValueError(f"{field} must encode {expected_bytes} bytes")
    return decoded


def _allowlist(name: str) -> frozenset[str]:
    return frozenset(item.strip() for item in os.getenv(name, "").split(",") if item.strip())


def _validate_allowlisted_pubkey(value: str, *, field: str, env_name: str) -> str:
    text = (value or "").strip()
    _decode_base58(text, field=field, expected_bytes=32)
    allowed = _allowlist(env_name)
    if not allowed:
        raise ValueError(f"{env_name} is not configured")
    if text not in allowed:
        raise ValueError(f"{field} is not in {env_name}")
    return text


def verify_solana_deposit(
    signature: str,
    program_id: str,
    vault_pda: str,
    commitment: str | int,
    depositor: str,
) -> dict[str, Any]:
    """Validate a Solana deposit envelope without applying EVM checksum rules."""
    sig = (signature or "").strip()
    _decode_base58(sig, field="signature", expected_bytes=64)
    program = _validate_allowlisted_pubkey(
        program_id, field="program_id", env_name="SOLANA_PROGRAM_ALLOWLIST"
    )
    vault = _validate_allowlisted_pubkey(
        vault_pda, field="vault_pda", env_name="VAULT_PDA_ALLOWLIST"
    )
    owner = (depositor or "").strip()
    _decode_base58(owner, field="depositor", expected_bytes=32)

    try:
        commitment_int = int(str(commitment), 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("commitment must be an integer") from exc
    if commitment_int < 0 or commitment_int >= 2**256:
        raise ValueError("commitment must fit uint256")

    rpc_url = os.getenv("SOLANA_RPC_URL", "").strip()
    message = (
        "Solana RPC confirmation pending implementation"
        if rpc_url
        else "Solana RPC not configured; confirmation pending RPC"
    )
    return {
        "status": "pending_rpc",
        "message": message,
        "signature": sig,
        "programId": program,
        "vaultPda": vault,
        "commitment": str(commitment_int),
        "depositor": owner,
        "rpcConfigured": bool(rpc_url),
    }
