"""
EVM trade executor for Siphon Protocol.
Flow: ZK withdraw from vault → Uniswap v3 swap → funds to recipient.
Chain-specific RPC + contracts come from evm_chain_config (per strategy from_chain).
"""
# The runtime image is Python 3.9, where `list | None` in an annotation is evaluated at def
# time and raises TypeError on import — taking the whole executor down, not just that function.
# This makes every annotation in the module a lazy string, so 3.10+ syntax is safe here the way
# it already is in executor_runner and withdraw_fee_ledger, which both carry this import.
from __future__ import annotations

import os
import json
import time
from decimal import Decimal, ROUND_DOWN
from typing import Optional
from dotenv import load_dotenv
import requests
from web3 import Web3
from web3.exceptions import ContractLogicError

try:
    from web3.middleware import ExtraDataToPOAMiddleware as _poa_middleware
except ImportError:  # web3 < 7
    from web3.middleware import geth_poa_middleware as _poa_middleware

from evm_chain_config import (
    EvmChainConfig,
    NATIVE_ASSET,
    get_evm_chain_config,
    resolve_execution_chain_id,
)
from transaction_policy import (
    NATIVE_VAULT_GAS_FLOOR,
    SWAP_GAS_FLOOR,
    TOKEN_VAULT_GAS_FLOOR,
    ZK_WITHDRAW_GAS_FLOOR,
    fee_params,
    wait_for_sufficient_balance,
)

# NOT override=True. The real process environment (Compose/systemd/K8s) is authoritative; a .env
# file only fills gaps. With override, a stale .env baked into the image silently won over every
# variable Compose set — that is how the executor kept reading the retired soft-era entrypoint
# (0x3423…) while `printenv` showed the Hard ASP one, and every arm failed as "ASP label rejected".
load_dotenv()

# Per-chain hot wallets (hex, with or without 0x). EVM_EXECUTOR_KEY is the legacy fallback.
_CHAIN_EXECUTOR_ENV = {
    8453: "BASE_EXECUTOR_KEY",
    11155111: "ETH_SEPOLIA_EXECUTOR_KEY",
    42161: "ARBITRUM_EXECUTOR_KEY",
    42431: "TEMPO_MODERATO_EXECUTOR_KEY",
    998: "HYPEREVM_TESTNET_EXECUTOR_KEY",
}

# ── CVM remote signing ──────────────────────────────────────────────────────────────────────
# When EVM_SIGNER_URL (+ token) is set, EVM transactions are signed inside the Phala CVM signer
# (imported keys, same addresses). This box then holds no EVM private key. The executor still
# builds each tx (nonce/gas/fees/data) and broadcasts; only the signature crosses the boundary.
EVM_SIGNER_URL = os.environ.get("EVM_SIGNER_URL", "").rstrip("/")
EVM_SIGNER_TOKEN = os.environ.get("EVM_SIGNER_TOKEN", "")


# Expected signer address per chain. When set, the address the CVM signer reports MUST match, or
# we refuse to sign — see RemoteAccount.address.
_CHAIN_EXECUTOR_ADDRESS_ENV = {
    8453: "BASE_EXECUTOR_ADDRESS",
    11155111: "ETH_SEPOLIA_EXECUTOR_ADDRESS",
    42161: "ARBITRUM_EXECUTOR_ADDRESS",
    42431: "TEMPO_MODERATO_EXECUTOR_ADDRESS",
    998: "HYPEREVM_TESTNET_EXECUTOR_ADDRESS",
}


def evm_remote_signing() -> bool:
    return bool(EVM_SIGNER_URL and EVM_SIGNER_TOKEN)


def assert_signer_config_complete() -> None:
    """Half-configured remote signing must not degrade to a local key.

    `evm_remote_signing()` is an AND, so dropping either variable silently flipped the executor
    back to `w3.eth.account.from_key(...)` — the exact opposite of the deployment's intent, and
    invisible because signing kept working. Today production sets both and holds no local key at
    all, so this only fires on a misconfigured deploy; that is precisely when it matters.
    """
    if bool(EVM_SIGNER_URL) != bool(EVM_SIGNER_TOKEN):
        missing = "EVM_SIGNER_TOKEN" if EVM_SIGNER_URL else "EVM_SIGNER_URL"
        raise RuntimeError(
            f"remote signing is half-configured: {missing} is unset. Refusing to fall back to a "
            f"local private key — set both, or unset both to sign locally on purpose."
        )


def get_evm_executor_private_key(chain_id: int) -> str:
    """Resolve signing key for a chain (BASE_EXECUTOR_KEY on Base, etc.). LOCAL mode only."""
    env_name = _CHAIN_EXECUTOR_ENV.get(chain_id, "EVM_EXECUTOR_KEY")
    key = (os.getenv(env_name) or os.getenv("EVM_EXECUTOR_KEY") or "").strip()
    if not key:
        raise ValueError(
            f"No executor key for chain {chain_id}: set {env_name} or EVM_EXECUTOR_KEY"
        )
    return key if key.startswith("0x") else "0x" + key


class _RemoteSigned:
    """Mimics eth-account's SignedTransaction — send_tx only reads .rawTransaction."""
    def __init__(self, raw_hex: str):
        self.rawTransaction = bytes.fromhex(raw_hex[2:] if raw_hex.startswith("0x") else raw_hex)
        self.raw_transaction = self.rawTransaction


class RemoteAccount:
    """Drop-in for a LocalAccount whose key lives in the CVM signer. Exposes .address and
    .sign_transaction(tx) so send_tx() works unchanged; signing round-trips to /evm/sign."""
    _addr_cache: dict = {}

    def __init__(self, chain_id: int):
        self.chain_id = chain_id

    @property
    def address(self) -> str:
        if self.chain_id not in RemoteAccount._addr_cache:
            res = requests.get(
                f"{EVM_SIGNER_URL}/evm/address",
                params={"chain_id": self.chain_id},
                headers={"X-API-TOKEN": EVM_SIGNER_TOKEN},
                timeout=15,
            )
            data = res.json() if res.ok else {}
            addr = data.get("address")
            if not addr:
                raise RuntimeError(f"evm-signer /evm/address failed: {data.get('error') or res.status_code}")
            addr = Web3.to_checksum_address(addr)
            # Trusting whatever the signer reports makes the executor follow a swapped or spoofed
            # signer to a different address — and that address is the tx sender and the withdraw
            # recipient baked into ZK proofs. Pin it when the deployment says which one to expect.
            want = (os.getenv(_CHAIN_EXECUTOR_ADDRESS_ENV.get(self.chain_id, "")) or "").strip()
            if want and Web3.to_checksum_address(want) != addr:
                raise RuntimeError(
                    f"evm-signer returned {addr} for chain {self.chain_id}, but "
                    f"{_CHAIN_EXECUTOR_ADDRESS_ENV[self.chain_id]} pins "
                    f"{Web3.to_checksum_address(want)}. Refusing to sign."
                )
            RemoteAccount._addr_cache[self.chain_id] = addr
        return RemoteAccount._addr_cache[self.chain_id]

    def sign_transaction(self, tx: dict) -> _RemoteSigned:
        # Serialize ONLY ints that could lose precision in JSON (> 2^53, i.e. value/fees) as
        # strings. Small ints (nonce/gas/chainId — and critically "type", which the signer does
        # NOT int-coerce) must stay numeric or eth_account rejects the tx server-side.
        safe = {}
        for k, v in tx.items():
            safe[k] = str(v) if isinstance(v, int) and abs(v) > 2**53 - 1 else v
        res = requests.post(
            f"{EVM_SIGNER_URL}/evm/sign",
            json={"chain_id": self.chain_id, "tx": safe},
            headers={"X-API-TOKEN": EVM_SIGNER_TOKEN},
            timeout=30,
        )
        data = res.json() if res.ok else {}
        raw = data.get("raw")
        if not raw:
            raise RuntimeError(f"evm-signer /evm/sign failed: {data.get('error') or res.status_code}")
        return _RemoteSigned(raw)

# Token decimals
TOKEN_DECIMALS = {"ETH": 18, "USDC": 6, "USDT": 6, "WBTC": 8}

# Minimal ABIs — Hard ASP Entrypoint.withdraw includes aspRoot + changeLabel
ENTRYPOINT_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"_asset","type":"address"},{"internalType":"address","name":"_recipient","type":"address"},{"internalType":"address","name":"_depositor","type":"address"},{"internalType":"uint256","name":"_changeValue","type":"uint256"},{"internalType":"uint256","name":"_withdrawnValue","type":"uint256"},{"internalType":"uint256","name":"_stateRoot","type":"uint256"},{"internalType":"uint256","name":"_aspRoot","type":"uint256"},{"internalType":"uint256[]","name":"_nullifierHashes","type":"uint256[]"},{"internalType":"uint256","name":"_changeCommitment","type":"uint256"},{"internalType":"uint256","name":"_changeLabel","type":"uint256"},{"internalType":"uint256[2]","name":"_pA","type":"uint256[2]"},{"internalType":"uint256[2][2]","name":"_pB","type":"uint256[2][2]"},{"internalType":"uint256[2]","name":"_pC","type":"uint256[2]"}],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_asset","type":"address"},{"internalType":"uint256","name":"_amount","type":"uint256"},{"internalType":"uint256","name":"_precommitment","type":"uint256"}],"name":"deposit","outputs":[{"internalType":"uint256","name":"_commitment","type":"uint256"}],"stateMutability":"payable","type":"function"}]')
ENTRYPOINT_MERGE_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"_asset","type":"address"},{"internalType":"address","name":"_depositor","type":"address"},{"internalType":"uint256","name":"_mergedValue","type":"uint256"},{"internalType":"uint256","name":"_stateRoot","type":"uint256"},{"internalType":"uint256","name":"_aspRoot","type":"uint256"},{"internalType":"uint256[]","name":"_nullifierHashes","type":"uint256[]"},{"internalType":"uint256","name":"_mergedCommitment","type":"uint256"},{"internalType":"uint256","name":"_mergedLabel","type":"uint256"},{"internalType":"uint256[2]","name":"_pA","type":"uint256[2]"},{"internalType":"uint256[2][2]","name":"_pB","type":"uint256[2][2]"},{"internalType":"uint256[2]","name":"_pC","type":"uint256[2]"}],"name":"merge","outputs":[],"stateMutability":"nonpayable","type":"function"}]')
ENTRYPOINT_VAULT_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"asset","type":"address"}],"name":"getVault","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"}]')
NULLIFIER_STATUS_ABI = json.loads('[{"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"nullifiers","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"}]')

# Custom error selectors for Vault/Entrypoint
CUSTOM_ERRORS = {
    bytes.fromhex("076490f6"): "InvalidZKProof()",
    bytes.fromhex("b6fac030"): "InvalidStateRoot()",
    bytes.fromhex("b115d857"): "NullifierAlreadySpent()",
    bytes.fromhex("dee790fb"): "VaultNotFound()",
    bytes.fromhex("9abc7491"): "InvalidWithdrawalAmount()",
    bytes.fromhex("d92e233d"): "ZeroAddress()",
    bytes.fromhex("8247bd80"): "OnlyEntrypoint()",
    bytes.fromhex("fe9ba5cd"): "InvalidDepositAmount()",
    bytes.fromhex("e346d81d"): "InvalidSwapAmount()",
    bytes.fromhex("f1d06811"): "WithdrawalCostExceedsAmount(uint256,uint256)",
    bytes.fromhex("3489dfb0"): "WithdrawalBelowMinimum(uint256,uint256)",
}

WITHDRAW_FEE_ERRORS = {
    bytes.fromhex("f1d06811"): "WithdrawalCostExceedsAmount",
    bytes.fromhex("3489dfb0"): "WithdrawalBelowMinimum",
}

class FatalExecutionError(Exception):
    """Raised when execution should not be retried (e.g. nullifier already spent)."""
    pass

class NullifierAlreadySpentError(FatalExecutionError):
    """Carries the exact proof nullifiers confirmed spent by the vault."""

    def __init__(self, spent_hashes: Optional[list[str]]):
        self.spent_hashes = spent_hashes
        joined = ",".join(spent_hashes) if spent_hashes else "unknown"
        super().__init__(f"withdraw() would revert: NullifierAlreadySpent({joined})")

class NullifierSpentSwapFailed(FatalExecutionError):
    """ZK withdraw confirmed (nullifier spent) but swap/bridge failed. Funds are in executor wallet."""
    pass


_HARD_ASP_VIEW_ABI = [
    {
        "inputs": [],
        "name": "aspPostman",
        "outputs": [{"internalType": "address", "name": "", "type": "address"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "currentAspRoot",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]


# The ceremony manifest ships alongside the zkeys it describes, so it cannot go stale the way a
# hand-set env var can when a generation is cut over.
_CEREMONY_MANIFEST = os.getenv("ZK_CEREMONY_MANIFEST", "/app/zk/CEREMONY.json")


def _ceremony_kind_from_manifest() -> str:
    """Ceremony kind from CEREMONY.json, or "" when the manifest is unreadable.

    The client (hardAspLive.ts) already resolves it exactly this way — env var first, then the
    manifest, then "dev-beacon". The executor read env vars ONLY, so an unset ZK_CEREMONY made it
    stricter than the client by accident: it rejected every Base withdrawal as dev-zkeys even
    though the deployed circuits are the reviewed round-2 MPC output. The user then saw the
    relayer 422 and got a raw wallet-confirmation popup instead of a gasless relayed withdrawal.
    """
    try:
        with open(_CEREMONY_MANIFEST, "r", encoding="utf-8") as fh:
            return str(json.load(fh).get("kind") or "").strip().lower()
    except Exception:
        return ""


def assert_hard_asp_entrypoint(w3: Web3, chain: EvmChainConfig) -> None:
    """Refuse FHE withdraw against soft-era entrypoints (Base mainnet cutover).

    Order matches client hardAspLive: ceremony check BEFORE soft override on mainnet.
    """
    if chain.chain_id in (8453, 1):
        env_name = (os.getenv("SIPHON_ENV") or os.getenv("ASP_ENV") or os.getenv("NODE_ENV") or "").strip().lower()
        production_lock = env_name in ("production", "prod", "mainnet")
        ceremony = (
            (os.getenv("ZK_CEREMONY") or os.getenv("NEXT_PUBLIC_ZK_CEREMONY") or "").strip().lower()
            or _ceremony_kind_from_manifest()
            or "dev-beacon"
        )
        allow_dev = (
            not production_lock
            and os.getenv("ALLOW_DEV_ZKEYS_ON_MAINNET", "").lower() in ("1", "true", "yes")
        )
        if ceremony in ("dev-beacon", "dev", "beacon") and not allow_dev:
            raise FatalExecutionError(
                "Hard ASP on Base mainnet requires MPC ceremony (ZK_CEREMONY=mpc). "
                + (
                    "DEV beacon forbidden in production."
                    if production_lock
                    else "Set ALLOW_DEV_ZKEYS_ON_MAINNET=1 only for explicit non-prod soak."
                )
            )
    if os.getenv("HARD_ASP_SOFT_OVERRIDE", "").lower() in ("1", "true", "yes"):
        print(f"   [EVM] HARD_ASP_SOFT_OVERRIDE — skipping Hard ASP EP probe on {chain.name}")
        return
    ep = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint),
        abi=_HARD_ASP_VIEW_ABI,
    )
    try:
        postman = ep.functions.aspPostman().call()
        _ = ep.functions.currentAspRoot().call()
    except Exception as e:
        raise FatalExecutionError(
            f"Entrypoint {chain.entrypoint} on {chain.name} is not Hard ASP "
            f"(aspPostman/currentAspRoot missing). Redeploy Hard ASP and set "
            f"BASE_MAINNET_ENTRYPOINT. Underlying: {e}"
        ) from e
    # aspPostman() returns a checksummed hex string; int() defaults to base 10 and raises on it.
    if int(postman, 16) == 0:
        print(f"   [EVM] WARN: aspPostman is address(0) on {chain.name} — setAspPostman before admits")


class CustodyStageError(RuntimeError):
    """A post-withdraw step failed; retain the exact asset/stage for recovery operators."""

    def __init__(self, stage: str, asset: str, amount_wei: int, tx_hash: Optional[str], cause: Exception):
        self.stage = stage
        self.asset = asset
        self.amount_wei = amount_wei
        self.tx_hash = tx_hash
        detail = f"stage={stage}, asset={asset}, amount={amount_wei}"
        if tx_hash:
            detail += f", prior_tx={tx_hash}"
        super().__init__(f"{detail}: {cause}")

def decode_revert(data: bytes) -> str:
    """Decode a revert reason from raw bytes (custom errors or revert string)."""
    if not data:
        return "empty revert data"
    selector = data[:4]
    if selector in WITHDRAW_FEE_ERRORS and len(data) >= 68:
        try:
            from eth_abi import decode
            amount, threshold = decode(["uint256", "uint256"], data[4:68])
            return f"Custom error: {WITHDRAW_FEE_ERRORS[selector]}({amount},{threshold})"
        except Exception:
            pass
    if selector in CUSTOM_ERRORS:
        return f"Custom error: {CUSTOM_ERRORS[selector]}"
    # Standard Error(string) = 0x08c379a0
    if selector == bytes.fromhex("08c379a0"):
        try:
            from eth_abi import decode
            msg = decode(["string"], data[4:])[0]
            return f"Revert string: {msg}"
        except Exception:
            pass
    return f"Unknown revert selector: {selector.hex()}, raw: {data.hex()[:80]}"

ERC20_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]')

