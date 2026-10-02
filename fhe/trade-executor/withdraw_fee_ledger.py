"""On-chain half of the fee ledger: the withdrawal gas reimbursement each vault has taken.

`fee_accruals` only knows about fees the EXECUTOR charges (arming, window, fill). Withdrawal is
charged by the vault itself — Vault/WithdrawFee.sol carves the gas reimbursement out of the
withdrawn amount and holds it as a pull-payment balance the collector claims later. So the money
lives in two places and a report that reads only the database silently under-counts.

Lifetime take per vault = what is still owed (`accruedMargin` + `accruedGasReimburse`, two view
calls) + what has already been pulled (MarginClaimed / GasReimburseClaimed events). The claimed
leg needs a log scan, so it is best-effort: if it fails, the owed figure is still exact and the
report says the claimed leg is unknown rather than quietly reporting a smaller total.

Vault addresses are resolved through Entrypoint.getVault() rather than hardcoded — entrypoints get
redeployed and a stale vault constant reads a dead contract's zero balances as "no fees".
"""
from __future__ import annotations

from web3 import Web3

# NATIVE_ASSET is the sentinel Entrypoint.getVault() expects for the ETH vault; take it from the
# chain config so the two can never drift.
from evm_chain_config import (
    NATIVE_ASSET,
    SUPPORTED_EXECUTOR_CHAIN_IDS,
    get_evm_chain_config,
)

VAULT_ASSETS = ("ETH", "USDC")
DECIMALS = {"ETH": 18, "USDC": 6}

_ENTRYPOINT_ABI = [{
    "inputs": [{"name": "", "type": "address"}], "name": "getVault",
    "outputs": [{"name": "", "type": "address"}], "stateMutability": "view", "type": "function",
}]

_VAULT_ABI = [
    {"inputs": [], "name": "accruedMargin", "outputs": [{"name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "accruedGasReimburse", "outputs": [{"name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "getFeeInfo",
     "outputs": [{"name": "enabled", "type": "bool"}, {"name": "gasMode", "type": "uint8"},
                 {"name": "feeBps", "type": "uint16"}, {"name": "minWithdrawWei", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"anonymous": False, "name": "MarginClaimed", "type": "event",
     "inputs": [{"indexed": True, "name": "to", "type": "address"},
                {"indexed": False, "name": "amount", "type": "uint256"}]},
    {"anonymous": False, "name": "GasReimburseClaimed", "type": "event",
     "inputs": [{"indexed": True, "name": "to", "type": "address"},
                {"indexed": False, "name": "amount", "type": "uint256"}]},
]

# Public RPCs cap eth_getLogs ranges; 10k blocks is the widest value every provider we use accepts.
# ponytail: fixed chunk, no adaptive shrink — a claim scan runs on demand, not in a hot path.
_LOG_CHUNK = 10_000


def _claimed_total(vault, from_block: int, to_block: int) -> int:
    """Sum of every claim this vault has paid out. Raises if the node refuses the scan."""
    total = 0
    for event in (vault.events.MarginClaimed, vault.events.GasReimburseClaimed):
        start = from_block
        while start <= to_block:
            end = min(start + _LOG_CHUNK - 1, to_block)
            # web3.py 6.x names these fromBlock/toBlock. Passing from_block/to_block raises
            # TypeError, which surfaced as claimed_error in /admin/fees and left `claimed` null on
            # every vault — the report silently understated what had already been paid out.
            for entry in event().get_logs(fromBlock=start, toBlock=end):
                total += int(entry["args"]["amount"])
            start = end + 1
    return total


def read_vault_fees(chain_id: int, *, scan_claims: bool = True, from_block: int = 0) -> list[dict]:
    """One row per vault on `chain_id`: what it is holding and what it has already paid out."""
    chain = get_evm_chain_config(chain_id)
    if not chain.entrypoint:
        return []
    w3 = Web3(Web3.HTTPProvider(chain.rpc_url, request_kwargs={"timeout": 15}))
    entrypoint = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint), abi=_ENTRYPOINT_ABI
    )

    rows: list[dict] = []
    for symbol in VAULT_ASSETS:
        asset = NATIVE_ASSET if symbol == "ETH" else chain.usdc
        try:
            vault_addr = entrypoint.functions.getVault(Web3.to_checksum_address(asset)).call()
        except Exception as exc:
            rows.append({"chain_id": chain_id, "chain": chain.name, "asset": symbol,
                         "error": f"getVault failed: {exc}"})
            continue
        if int(vault_addr, 16) == 0:
            continue

        vault = w3.eth.contract(address=vault_addr, abi=_VAULT_ABI)
        try:
            margin = int(vault.functions.accruedMargin().call())
            gas = int(vault.functions.accruedGasReimburse().call())
            enabled, _mode, fee_bps, _min = vault.functions.getFeeInfo().call()
        except Exception as exc:
            rows.append({"chain_id": chain_id, "chain": chain.name, "asset": symbol,
                         "vault": vault_addr, "error": f"vault read failed: {exc}"})
            continue

        claimed, claimed_error = 0, None
        if scan_claims:
            try:
                claimed = _claimed_total(vault, from_block, w3.eth.block_number)
            except Exception as exc:
                claimed_error = str(exc)
        else:
            claimed_error = "claim scan skipped"

        scale = 10 ** DECIMALS[symbol]
        rows.append({
            "chain_id": chain_id,
            "chain": chain.name,
            "asset": symbol,
            "vault": vault_addr,
            "fee_enabled": bool(enabled),
            "fee_bps": int(fee_bps),
            "unclaimed_margin_wei": str(margin),
            "unclaimed_gas_wei": str(gas),
            "claimed_wei": None if claimed_error else str(claimed),
            "claimed_error": claimed_error,
            # Lifetime take is only knowable when the claim scan succeeded.
            "lifetime_wei": None if claimed_error else str(margin + gas + claimed),
            "unclaimed": (margin + gas) / scale,
            "lifetime": None if claimed_error else (margin + gas + claimed) / scale,
        })
    return rows


def read_all_vault_fees(*, scan_claims: bool = True, from_blocks: dict | None = None) -> list[dict]:
    """Every strategy chain's vaults. A chain that is unreachable contributes an error row rather
    than taking the whole report down — a single dead RPC must not read as "no fees"."""
    from_blocks = from_blocks or {}
    out: list[dict] = []
    for chain_id in sorted(SUPPORTED_EXECUTOR_CHAIN_IDS):
        try:
            out.extend(read_vault_fees(chain_id, scan_claims=scan_claims,
                                       from_block=int(from_blocks.get(chain_id, 0))))
        except Exception as exc:
            out.append({"chain_id": chain_id, "error": str(exc)})
    return out
