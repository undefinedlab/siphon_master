"""
Per-chain EVM config for the trade-executor.
Strategies carry from_chain / to_chain; execution picks RPC + contracts by from_chain.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict

NATIVE_ASSET = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"

# Chains a STRATEGY may originate from (from_chain — where the shielded vault lives).
# 900002 = Solana Devnet native vault + on-vault CPMM (siphon-pool-v1).
SUPPORTED_EXECUTOR_CHAIN_IDS = {8453, 11155111, 42161, 42431, 998, 900_002}

# HyperEVM (testnet 998 / mainnet 999) — native vault source for private HL perps.
HYPEREVM_TESTNET_CHAIN_ID = 998
HYPEREVM_MAINNET_CHAIN_ID = 999

# Polygon is NOT a strategy source chain (no Siphon vault there). It's a config-only chain the
# executor transacts on for Polymarket: the LiFi return leg resolves its RPC, and CTF redemption
# uses its USDC/contracts. Keep it out of SUPPORTED_EXECUTOR_CHAIN_IDS so no one can create a
# strategy with from_chain=137.
POLYGON_CHAIN_ID = 137


@dataclass(frozen=True)
class EvmChainConfig:
    chain_id: int
    name: str
    rpc_url: str
    entrypoint: str
    # v2/v3 VaultKernel. Separate from `entrypoint`, which is the v1 contract — the two coexist
    # while v1 vaults still hold funds. Resolved from server config ONLY, never from a request:
    # a caller who could name the target contract could point a valid proof at a contract of
    # their choosing.
    vault_kernel: str = ""
    uniswap_v3_router: str = ""
    uniswap_v3_factory: str = ""
    weth: str = ""
    usdc: str = ""
    swap_fee_tier: int = 3000

    def token_address(self, symbol: str) -> str:
        sym = symbol.upper()
        if sym == "ETH":
            return NATIVE_ASSET
        if sym in ("USDC", "PATHUSD"):
            return self.usdc
        if sym == "WETH":
            return self.weth
        extra = _EXTRA_TOKENS.get(self.chain_id, {})
        if sym in extra:
            return extra[sym]
        return sym


# Extra tokens only used on some testnets (executor swap path).
_EXTRA_TOKENS: Dict[int, Dict[str, str]] = {
    11155111: {
        "USDT": "0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0",
        "WBTC": "0x92f3B59a79bFf5dc60c0d59eA13a44D082B2bdFC",
    },
    42431: {
        "ALPHAUSD": "0x20c0000000000000000000000000000000000001",
        "BETAUSD": "0x20c0000000000000000000000000000000000002",
        "THETAUSD": "0x20c0000000000000000000000000000000000003",
    },
}

# Defaults aligned with siphon-app/src/lib/networks.ts
_CHAIN_DEFAULTS: Dict[int, EvmChainConfig] = {
    8453: EvmChainConfig(
        chain_id=8453,
        name="Base",
        rpc_url="https://mainnet.base.org",
        # Hard ASP R2 MPC deployment, 2026-08-21. The retired 0x5433995f… Entrypoint is
        # a legacy migration source only and must never receive new strategy execution.
        entrypoint="0xA8AD713eDc27b14AA6057C53745479bc6a7E145A",
        # Left empty here, NOT read from env: this dict is built at import time, before `_env`
        # is defined below, so an env lookup at this point is a NameError on import. The env
        # overrides happen in get_evm_chain_config().
        vault_kernel="",
        uniswap_v3_router="0x2626664c2603336E57B271c5C0b26F421741e481",
        uniswap_v3_factory="0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        weth="0x4200000000000000000000000000000000000006",
        usdc="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        swap_fee_tier=500,  # deepest WETH/USDC pool on Base
    ),
    11155111: EvmChainConfig(
        chain_id=11155111,
        name="Ethereum Sepolia",
        rpc_url="https://ethereum-sepolia-rpc.publicnode.com",
        # Align with siphon-app networks.ts (soft-era until Hard ASP redeploy).
        entrypoint="0xE5126A49D1bb93957b4B2F63BCB05a1F8EA9e705",
        vault_kernel="",  # see the Base entry — env overrides live in get_evm_chain_config()
        # Canonical Sepolia SwapRouter02. The previous default here was the SimpleSwapRouter stub
        # 0x5D49f98e…, whose bytecode does not contain exactInputSingle (0x04e45aaf) at all — the
        # selector every caller in this repo uses, including UniswapV3SettlementAdapter. Any box
        # without an ETH_SEPOLIA_UNISWAP_V3_ROUTER override reverted every Sepolia swap.
        uniswap_v3_router="0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
        uniswap_v3_factory="0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
        weth="0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
        usdc="0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    ),
    # Arbitrum One. Addresses read back on-chain 2026-09-27: the router carries exactInputSingle
    # (0x04e45aaf) and its factory()/WETH9() are the two below. USDC is native USDC, not USDC.e.
    42161: EvmChainConfig(
        chain_id=42161,
        name="Arbitrum",
        rpc_url="https://arb1.arbitrum.io/rpc",
        entrypoint="",  # no v1 entrypoint on Arbitrum — v5 kernel only
        vault_kernel="",  # env only: ARBITRUM_VAULT_KERNEL / VAULT_KERNEL_42161
        uniswap_v3_router="0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        uniswap_v3_factory="0x1F98431c8aD98523631AE4a59f267346ea31F984",
        weth="0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        usdc="0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        swap_fee_tier=500,  # deepest WETH/USDC pool (0xC6962004…), ~8x the 3000 pool
    ),
    # Polygon — config-only (Polymarket settlement). No Siphon entrypoint/uniswap here; the executor
    # uses USDC + Polymarket's CTF contracts. USDC = Polymarket's collateral (bridged USDC.e).
    POLYGON_CHAIN_ID: EvmChainConfig(
        chain_id=POLYGON_CHAIN_ID,
        name="Polygon",
        rpc_url="https://polygon-rpc.com",
        entrypoint="",
        vault_kernel="",
        uniswap_v3_router="",
        uniswap_v3_factory="",
        weth="0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",  # WPOL/WMATIC
        usdc="0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",  # USDC.e (Polymarket collateral)
    ),
    # Tempo Moderato — admin testnet showcase (pathUSD + enshrined Stablecoin DEX).
    # Kernel empty until DeployVaultStack; uniswap fields unused (DEX is 0xdec0…, adapter TBD).
    42431: EvmChainConfig(
        chain_id=42431,
        name="Tempo Moderato",
        rpc_url="https://rpc.moderato.tempo.xyz",
        entrypoint="",
        vault_kernel="",
        uniswap_v3_router="0xdec0000000000000000000000000000000000000",
        uniswap_v3_factory="",
        weth="0x20c0000000000000000000000000000000000000",
        usdc="0x20c0000000000000000000000000000000000000",
    ),
    # HyperEVM Testnet — admin native vault for private HL perps (Circle USDC + HYPE gas).
    998: EvmChainConfig(
        chain_id=998,
        name="HyperEVM Testnet",
        rpc_url="https://rpc.hyperliquid-testnet.xyz/evm",
        entrypoint="",
        vault_kernel="",
        uniswap_v3_router="",
        uniswap_v3_factory="",
        weth="0x0000000000000000000000000000000000000000",
        usdc="0x2B3370eE501B4a559b57D449569354196457D8Ab",
    ),
}


def _env(key: str, fallback: str = "") -> str:
    return (os.getenv(key) or fallback).strip()


def get_evm_chain_config(chain_id: str | int) -> EvmChainConfig:
    """Resolve RPC + contract addresses for a chain. Env overrides per chain."""
    cid = int(chain_id)
    base = _CHAIN_DEFAULTS.get(cid)
    if not base:
        raise ValueError(
            f"Unsupported EVM chain {cid}. Executor supports: {sorted(SUPPORTED_EXECUTOR_CHAIN_IDS)}"
        )

    if cid == 8453:
        return EvmChainConfig(
            chain_id=cid,
            name=base.name,
            rpc_url=_env("BASE_MAINNET_RPC", _env("ETH_RPC_URL", base.rpc_url)),
            entrypoint=_env("BASE_MAINNET_ENTRYPOINT", _env("ENTRYPOINT_ADDRESS", base.entrypoint)),
            # Both naming conventions accepted: the executor's own BASE_MAINNET_*/VAULT_KERNEL_<id>
            # and the NEXT_PUBLIC_V3_* names shared with the frontend env, so a box configured
            # either way resolves the kernel rather than silently falling back to "".
            vault_kernel=_env(
                "BASE_MAINNET_VAULT_KERNEL",
                _env("VAULT_KERNEL_8453", _env("NEXT_PUBLIC_V3_BASE_VAULT_KERNEL", _env("BASE_VAULT_KERNEL", base.vault_kernel))),
            ),
            uniswap_v3_router=_env("BASE_MAINNET_UNISWAP_V3_ROUTER", _env("UNISWAP_V3_ROUTER", base.uniswap_v3_router)),
            uniswap_v3_factory=_env("BASE_MAINNET_UNISWAP_V3_FACTORY", base.uniswap_v3_factory),
            weth=_env("BASE_MAINNET_WETH", _env("WETH_ADDRESS", base.weth)),
            usdc=_env("BASE_MAINNET_USDC", _env("USDC_ADDRESS", base.usdc)),
        )

    if cid == 11155111:
        return EvmChainConfig(
            chain_id=cid,
            name=base.name,
            rpc_url=_env("ETH_SEPOLIA_RPC", base.rpc_url),
            entrypoint=_env("ETH_SEPOLIA_ENTRYPOINT", base.entrypoint),
            vault_kernel=_env(
                "ETH_SEPOLIA_VAULT_KERNEL",
                _env("VAULT_KERNEL_11155111", _env("NEXT_PUBLIC_V3_SEPOLIA_VAULT_KERNEL", _env("SEPOLIA_VAULT_KERNEL", base.vault_kernel))),
            ),
            uniswap_v3_router=_env("ETH_SEPOLIA_UNISWAP_V3_ROUTER", base.uniswap_v3_router),
            uniswap_v3_factory=_env("ETH_SEPOLIA_UNISWAP_V3_FACTORY", base.uniswap_v3_factory),
            weth=_env("ETH_SEPOLIA_WETH", base.weth),
            usdc=_env("ETH_SEPOLIA_USDC", base.usdc),
        )

    if cid == 42161:
        return EvmChainConfig(
            chain_id=cid,
            name=base.name,
            rpc_url=_env("ARBITRUM_RPC", _env("ARB_RPC", base.rpc_url)),
            entrypoint="",
            vault_kernel=_env(
                "ARBITRUM_VAULT_KERNEL",
                _env("VAULT_KERNEL_42161", _env("NEXT_PUBLIC_V3_ARBITRUM_VAULT_KERNEL", base.vault_kernel)),
            ),
            uniswap_v3_router=_env("ARBITRUM_UNISWAP_V3_ROUTER", base.uniswap_v3_router),
            uniswap_v3_factory=_env("ARBITRUM_UNISWAP_V3_FACTORY", base.uniswap_v3_factory),
            weth=_env("ARBITRUM_WETH", base.weth),
            usdc=_env("ARBITRUM_USDC", base.usdc),
            swap_fee_tier=base.swap_fee_tier,
        )

    if cid == POLYGON_CHAIN_ID:
        return EvmChainConfig(
            chain_id=cid,
            name=base.name,
            rpc_url=_env("POLYGON_RPC", base.rpc_url),
            entrypoint="",
            vault_kernel="",
            uniswap_v3_router="",
            uniswap_v3_factory="",
            weth=base.weth,
            usdc=_env("POLYGON_USDC", base.usdc),
        )

    if cid == 42431:
        return EvmChainConfig(
            chain_id=cid,
            name=base.name,
            rpc_url=_env("TEMPO_MODERATO_RPC", base.rpc_url),
            entrypoint="",
            vault_kernel=_env(
                "TEMPO_MODERATO_VAULT_KERNEL",
                _env(
                    "VAULT_KERNEL_42431",
                    _env("NEXT_PUBLIC_V3_TEMPO_MODERATO_VAULT_KERNEL", base.vault_kernel),
                ),
            ),
            uniswap_v3_router=_env("TEMPO_MODERATO_STABLECOIN_DEX", base.uniswap_v3_router),
            uniswap_v3_factory="",
            weth=_env("TEMPO_MODERATO_PATHUSD", base.weth),
            usdc=_env("TEMPO_MODERATO_PATHUSD", base.usdc),
        )

    if cid == 998:
        return EvmChainConfig(
            chain_id=cid,
            name=base.name,
            rpc_url=_env("HYPEREVM_TESTNET_RPC", base.rpc_url),
            entrypoint="",
            vault_kernel=_env(
                "HYPEREVM_TESTNET_VAULT_KERNEL",
                _env(
                    "VAULT_KERNEL_998",
                    _env("NEXT_PUBLIC_V3_HYPEREVM_TESTNET_VAULT_KERNEL", base.vault_kernel),
                ),
            ),
            uniswap_v3_router="",
            uniswap_v3_factory="",
            weth=base.weth,
            usdc=_env("HYPEREVM_TESTNET_USDC", base.usdc),
        )

    raise ValueError(f"Unsupported EVM chain {cid}")


def resolve_execution_chain_id(strategy: dict) -> int:
    """Chain used for ZK withdraw + same-chain swap (strategy source chain)."""
    raw = strategy.get("from_chain") or strategy.get("chain_id") or "8453"
    cid = int(raw)
    if cid not in SUPPORTED_EXECUTOR_CHAIN_IDS:
        raise ValueError(
            f"Strategy from_chain={cid} is not supported by the executor. "
            f"Supported: {sorted(SUPPORTED_EXECUTOR_CHAIN_IDS)}"
        )
    return cid