UNIVERSAL_ROUTER_ABI = json.loads('[{"inputs":[{"internalType":"bytes","name":"commands","type":"bytes"},{"internalType":"bytes[]","name":"inputs","type":"bytes[]"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"execute","outputs":[],"stateMutability":"payable","type":"function"}]')
# Uniswap SwapRouter02: exactInputSingle with the 7-field struct (no deadline) — payable,
# auto-wraps msg.value when tokenIn == WETH9.
SWAP_ROUTER_02_ABI = json.loads('[{"inputs":[{"components":[{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint24","name":"fee","type":"uint24"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMinimum","type":"uint256"},{"internalType":"uint160","name":"sqrtPriceLimitX96","type":"uint160"}],"internalType":"struct IV3SwapRouter.ExactInputSingleParams","name":"params","type":"tuple"}],"name":"exactInputSingle","outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],"stateMutability":"payable","type":"function"}]')
# Classic Uniswap V3 SwapRouter ABI (8-field struct with deadline). Sepolia's
# SimpleSwapRouter exposes this selector for ERC20 input in addition to its ETH helper.
SWAP_ROUTER_V3_ABI = json.loads('[{"inputs":[{"components":[{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint24","name":"fee","type":"uint24"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMinimum","type":"uint256"},{"internalType":"uint160","name":"sqrtPriceLimitX96","type":"uint160"}],"internalType":"struct ISwapRouter.ExactInputSingleParams","name":"params","type":"tuple"}],"name":"exactInputSingle","outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],"stateMutability":"payable","type":"function"}]')
SIMPLE_SWAP_ROUTER_POOL_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"pool","type":"address"},{"components":[{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint24","name":"fee","type":"uint24"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMinimum","type":"uint256"},{"internalType":"uint160","name":"sqrtPriceLimitX96","type":"uint160"}],"internalType":"struct ISwapRouter.ExactInputSingleParams","name":"params","type":"tuple"}],"name":"exactInputSingleWithPool","outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],"stateMutability":"payable","type":"function"}]')
SIMPLE_SWAP_ROUTER_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"pool","type":"address"},{"internalType":"address","name":"weth","type":"address"},{"components":[{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint24","name":"fee","type":"uint24"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMinimum","type":"uint256"},{"internalType":"uint160","name":"sqrtPriceLimitX96","type":"uint160"}],"internalType":"struct ISwapRouter.ExactInputSingleParams","name":"params","type":"tuple"}],"name":"exactInputSingleWithETH","outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],"stateMutability":"payable","type":"function"}]')
UNISWAP_V3_FACTORY_ABI = json.loads('[{"inputs":[{"internalType":"address","name":"tokenA","type":"address"},{"internalType":"address","name":"tokenB","type":"address"},{"internalType":"uint24","name":"fee","type":"uint24"}],"name":"getPool","outputs":[{"internalType":"address","name":"pool","type":"address"}],"stateMutability":"view","type":"function"}]')
WETH_ABI = json.loads('[{"inputs":[{"internalType":"uint256","name":"wad","type":"uint256"}],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"guy","type":"address"},{"internalType":"uint256","name":"wad","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}]')

_SIMPLE_SWAP_SELECTOR = Web3.keccak(
    text="exactInputSingleWithETH(address,address,(address,address,uint24,address,uint256,uint256,uint256,uint160))"
)[:4].hex().removeprefix("0x")
# Uniswap SwapRouter02 exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) = 0x04e45aaf
_SWAP_ROUTER_02_SELECTOR = Web3.keccak(
    text="exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
)[:4].hex().removeprefix("0x")
_SWAP_ROUTER_V3_SELECTOR = Web3.keccak(
    text="exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"
)[:4].hex().removeprefix("0x")
_SIMPLE_POOL_SWAP_SELECTOR = Web3.keccak(
    text="exactInputSingleWithPool(address,(address,address,uint24,address,uint256,uint256,uint256,uint160))"
)[:4].hex().removeprefix("0x")
_UNIVERSAL_ROUTER_EXECUTE_SELECTOR = "3593564c"


def get_web3(chain: EvmChainConfig) -> Web3:
    w3 = Web3(Web3.HTTPProvider(chain.rpc_url))
    w3.middleware_onion.inject(_poa_middleware, layer=0)
    return w3


def get_executor_account(w3: Web3, chain_id: int):
    # Remote (CVM) signing when configured — the private key never touches this process.
    assert_signer_config_complete()
    if evm_remote_signing():
        return RemoteAccount(chain_id)
    return w3.eth.account.from_key(get_evm_executor_private_key(chain_id))


# Modest fallbacks when estimate_gas fails (not used when estimate succeeds).
_GAS_FALLBACK = {
    "zk_withdraw": ZK_WITHDRAW_GAS_FLOOR,
    "zk_merge": ZK_WITHDRAW_GAS_FLOOR,
    "ur_swap": SWAP_GAS_FLOOR,
    "simple_swap": SWAP_GAS_FLOOR,
    "token_to_weth": SWAP_GAS_FLOOR,
    "vault_deposit": TOKEN_VAULT_GAS_FLOOR,
    "vault_deposit_native": NATIVE_VAULT_GAS_FLOOR,
}


def send_tx(
    w3: Web3,
    account,
    tx_params: dict,
    label: str = "",
    gas_buffer: float = 1.3,
    on_prepared=None,
) -> str:
    """Sign and send a transaction, return tx hash."""
    tx_params.setdefault("from", account.address)

    t0 = time.monotonic()
    # Use the PENDING nonce so back-to-back txs in one flow (e.g. ZK withdraw →
    # swap) queue sequentially. Using the confirmed nonce here would collide with
    # an in-flight prior tx and the second tx gets dropped.
    tx_params.setdefault("nonce", w3.eth.get_transaction_count(account.address, "pending"))
    tx_params.setdefault("chainId", w3.eth.chain_id)
    chain_id = int(tx_params["chainId"])
    t_prep = (time.monotonic() - t0) * 1000

    # Estimate gas without a preset cap, then add a small buffer (~30%).
    t_gas = 0.0
    tg = time.monotonic()
    gas_floor = int(tx_params.pop("gas", 0) or 0)
    estimate_params = dict(tx_params)
    try:
        est = w3.eth.estimate_gas(estimate_params)
        gas_limit = max(gas_floor, int(est * gas_buffer))
        print(f"   [EVM] Gas estimate: {est} → limit {gas_limit} ({label or 'tx'})")
    except ContractLogicError as e:
        # A revert during estimation is the node telling us this exact call fails. Broadcasting it
        # anyway on a guessed limit cannot succeed — it only pays gas to learn the same thing, and
        # a retrying caller pays it once per attempt (a single armed leg burned 10 reverted txs on
        # a ProofFailed the estimator had already returned). Only a TRANSIENT estimator failure —
        # a rate-limited or lagging node, below — deserves the fallback.
        # web3 renders a custom-error revert as a bare "execution reverted" — the 4-byte selector
        # that says WHICH error is dropped, and the log then names no cause at all. A whole TWAP
        # debug went into recovering a selector the node had returned all along. Re-ask with a raw
        # eth_call, which carries `data`, and put it in the message.
        detail = getattr(e, "data", None)
        if not detail:
            try:
                raw = w3.provider.make_request("eth_call", [
                    {k: (hex(v) if isinstance(v, int) else v)
                     for k, v in estimate_params.items() if k in ("from", "to", "data", "value")},
                    "latest",
                ])
                detail = (raw.get("error") or {}).get("data")
            except Exception:
                detail = None
        suffix = f" selector={str(detail)[:10]}" if detail else " (node returned no revert data)"
        raise ValueError(f"tx would revert ({e}){suffix} — not broadcasting") from e
    except Exception as e:
        gas_limit = gas_floor or _GAS_FALLBACK.get(label, 600_000)
        print(f"   [EVM] Gas estimation failed: {e}, using fallback {gas_limit}")
    tx_params["gas"] = gas_limit
    t_gas = (time.monotonic() - tg) * 1000

    fees = fee_params(w3, chain_id)
    gas_cost = gas_limit * fees["maxFeePerGas"]
    value = int(tx_params.get("value", 0) or 0)
    max_cost = value + gas_cost

    # USDC→ETH QuickSwap is a back-to-back unwrap then native delivery. A
    # load-balanced RPC can acknowledge the unwrap receipt but briefly serve
    # the old executor balance to the next request. Wait for a replica that can
    # see enough balance for the value-bearing transaction instead of either
    # rejecting it locally or estimating against stale state.
    balance_attempts = 15 if value else 1
    balance = wait_for_sufficient_balance(
        w3,
        account.address,
        max_cost,
        attempts=balance_attempts,
        on_wait=lambda current, attempt, attempts: (
            print(
                f"   [EVM] ⏳ waiting for native balance sync: need {max_cost}, "
                f"RPC reports {current} ({attempt}/{attempts})"
            )
        ),
    )
    if balance < max_cost:
        raise ValueError(
            f"Executor wallet {account.address} needs ~{max_cost / 1e18:.6f} ETH "
            f"for value + gas (value={value / 1e18:.6f}, "
            f"max gas={gas_cost / 1e18:.6f}); have {balance / 1e18:.6f} ETH "
            f"on chain {chain_id}. Top up the executor wallet."
        )

    tx_params["maxPriorityFeePerGas"] = fees["maxPriorityFeePerGas"]
    tx_params["maxFeePerGas"] = fees["maxFeePerGas"]

    # The executor wallet is an EIP-7702 delegated account (code starts 0xef0100…),
    # which the Base sequencer caps at 1 in-flight tx. After a prior tx in the same
    # flow (e.g. the ZK withdraw) mines, it can briefly linger in the txpool, so a
    # back-to-back send (the swap) is rejected with
    #   "in-flight transaction limit reached for delegated accounts" (code -32000).
    # Sign exactly once. Retrying a newly signed transaction here used to mutate the durable relay
    # journal (the pending nonce can change between attempts), allowing the recovery worker and the
    # live request to broadcast two different transactions for one proof. Re-sending identical raw
    # bytes is safe: duplicate sends are idempotent at the transaction-hash boundary.
    ts = time.monotonic()
    signed = account.sign_transaction(tx_params)
    t_sign = (time.monotonic() - ts) * 1000
    raw = signed.rawTransaction
    if on_prepared is not None:
        on_prepared(w3.keccak(raw).hex(), raw.hex())

    t_send = time.monotonic()
    tx_hash = None
    for attempt in range(6):
        try:
            tx_hash = w3.eth.send_raw_transaction(raw)
            break
        except Exception as e:
            if "in-flight transaction limit" in str(e) and attempt < 5:
                wait = 2 + attempt * 2
                print(f"   [EVM] ⏳ delegated-account in-flight limit; retry {attempt+1}/5 in {wait}s")
                time.sleep(wait)
                continue
            raise
    if tx_hash is None:
        raise RuntimeError("Failed to broadcast tx: in-flight transaction limit not cleared after retries")
    t_send = (time.monotonic() - t_send) * 1000
    print(f"   [EVM] Tx sent: {tx_hash.hex()}")

    t_mine = time.monotonic()
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=600)
    t_mine = (time.monotonic() - t_mine) * 1000

    if receipt.status != 1:
        revert_reason = _replay_revert_reason(w3, tx_hash, receipt.blockNumber)
        detail = f" ({revert_reason})" if revert_reason else ""
        raise RuntimeError(f"Transaction reverted: {tx_hash.hex()}{detail}")

    tag = f" [{label}]" if label else ""
    print(f"   [EVM] Tx mined in block {receipt.blockNumber}: {tx_hash.hex()}")
    print(f"   [Benchmark]{tag} nonce/chain={t_prep:.0f}ms | gas_est={t_gas:.0f}ms | sign={t_sign:.0f}ms | broadcast={t_send:.0f}ms | mine={t_mine:.0f}ms | gas_used={receipt.gasUsed}")
    return tx_hash.hex()


def verified_prepared_transaction(raw_hex: str, expected_hash: str, w3: Web3) -> bytes:
    """Decode a journaled transaction and verify its hash before any rebroadcast side effect."""
    raw = (raw_hex or "").removeprefix("0x")
    try:
        raw_bytes = bytes.fromhex(raw)
    except ValueError as exc:
        raise ValueError("relay journal contains invalid transaction bytes") from exc
    if not raw_bytes or w3.keccak(raw_bytes).hex().lower() != (expected_hash or "").lower():
        raise ValueError("relay journal transaction hash mismatch")
    return raw_bytes


def _replay_revert_reason(w3: Web3, tx_hash, block_number: int) -> str:
    """Best-effort decode of an on-chain revert."""
    try:
        tx = w3.eth.get_transaction(tx_hash)
        w3.eth.call(
            {
                "from": tx["from"],
                "to": tx["to"],
                "data": tx["input"],
                "value": tx["value"],
                "gas": tx["gas"],
            },
            block_number - 1,
        )
        return ""
    except Exception as exc:
        data = getattr(exc, "data", None)
        if isinstance(data, str) and data.startswith("0x") and len(data) > 10:
            return decode_revert(bytes.fromhex(data[2:]))
        if isinstance(data, dict):
            for val in data.values():
                if isinstance(val, str) and val.startswith("0x") and len(val) > 10:
                    return decode_revert(bytes.fromhex(val[2:]))
        msg = str(exc)
        if "revert" in msg.lower() or "execution" in msg.lower():
            return msg
        return ""


def _router_uses_simple_swap(w3: Web3, router_address: str) -> bool:
    code = w3.eth.get_code(Web3.to_checksum_address(router_address)).hex().lower()
    return _SIMPLE_SWAP_SELECTOR in code


def _router_uses_swap_router_02(w3: Web3, router_address: str) -> bool:
    """Uniswap SwapRouter02 exposes exactInputSingle but not the UniversalRouter execute()."""
    code = w3.eth.get_code(Web3.to_checksum_address(router_address)).hex().lower()
    return _SWAP_ROUTER_02_SELECTOR in code and "3593564c" not in code


def _router_uses_classic_v3(w3: Web3, router_address: str) -> bool:
    """Classic V3 SwapRouter exactInputSingle includes a deadline in its tuple."""
    code = w3.eth.get_code(Web3.to_checksum_address(router_address)).hex().lower()
    return _SWAP_ROUTER_V3_SELECTOR in code


