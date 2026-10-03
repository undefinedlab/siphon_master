"""Salted label derivation — PROTOCOL §2.3 / §2.7."""
from __future__ import annotations

from core.domains import mint_label_salted, vault_scope_id_evm, vault_scope_id_sol
from core.poseidon import field_mod
from solana_chain_ids import is_solana_chain_id

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def solana_pubkey_field(pubkey: str) -> int:
    """Decode a case-sensitive base58 Solana public key into its field input."""
    text = pubkey.strip()
    value = 0
    try:
        for char in text:
            value = value * 58 + _BASE58_ALPHABET.index(char)
    except ValueError as exc:
        raise ValueError("invalid Solana public key") from exc
    payload_bytes = (value.bit_length() + 7) // 8
    decoded_bytes = len(text) - len(text.lstrip("1")) + payload_bytes
    if decoded_bytes != 32:
        raise ValueError("Solana public key must encode 32 bytes")
    return field_mod(value)


def evm_vault_scope_id(chain_id: int, vault_hex: str) -> int:
    raw = vault_hex.lower().removeprefix("0x")
    vault_field = int(raw, 16)
    return vault_scope_id_evm(chain_id, vault_field)


def derive_deposit_label(
    *,
    chain_id: int,
    vault_address: str,
    deposit_nonce: int,
    user_salt: int,
    program_id: str | None = None,
) -> int:
    if user_salt == 0:
        raise ValueError("userSalt must be non-zero")
    if is_solana_chain_id(chain_id):
        if not program_id:
            raise ValueError("program_id required for Solana label derivation")
        scope = vault_scope_id_sol(
            solana_pubkey_field(program_id),
            solana_pubkey_field(vault_address),
        )
    else:
        scope = evm_vault_scope_id(chain_id, vault_address)
    return mint_label_salted(scope, deposit_nonce, user_salt)
