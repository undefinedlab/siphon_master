"""On-chain verification — VaultKernel.Deposited + ComplianceHub postman (v2)."""
from __future__ import annotations

import logging
import os
from typing import Any

from web3 import Web3

import config
from core.label import derive_deposit_label
from db import get_decision_by_commitment, get_decision_by_tx

log = logging.getLogger("aspv2.chain_verify")

DEPOSITED_ABI = [
    {
        "anonymous": False,
        "inputs": [
            # D1 added `token` and moved `indexed` onto it — depositor is deliberately NOT indexed
            # (PROTOCOL 2.7, and INTEGRATION.md says so explicitly). This ABI still described the
            # pre-D1 5-argument event, so topic0 never matched and get_logs returned nothing:
            # the watcher silently admitted zero deposits on every chain.
            {"indexed": False, "internalType": "address", "name": "depositor", "type": "address"},
            {"indexed": True, "internalType": "address", "name": "token", "type": "address"},
            {"indexed": False, "internalType": "uint256", "name": "amount", "type": "uint256"},
            {"indexed": False, "internalType": "uint256", "name": "commitment", "type": "uint256"},
            {"indexed": False, "internalType": "uint256", "name": "depositNonce", "type": "uint256"},
            {"indexed": False, "internalType": "uint256", "name": "stateRootAfter", "type": "uint256"},
        ],
        "name": "Deposited",
        "type": "event",
    }
]


def _event_signature(abi: dict) -> str:
    return f"{abi['name']}({','.join(i['type'] for i in abi['inputs'])})"


# Derived, never hand-written. The topic used to be a literal string in watch_deposits.py that
# disagreed with this ABI; deriving it makes that class of drift impossible.
DEPOSITED_SIGNATURE = _event_signature(DEPOSITED_ABI[0])
DEPOSITED_TOPIC = "0x" + Web3.keccak(text=DEPOSITED_SIGNATURE).hex().removeprefix("0x")

HUB_POSTMAN_ABI = [
    {
        "inputs": [],
        "name": "postman",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "admittedRoot",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "revokedRoot",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]


def _w3(chain_id: int | None = None) -> Web3 | None:
    url = None
    if chain_id is not None:
        url = config.rpc_url_for(chain_id)
    url = url or config.RPC_URL or os.getenv("ASP_POSTMAN_RPC") or ""
    if not url:
        return None
    return Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 20}))


def onchain_postman_address(chain_id: int | None = None) -> str | None:
    w3 = _w3(chain_id)
    if not w3:
        return None
    cid = chain_id if chain_id is not None else int(w3.eth.chain_id)
    hub = config.compliance_hub_address(cid) or (os.getenv("ASP_COMPLIANCE_HUB") or "").strip()
    if not hub:
        return None
    try:
        c = w3.eth.contract(address=Web3.to_checksum_address(hub), abi=HUB_POSTMAN_ABI)
        return str(c.functions.postman().call()).lower()
    except Exception as exc:
        log.warning("ComplianceHub.postman() read failed: %s", exc)
        return None


def assert_postman_key_matches_chain(account_address: str, chain_id: int | None = None) -> None:
    onchain = onchain_postman_address(chain_id)
    if onchain is None:
        raise RuntimeError(
            "Cannot verify ComplianceHub.postman on-chain "
            "(set ASP_COMPLIANCE_HUB_<chainId> + ASP_RPC_URL)"
        )
    if onchain == "0x0000000000000000000000000000000000000000":
        raise RuntimeError("ComplianceHub.postman is unset (address(0))")
    if account_address.lower() != onchain:
        raise RuntimeError(
            f"ASP_POSTMAN_KEY address {account_address.lower()} ≠ on-chain postman {onchain}"
        )


def read_onchain_roots(chain_id: int | None = None) -> dict[str, str] | None:
    w3 = _w3(chain_id)
    if not w3:
        return None
    cid = chain_id if chain_id is not None else int(w3.eth.chain_id)
    hub = config.compliance_hub_address(cid)
    if not hub:
        return None
    c = w3.eth.contract(address=Web3.to_checksum_address(hub), abi=HUB_POSTMAN_ABI)
    return {
        "admittedRoot": str(c.functions.admittedRoot().call()),
        "revokedRoot": str(c.functions.revokedRoot().call()),
        "chainId": cid,
    }


def _require_vault_match(w3: Web3, vault: str, chain_id: int) -> None:
    expected = config.vault_kernel_address(chain_id)
    if not expected:
        # F-4: fail closed — never accept arbitrary vault when unset
        if getattr(config, "ALLOW_ANY_VAULT", False) and not config.PRODUCTION_LOCK:
            log.warning("VAULT_KERNEL_%s unset — ALLOW_ANY_VAULT (dev only)", chain_id)
            return
        raise ValueError(f"VAULT_KERNEL_{chain_id} not configured — refuse deposit verify")
    if Web3.to_checksum_address(vault) != Web3.to_checksum_address(expected):
        raise ValueError("vault address does not match configured VaultKernel for chain")


def _require_confirmations(w3: Web3, receipt: Any) -> None:
    required = max(0, int(config.CHAIN_MIN_CONFIRMATIONS))
    if required == 0:
        return
    block_number = int(receipt["blockNumber"])
    confirmations = int(w3.eth.block_number) - block_number + 1
    if confirmations < required:
        raise ValueError(f"transaction has {confirmations}/{required} confirmations")