def _router_uses_simple_pool_swap(w3: Web3, router_address: str) -> bool:
    """Custom Sepolia router path for ERC20 input; the pool address is explicit."""
    code = w3.eth.get_code(Web3.to_checksum_address(router_address)).hex().lower()
    return _SIMPLE_POOL_SWAP_SELECTOR in code


def _router_uses_universal(w3: Web3, router_address: str) -> bool:
    code = w3.eth.get_code(Web3.to_checksum_address(router_address)).hex().lower()
    return _UNIVERSAL_ROUTER_EXECUTE_SELECTOR in code


def _resolve_v3_pool(
    w3: Web3,
    chain: EvmChainConfig,
    token_in: str,
    token_out: str,
    fee_tier: int,
) -> tuple[str, int]:
    factory = w3.eth.contract(
        address=Web3.to_checksum_address(chain.uniswap_v3_factory),
        abi=UNISWAP_V3_FACTORY_ABI,
    )
    token_a = Web3.to_checksum_address(token_in)
    token_b = Web3.to_checksum_address(token_out)
    for fee in dict.fromkeys([fee_tier, 3000, 500, 10000, 100]):
        pool = factory.functions.getPool(token_a, token_b, fee).call()
        if pool and str(pool).lower() != "0x0000000000000000000000000000000000000000":
            return Web3.to_checksum_address(pool), fee
    raise RuntimeError(
        f"No Uniswap V3 pool for {token_in} → {token_out} on {chain.name} (tried common fee tiers)"
    )


DEFAULT_MAX_SLIPPAGE_BPS = int(os.getenv("DEFAULT_MAX_SLIPPAGE_BPS", "300"))
MAX_ALLOWED_SLIPPAGE_BPS = 5_000


def minimum_output_wei(
    asset_in: str,
    asset_out: str,
    amount_in_wei: int,
    eth_usd_price: float,
    max_slippage_bps: Optional[int],
) -> int:
    """Return a non-zero ETH/USDC minimum output from the independent ETH/USD feed.

    The executor currently supports ETH and six-decimal USDC for same-chain single-shot
    swaps. Using the scheduler's oracle price makes the bound independent of the AMM spot
    price, so a manipulated pool cannot manufacture its own permissive quote.
    """
    if amount_in_wei <= 0:
        raise ValueError("swap input must be positive")
    price = Decimal(str(eth_usd_price))
    if price <= 0:
        raise ValueError("ETH/USD price must be positive for slippage protection")

    bps = DEFAULT_MAX_SLIPPAGE_BPS if max_slippage_bps is None else int(max_slippage_bps)
    # A zero bound is not executable on a fee-bearing AMM: even a perfectly priced
    # pool charges its LP fee, so the transaction would revert after a private
    # nullifier had already been spent. Require an explicit positive safety margin.
    if bps <= 0 or bps > MAX_ALLOWED_SLIPPAGE_BPS:
        raise ValueError(
            f"max_slippage_bps must be between 1 and {MAX_ALLOWED_SLIPPAGE_BPS}"
        )

    pair = (asset_in.upper(), asset_out.upper())
    if pair == ("USDC", "ETH"):
        # USDC units (1e6) → ETH wei (1e18): amount * 1e12 / ETHUSD.
        expected = (
            Decimal(amount_in_wei) * Decimal(10**12) / price
        ).to_integral_value(rounding=ROUND_DOWN)
    elif pair == ("ETH", "USDC"):
        # ETH wei (1e18) → USDC units (1e6): amount * ETHUSD / 1e12.
        expected = (
            Decimal(amount_in_wei) * price / Decimal(10**12)
        ).to_integral_value(rounding=ROUND_DOWN)
    else:
        raise ValueError(f"no protected single-shot price conversion for {pair[0]}→{pair[1]}")

    minimum = int(expected) * (10_000 - bps) // 10_000
    if minimum <= 0:
        raise ValueError("calculated minimum swap output is zero")
    return minimum


def preflight_same_chain_swap(
    w3: Web3,
    chain: EvmChainConfig,
    asset_in: str,
    asset_out: str,
    amount_in_wei: int,
    eth_usd_price: float,
    max_slippage_bps: Optional[int],
) -> Optional[int]:
    """Validate deterministic same-chain routing before any private nullifier is spent."""
    pair = (asset_in.upper(), asset_out.upper())
    if pair[0] == pair[1]:
        return None

    amount_out_minimum = minimum_output_wei(
        pair[0], pair[1], amount_in_wei, eth_usd_price, max_slippage_bps
    )
    router = chain.uniswap_v3_router

    if pair == ("ETH", "USDC"):
        _resolve_v3_pool(
            w3, chain, chain.weth, chain.token_address("USDC"), chain.swap_fee_tier
        )
        if not (
            _router_uses_simple_swap(w3, router)
            or _router_uses_swap_router_02(w3, router)
            or _router_uses_universal(w3, router)
        ):
            raise ValueError(f"configured router {router} cannot execute ETH→USDC")
        return amount_out_minimum

    if pair == ("USDC", "ETH"):
        _resolve_v3_pool(
            w3, chain, chain.token_address("USDC"), chain.weth, chain.swap_fee_tier
        )
        if not (
            _router_uses_simple_pool_swap(w3, router)
            or _router_uses_classic_v3(w3, router)
            or _router_uses_swap_router_02(w3, router)
        ):
            raise ValueError(f"configured router {router} cannot execute USDC→ETH")
        return amount_out_minimum

    raise ValueError(
        f"unsupported protected single-shot swap {pair[0]}→{pair[1]}"
    )


def _extract_nullifier_hashes(zk_proof: dict) -> list[int]:
    """Validate and return every public nullifier bound into a withdraw proof.

    WN proofs have N nullifier public inputs, so silently collapsing a proof to
    ``nullifierHash`` makes the executor select W1 and guarantees
    ``InvalidZKProof``.  Legacy singular payloads remain valid for W1 only.
    """
    declared_count = zk_proof.get("noteCount")
    if declared_count is not None:
        try:
            declared_count = int(declared_count)
        except (TypeError, ValueError) as exc:
            raise FatalExecutionError("zk_proof noteCount must be an integer") from exc
        if declared_count < 1 or declared_count > 6:
            raise FatalExecutionError("zk_proof noteCount must be between 1 and 6")

    hashes = zk_proof.get("nullifierHashes")
    if hashes is not None:
        if not isinstance(hashes, list) or not hashes:
            raise FatalExecutionError("zk_proof nullifierHashes must be a non-empty array")
        if len(hashes) > 6:
            raise FatalExecutionError("zk_proof nullifierHashes supports at most 6 notes")
        if declared_count is not None and declared_count != len(hashes):
            raise FatalExecutionError(
                f"zk_proof noteCount={declared_count} does not match "
                f"nullifierHashes length={len(hashes)}"
            )
        try:
            parsed = [int(value) for value in hashes]
        except (TypeError, ValueError) as exc:
            raise FatalExecutionError("zk_proof nullifierHashes contains a non-integer") from exc

        public_signals = zk_proof.get("publicSignals")
        if isinstance(public_signals, list):
            # Hard ASP withdraw: N + 6 publics (adds aspRoot + changeLabel vs soft N+4)
            inferred_count = len(public_signals) - 6
            if inferred_count != len(parsed):
                raise FatalExecutionError(
                    "zk_proof nullifierHashes length does not match Hard ASP publicSignals "
                    f"({len(parsed)} hashes, {inferred_count} inferred notes; expected len(publicSignals)=N+6)"
                )

        singular = zk_proof.get("nullifierHash")
        if singular not in (None, ""):
            try:
                singular_value = int(singular)
            except (TypeError, ValueError) as exc:
                raise FatalExecutionError("zk_proof nullifierHash must be an integer") from exc
            if singular_value != parsed[0]:
                raise FatalExecutionError(
                    "zk_proof nullifierHash does not match nullifierHashes[0]"
                )
        return parsed

    singular = zk_proof.get("nullifierHash")
    if singular in (None, ""):
        raise FatalExecutionError("zk_proof missing nullifierHashes[] / nullifierHash")

    # A declared multi-note proof cannot be reconstructed here: the omitted
    # nullifiers are derived from client-held note secrets and were never sent.
    if declared_count is not None and declared_count != 1:
        raise FatalExecutionError(
            "zk_proof missing nullifierHashes[] for a multi-note proof; "
            "the strategy must be re-armed from the client"
        )

    public_signals = zk_proof.get("publicSignals")
    # Hard ASP W1 = 7 publics; soft W1 = 5 — reject soft-era proofs
    if isinstance(public_signals, list) and len(public_signals) != 7:
        inferred_count = len(public_signals) - 6 if len(public_signals) >= 7 else len(public_signals) - 4
        raise FatalExecutionError(
            "zk_proof missing nullifierHashes[] for a multi-note Hard ASP proof "
            f"({inferred_count} notes inferred from publicSignals); "
            "the strategy must be re-armed from the client"
        )

    try:
        return [int(singular)]
    except (TypeError, ValueError) as exc:
        raise FatalExecutionError("zk_proof nullifierHash must be an integer") from exc


def _extract_change_commitment(zk_proof: dict) -> str:
    """Extract the change commitment.

    Frontend sends changeCommitment (circuit output). newCommitment is an alias
    kept for backward compatibility with older proof shapes.
    """
    return str(zk_proof.get("changeCommitment") or zk_proof.get("newCommitment", ""))


def _confirmed_spent_nullifiers(
    w3: Web3,
    chain: EvmChainConfig,
    asset_address: str,
    nullifier_hashes: list[int],
) -> Optional[list[str]]:
    """Read the vault's public mapping so a mixed WN proof does not quarantine valid notes."""
    try:
        entrypoint = w3.eth.contract(
            address=Web3.to_checksum_address(chain.entrypoint),
            abi=ENTRYPOINT_VAULT_ABI,
        )
        vault_address = entrypoint.functions.getVault(
            Web3.to_checksum_address(asset_address)
        ).call()
        vault = w3.eth.contract(
            address=Web3.to_checksum_address(vault_address),
            abi=NULLIFIER_STATUS_ABI,
        )
        return [str(value) for value in nullifier_hashes if vault.functions.nullifiers(value).call()]
    except Exception as exc:
        print(f"   [EVM] ⚠️ could not reconcile spent nullifiers on-chain: {exc}")
        return None


def zk_withdraw_from_vault(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    asset_address: str,
    recipient: str,
    amount_wei: int,
    zk_proof: dict,
    change_depositor: str,
    on_prepared=None,
) -> str:
    """
    Call Entrypoint.withdraw() with the Hard ASP ZK proof.
    zk_proof must contain: stateRoot, aspRoot, changeLabel, nullifierHashes[],
    changeCommitment, changeValue, pA, pB, pC

    `change_depositor` is the note OWNER (the strategy's user), never the recipient and never
    the executor: it and `changeValue` back the change note's DepositInfo, which is what the
    postman revokes and the owner ragequits against. Handing the executor's own address here
    would silently transfer that authority away from the user.
    """
    print(f"   [EVM] ZK withdraw on {chain.name} ({chain.chain_id}): {amount_wei} wei of {asset_address} → {recipient}")

    assert_hard_asp_entrypoint(w3, chain)

    entrypoint = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint),
        abi=ENTRYPOINT_ABI,
    )

    nullifier_hashes_list = _extract_nullifier_hashes(zk_proof)
    nullifier_hash = str(nullifier_hashes_list[0])
    change_commitment = _extract_change_commitment(zk_proof)

    if not change_commitment:
        raise FatalExecutionError("zk_proof missing changeCommitment / newCommitment")

    asp_root = zk_proof.get("aspRoot")
    change_label = zk_proof.get("changeLabel")
    if asp_root in (None, ""):
        raise FatalExecutionError("zk_proof missing aspRoot (Hard ASP)")
    if change_label in (None, ""):
        raise FatalExecutionError("zk_proof missing changeLabel (Hard ASP)")

    # changeValue is a PRIVATE circuit input — it is not in publicSignals and cannot be derived
    # from the proof, so a blob armed before it was plumbed through is unusable. Fail closed with
    # an actionable message rather than guessing: a wrong value writes the wrong DepositInfo.
    change_value = zk_proof.get("changeValue")
    if change_value in (None, ""):
        raise FatalExecutionError(
            "zk_proof missing changeValue — re-arm this strategy (armed before the "
            "depositor/changeValue fields were added to Entrypoint.withdraw)"
        )
    if not change_depositor:
        raise FatalExecutionError("change_depositor required — refusing to strand change-note authority")
    change_depositor_cs = Web3.to_checksum_address(change_depositor)
    change_value_i = int(change_value)

    # Parse proof components — stored as string arrays in the DB
    pA = [int(x) for x in zk_proof["pA"]]
    pB = [[int(x) for x in row] for row in zk_proof["pB"]]
    pC = [int(x) for x in zk_proof["pC"]]
    asp_root_i = int(asp_root)
    change_label_i = int(change_label)

    print(f"   [EVM] Proof components:")
    print(f"         stateRoot:        {zk_proof['stateRoot']}")
    print(f"         aspRoot:          {str(asp_root_i)[:12]}…")
    print(f"         nullifierHash[0]: {nullifier_hash[:16]}…" if len(nullifier_hash) > 16 else f"         nullifierHash[0]: {nullifier_hash}")
    print(f"         changeCommitment: {str(change_commitment)[:16]}…")
    # Privacy: do not log full changeLabel (association graph)

    # Dry-run via raw JSON-RPC eth_call (web3.py misreads void-returning functions)
    import requests as _req
    # Signature MUST track the deployed Entrypoint exactly. Round 2 inserted _depositor and
    # _changeValue after _recipient; the old 11-arg form hashes to a selector the contract does
    # not implement, so the call reverts with EMPTY revert data and reads as a proof failure.
    # tests/test_hard_asp_contract_compat.py pins this against the deployed bytecode.
    _withdraw_sel = Web3.keccak(
        text="withdraw(address,address,address,uint256,uint256,uint256,uint256,uint256[],uint256,uint256,uint256[2],uint256[2][2],uint256[2])"
    )[:4]
    from eth_abi import encode as _enc
    _calldata = _withdraw_sel + _enc(
        [
            "address", "address", "address", "uint256", "uint256", "uint256", "uint256",
            "uint256[]", "uint256", "uint256",
            "uint256[2]", "uint256[2][2]", "uint256[2]",
        ],
        [
            Web3.to_checksum_address(asset_address),
            Web3.to_checksum_address(recipient),
            change_depositor_cs,
            change_value_i,
            amount_wei,
            int(zk_proof["stateRoot"]),
            asp_root_i,
            nullifier_hashes_list,
            int(change_commitment),
            change_label_i,
            pA, pB, pC,
        ],
    )
    t_dryrun = time.monotonic()
    _resp = _req.post(chain.rpc_url, json={
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{"to": chain.entrypoint, "from": account.address, "data": "0x" + _calldata.hex(), "gas": "0x4C4B40"}, "latest"]
    }, timeout=15).json()
    t_dryrun = (time.monotonic() - t_dryrun) * 1000
    if "error" in _resp:
        _err_data = _resp["error"].get("data", "")
        _raw = bytes.fromhex(_err_data[2:]) if isinstance(_err_data, str) and _err_data.startswith("0x") else b""
        _reason = decode_revert(_raw)
        print(f"   [EVM] ❌ eth_call revert: {_reason} | raw: {_resp['error']}")
        if "NullifierAlreadySpent()" in _reason:
            spent_hashes = _confirmed_spent_nullifiers(
                w3, chain, asset_address, nullifier_hashes_list
            )
            raise NullifierAlreadySpentError(spent_hashes)
        # Fatal errors — retrying will never succeed
        _fatal_errors = {
            "NullifierAlreadySpent()",
            "InvalidZKProof()",
            "InvalidAspRoot()",
            "ZeroAddress()",
            "InvalidWithdrawalAmount()",
            "WithdrawalCostExceedsAmount(",
            "WithdrawalBelowMinimum(",
        }
        if any(e in _reason for e in _fatal_errors):
            diagnostic = ""
            if "InvalidZKProof()" in _reason and "nullifierHashes" not in zk_proof:
                diagnostic = (
                    "; legacy proof omitted nullifierHashes[] — if this is a multi-note "
                    "proof, the missing hashes cannot be recovered server-side and the "
                    "strategy must be re-armed"
                )
            raise FatalExecutionError(f"withdraw() would revert: {_reason}{diagnostic}")
        raise RuntimeError(f"withdraw() would revert: {_reason}")
    else:
        print(f"   [EVM] ✅ eth_call dry-run OK ({t_dryrun:.0f}ms)")

    # Pre-set gas so build_transaction doesn't call estimate_gas inline
    tx = entrypoint.functions.withdraw(
        Web3.to_checksum_address(asset_address),
        Web3.to_checksum_address(recipient),
        change_depositor_cs,
        change_value_i,
        amount_wei,
        int(zk_proof["stateRoot"]),
        asp_root_i,
        nullifier_hashes_list,
        int(change_commitment),
        change_label_i,
        pA,
        pB,
        pC,
    ).build_transaction({"from": account.address})

    print(f"   [Benchmark] [zk_withdraw] eth_call_dryrun={t_dryrun:.0f}ms")
    return send_tx(
        w3,
        account,
        tx,
        label="zk_withdraw",
        gas_buffer=1.35,
        on_prepared=on_prepared,
    )


