from __future__ import annotations

import os
import re
import time

import base58
from web3 import Web3

from asp_membership import assert_label_in_asp

EVM_CHAIN_IDS = {"1", "11155111", "42161", "10", "8453", "84532", "137", "42431", "4217", "998", "999", "1337"}
EVM_PATTERN   = re.compile(r'^0x[0-9a-fA-F]{40}$')

# ── Sanctions screening (Chainalysis on-chain oracle) ────────────────────────
# Keyless: the oracle is a public smart contract, isSanctioned(address) → bool. Free, no
# API key. Same address on most chains; Base mainnet differs. Docs:
#   go.chainalysis.com/chainalysis-oracle-docs.html
_ORACLE_DEFAULT = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb"
_ORACLE_BY_CHAIN = {
    "8453": "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B",  # Base mainnet
}
_ORACLE_ABI = [{
    "inputs": [{"internalType": "address", "name": "addr", "type": "address"}],
    "name": "isSanctioned",
    "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
    "stateMutability": "view",
    "type": "function",
}]

# chainId → an RPC URL for the oracle call. Falls back to a public gateway per chain.
_ORACLE_RPC = {
    "8453":     os.getenv("BASE_MAINNET_RPC", "https://mainnet.base.org"),
    "1":        os.getenv("ETH_MAINNET_RPC", "https://eth.llamarpc.com"),
    "42161":    os.getenv("ARB_RPC", "https://arb1.arbitrum.io/rpc"),
    "10":       os.getenv("OP_RPC", "https://mainnet.optimism.io"),
    "137":      os.getenv("POLYGON_RPC", "https://polygon-rpc.com"),
}

# The oracle is only deployed on mainnets — skip testnets (never sanctioned there).
_ORACLE_CHAINS = set(_ORACLE_RPC.keys())

# Align with siphon-app / ASP: fail CLOSED on oracle RPC errors by default.
# Set SANCTIONS_ORACLE_FAIL_OPEN=1 only for local soak when RPC is flaky.
_ORACLE_FAIL_OPEN = os.getenv("SANCTIONS_ORACLE_FAIL_OPEN", "").lower() in ("1", "true", "yes")

_screen_cache: dict[str, tuple[bool, str, float]] = {}
_SCREEN_TTL = 3600  # 1h — sanctions lists change slowly


def check_sanctions(address: str, chain_id: str) -> tuple[bool, str]:
    """Return (is_sanctioned, reason) via the Chainalysis on-chain oracle.

    Positive hit → always block.
    RPC/oracle errors → fail CLOSED by default (treat as unavailable / block).
    Set SANCTIONS_ORACLE_FAIL_OPEN=1 to restore legacy fail-open.
    Testnets / unsupported chains: not screened (returns clean).
    """
    addr = (address or "").lower()
    cid = str(chain_id)
    if not addr or cid not in _ORACLE_CHAINS:
        return False, ""

    now = time.time()
    cache_key = f"{cid}:{addr}"
    cached = _screen_cache.get(cache_key)
    if cached and now - cached[2] < _SCREEN_TTL:
        return cached[0], cached[1]

    try:
        w3 = Web3(Web3.HTTPProvider(_ORACLE_RPC[cid], request_kwargs={"timeout": 4}))
        oracle = w3.eth.contract(
            address=Web3.to_checksum_address(_ORACLE_BY_CHAIN.get(cid, _ORACLE_DEFAULT)),
            abi=_ORACLE_ABI,
        )
        sanctioned = bool(oracle.functions.isSanctioned(Web3.to_checksum_address(addr)).call())
        result = (True, "Address is on the OFAC sanctions list (Chainalysis oracle)") if sanctioned else (False, "")
        _screen_cache[cache_key] = (result[0], result[1], now)
        return result
    except Exception as e:
        if _ORACLE_FAIL_OPEN:
            print(f"[sanctions] oracle check failed for {cid}:{addr}: {e} — failing open")
            return False, ""
        print(f"[sanctions] oracle check failed for {cid}:{addr}: {e} — failing closed")
        return True, "Sanctions oracle unavailable — execution paused until RPC recovers"

def is_valid_evm_address(addr: str) -> bool:
    return bool(EVM_PATTERN.match(addr))

def is_valid_solana_address(addr: str) -> bool:
    try:
        decoded = base58.b58decode(addr)
        return 32 <= len(decoded) <= 44
    except Exception:
        return False


def validate_note_label(
    label: str | int | None,
    *,
    chain_id: int | str | None = None,
) -> tuple[bool, str]:
    """Hard ASP gate: note label must be in the live association set before private spend / arm."""
    if label is None or str(label).strip() == "":
        return False, "note label required for Hard ASP"
    return assert_label_in_asp(label, chain_id=chain_id)


def validate_recipient(recipient_address: str, to_chain: str) -> tuple[bool, str]:
    """
    Returns (is_valid, error_message). Combines format validation with sanctions screening —
    a recipient must be a well-formed address AND not on a sanctions list.
    to_chain: EVM chain ID string ("1", "11155111", etc.) or "solana"
    """
    if not recipient_address:
        return False, "recipient_address is required"
    if not to_chain:
        return False, "to_chain is required"

    # Solana product chains: literal "solana", Devnet numeric id 900002, mainnet 900001.
    if to_chain.lower() == "solana" or str(to_chain) in ("900002", "900001"):
        if not is_valid_solana_address(recipient_address):
            return False, f"Invalid Solana address '{recipient_address}' for destination chain {to_chain}"
    elif to_chain in EVM_CHAIN_IDS:
        if not is_valid_evm_address(recipient_address):
            return False, f"Invalid EVM address '{recipient_address}' for destination chain {to_chain}"
    else:
        return False, f"Unknown destination chain '{to_chain}'"

    # Sanctions screening via the Chainalysis on-chain oracle (EVM mainnets only).
    if to_chain in EVM_CHAIN_IDS:
        sanctioned, reason = check_sanctions(recipient_address, to_chain)
        if sanctioned:
            return False, reason

    return True, ""
