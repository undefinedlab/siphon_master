"""Protocol domain separators — zkv2 test-vectors/domains.json."""
from __future__ import annotations

import json
from functools import lru_cache

import config
from core.poseidon import hash2, hash_inputs


@lru_cache(maxsize=1)
def load_domains() -> dict[str, int]:
    data = json.loads(config.ZKV2_DOMAINS_PATH.read_text())
    return {
        "DOMAIN_SMT_KEY": int(data["DOMAIN_SMT_KEY"]),
        "DOMAIN_SMT_LEAF": int(data["DOMAIN_SMT_LEAF"]),
        "DOMAIN_VAULT_SCOPE": int(data["DOMAIN_VAULT_SCOPE"]),
        "DOMAIN_PAYEE": int(data["DOMAIN_PAYEE"]),
        "DOMAIN_CHAIN_EVM": int(data["DOMAIN_CHAIN_EVM"]),
        "DOMAIN_CHAIN_SOL": int(data["DOMAIN_CHAIN_SOL"]),
        "DOMAIN_PAYEE_SOL_COMPRESS": int(data["DOMAIN_PAYEE_SOL_COMPRESS"]),
    }


def smt_key(label: int, domain_smt_key: int | None = None) -> int:
    d = load_domains()
    dom = domain_smt_key if domain_smt_key is not None else d["DOMAIN_SMT_KEY"]
    return hash_inputs(dom, label)


def smt_leaf_hash(label: int, domain_smt_leaf: int | None = None) -> int:
    d = load_domains()
    dom = domain_smt_leaf if domain_smt_leaf is not None else d["DOMAIN_SMT_LEAF"]
    return hash_inputs(dom, label)


def vault_scope_id_evm(chain_id: int, vault_address: int) -> int:
    """PoseidonT4([DOMAIN_CHAIN_EVM, chainId, vaultAddressField]) — CommitmentLib."""
    d = load_domains()
    return hash_inputs(d["DOMAIN_CHAIN_EVM"], chain_id, vault_address)


def vault_scope_id_sol(program_id_field: int, vault_pda_field: int) -> int:
    """Poseidon([DOMAIN_CHAIN_SOL, programIdField, vaultPdaField]) — solana-v1."""
    d = load_domains()
    return hash_inputs(d["DOMAIN_CHAIN_SOL"], program_id_field, vault_pda_field)


def payee_id_sol(pubkey_field: int) -> int:
    """Poseidon(DOMAIN_PAYEE, Poseidon(DOMAIN_PAYEE_SOL_COMPRESS, pubkeyField))."""
    d = load_domains()
    payee_field = hash_inputs(d["DOMAIN_PAYEE_SOL_COMPRESS"], pubkey_field)
    return hash_inputs(d["DOMAIN_PAYEE"], payee_field)


def nonce_stem(vault_scope_id: int, deposit_nonce: int) -> int:
    """PoseidonT4([DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce])."""
    d = load_domains()
    return hash_inputs(d["DOMAIN_VAULT_SCOPE"], vault_scope_id, deposit_nonce)


def mint_label_salted(vault_scope_id: int, deposit_nonce: int, user_salt: int) -> int:
    return hash2(nonce_stem(vault_scope_id, deposit_nonce), user_salt)