def zk_withdraw_from_legacy_vault(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    asset_address: str,
    recipient: str,
    amount_wei: int,
    zk_proof: dict,
) -> str:
    """Withdraw from an allowlisted soft-era vault using its pre-ASP proof shape.

    ``chain.entrypoint`` comes only from ``legacy_vaults.resolve_legacy_vault``.
    Raw calldata is intentional: the current Entrypoint ABI exposes the Hard-ASP
    overload and must not accidentally change the legacy selector.
    """
    nullifier_hashes = _extract_nullifier_hashes(zk_proof)
    change_commitment = _extract_change_commitment(zk_proof)
    if not change_commitment:
        raise FatalExecutionError("zk_proof missing changeCommitment / newCommitment")
    if zk_proof.get("aspRoot") not in (None, "") or zk_proof.get("changeLabel") not in (None, ""):
        raise FatalExecutionError("legacy withdrawal does not accept Hard ASP proof fields")

    try:
        p_a = [int(value) for value in zk_proof["pA"]]
        p_b = [[int(value) for value in row] for row in zk_proof["pB"]]
        p_c = [int(value) for value in zk_proof["pC"]]
        state_root = int(zk_proof["stateRoot"])
        change_commitment_i = int(change_commitment)
    except (KeyError, TypeError, ValueError) as exc:
        raise FatalExecutionError("legacy withdrawal proof contains malformed fields") from exc

    from eth_abi import encode as _encode
    import requests as _requests

    selector = Web3.keccak(
        text="withdraw(address,address,uint256,uint256,uint256[],uint256,uint256[2],uint256[2][2],uint256[2])"
    )[:4]
    calldata = selector + _encode(
        [
            "address", "address", "uint256", "uint256", "uint256[]",
            "uint256", "uint256[2]", "uint256[2][2]", "uint256[2]",
        ],
        [
            Web3.to_checksum_address(asset_address),
            Web3.to_checksum_address(recipient),
            amount_wei,
            state_root,
            nullifier_hashes,
            change_commitment_i,
            p_a,
            p_b,
            p_c,
        ],
    )

    response = _requests.post(
        chain.rpc_url,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{
                "to": chain.entrypoint,
                "from": account.address,
                "data": "0x" + calldata.hex(),
                "gas": "0x4C4B40",
            }, "latest"],
        },
        timeout=15,
    ).json()
    if "error" in response:
        error_data = response["error"].get("data", "")
        raw = (
            bytes.fromhex(error_data[2:])
            if isinstance(error_data, str) and error_data.startswith("0x")
            else b""
        )
        reason = decode_revert(raw)
        if "NullifierAlreadySpent()" in reason:
            spent = _confirmed_spent_nullifiers(
                w3, chain, asset_address, nullifier_hashes
            )
            raise NullifierAlreadySpentError(spent)
        fatal_errors = {
            "NullifierAlreadySpent()",
            "InvalidZKProof()",
            "ZeroAddress()",
            "InvalidWithdrawalAmount()",
            "WithdrawalCostExceedsAmount(",
            "WithdrawalBelowMinimum(",
        }
        if any(error in reason for error in fatal_errors):
            raise FatalExecutionError(f"legacy withdraw() would revert: {reason}")
        raise RuntimeError(f"legacy withdraw() would revert: {reason}")

    tx = {
        "from": account.address,
        "to": Web3.to_checksum_address(chain.entrypoint),
        "data": calldata,
        "gas": _GAS_FALLBACK["zk_withdraw"],
    }
    return send_tx(w3, account, tx, label="legacy_zk_withdraw", gas_buffer=1.35)


def zk_withdraw_from_legacy_vault(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    asset_address: str,
    recipient: str,
    amount_wei: int,
    zk_proof: dict,
) -> str:
    """Withdraw from an allowlisted soft-era vault using its pre-ASP proof shape.

    ``chain.entrypoint`` comes only from ``legacy_vaults.resolve_legacy_vault``.
    Raw calldata is intentional: the current Entrypoint ABI exposes the Hard-ASP
    overload and must not accidentally change the legacy selector.
    """
    nullifier_hashes = _extract_nullifier_hashes(zk_proof)
    change_commitment = _extract_change_commitment(zk_proof)
    if not change_commitment:
        raise FatalExecutionError("zk_proof missing changeCommitment / newCommitment")
    if zk_proof.get("aspRoot") not in (None, "") or zk_proof.get("changeLabel") not in (None, ""):
        raise FatalExecutionError("legacy withdrawal does not accept Hard ASP proof fields")

    try:
        p_a = [int(value) for value in zk_proof["pA"]]
        p_b = [[int(value) for value in row] for row in zk_proof["pB"]]
        p_c = [int(value) for value in zk_proof["pC"]]
        state_root = int(zk_proof["stateRoot"])
        change_commitment_i = int(change_commitment)
    except (KeyError, TypeError, ValueError) as exc:
        raise FatalExecutionError("legacy withdrawal proof contains malformed fields") from exc

    from eth_abi import encode as _encode
    import requests as _requests

    selector = Web3.keccak(
        text="withdraw(address,address,uint256,uint256,uint256[],uint256,uint256[2],uint256[2][2],uint256[2])"
    )[:4]
    calldata = selector + _encode(
        [
            "address", "address", "uint256", "uint256", "uint256[]",
            "uint256", "uint256[2]", "uint256[2][2]", "uint256[2]",
        ],
        [
            Web3.to_checksum_address(asset_address),
            Web3.to_checksum_address(recipient),
            amount_wei,
            state_root,
            nullifier_hashes,
            change_commitment_i,
            p_a,
            p_b,
            p_c,
        ],
    )

    response = _requests.post(
        chain.rpc_url,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{
                "to": chain.entrypoint,
                "from": account.address,
                "data": "0x" + calldata.hex(),
                "gas": "0x4C4B40",
            }, "latest"],
        },
        timeout=15,
    ).json()
    if "error" in response:
        error_data = response["error"].get("data", "")
        raw = (
            bytes.fromhex(error_data[2:])
            if isinstance(error_data, str) and error_data.startswith("0x")
            else b""
        )
        reason = decode_revert(raw)
        if "NullifierAlreadySpent()" in reason:
            spent = _confirmed_spent_nullifiers(
                w3, chain, asset_address, nullifier_hashes
            )
            raise NullifierAlreadySpentError(spent)
        fatal_errors = {
            "NullifierAlreadySpent()",
            "InvalidZKProof()",
            "ZeroAddress()",
            "InvalidWithdrawalAmount()",
            "WithdrawalCostExceedsAmount(",
            "WithdrawalBelowMinimum(",
        }
        if any(error in reason for error in fatal_errors):
            raise FatalExecutionError(f"legacy withdraw() would revert: {reason}")
        raise RuntimeError(f"legacy withdraw() would revert: {reason}")

    tx = {
        "from": account.address,
        "to": Web3.to_checksum_address(chain.entrypoint),
        "data": calldata,
        "gas": _GAS_FALLBACK["zk_withdraw"],
    }
    return send_tx(w3, account, tx, label="legacy_zk_withdraw", gas_buffer=1.35)





def zk_merge_from_vault(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    asset_address: str,
    zk_proof: dict,
    depositor: str,
    on_prepared=None,
) -> str:
    """Submit a Hard ASP M2-M6 consolidation proof without moving funds.

    Round 2 added _depositor + _mergedValue, which back the merged note's DepositInfo. Same
    contract drift as withdraw(): the old 9-arg form reverts with empty revert data.
    """
    assert_hard_asp_entrypoint(w3, chain)

    nullifier_hashes = _extract_nullifier_hashes(zk_proof)
    if len(nullifier_hashes) < 2:
        raise FatalExecutionError("merge proof requires at least two nullifierHashes")

    asp_root = zk_proof.get("aspRoot")
    merged_commitment = zk_proof.get("mergedCommitment")
    if merged_commitment in (None, ""):
        merged_commitment = zk_proof.get("changeCommitment")
    merged_label = zk_proof.get("mergedLabel")
    if asp_root in (None, ""):
        raise FatalExecutionError("merge proof missing aspRoot (Hard ASP)")
    if merged_commitment in (None, ""):
        raise FatalExecutionError("merge proof missing mergedCommitment")
    if merged_label in (None, ""):
        raise FatalExecutionError("merge proof missing mergedLabel (Hard ASP)")

    # Private circuit input, same as withdraw's changeValue — not recoverable from the proof.
    merged_value = zk_proof.get("mergedValue")
    if merged_value in (None, ""):
        merged_value = zk_proof.get("changeValue")
    if merged_value in (None, ""):
        raise FatalExecutionError(
            "merge proof missing mergedValue — re-arm (armed before the depositor/mergedValue "
            "fields were added to Entrypoint.merge)"
        )
    if not depositor:
        raise FatalExecutionError("depositor required — refusing to strand merged-note authority")

    try:
        pA = [int(value) for value in zk_proof["pA"]]
        pB = [[int(value) for value in row] for row in zk_proof["pB"]]
        pC = [int(value) for value in zk_proof["pC"]]
        state_root = int(zk_proof["stateRoot"])
        asp_root_i = int(asp_root)
        merged_commitment_i = int(merged_commitment)
        merged_label_i = int(merged_label)
        merged_value_i = int(merged_value)
        depositor_cs = Web3.to_checksum_address(depositor)
    except (KeyError, TypeError, ValueError) as exc:
        raise FatalExecutionError("merge proof contains malformed fields") from exc

    entrypoint = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint),
        abi=ENTRYPOINT_MERGE_ABI,
    )
    tx = entrypoint.functions.merge(
        Web3.to_checksum_address(asset_address),
        depositor_cs,
        merged_value_i,
        state_root,
        asp_root_i,
        nullifier_hashes,
        merged_commitment_i,
        merged_label_i,
        pA,
        pB,
        pC,
    ).build_transaction({"from": account.address})
    send_options = {"label": "zk_merge", "gas_buffer": 1.35}
    if on_prepared is not None:
        send_options["on_prepared"] = on_prepared
    return send_tx(w3, account, tx, **send_options)


def _swap_eth_to_token_universal(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    token_out_address: str,
    amount_wei: int,
    recipient: str,
    fee_tier: int,
    amount_out_minimum: int,
) -> str:
    """ETH → token via Uniswap Universal Router: WRAP_ETH + V3_SWAP_EXACT_IN."""
    from eth_abi import encode as _abi_encode

    router = w3.eth.contract(
        address=Web3.to_checksum_address(chain.uniswap_v3_router),
        abi=UNIVERSAL_ROUTER_ABI,
    )

    commands = bytes([0x0b, 0x00])
    wrap_input = _abi_encode(
        ["address", "uint256"],
        [Web3.to_checksum_address(chain.uniswap_v3_router), amount_wei],
    )
    path = (
        bytes.fromhex(Web3.to_checksum_address(chain.weth)[2:])
        + fee_tier.to_bytes(3, "big")
        + bytes.fromhex(Web3.to_checksum_address(token_out_address)[2:])
    )
    swap_input = _abi_encode(
        ["address", "uint256", "uint256", "bytes", "bool"],
        [Web3.to_checksum_address(recipient), amount_wei, amount_out_minimum, path, False],
    )

    tx = router.functions.execute(
        commands,
        [wrap_input, swap_input],
        int(time.time()) + 300,
    ).build_transaction({
        "from": account.address,
        "value": amount_wei,
        "gas": SWAP_GAS_FLOOR,
    })
    return send_tx(w3, account, tx, label="ur_swap")


def _swap_eth_to_token_simple(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    token_out_address: str,
    amount_wei: int,
    recipient: str,
    fee_tier: int,
    amount_out_minimum: int,
) -> str:
    """ETH → token via deployed SimpleSwapRouter (Sepolia entrypoint router)."""
    pool, fee = _resolve_v3_pool(
        w3, chain, chain.weth, token_out_address, fee_tier
    )
    router = w3.eth.contract(
        address=Web3.to_checksum_address(chain.uniswap_v3_router),
        abi=SIMPLE_SWAP_ROUTER_ABI,
    )
    params = (
        Web3.to_checksum_address(chain.weth),
        Web3.to_checksum_address(token_out_address),
        fee,
        Web3.to_checksum_address(recipient),
        int(time.time()) + 300,
        amount_wei,
        amount_out_minimum,
        0,
    )
    tx = router.functions.exactInputSingleWithETH(
        pool,
        Web3.to_checksum_address(chain.weth),
        params,
    ).build_transaction({
        "from": account.address,
        "value": amount_wei,
        "gas": SWAP_GAS_FLOOR,
    })
    return send_tx(w3, account, tx, label="simple_swap")


def _swap_eth_to_token_swap_router_02(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    token_out_address: str,
    amount_wei: int,
    recipient: str,
    fee_tier: int,
    amount_out_minimum: int,
) -> str:
    """ETH → token via Uniswap SwapRouter02.exactInputSingle (payable, auto-wraps ETH)."""
    # Pick a fee tier that actually has a pool (preferring the requested one).
    _, fee = _resolve_v3_pool(w3, chain, chain.weth, token_out_address, fee_tier)
    router = w3.eth.contract(
        address=Web3.to_checksum_address(chain.uniswap_v3_router),
        abi=SWAP_ROUTER_02_ABI,
    )
    params = (
        Web3.to_checksum_address(chain.weth),       # tokenIn (msg.value gets wrapped)
        Web3.to_checksum_address(token_out_address),  # tokenOut
        fee,
        Web3.to_checksum_address(recipient),
        amount_wei,
        amount_out_minimum,
        0,                                            # sqrtPriceLimitX96
    )
    tx = router.functions.exactInputSingle(params).build_transaction({
        "from": account.address,
        "value": amount_wei,
        "gas": SWAP_GAS_FLOOR,
    })
    return send_tx(w3, account, tx, label="ur_swap")