def verify_deposited(
    *,
    tx_hash: str,
    chain_id: int,
    vault: str,
    commitment: str | int | None = None,
    depositor: str | None = None,
    user_salt: int | str | None = None,
    label: str | int | None = None,
) -> dict[str, Any]:
    """Parse VaultKernel.Deposited from receipt. Optionally cross-check label derivation."""
    w3 = _w3(chain_id)
    if not w3:
        raise RuntimeError("ASP_RPC_URL required for on-chain deposit verify")
    if not tx_hash or not str(tx_hash).startswith("0x"):
        raise ValueError("txHash required")
    if not vault:
        raise ValueError("vault required")

    vault_cs = Web3.to_checksum_address(vault)
    _require_vault_match(w3, vault_cs, chain_id)

    receipt = w3.eth.get_transaction_receipt(tx_hash)
    if receipt is None or receipt.get("status") != 1:
        raise ValueError("tx missing or failed")
    _require_confirmations(w3, receipt)

    event = w3.eth.contract(abi=DEPOSITED_ABI).events.Deposited()
    matches = []
    for log_entry in receipt["logs"]:
        if log_entry["address"].lower() != vault_cs.lower():
            continue
        try:
            ev = event.process_log(log_entry)
            matches.append(
                {
                    "depositor": str(ev["args"]["depositor"]).lower(),
                    "token": str(ev["args"]["token"]).lower(),
                    "amount": str(ev["args"]["amount"]),
                    "commitment": str(ev["args"]["commitment"]),
                    "depositNonce": int(ev["args"]["depositNonce"]),
                    "stateRootAfter": str(ev["args"]["stateRootAfter"]),
                    "vault": log_entry["address"],
                    "chainId": chain_id,
                }
            )
        except Exception:
            continue
    if not matches:
        raise ValueError("Deposited event not found in tx for vault")
    if len(matches) > 1:
        raise ValueError("multiple Deposited events in tx — specify commitment")

    ev = matches[0]
    if commitment is not None and str(ev["commitment"]) != str(commitment):
        raise ValueError("Deposited commitment mismatch")
    if depositor and ev["depositor"] != depositor.lower():
        raise ValueError("Deposited depositor mismatch")

    if user_salt is not None and label is not None:
        derived = derive_deposit_label(
            chain_id=chain_id,
            vault_address=vault_cs,
            deposit_nonce=ev["depositNonce"],
            user_salt=int(user_salt),
        )
        if str(derived) != str(int(label)):
            raise ValueError("label does not match depositNonce + userSalt derivation")

    return ev


def verify_screen_admit_binding(
    db,
    *,
    commitment: str | None,
    chain_id: int,
    tx_hash: str | None,
    depositor: str | None,
) -> None:
    """Require prior screen decision == admit (depositor bind, freshness, recheck)."""
    from util import normalize_depositor

    row = None
    if commitment:
        row = get_decision_by_commitment(db, commitment, chain_id=chain_id)
    if row is None and tx_hash:
        row = get_decision_by_tx(db, chain_id, tx_hash)
    if row is None:
        raise ValueError("no screen decision found for commitment or txHash")
    if row.decision != "admit":
        raise ValueError(f"screen decision is {row.decision}, not admit")
    dep = normalize_depositor(depositor, chain_id)
    if not dep:
        raise ValueError("depositor required for screen binding")
    screen_dep = normalize_depositor(row.depositor, chain_id)
    if not screen_dep:
        raise ValueError("screen decision missing depositor")
    if screen_dep != dep:
        raise ValueError("screen depositor does not match deposit depositor")
    if row.chain_id is not None and int(row.chain_id) != int(chain_id):
        raise ValueError("screen chainId does not match deposit chainId")

    # F-2: reject stale screen admits
    max_age = max(0, int(getattr(config, "SCREEN_ADMIT_MAX_AGE_SEC", 3600)))
    if max_age > 0 and row.created_at is not None:
        from datetime import datetime, timezone

        created = row.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - created).total_seconds()
        if age > max_age:
            raise ValueError(f"screen decision expired ({int(age)}s > {max_age}s)")

    if getattr(config, "SCREEN_ADMIT_RECHECK", True):
        from db import find_list_hits
        from oracle import OracleUnavailable, is_sanctioned

        # F-1: local lists (mixer / sanction / custom_ban) — not oracle-only
        for hit in find_list_hits(db, [dep]):
            if hit.kind in ("mixer", "sanction", "custom_ban"):
                raise ValueError(f"depositor list hit at admit recheck: {hit.kind}")

        try:
            if is_sanctioned(dep, chain_id):
                raise ValueError("depositor sanctioned at admit recheck")
        except OracleUnavailable as exc:
            if config.ORACLE_FAIL_CLOSED:
                raise ValueError(f"admit recheck oracle unavailable: {exc}") from exc

        # F-5: zkMe KYT recheck only with active entitlement (no unpaid quota burn)
        if config.ZKME_MCH_NO and config.ZKME_API_KEY:
            from db import has_active_kyt_entitlement
            from zkme import ZkMeUnavailable, screen_address as zkme_screen

            if not has_active_kyt_entitlement(db, dep) and not getattr(
                config, "ALLOW_SKIP_KYT_FEE", False
            ):
                raise ValueError("kyt entitlement inactive at admit recheck")

            try:
                zkme_result = zkme_screen(dep, chain_id)
                if zkme_result.decision == "deny":
                    raise ValueError("depositor zkme deny at admit recheck")
            except ZkMeUnavailable as exc:
                raise ValueError(f"admit recheck zkme unavailable: {exc}") from exc
