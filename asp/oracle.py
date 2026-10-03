"""Chainalysis OFAC on-chain oracle."""
from __future__ import annotations

import logging
import time

import config

log = logging.getLogger("aspv2.oracle")

_cache: dict[str, tuple[bool, float]] = {}


class OracleUnavailable(Exception):
    """RPC missing or call failed."""


def _ttl_for(sanctioned: bool) -> float:
    if sanctioned:
        return float(getattr(config, "ORACLE_CACHE_TTL_HIT_SEC", 3600))
    return float(getattr(config, "ORACLE_CACHE_TTL_CLEAN_SEC", 60))


def is_sanctioned(address: str, chain_id: int) -> bool:
    from web3 import Web3

    addr = (address or "").lower().strip()
    if not addr or chain_id not in config.ORACLE_CHAINS:
        return False

    key = f"{chain_id}:{addr}"
    hit = _cache.get(key)
    if hit:
        sanctioned, ts = hit
        if time.time() - ts < _ttl_for(sanctioned):
            return sanctioned

    url = config.rpc_url_for(chain_id)
    if not url:
        log.warning("oracle skipped (no RPC) for %s", key)
        if config.ORACLE_FAIL_CLOSED:
            raise OracleUnavailable(f"no RPC for chain {chain_id}")
        return False

    try:
        w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 20}))
        oracle_addr = config.ORACLE_BY_CHAIN.get(chain_id, config.ORACLE_DEFAULT)
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(oracle_addr),
            abi=config.ORACLE_ABI,
        )
        sanctioned = bool(contract.functions.isSanctioned(Web3.to_checksum_address(addr)).call())
        _cache[key] = (sanctioned, time.time())
        return sanctioned
    except OracleUnavailable:
        raise
    except Exception as exc:
        log.warning(
            "oracle check failed for %s — %s",
            key,
            "fail closed" if config.ORACLE_FAIL_CLOSED else "fail open",
        )
        if config.ORACLE_FAIL_CLOSED:
            raise OracleUnavailable(str(exc)) from exc
        return False