def swap_eth_to_token(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    token_out_address: str,
    amount_wei: int,
    recipient: str,
    amount_out_minimum: int,
    fee_tier: Optional[int] = None,
) -> str:
    """ETH → ERC20 using the swap router configured for this chain."""
    fee = fee_tier if fee_tier is not None else chain.swap_fee_tier
    router_addr = chain.uniswap_v3_router
    if _router_uses_simple_swap(w3, router_addr):
        print(
            f"   [EVM] Swapping on {chain.name} ({chain.chain_id}): "
            f"{amount_wei} wei ETH → {token_out_address} via SimpleSwapRouter"
        )
        return _swap_eth_to_token_simple(
            w3, account, chain, token_out_address, amount_wei, recipient, fee,
            amount_out_minimum,
        )

    if _router_uses_swap_router_02(w3, router_addr):
        print(
            f"   [EVM] Swapping on {chain.name} ({chain.chain_id}): "
            f"{amount_wei} wei ETH → {token_out_address} via SwapRouter02"
        )
        return _swap_eth_to_token_swap_router_02(
            w3, account, chain, token_out_address, amount_wei, recipient, fee,
            amount_out_minimum,
        )

    print(
        f"   [EVM] Swapping on {chain.name} ({chain.chain_id}): "
        f"{amount_wei} wei ETH → {token_out_address} via UniversalRouter"
    )
    return _swap_eth_to_token_universal(
        w3, account, chain, token_out_address, amount_wei, recipient, fee,
        amount_out_minimum,
    )


def _approve_erc20_exact(
    w3: Web3,
    account,
    token,
    spender: str,
    amount_wei: int,
) -> None:
    """Grant only this swap's input amount, resetting a stale allowance first."""
    spender = Web3.to_checksum_address(spender)
    current = int(token.functions.allowance(account.address, spender).call())
    if current:
        reset_tx = token.functions.approve(spender, 0).build_transaction(
            {"from": account.address, "gas": 120_000}
        )
        send_tx(w3, account, reset_tx, label="approve_swap_reset")
    approve_tx = token.functions.approve(spender, amount_wei).build_transaction(
        {"from": account.address, "gas": 120_000}
    )
    send_tx(w3, account, approve_tx, label="approve_swap")


def _best_effort_revoke_erc20(
    w3: Web3,
    account,
    token,
    spender: str,
) -> None:
    """Revoke a residual allowance after a failed swap without masking the root error."""
    try:
        spender = Web3.to_checksum_address(spender)
        if int(token.functions.allowance(account.address, spender).call()) <= 0:
            return
        revoke_tx = token.functions.approve(spender, 0).build_transaction(
            {"from": account.address, "gas": 120_000}
        )
        send_tx(w3, account, revoke_tx, label="approve_swap_revoke")
    except Exception as revoke_err:
        print(f"   [EVM] ⚠️ could not revoke failed-swap allowance: {revoke_err}")


def swap_token_to_eth(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    token_in_address: str,
    amount_wei: int,
    amount_out_minimum: int,
) -> tuple[str, int]:
    """Swap an exact ERC20 amount to WETH, then unwrap exactly the received WETH.

    Returns ``(unwrap_tx_hash, native_wei_received)``. The caller decides whether to
    transfer the native ETH externally or re-deposit it into the private native vault.
    """
    if amount_out_minimum <= 0:
        raise ValueError("token→ETH swap requires a non-zero amountOutMinimum")

    router_address = Web3.to_checksum_address(chain.uniswap_v3_router)
    token_in_address = Web3.to_checksum_address(token_in_address)
    weth_address = Web3.to_checksum_address(chain.weth)
    pool, fee = _resolve_v3_pool(
        w3, chain, token_in_address, weth_address, chain.swap_fee_tier
    )
    token = w3.eth.contract(address=token_in_address, abi=ERC20_ABI)
    _approve_erc20_exact(w3, account, token, router_address, amount_wei)

    recipient = Web3.to_checksum_address(account.address)
    if _router_uses_simple_pool_swap(w3, router_address):
        router = w3.eth.contract(address=router_address, abi=SIMPLE_SWAP_ROUTER_POOL_ABI)
        params = (
            token_in_address,
            weth_address,
            fee,
            recipient,
            int(time.time()) + 300,
            amount_wei,
            amount_out_minimum,
            0,
        )
        swap_call = router.functions.exactInputSingleWithPool(pool, params)
    elif _router_uses_classic_v3(w3, router_address):
        router = w3.eth.contract(address=router_address, abi=SWAP_ROUTER_V3_ABI)
        params = (
            token_in_address,
            weth_address,
            fee,
            recipient,
            int(time.time()) + 300,
            amount_wei,
            amount_out_minimum,
            0,
        )
        swap_call = router.functions.exactInputSingle(params)
    elif _router_uses_swap_router_02(w3, router_address):
        router = w3.eth.contract(address=router_address, abi=SWAP_ROUTER_02_ABI)
        params = (
            token_in_address,
            weth_address,
            fee,
            recipient,
            amount_wei,
            amount_out_minimum,
            0,
        )
        swap_call = router.functions.exactInputSingle(params)
    else:
        raise RuntimeError(
            f"Configured router {router_address} has no supported ERC20 exactInputSingle selector"
        )

    print(
        f"   [EVM] Swapping on {chain.name} ({chain.chain_id}): "
        f"{amount_wei} of {token_in_address} → WETH (min {amount_out_minimum})"
    )
    swap_tx = swap_call.build_transaction(
        {"from": account.address, "value": 0, "gas": SWAP_GAS_FLOOR}
    )
    swap_hash = None
    try:
        swap_hash = send_tx(w3, account, swap_tx, label="token_to_weth")
    except Exception as swap_err:
        _best_effort_revoke_erc20(w3, account, token, router_address)
        raise CustodyStageError(
            "token_to_weth", token_in_address, amount_wei, None, swap_err
        ) from swap_err
    try:
        received_weth = token_received_in_tx(
            w3, swap_hash, weth_address, account.address
        )
    except Exception as receipt_err:
        raise CustodyStageError(
            "token_to_weth_receipt", "WETH", 0, swap_hash, receipt_err
        ) from receipt_err
    if received_weth < amount_out_minimum:
        raise CustodyStageError(
            "token_to_weth_receipt",
            "WETH",
            received_weth,
            swap_hash,
            RuntimeError(
                f"WETH received {received_weth} below protected minimum {amount_out_minimum}"
            ),
        )

    weth = w3.eth.contract(address=weth_address, abi=WETH_ABI)
    unwrap_tx = weth.functions.withdraw(received_weth).build_transaction(
        {"from": account.address, "gas": 120_000}
    )
    try:
        unwrap_hash = send_tx(w3, account, unwrap_tx, label="unwrap_weth")
    except Exception as unwrap_err:
        raise CustodyStageError(
            "unwrap_weth", "WETH", received_weth, swap_hash, unwrap_err
        ) from unwrap_err
    return unwrap_hash, received_weth


def transfer_eth(w3: Web3, account, recipient: str, amount_wei: int) -> str:
    """Direct ETH transfer (no swap needed for ETH→ETH strategies)."""
    print(f"   [EVM] Transferring {amount_wei} wei ETH → {recipient}")
    tx = {
        "to":    Web3.to_checksum_address(recipient),
        "value": amount_wei,
        "data":  b"",
    }
    return send_tx(w3, account, tx)


def erc20_balance_of(w3: Web3, token_address: str, owner: str) -> int:
    token = w3.eth.contract(
        address=Web3.to_checksum_address(token_address),
        abi=ERC20_ABI,
    )
    return int(token.functions.balanceOf(Web3.to_checksum_address(owner)).call())


# Transfer(address indexed from, address indexed to, uint256 value)
_TRANSFER_TOPIC = Web3.keccak(text="Transfer(address,address,uint256)")


def token_received_in_tx(w3: Web3, tx_hash: str, token_address: str, recipient: str) -> int:
    """Sum the token amount delivered to `recipient` in `tx_hash` by reading the swap receipt's
    ERC20 Transfer events. Deterministic — avoids the read-after-write race where a balanceOf
    right after the swap mines can hit an un-synced RPC replica and report a 0 delta."""
    # POLL for the receipt, don't read it once: the swap tx is already mined (swap_eth_to_token waited
    # on it), but a load-balanced RPC can route THIS read to a replica that hasn't synced the tx yet,
    # raising TransactionNotFound. A single get_transaction_receipt turned that transient lag into a
    # false "swap failed" AFTER the swap succeeded on-chain — stranding the fill in the executor
    # wallet. wait_for_transaction_receipt retries until a synced replica answers (same as the withdraw
    # path). A short poll covers replica lag; a genuinely missing tx still raises after the timeout.
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180, poll_latency=2)
    token = Web3.to_checksum_address(token_address)
    recip = Web3.to_checksum_address(recipient)
    total = 0
    for log in receipt["logs"]:
        if Web3.to_checksum_address(log["address"]) != token:
            continue
        topics = log["topics"]
        if len(topics) < 3 or bytes(topics[0]) != bytes(_TRANSFER_TOPIC):
            continue
        to_addr = Web3.to_checksum_address("0x" + bytes(topics[2])[-20:].hex())
        if to_addr == recip:
            total += int(bytes(log["data"]).hex() or "0", 16)
    return total


def deposit_to_vault(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    token_address: str,
    amount_wei: int,
    precommitment: int,
) -> str:
    """Re-deposit ERC20 funds the executor holds into the Siphon vault as a private note.

    The Entrypoint pulls `amount_wei` from the executor (msg.sender) into the asset's vault and
    mints commitment = Poseidon(actualReceived, precommitment) on-chain. The user — who alone
    knows the nullifier/secret behind `precommitment` — can later withdraw this note themselves.
    """
    token = w3.eth.contract(
        address=Web3.to_checksum_address(token_address),
        abi=ERC20_ABI,
    )
    entrypoint = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint),
        abi=ENTRYPOINT_ABI,
    )

    entrypoint_addr = Web3.to_checksum_address(chain.entrypoint)

    # Approve the Entrypoint to pull the tokens (Entrypoint routes them straight to the vault).
    # Set explicit gas so build_transaction does NOT run an inline estimate_gas (which would hit
    # the same read-after-write RPC lag and could simulate against stale state).
    approve_tx = token.functions.approve(
        entrypoint_addr,
        amount_wei,
    ).build_transaction({"from": account.address, "gas": 120_000})
    send_tx(w3, account, approve_tx, label="approve_deposit")

    # Wait until the executor's RPC actually reflects the new allowance before building the
    # deposit. Without this, the deposit's gas pre-flight can simulate against allowance=0 on an
    # un-synced replica and revert with "transfer amount exceeds allowance".
    for attempt in range(12):
        try:
            allowance = token.functions.allowance(account.address, entrypoint_addr).call()
        except Exception:
            allowance = 0
        if allowance >= amount_wei:
            break
        time.sleep(1)
    else:
        print(f"   [EVM] ⚠️ allowance still {allowance} < {amount_wei} after wait; attempting deposit anyway")

    print(
        f"   [EVM] Re-depositing {amount_wei} of {token_address} into Siphon vault "
        f"as note precommitment={precommitment}"
    )
    # Explicit gas again: skip the inline estimate and give send_tx a gas floor.
    deposit_tx = entrypoint.functions.deposit(
        Web3.to_checksum_address(token_address),
        amount_wei,
        int(precommitment),
    ).build_transaction(
        {"from": account.address, "value": 0, "gas": TOKEN_VAULT_GAS_FLOOR}
    )
    return send_tx(w3, account, deposit_tx, label="vault_deposit")


def deposit_native_to_vault(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    amount_wei: int,
    precommitment: int,
) -> str:
    """Deposit native ETH the executor holds into the native Siphon vault as a private note.
    Payable deposit — no approve; mints Poseidon(amount, precommitment) on-chain. Used by the
    vault-output and recovery flows."""
    entrypoint = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint),
        abi=ENTRYPOINT_ABI,
    )
    deposit_tx = entrypoint.functions.deposit(
        Web3.to_checksum_address(NATIVE_ASSET),
        amount_wei,
        int(precommitment),
    ).build_transaction(
        {
            "from": account.address,
            "value": amount_wei,
            "gas": NATIVE_VAULT_GAS_FLOOR,
        }
    )
    return send_tx(w3, account, deposit_tx, label="vault_deposit_native")


def execute_evm_trade(strategy: dict, current_price: float, on_withdraw_confirmed=None) -> Optional[str]:
    """
    Full EVM execution flow:
      1. ZK withdraw from Siphon vault (if zkp_data present)
      2. Swap asset_in → asset_out via Uniswap v3 (if different tokens)
      3. Transfer directly if same token

    on_withdraw_confirmed: optional callable(zk_tx_hash) fired the moment the ZK
    withdraw receipt confirms on-chain (status==1), before the swap. This is the
    point at which the nullifier is genuinely spent, so the caller marks the note
    spent here — a later swap failure must NOT revert it.

    Returns tx_hash of final transaction, or None on failure.
    """
    print(f"\n{'='*60}")
    print(f"[EVM Executor] Strategy {strategy.get('id')} | price={current_price:.2f}")

    try:
        exec_chain_id = resolve_execution_chain_id(strategy)
        # Preflight: ensure a signer exists for this chain. Remote mode has no local key —
        # the CVM signer is checked lazily on first sign, so only gate the local path here.
        if not evm_remote_signing():
            get_evm_executor_private_key(exec_chain_id)
    except ValueError as e:
        print(f"   [EVM] ❌ {e}")
        return None

    try:
        chain = get_evm_chain_config(exec_chain_id)
        w3 = get_web3(chain)
        if not w3.is_connected():
            print(f"   [EVM] ❌ Cannot connect to RPC for chain {exec_chain_id}: {chain.rpc_url}")
            return None

        on_chain_id = w3.eth.chain_id
        if on_chain_id != chain.chain_id:
            print(f"   [EVM] ❌ RPC chain mismatch: expected {chain.chain_id}, got {on_chain_id}")
            return None

        account = get_executor_account(w3, exec_chain_id)
        print(f"   [EVM] Chain: {chain.name} ({chain.chain_id}) | Entrypoint: {chain.entrypoint}")
        print(f"   [EVM] Executor: {account.address}")

        asset_in  = strategy.get("asset_in", "ETH").upper()
        asset_out = strategy.get("asset_out", "USDC").upper()
        amount    = float(strategy.get("amount", 0))
        recipient = strategy.get("recipient_address")
        zkp_data  = strategy.get("zkp_data")
        raw_private = strategy.get("is_private", True)
        is_private = (
            raw_private.strip().lower() not in {"", "0", "false", "no"}
            if isinstance(raw_private, str)
            else bool(raw_private)
        )
        output_mode = (strategy.get("output_mode") or "address").lower()
        output_precommitment = strategy.get("output_precommitment")

        # In 'vault' mode the swap output is re-deposited into the Siphon vault as a private
        # note (no external recipient). The user later withdraws it themselves.
        is_vault_output = output_mode == "vault"

        if is_vault_output and not output_precommitment:
            print("   [EVM] ❌ output_mode=vault but no output_precommitment")
            return None
        if not is_vault_output and not recipient:
            print("   [EVM] ❌ No recipient_address")
            return None
        if is_private and not zkp_data:
            raise FatalExecutionError(
                "private EVM strategy requires a ZK withdrawal proof"
            )

        decimals_in = TOKEN_DECIMALS.get(asset_in, 18)
        amount_wei  = int(Decimal(str(amount)) * Decimal(10 ** decimals_in))

        if amount_wei <= 0:
            print(f"   [EVM] ❌ Invalid amount: {amount}")
            return None

        to_chain   = strategy.get('to_chain', str(exec_chain_id))
        from_chain = strategy.get('from_chain', str(exec_chain_id))
        is_cross_chain = str(to_chain) != str(from_chain)

        # Atomic vault settle: swap proof + same-chain + vault output → no EOA custody.
        if (
            is_private
            and is_vault_output
            and not is_cross_chain
            and is_swap_and_deposit_proof(zkp_data)
        ):
            print("   [EVM] Using Entrypoint.swapAndDeposit (atomic re-shield)")
            return execute_evm_swap_and_deposit(
                strategy, current_price, on_withdraw_confirmed=on_withdraw_confirmed
            )

        # Compute the exact post-fee amount before withdrawal so every deterministic route,
        # price, slippage, pool, and router check can fail without spending a nullifier.
        fee_wei = 0
        net_wei = amount_wei
        try:
            from fee_calc import compute_execution_fee_wei, exec_bps
            # A signed billing_ref is attached only by the API gateway, so its presence is what
            # separates a partner order (0.05%) from a retail one (0.20%). Time armed is priced
            # once by the window fee at arming and does not move the fill.
            is_api = bool(strategy.get('billing_ref'))
            fee_wei = compute_execution_fee_wei(
                amount_wei, decimals_in, float(current_price or 0), is_api=is_api
            )
            net_wei = amount_wei - fee_wei
            print(f"   [Fee] fill {exec_bps(is_api)}bps ({'api' if is_api else 'retail'}) → "
                  f"{fee_wei} wei {asset_in} (net {net_wei})")
        except Exception as fee_err:
            print(f"   [Fee] ⚠️ fee calculation skipped (executing full amount): {fee_err}")
            fee_wei = 0
            net_wei = amount_wei

        amount_out_minimum = None
        if not is_cross_chain:
            if asset_in == asset_out:
                if not is_vault_output and asset_in != "ETH":
                    raise ValueError(
                        f"same-asset {asset_in}→address ERC20 delivery is not implemented"
                    )
            else:
                amount_out_minimum = preflight_same_chain_swap(
                    w3,
                    chain,
                    asset_in,
                    asset_out,
                    net_wei,
                    current_price,
                    strategy.get("max_slippage_bps"),
                )

        # Step 1: ZK withdraw from vault to executor wallet
        zk_tx = None
        if zkp_data:
            zk = zkp_data if isinstance(zkp_data, dict) else json.loads(zkp_data)
            if zk.get("pA") and zk.get("stateRoot"):
                proof = zk
            elif isinstance(zk.get("proof"), dict) and zk["proof"].get("pA"):
                proof = zk["proof"]
            else:
                proof = None

            if proof:
                asset_address = chain.token_address(asset_in)
                t_zk = time.monotonic()
                zk_tx = zk_withdraw_from_vault(
                    w3, account,
                    chain,
                    asset_address,
                    account.address,  # withdraw to executor, swap/bridge handles final delivery
                    amount_wei,
                    proof,
                    # Change-note authority stays with the strategy owner, NOT the executor
                    # (which is only the recipient of the withdrawn leg).
                    strategy.get("user_id"),
                )
                t_zk_ms = (time.monotonic() - t_zk) * 1000
                print(f"   [Benchmark] [zk_withdraw_total]   = {t_zk_ms:.0f}ms")
                # send_tx() inside zk_withdraw_from_vault only returns after the
                # receipt confirmed with status==1, so reaching here means the
                # withdraw is on-chain and the nullifier is spent. Mark it NOW,
                # before the swap, so a swap failure can't make it spendable again.
                if zk_tx and on_withdraw_confirmed:
                    try:
                        on_withdraw_confirmed(zk_tx)
                    except Exception as cb_err:
                        # Never let bookkeeping break the on-chain flow; the
                        # NullifierSpentSwapFailed path is the safety net.
                        print(f"   [EVM] ⚠️ on_withdraw_confirmed callback error: {cb_err}")
            else:
                if is_private:
                    raise FatalExecutionError(
                        "private EVM strategy has malformed zkp_data (missing pA/stateRoot)"
                    )
                print("   [EVM] ⚠️  public strategy has malformed zkp_data — direct execution")
        else:
            print("   [EVM] ℹ️  Public strategy — executing direct from executor wallet")

        if is_private and not zk_tx:
            raise FatalExecutionError(
                "private EVM strategy did not confirm a ZK withdrawal"
            )

        # ── Protocol fee (Part B: execution fee) ──────────────────────────────────────────────
        # Deducted in the INPUT asset from the amount the executor now custodies. The fee simply
        # STAYS in the executor wallet (zero extra gas) and is recorded as a FeeAccrual. The user
        # receives net = amount - fee.
        if fee_wei > 0:
            print(f"   [Fee] Execution fee = {fee_wei} wei {asset_in} "
                  f"(net {net_wei}); retained in executor wallet")
            try:
                from fee_ledger import record_fee
                record_fee(exec_chain_id, asset_in, fee_wei, kind='execution',
                           strategy_id=strategy.get('id'))
            except Exception as fee_err:
                # The on-chain custody amount is already fixed. Never change net_wei because
                # ancillary ledger persistence failed; that would invalidate the preflight.
                print(f"   [Fee] ⚠️ fee ledger record failed: {fee_err}")

        # Step 2: cross-chain → Li.Fi; same-chain swap → Uniswap; same asset → direct transfer
        t_swap = time.monotonic()
        try:
            if is_cross_chain:
                from_token = chain.token_address(asset_in)
                try:
                    to_token = get_evm_chain_config(to_chain).token_address(asset_out)
                except ValueError:
                    to_token = NATIVE_ASSET if asset_out == "ETH" else asset_out
                from lifi_executor import execute_lifi_swap
                tx_hash = execute_lifi_swap(
                    from_chain=str(from_chain),
                    to_chain=str(to_chain),
                    from_token=from_token,
                    to_token=to_token,
                    from_amount_wei=net_wei,
                    recipient=recipient,
                    rpc_url=chain.rpc_url,
                )
                print(f"   [Benchmark] [lifi_swap_total]             = {(time.monotonic()-t_swap)*1000:.0f}ms")
            elif asset_in == "ETH" and asset_out != "ETH":
                token_out_address = chain.token_address(asset_out)
                assert amount_out_minimum is not None
                if is_vault_output:
                    # Swap to the executor wallet, then re-deposit the actual output into the
                    # asset_out vault as a private note (Poseidon(amountOut, precommitment)).
                    swap_tx = swap_eth_to_token(
                        w3, account, chain, token_out_address, net_wei, account.address,
                        amount_out_minimum,
                    )
                    print(f"   [EVM] Swap tx (to executor): {swap_tx}")
                    # Read the exact amount delivered from the swap receipt (Transfer event) — robust
                    # against RPC read-after-write lag that a balanceOf snapshot can hit.
                    try:
                        received = token_received_in_tx(
                            w3, swap_tx, token_out_address, account.address
                        )
                    except Exception as receipt_err:
                        raise CustodyStageError(
                            "eth_to_token_receipt", asset_out, 0, swap_tx, receipt_err
                        ) from receipt_err
                    if received <= 0:
                        # Never use balanceOf as a fallback: the executor is shared custody and may
                        # hold unrelated user outputs/fees. A missing receipt event must fail closed.
                        raise CustodyStageError(
                            "eth_to_token_receipt",
                            asset_out,
                            received,
                            swap_tx,
                            RuntimeError(
                                f"Swap receipt proves no {asset_out} was delivered to the executor"
                            ),
                        )
                    print(f"   [EVM] {asset_out} received from swap: {received}")
                    print(f"   [Benchmark] [uniswap_swap_total]          = {(time.monotonic()-t_swap)*1000:.0f}ms")
                    try:
                        tx_hash = deposit_to_vault(
                            w3, account, chain, token_out_address, received,
                            int(output_precommitment)
                        )
                    except Exception as delivery_err:
                        raise CustodyStageError(
                            "deliver_token", asset_out, received, swap_tx, delivery_err
                        ) from delivery_err
                else:
                    tx_hash = swap_eth_to_token(
                        w3, account, chain, token_out_address, net_wei, recipient,
                        amount_out_minimum,
                    )
                    print(f"   [Benchmark] [uniswap_swap_total]          = {(time.monotonic()-t_swap)*1000:.0f}ms")
            elif asset_out == "ETH" and asset_in != "ETH":
                token_in_address = chain.token_address(asset_in)
                assert amount_out_minimum is not None
                unwrap_hash, received_native = swap_token_to_eth(
                    w3,
                    account,
                    chain,
                    token_in_address,
                    net_wei,
                    amount_out_minimum,
                )
                try:
                    if is_vault_output:
                        tx_hash = deposit_native_to_vault(
                            w3,
                            account,
                            chain,
                            received_native,
                            int(output_precommitment),
                        )
                    else:
                        tx_hash = transfer_eth(
                            w3, account, recipient, received_native
                        )
                except Exception as delivery_err:
                    raise CustodyStageError(
                        "deliver_native", "ETH", received_native, unwrap_hash, delivery_err
                    ) from delivery_err
                print(
                    f"   [Benchmark] [token_to_eth_total]           = "
                    f"{(time.monotonic()-t_swap)*1000:.0f}ms"
                )
            elif asset_in == asset_out:
                # Same asset in and out — no swap. The execution fee is already skimmed above; just
                # deliver the remainder. Vault output (e.g. USDC→USDC) re-deposits the withdrawn
                # funds straight back into the vault under the pre-set output_precommitment, using the
                # same machinery as the swap→vault path — the user withdraws that note themselves.
                if is_vault_output and asset_in != "ETH":
                    tx_hash = deposit_to_vault(
                        w3, account, chain, chain.token_address(asset_in), net_wei, int(output_precommitment)
                    )
                elif is_vault_output and asset_in == "ETH":
                    tx_hash = deposit_native_to_vault(
                        w3, account, chain, net_wei, int(output_precommitment)
                    )
                elif asset_in == "ETH":
                    tx_hash = transfer_eth(w3, account, recipient, net_wei)
                else:
                    # Rejected by preflight before a private withdrawal; kept fail-closed for
                    # defense in depth if routing changes.
                    raise RuntimeError(
                        f"same-asset {asset_in}→address ERC20 delivery is not implemented"
                    )
                print(f"   [Benchmark] [same_asset_deliver_total]    = {(time.monotonic()-t_swap)*1000:.0f}ms")
            else:
                raise RuntimeError(f"unsupported single-shot token→token swap {asset_in}→{asset_out}")
        except Exception as swap_err:
            if zk_tx:
                # Nullifier is spent on-chain — mark fatal so scheduler doesn't retry with same nullifier
                raise NullifierSpentSwapFailed(
                    f"ZK withdraw confirmed ({zk_tx}) but swap failed: {swap_err}. "
                    f"Custody recovery context: executor={account.address}; "
                    f"input_amount={amount_wei} {asset_in}; net_amount={net_wei} {asset_in}."
                ) from swap_err
            raise

        print(f"   [EVM] ✅ Done: {tx_hash}")
        print("="*60)
        return tx_hash

    except FatalExecutionError:
        raise
    except ValueError as e:
        print(f"   [EVM] ❌ Config error: {e}")
        return None
    except Exception as e:
        print(f"   [EVM] ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return None


# Entrypoint.swap(...) ABI — atomic on-chain Vault.swap used for TWAP/grid legs. Each leg spends
# one slice note using the 11-signal Hard ASP proof and the vault swaps from its own funds.
_HARD_ASP_ZKPROOF_COMPONENTS = [
    {"internalType": "uint256", "name": "stateRoot", "type": "uint256"},
    {"internalType": "uint256", "name": "aspRoot", "type": "uint256"},
    {"internalType": "uint256", "name": "nullifier", "type": "uint256"},
    {"internalType": "uint256", "name": "newCommitment", "type": "uint256"},
    {"internalType": "uint256", "name": "newLabel", "type": "uint256"},
    {"internalType": "address", "name": "recipient", "type": "address"},
    {"internalType": "address", "name": "pool", "type": "address"},
    {"internalType": "address", "name": "dstToken", "type": "address"},
    {"internalType": "uint256", "name": "fee", "type": "uint256"},
    {"internalType": "uint256", "name": "minAmountOut", "type": "uint256"},
    {"internalType": "uint256[2]", "name": "pA", "type": "uint256[2]"},
    {"internalType": "uint256[2][2]", "name": "pB", "type": "uint256[2][2]"},
    {"internalType": "uint256[2]", "name": "pC", "type": "uint256[2]"},
    # Authority over the swap CHANGE note, relayer-supplied and NOT bound in the swap public
    # signals: the postman revokes and the owner ragequits against these. Omitting them changes
    # the function selector, so every swap/swapAndDeposit call reverts with no revert data.
    {"internalType": "address", "name": "changeDepositor", "type": "address"},
    {"internalType": "uint256", "name": "changeValue", "type": "uint256"},
]


def _abi_input(internal_type: str, name: str, abi_type: str) -> dict:
    return {"internalType": internal_type, "name": name, "type": abi_type}


def _hard_asp_proof_abi_input() -> dict:
    return {
        "components": _HARD_ASP_ZKPROOF_COMPONENTS,
        "internalType": "struct IVault.ZKProof",
        "name": "_zkProof",
        "type": "tuple",
    }


ENTRYPOINT_SWAP_ABI = [{
    "inputs": [
        _abi_input("address", "_pool", "address"),
        _abi_input("address", "_srcToken", "address"),
        _abi_input("address", "_dstToken", "address"),
        _abi_input("address payable", "_recipient", "address"),
        _abi_input("uint256", "_amountIn", "uint256"),
        _abi_input("uint256", "_minAmountOut", "uint256"),
        _abi_input("uint24", "_fee", "uint24"),
        _abi_input("uint256", "_deadline", "uint256"),
        _hard_asp_proof_abi_input(),
    ],
    "name": "swap",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function",
}]

ENTRYPOINT_SWAP_AND_DEPOSIT_ABI = [
    {
        "inputs": [],
        "name": "supportsSwapAndDeposit",
        "outputs": [_abi_input("bool", "", "bool")],
        "stateMutability": "pure",
        "type": "function",
    },
    {
        "inputs": [
            _abi_input("address", "_pool", "address"),
            _abi_input("address", "_srcToken", "address"),
            _abi_input("address", "_dstToken", "address"),
            _abi_input("uint256", "_amountIn", "uint256"),
            _abi_input("uint256", "_minAmountOut", "uint256"),
            _abi_input("uint24", "_fee", "uint24"),
            _abi_input("uint256", "_deadline", "uint256"),
            _abi_input("uint256", "_outputPrecommitment", "uint256"),
            _hard_asp_proof_abi_input(),
        ],
        "name": "swapAndDeposit",
        "outputs": [
            _abi_input("uint256", "amountOut", "uint256"),
            _abi_input("uint256", "outputCommitment", "uint256"),
        ],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    # Needed to attribute the on-chain fill skim to a collector in the receipt (see
    # fee_ledger.record_swap_and_deposit_fee). Read-only.
    {
        "inputs": [],
        "name": "swapAndDepositFeeCollector",
        "outputs": [_abi_input("address", "", "address")],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "swapAndDepositFeeBps",
        "outputs": [_abi_input("uint16", "", "uint16")],
        "stateMutability": "view",
        "type": "function",
    },
]


def _parse_zk_blob(zkp_data) -> dict:
    zk = zkp_data if isinstance(zkp_data, dict) else json.loads(zkp_data)
    if isinstance(zk.get("proof"), dict) and zk["proof"].get("pA"):
        return {**zk, **zk["proof"]}
    return zk


def _hard_asp_swap_proof_tuple(zk: dict, nullifier: int, change_depositor: str) -> tuple:
    """Encode IVault.ZKProof in the exact Hard ASP field order."""
    asp_root = zk.get("aspRoot")
    new_label = zk.get("newLabel")
    new_commitment = zk.get("newCommitment")
    if new_commitment in (None, ""):
        new_commitment = zk.get("changeCommitment")
    if asp_root in (None, ""):
        raise FatalExecutionError("swap proof missing aspRoot (Hard ASP)")
    if new_label in (None, ""):
        raise FatalExecutionError("swap proof missing newLabel (Hard ASP)")
    if new_commitment in (None, ""):
        raise FatalExecutionError("swap proof missing newCommitment / changeCommitment")

    # Fail closed on both. address(0) would leave the change note with no depositor, so the
    # postman could not revoke it and the owner could not ragequit it; a guessed changeValue
    # would record the wrong remainder in DepositInfo. Strategies armed before the frontend
    # started sending changeValue land here and must be re-armed rather than mis-encoded.
    change_value = zk.get("changeValue")
    if change_value in (None, ""):
        raise FatalExecutionError(
            "swap proof missing changeValue — re-arm this strategy (armed before the "
            "changeDepositor/changeValue fields were added to IVault.ZKProof)"
        )
    if not change_depositor:
        raise FatalExecutionError("swap proof missing changeDepositor (strategy has no user_id)")
    try:
        change_depositor = Web3.to_checksum_address(change_depositor)
    except (ValueError, TypeError) as exc:
        raise FatalExecutionError(f"changeDepositor is not an address: {change_depositor!r}") from exc

    try:
        return (
            int(zk["stateRoot"]),
            int(asp_root),
            int(nullifier),
            int(new_commitment),
            int(new_label),
            zk["recipient"],
            zk["pool"],
            zk["dstToken"],
            int(zk["fee"]),
            int(zk["minAmountOut"]),
            [int(value) for value in zk["pA"]],
            [[int(value) for value in row] for row in zk["pB"]],
            [int(value) for value in zk["pC"]],
            change_depositor,
            int(change_value),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise FatalExecutionError("swap proof contains malformed fields") from exc


def is_swap_and_deposit_proof(zkp_data) -> bool:
    """True when zkp_data is an explicit swapAndDeposit wire blob (venue or full swap fields)."""
    if not zkp_data:
        return False
    try:
        zk = _parse_zk_blob(zkp_data)
    except Exception:
        return False
    if str(zk.get("venue") or "").lower() in {"swap_and_deposit", "swapanddeposit"}:
        return bool(zk.get("pA") and zk.get("pool"))
    return bool(
        zk.get("pool")
        and zk.get("dstToken")
        and zk.get("minAmountOut") is not None
        and zk.get("recipient")
        and zk.get("pA")
    )


def execute_evm_swap_and_deposit(strategy: dict, current_price: float, on_withdraw_confirmed=None) -> Optional[str]:
    """Atomic same-chain settle: Entrypoint.swapAndDeposit (no executor custody).

    Requires a swap proof bound to the dst vault as recipient, plus output_precommitment for the
    re-shielded note. Principal never sits in the executor EOA. On-chain fee skim (if configured
    on Entrypoint) is taken from the measured output before creditNote.
    """
    exec_chain_id = resolve_execution_chain_id(strategy)
    chain = get_evm_chain_config(exec_chain_id)
    w3 = get_web3(chain)
    if not w3.is_connected():
        print(f"   [EVM] ❌ Cannot connect to RPC for chain {exec_chain_id}")
        return None
    account = get_executor_account(w3, exec_chain_id)

    output_precommitment = strategy.get("output_precommitment")
    if not output_precommitment:
        raise FatalExecutionError("swapAndDeposit requires output_precommitment")

    zk = _parse_zk_blob(strategy.get("zkp_data"))
    nullifiers = zk.get("nullifierHashes") or ([zk["nullifier"]] if zk.get("nullifier") else [])
    if not nullifiers and zk.get("nullifierHash"):
        nullifiers = [zk["nullifierHash"]]
    if not nullifiers:
        raise FatalExecutionError("swapAndDeposit proof missing nullifier")
    nullifier = int(nullifiers[0])

    asset_in = strategy.get("asset_in", "ETH").upper()
    asset_out = strategy.get("asset_out", "USDC").upper()
    # Vault lookup uses NATIVE sentinel for ETH — do NOT substitute WETH here.
    src_token = Web3.to_checksum_address(chain.token_address(asset_in))
    dst_token = Web3.to_checksum_address(chain.token_address(asset_out))

    pool = Web3.to_checksum_address(zk["pool"])
    proof_dst = Web3.to_checksum_address(zk["dstToken"])
    recipient = Web3.to_checksum_address(zk["recipient"])
    fee = int(zk["fee"])
    min_out = int(zk["minAmountOut"])
    amount_in = int(zk.get("amountIn") or zk.get("amount") or 0)
    if amount_in <= 0:
        raise FatalExecutionError("swapAndDeposit proof missing amountIn")
    deadline = int(time.time()) + 300

    # Preflight: deployed Entrypoint must expose the upgraded selector (H3).
    entrypoint = w3.eth.contract(
        address=Web3.to_checksum_address(chain.entrypoint),
        abi=ENTRYPOINT_SWAP_AND_DEPOSIT_ABI,
    )
    try:
        if not entrypoint.functions.supportsSwapAndDeposit().call():
            raise FatalExecutionError("Entrypoint supportsSwapAndDeposit returned false")
    except FatalExecutionError:
        raise
    except Exception as e:
        raise FatalExecutionError(
            f"Entrypoint missing supportsSwapAndDeposit — redeploy required before atomic settle ({e})"
        ) from e

    # Accounting only: on-chain swapAndDepositFeeBps skims from measured output. Log the legacy
    # input-side fee estimate so ops can compare; do not retain funds in the executor EOA.
    decimals_in = TOKEN_DECIMALS.get(asset_in, 18)
    try:
        from fee_calc import compute_execution_fee_wei
        # Same rate the legacy path uses, so the two estimates stay comparable. Both are now a
        # flat bps of notional, so the on-chain skim and this estimate agree by construction.
        fee_est = compute_execution_fee_wei(
            amount_in, decimals_in, float(current_price or 0),
            is_api=bool(strategy.get('billing_ref')),
        )
        if fee_est > 0:
            print(
                f"   [Fee] swapAndDeposit on-chain skim handles protocol fee; "
                f"legacy input-side estimate would have been {fee_est} wei {asset_in}"
            )
    except Exception as fee_err:
        print(f"   [Fee] ⚠️ fee estimate skipped: {fee_err}")

    zkproof_struct = _hard_asp_swap_proof_tuple(
        {
            **zk,
            "recipient": recipient,
            "pool": pool,
            "dstToken": proof_dst,
            "fee": fee,
            "minAmountOut": min_out,
        },
        nullifier,
        strategy.get("user_id"),
    )

    print(
        f"   [EVM] swapAndDeposit on {chain.name}: {amount_in} {asset_in} → {asset_out} "
        f"(pool {pool}, fee {fee}, re-shield pc={str(output_precommitment)[:10]}…)"
    )
    tx = entrypoint.functions.swapAndDeposit(
        pool,
        src_token,
        dst_token,
        amount_in,
        min_out,
        fee,
        deadline,
        int(output_precommitment),
        zkproof_struct,
    ).build_transaction({"from": account.address, "gas": 3_500_000})
    tx_hash = send_tx(w3, account, tx, label="swap_and_deposit")

    # The fill fee is skimmed on-chain and pulled straight to the collector, emitting no event of
    # its own — recover it from this receipt or it never reaches the ledger. See
    # record_swap_and_deposit_fee. Best-effort: the trade has already settled either way.
    if tx_hash:
        try:
            from fee_ledger import record_swap_and_deposit_fee
            collector = entrypoint.functions.swapAndDepositFeeCollector().call()
            record_swap_and_deposit_fee(
                w3, exec_chain_id, tx_hash,
                dst_token=dst_token, dst_symbol=(asset_out or "").upper(),
                collector=collector,
                strategy_id=strategy.get("id"), leg_id=strategy.get("leg_id"),
            )
        except Exception as fee_err:
            print(f"   [Fee] ⚠️ fill-fee ledger write skipped: {fee_err}")

    if tx_hash and on_withdraw_confirmed:
        try:
            on_withdraw_confirmed(tx_hash)
        except Exception as cb_err:
            print(f"   [EVM] ⚠️ swapAndDeposit on_withdraw_confirmed callback error: {cb_err}")
    return tx_hash


def execute_evm_leg_swap(strategy: dict, current_price: float, on_withdraw_confirmed=None) -> Optional[str]:
    """Execute ONE TWAP/grid leg as an atomic on-chain Vault.swap (Entrypoint.swap).

    The leg's zkp_data is an 11-signal Hard ASP swap proof (one slice note → one swap), produced by the
    browser's generateSwapProof. We rebuild the IVault.ZKProof struct from it and submit
    Entrypoint.swap; the vault verifies the proof, spends the slice nullifier, inserts the change
    note, and swaps from its own funds to the proof-bound recipient. No funds touch the executor.
    """
    exec_chain_id = resolve_execution_chain_id(strategy)
    chain = get_evm_chain_config(exec_chain_id)
    w3 = get_web3(chain)
    if not w3.is_connected():
        print(f"   [EVM] ❌ Cannot connect to RPC for chain {exec_chain_id}")
        return None
    account = get_executor_account(w3, exec_chain_id)

    zkp = strategy.get("zkp_data")
    zk = zkp if isinstance(zkp, dict) else json.loads(zkp)
    if isinstance(zk.get("proof"), dict):
        zk = zk["proof"]

    nullifiers = zk.get("nullifierHashes") or ([zk["nullifierHash"]] if zk.get("nullifierHash") else [])
    if not nullifiers:
        raise FatalExecutionError("leg swap proof missing nullifierHashes")
    nullifier = int(nullifiers[0])

    asset_in = strategy.get("asset_in", "ETH").upper()
    src_token = chain.token_address(asset_in)
    # Native sentinel → WETH for the on-chain swap path (vault wraps internally).
    src_for_call = chain.weth if src_token == NATIVE_ASSET else src_token

    pool      = Web3.to_checksum_address(zk["pool"])
    dst_token = Web3.to_checksum_address(zk["dstToken"])
    recipient = Web3.to_checksum_address(zk["recipient"])
    fee       = int(zk["fee"])
    min_out   = int(zk["minAmountOut"])
    amount_in = int(zk["amountIn"])
    deadline  = int(time.time()) + 300

    zkproof_struct = _hard_asp_swap_proof_tuple(
        {
            **zk,
            "recipient": recipient,
            "pool": pool,
            "dstToken": dst_token,
            "fee": fee,
            "minAmountOut": min_out,
        },
        nullifier,
        strategy.get("user_id"),
    )

    entrypoint = w3.eth.contract(address=Web3.to_checksum_address(chain.entrypoint), abi=ENTRYPOINT_SWAP_ABI)
    print(f"   [EVM] Leg swap on {chain.name}: {amount_in} {asset_in} → {dst_token} (pool {pool}, fee {fee})")
    tx = entrypoint.functions.swap(
        pool, Web3.to_checksum_address(src_for_call), dst_token, recipient,
        amount_in, min_out, fee, deadline, zkproof_struct,
    ).build_transaction({"from": account.address, "gas": 1_500_000})
    tx_hash = send_tx(w3, account, tx, label="leg_swap")
    # Vault.swap is atomic — once it confirms, the slice nullifier is spent on-chain.
    if tx_hash and on_withdraw_confirmed:
        try:
            on_withdraw_confirmed(tx_hash)
        except Exception as cb_err:
            print(f"   [EVM] ⚠️ leg on_withdraw_confirmed callback error: {cb_err}")
    return tx_hash



# SiphonV4Vault.shieldedSwap — the v4 shielded-swap entrypoint. The hook verifies the proof INSIDE
# the pool's swap (beforeSwap), then re-shields the output as a note (afterSwap), all in one tx.
# msg.sender must == the proof's recipient, which the browser sets to the executor for strategy legs.
SHIELDED_SWAP_ABI = json.loads('[{"inputs":[{"components":[{"internalType":"Currency","name":"currency0","type":"address"},{"internalType":"Currency","name":"currency1","type":"address"},{"internalType":"uint24","name":"fee","type":"uint24"},{"internalType":"int24","name":"tickSpacing","type":"int24"},{"internalType":"contract IHooks","name":"hooks","type":"address"}],"internalType":"struct PoolKey","name":"_key","type":"tuple"},{"components":[{"internalType":"bool","name":"zeroForOne","type":"bool"},{"internalType":"int256","name":"amountSpecified","type":"int256"},{"internalType":"uint160","name":"sqrtPriceLimitX96","type":"uint160"}],"internalType":"struct SwapParams","name":"_params","type":"tuple"},{"internalType":"bytes","name":"_hookData","type":"bytes"}],"name":"shieldedSwap","outputs":[{"internalType":"BalanceDelta","name":"delta","type":"int256"}],"stateMutability":"nonpayable","type":"function"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"PoolId","name":"poolId","type":"bytes32"},{"indexed":false,"internalType":"uint256","name":"nullifierHash","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"changeCommitment","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"outputCommitment","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amountOut","type":"uint256"}],"name":"ShieldedSwap","type":"event"}]')

# The SwapProof tuple carried in hookData. Field order MUST match SiphonV4Types.SwapProof / the 11
# public signals. `precommitment` is the OUTPUT note's precommitment (not a circuit signal).
_SWAP_PROOF_TUPLE = (
    "(uint256,uint256,uint256,uint256,uint256,address,address,uint256,uint256,"
    "uint256,uint256,uint256[2],uint256[2][2],uint256[2])"
)

MIN_SQRT_PRICE_PLUS_1 = 4295128740
MAX_SQRT_PRICE_MINUS_1 = 1461446703485210103287273052203988822378723970341


def execute_shielded_swap_v4(strategy: dict, current_price: float, on_withdraw_confirmed=None) -> Optional[str]:
    """Execute ONE strategy leg through the Siphon v4 hook (vault.shieldedSwap).

    Same shape as execute_evm_leg_swap, but the swap goes through the v4 pool: the hook verifies the
    proof in beforeSwap, burns the input nullifier, and re-shields the output in afterSwap — the
    executor never custodies funds and no third party can front-run (msg.sender == recipient == the
    executor). Requires a v4 pool for the leg's token pair (see v4_config) and a v4-bound proof in
    zkp_data (recipient == executor, pool == PoolId low bits, plus outputPrecommitment).
    """
    from eth_abi import encode as abi_encode
    from v4_config import v4_deployment, v4_pool_for

    exec_chain_id = resolve_execution_chain_id(strategy)
    chain = get_evm_chain_config(exec_chain_id)
    dep = v4_deployment(exec_chain_id)
    if not dep:
        raise FatalExecutionError(f"no v4 deployment for chain {exec_chain_id}")

    w3 = get_web3(chain)
    if not w3.is_connected():
        print(f"   [EVM] ❌ Cannot connect to RPC for chain {exec_chain_id}")
        return None
    account = get_executor_account(w3, exec_chain_id)

    zkp = strategy.get("zkp_data")
    zk = zkp if isinstance(zkp, dict) else json.loads(zkp)
    if isinstance(zk.get("proof"), dict):
        zk = zk["proof"]

    nullifiers = zk.get("nullifierHashes") or ([zk["nullifierHash"]] if zk.get("nullifierHash") else [])
    if not nullifiers:
        raise FatalExecutionError("v4 leg proof missing nullifierHashes")

    src_token = Web3.to_checksum_address(zk["srcToken"] if zk.get("srcToken") else chain.token_address(strategy.get("asset_in", "ETH").upper()))
    dst_token = Web3.to_checksum_address(zk["dstToken"])
    pool = v4_pool_for(exec_chain_id, src_token, dst_token)
    if not pool:
        raise FatalExecutionError(f"no v4 pool for {src_token}/{dst_token} on chain {exec_chain_id}")

    recipient = Web3.to_checksum_address(zk["recipient"])
    if recipient != account.address:
        # The hook enforces msg.sender == recipient; a proof bound to anyone else cannot be relayed.
        raise FatalExecutionError(
            f"v4 leg proof recipient {recipient} != executor {account.address}; "
            "the browser must bind the leg proof to the executor wallet"
        )

    zero_for_one = src_token.lower() == pool["currency0"].lower()
    amount_in = int(zk["amountIn"])
    min_out = int(zk["minAmountOut"])
    out_precommitment = int(zk.get("outputPrecommitment") or zk.get("precommitment") or 0)
    if out_precommitment == 0:
        raise FatalExecutionError("v4 leg proof missing outputPrecommitment for the re-shielded note")
    asp_root = zk.get("aspRoot")
    new_label = zk.get("newLabel")
    if asp_root in (None, ""):
        raise FatalExecutionError("v4 leg proof missing aspRoot (Hard ASP)")
    if new_label in (None, ""):
        raise FatalExecutionError("v4 leg proof missing newLabel (Hard ASP)")

    pA = [int(x) for x in zk["pA"]]
    pB = [[int(x) for x in row] for row in zk["pB"]]
    pC = [int(x) for x in zk["pC"]]

    # abi.encode(SwapProof) — the hook decodes this in beforeSwap.
    hook_data = abi_encode(
        [_SWAP_PROOF_TUPLE],
        [(
            int(zk["stateRoot"]),
            int(asp_root),
            int(nullifiers[0]),
            int(zk.get("changeCommitment") or zk.get("newCommitment")),
            int(new_label),
            recipient,
            dst_token,
            int(zk["fee"]),
            min_out,
            amount_in,
            out_precommitment,
            pA, pB, pC,
        )],
    )

    pool_key = (
        Web3.to_checksum_address(pool["currency0"]),
        Web3.to_checksum_address(pool["currency1"]),
        int(pool["fee"]),
        int(pool["tickSpacing"]),
        Web3.to_checksum_address(pool["hooks"]),
    )
    swap_params = (
        zero_for_one,
        -amount_in,  # negative == exact input
        MIN_SQRT_PRICE_PLUS_1 if zero_for_one else MAX_SQRT_PRICE_MINUS_1,
    )

    vault = w3.eth.contract(address=Web3.to_checksum_address(dep["vault"]), abi=SHIELDED_SWAP_ABI)
    print(f"   [EVM-v4] Shielded leg swap on {chain.name}: {amount_in} {src_token} → {dst_token} "
          f"(pool {pool['currency0'][:10]}../{pool['currency1'][:10]}.., fee {pool['fee']})")
    tx = vault.functions.shieldedSwap(pool_key, swap_params, hook_data).build_transaction(
        {"from": account.address, "gas": 3_000_000}
    )
    tx_hash = send_tx(w3, account, tx, label="v4_shielded_swap")

    # shieldedSwap is atomic — once it confirms, the input nullifier is spent and the output note minted.
    if tx_hash and on_withdraw_confirmed:
        try:
            on_withdraw_confirmed(tx_hash)
        except Exception as cb_err:
            print(f"   [EVM-v4] ⚠️ leg on_withdraw_confirmed callback error: {cb_err}")
    return tx_hash


# ─────────────────────────────────────────────────────────────────────────────────────────────
# v2/v3 — VaultKernel.spend
#
# One entry point for all five actions (WITHDRAW / MERGE / SWAP / SPLIT / RAGEQUIT). The action
# is publicInputs[0]; the kernel routes to the matching verifier itself, so the relayer does not
# need to know or care which action it is submitting.
# ─────────────────────────────────────────────────────────────────────────────────────────────

VAULT_KERNEL_SPEND_ABI = json.loads(
    '[{"inputs":['
    '{"internalType":"uint256[25]","name":"publicInputs","type":"uint256[25]"},'
    '{"internalType":"uint256[8]","name":"proof","type":"uint256[8]"},'
    '{"internalType":"uint256[5]","name":"compliancePublicInputs","type":"uint256[5]"},'
    '{"internalType":"uint256[8]","name":"complianceProof","type":"uint256[8]"},'
    '{"components":['
    '{"internalType":"bytes","name":"rawPayee","type":"bytes"},'
    '{"internalType":"uint256[8]","name":"splitCommitments","type":"uint256[8]"}],'
    '"internalType":"struct SpendExtra","name":"extra","type":"tuple"}],'
    '"name":"spend","outputs":[],"stateMutability":"nonpayable","type":"function"}]'
)

SPEND_PUBLIC_WIDTH = 25
SPEND_PROOF_WIDTH = 8
SPEND_SPLIT_OUTPUTS = 8
# COMPLIANCE_CIRCUIT_SPLIT §6.2 — [inputCount, admittedRoot, revokedRoot, labelCommit,
# programVersion]. The spend vector stays 25: labelCommit rides index 24, the one mux slot no
# action used, so nothing about the attester digest or this ABI's first argument changes.
SPEND_COMPLIANCE_WIDTH = 5
_ACTION_NAMES = {0: "WITHDRAW", 1: "MERGE", 2: "SWAP", 3: "SPLIT", 4: "RAGEQUIT"}


def vault_kernel_spend(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    public_inputs: list,
    proof: list,
    compliance_public_inputs: list,
    compliance_proof: list,
    raw_payee: bytes,
    split_commitments: list | None = None,
    on_prepared=None,
) -> str:
    """Submit VaultKernel.spend(). Returns the tx hash.

    The relayer only pays gas: every value that moves is a public signal inside the proof, and
    the payee is bound to publicInputs by the circuit, so a relayer cannot redirect funds. That
    is also why the kernel address comes from `chain` (server config) and never from the caller.

    Replay is prevented on-chain by the nullifier set, so a duplicate submission reverts with
    NullifierAlreadyUsed rather than paying out twice.
    """
    if not chain.vault_kernel:
        raise ValueError(
            f"No VaultKernel configured for chain {chain.chain_id}. "
            f"Set ETH_SEPOLIA_VAULT_KERNEL / BASE_MAINNET_VAULT_KERNEL."
        )
    if len(public_inputs) != SPEND_PUBLIC_WIDTH:
        raise ValueError(f"publicInputs must be {SPEND_PUBLIC_WIDTH} values, got {len(public_inputs)}")
    if len(proof) != SPEND_PROOF_WIDTH:
        raise ValueError(f"proof must be {SPEND_PROOF_WIDTH} values, got {len(proof)}")
    # RAGEQUIT is the one action the kernel does NOT bind to a compliance proof: it is the exit for
    # unadmitted or revoked labels, so there is nothing to prove admission against. Every other
    # action MUST carry the half, and this is fail-closed on purpose — a caller that silently
    # dropped it would otherwise submit zeros and revert on-chain as LabelCommitMismatch, which
    # reads as a proving fault rather than a wiring bug.
    if int(public_inputs[0]) == 4:
        compliance_public_inputs = list(compliance_public_inputs or [0] * SPEND_COMPLIANCE_WIDTH)
        compliance_proof = list(compliance_proof or [0] * SPEND_PROOF_WIDTH)
    if len(compliance_public_inputs) != SPEND_COMPLIANCE_WIDTH:
        raise ValueError(
            f"compliancePublicInputs must be {SPEND_COMPLIANCE_WIDTH} values, "
            f"got {len(compliance_public_inputs)}"
        )
    if len(compliance_proof) != SPEND_PROOF_WIDTH:
        raise ValueError(f"complianceProof must be {SPEND_PROOF_WIDTH} values, got {len(compliance_proof)}")
    # Only WITHDRAW (0) and RAGEQUIT (4) pay out to an EOA, so only those carry a payee. MERGE,
    # SWAP and SPLIT re-shield entirely inside the vault and send empty bytes; demanding 20 bytes
    # for every action rejected them outright.
    if int(public_inputs[0]) in (0, 4):
        if len(raw_payee) != 20:
            raise ValueError(f"rawPayee must be 20 bytes for WITHDRAW/RAGEQUIT, got {len(raw_payee)}")
    elif raw_payee and len(raw_payee) != 20:
        raise ValueError(f"rawPayee must be empty or 20 bytes, got {len(raw_payee)}")

    splits = list(split_commitments or [])
    if len(splits) > SPEND_SPLIT_OUTPUTS:
        raise ValueError(f"at most {SPEND_SPLIT_OUTPUTS} splitCommitments, got {len(splits)}")
    splits += [0] * (SPEND_SPLIT_OUTPUTS - len(splits))

    action = int(public_inputs[0])
    kernel = w3.eth.contract(
        address=Web3.to_checksum_address(chain.vault_kernel),
        abi=VAULT_KERNEL_SPEND_ABI,
    )
    print(
        f"   [EVM] VaultKernel.spend on {chain.name} ({chain.chain_id}): "
        f"action {action} ({_ACTION_NAMES.get(action, '?')}) → {chain.vault_kernel}"
    )

    fn = kernel.functions.spend(
        [int(x) for x in public_inputs],
        [int(x) for x in proof],
        [int(x) for x in compliance_public_inputs],
        [int(x) for x in compliance_proof],
        (raw_payee, [int(x) for x in splits]),
    )
    tx_params = fn.build_transaction({
        "from": account.address,
        "chainId": chain.chain_id,
        # Poseidon-heavy: a 6-input merge is far above a plain transfer. send_tx applies its own
        # buffer on top of the estimate.
        "gas": 3_000_000,
    })
    return send_tx(w3, account, tx_params, label=f"spend:{_ACTION_NAMES.get(action, action)}",
                   on_prepared=on_prepared)


# ─────────────────────────────────────────────────────────────────────────────────────────────
# v3 — VaultKernel.spendAttested
#
# Same proof and public inputs as spend(), plus a TEE freshness attestation.
#
# Why the extra signature: the circuit binds `revokedRoot` as a public input, and a strategy leg
# is proved at fire time against whatever root is current then. The hub accepts any once-PUBLISHED
# revoked root rather than only the live one (`revokedRootWasPublished`), because insisting on the
# live root would make every leg race the ASP's next publish. That relaxation is safe only because
# the enclave separately attests that the note is not revoked as of a CURRENT snapshot — the
# attestation is what supplies the freshness the root no longer does.
#
# The signature covers keccak256 of all 25 limbs, so it authorises exactly one spend and cannot be
# moved to another. The kernel is bound too (via msg.sender inside the hub), so an attestation for
# one kernel cannot be replayed against another sharing the same hub.
# ─────────────────────────────────────────────────────────────────────────────────────────────

VAULT_KERNEL_SPEND_ATTESTED_ABI = json.loads(
    '[{"inputs":['
    '{"internalType":"uint256[25]","name":"publicInputs","type":"uint256[25]"},'
    '{"internalType":"uint256[8]","name":"proof","type":"uint256[8]"},'
    '{"internalType":"uint256[5]","name":"compliancePublicInputs","type":"uint256[5]"},'
    '{"internalType":"uint256[8]","name":"complianceProof","type":"uint256[8]"},'
    '{"components":['
    '{"internalType":"bytes","name":"rawPayee","type":"bytes"},'
    '{"internalType":"uint256[8]","name":"splitCommitments","type":"uint256[8]"}],'
    '"internalType":"struct SpendExtra","name":"extra","type":"tuple"},'
    '{"internalType":"uint256","name":"attestationExpiry","type":"uint256"},'
    '{"internalType":"bytes","name":"attesterSig","type":"bytes"}],'
    '"name":"spendAttested","outputs":[],"stateMutability":"nonpayable","type":"function"}]'
)


def vault_kernel_spend_attested(
    w3: Web3,
    account,
    chain: EvmChainConfig,
    public_inputs: list,
    proof: list,
    compliance_public_inputs: list,
    compliance_proof: list,
    raw_payee: bytes,
    attestation_expiry: int,
    attester_sig: bytes,
    split_commitments: list | None = None,
    on_prepared=None,
) -> str:
    """Submit VaultKernel.spendAttested(). Returns the tx hash.

    Validation mirrors `vault_kernel_spend` — same widths, same reason for taking the kernel
    address from server config rather than the caller — plus the attestation.

    The expiry is checked here as well as on-chain because an expired attestation is a guaranteed
    revert: submitting it burns gas and, worse, looks like a proving fault in the logs. Better to
    fail before the tx and let the next tick re-prove against a fresh snapshot.
    """
    if not chain.vault_kernel:
        raise ValueError(
            f"No VaultKernel configured for chain {chain.chain_id}. "
            f"Set ETH_SEPOLIA_VAULT_KERNEL / BASE_MAINNET_VAULT_KERNEL."
        )
    if len(public_inputs) != SPEND_PUBLIC_WIDTH:
        raise ValueError(f"publicInputs must be {SPEND_PUBLIC_WIDTH} values, got {len(public_inputs)}")
    if len(proof) != SPEND_PROOF_WIDTH:
        raise ValueError(f"proof must be {SPEND_PROOF_WIDTH} values, got {len(proof)}")
    # RAGEQUIT is the one action the kernel does NOT bind to a compliance proof: it is the exit for
    # unadmitted or revoked labels, so there is nothing to prove admission against. Every other
    # action MUST carry the half, and this is fail-closed on purpose — a caller that silently
    # dropped it would otherwise submit zeros and revert on-chain as LabelCommitMismatch, which
    # reads as a proving fault rather than a wiring bug.
    if int(public_inputs[0]) == 4:
        compliance_public_inputs = list(compliance_public_inputs or [0] * SPEND_COMPLIANCE_WIDTH)
        compliance_proof = list(compliance_proof or [0] * SPEND_PROOF_WIDTH)
    if len(compliance_public_inputs) != SPEND_COMPLIANCE_WIDTH:
        raise ValueError(
            f"compliancePublicInputs must be {SPEND_COMPLIANCE_WIDTH} values, "
            f"got {len(compliance_public_inputs)}"
        )
    if len(compliance_proof) != SPEND_PROOF_WIDTH:
        raise ValueError(f"complianceProof must be {SPEND_PROOF_WIDTH} values, got {len(compliance_proof)}")
    # Same action-aware rule as spend(): a strategy leg is a SWAP, which re-shields in-vault and
    # carries no payee.
    if int(public_inputs[0]) in (0, 4):
        if len(raw_payee) != 20:
            raise ValueError(f"rawPayee must be 20 bytes for WITHDRAW/RAGEQUIT, got {len(raw_payee)}")
    elif raw_payee and len(raw_payee) != 20:
        raise ValueError(f"rawPayee must be empty or 20 bytes, got {len(raw_payee)}")
    # 65 bytes of r||s||v. The hub rejects any other length outright (BadSignatureLength), so
    # catching it here turns a wasted transaction into a retry.
    if len(attester_sig) != 65:
        raise ValueError(f"attesterSig must be 65 bytes, got {len(attester_sig)}")

    now = int(time.time())
    if attestation_expiry <= now:
        raise ValueError(
            f"attestation expired {now - attestation_expiry}s ago — re-prove instead of submitting"
        )

    splits = list(split_commitments or [])
    if len(splits) > SPEND_SPLIT_OUTPUTS:
        raise ValueError(f"at most {SPEND_SPLIT_OUTPUTS} splitCommitments, got {len(splits)}")
    splits += [0] * (SPEND_SPLIT_OUTPUTS - len(splits))

    action = int(public_inputs[0])
    kernel = w3.eth.contract(
        address=Web3.to_checksum_address(chain.vault_kernel),
        abi=VAULT_KERNEL_SPEND_ATTESTED_ABI,
    )
    print(
        f"   [EVM] VaultKernel.spendAttested on {chain.name} ({chain.chain_id}): "
        f"action {action} ({_ACTION_NAMES.get(action, '?')}) → {chain.vault_kernel} "
        f"(attestation valid {attestation_expiry - now}s more)"
    )

    fn = kernel.functions.spendAttested(
        [int(x) for x in public_inputs],
        [int(x) for x in proof],
        [int(x) for x in compliance_public_inputs],
        [int(x) for x in compliance_proof],
        (raw_payee, [int(x) for x in splits]),
        int(attestation_expiry),
        attester_sig,
    )
    tx_params = fn.build_transaction({
        "from": account.address,
        "chainId": chain.chain_id,
        # Poseidon-heavy, same as spend(); the added ecrecover is negligible beside it.
        "gas": 3_000_000,
    })
    return send_tx(w3, account, tx_params,
                   label=f"spendAttested:{_ACTION_NAMES.get(action, action)}",
                   on_prepared=on_prepared)
