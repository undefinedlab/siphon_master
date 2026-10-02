#!/usr/bin/env python3
"""HyperEVM Testnet (998) native vault -> Hyperliquid testnet perps E2E smoke (Option A).

Product path: shield USDC on 998 → arm HYPERLIQUID → WITHDRAW to executor →
CoreDepositWallet → HyperCore testnet → open/close (exit currently usdSend on HyperCore).

Stages (catalog / wiring — live deposit+trade when keys + vault are set):
  1. Chain catalog: SUPPORTED 998, RPC eth_chainId, USDC defaults
  2. Hyperliquid testnet public mids (HYPERLIQUID_TESTNET=1)
  3. hyperevm_bridge address table + is_hyperevm_chain
  4. Optional: hl_bridge ping when HYPERLIQUID_PRIVATE_KEY set
  5. Optional: CoreDepositWallet deposit dry-check (needs executor key + USDC + HYPE)

Usage:
  set HYPERLIQUID_TESTNET=1
  python scripts/e2e_hyperevm_perps.py
  python scripts/e2e_hyperevm_perps.py --live-deposit   # needs funded executor on 998

Full product E2E (deposit → ASP admit → arm → open → close → re-shield) still needs
DeployVaultStack addresses in VAULT_KERNEL_998 / NEXT_PUBLIC_V3_HYPEREVM_TESTNET_*.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ.setdefault("NOTE_DB_URI", "postgresql://e2e:e2e@127.0.0.1:5432/e2e")
os.environ.setdefault("SERVER_HMAC_SECRET", "e2e-hmac-secret")
os.environ.setdefault("DATABASE_URI", "sqlite:///:memory:")
os.environ.setdefault("HYPERLIQUID_TESTNET", "1")

_default_py = ROOT / (".venv-hl/Scripts/python.exe" if os.name == "nt" else ".venv-hl/bin/python")
if _default_py.is_file() and not os.environ.get("HYPERLIQUID_PYTHON"):
    os.environ["HYPERLIQUID_PYTHON"] = str(_default_py)

HYPEREVM_TESTNET = 998
EXPECTED_USDC = "0x2B3370eE501B4a559b57D449569354196457D8Ab"


def _ok(msg: str) -> None:
    print(f"  OK  {msg}")


def _skip(msg: str) -> None:
    print(f"  SKIP {msg}")


def _fail(msg: str) -> None:
    print(f"  FAIL {msg}")
    raise SystemExit(1)


def stage_catalog() -> None:
    print("\n[1] Executor catalog + RPC")
    from evm_chain_config import (
        SUPPORTED_EXECUTOR_CHAIN_IDS,
        get_evm_chain_config,
        HYPEREVM_TESTNET_CHAIN_ID,
    )
    import hyperevm_bridge

    if HYPEREVM_TESTNET not in SUPPORTED_EXECUTOR_CHAIN_IDS:
        _fail(f"998 missing from SUPPORTED_EXECUTOR_CHAIN_IDS: {SUPPORTED_EXECUTOR_CHAIN_IDS}")
    _ok(f"SUPPORTED includes {HYPEREVM_TESTNET}")

    cfg = get_evm_chain_config(HYPEREVM_TESTNET_CHAIN_ID)
    if cfg.usdc.lower() != EXPECTED_USDC.lower():
        _fail(f"USDC mismatch: {cfg.usdc}")
    _ok(f"USDC={cfg.usdc} rpc={cfg.rpc_url}")

    if not hyperevm_bridge.is_hyperevm_chain(998):
        _fail("is_hyperevm_chain(998) false")
    if hyperevm_bridge.is_hyperevm_chain(8453):
        _fail("is_hyperevm_chain(8453) should be false")
    _ok("hyperevm_bridge chain gate")

    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}).encode()
    req = urllib.request.Request(
        cfg.rpc_url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode())
    cid = int(data.get("result") or "0x0", 16)
    if cid != HYPEREVM_TESTNET:
        _fail(f"RPC chainId={cid}, expected {HYPEREVM_TESTNET}")
    _ok(f"RPC eth_chainId={cid}")


def stage_hl_testnet() -> None:
    print("\n[2] Hyperliquid testnet mids")
    import hyperliquid_client as hl

    if not hl.testnet():
        _fail("expected HYPERLIQUID_TESTNET=1")
    _ok(f"API={hl.INFO_URL_TEST}")
    mids = hl.all_mids()
    if not mids.get("BTC"):
        _fail(f"allMids missing BTC: {list(mids)[:8]}")
    _ok(f"BTC mid=${mids['BTC']:,.2f}")


def stage_bridge_addrs() -> None:
    print("\n[3] CoreDepositWallet table")
    import hyperevm_bridge as hb

    usdc, wallet = hb._addrs(998)
    if usdc.lower() != EXPECTED_USDC.lower():
        _fail(usdc)
    if wallet.lower() != hb.HYPEREVM_TESTNET_CORE_DEPOSIT.lower():
        _fail(wallet)
    _ok(f"testnet CoreDepositWallet={wallet}")
    _ok(f"USDC system addr={hb.USDC_SYSTEM_ADDRESS}")


def stage_hl_ping() -> None:
    print("\n[4] hl_bridge ping")
    import hyperliquid_client as hl

    if not hl.is_configured():
        _skip("HYPERLIQUID_MASTER_PRIVATE_KEY unset")
        return
    out = hl._bridge_call({"op": "ping"}, timeout=60.0)
    _ok(f"ping account={out.get('account')} signer={out.get('signer')}")


def stage_live_deposit(do_live: bool) -> None:
    print("\n[5] HyperEVM -> Core deposit")
    if not do_live:
        _skip("pass --live-deposit to attempt CoreDepositWallet.deposit (spends USDC+HYPE)")
        return
    key = (os.environ.get("HYPEREVM_TESTNET_EXECUTOR_KEY") or os.environ.get("EVM_EXECUTOR_KEY") or "").strip()
    if not key:
        _fail("set HYPEREVM_TESTNET_EXECUTOR_KEY for --live-deposit")
    from evm_chain_config import get_evm_chain_config
    from evm_executor import get_web3, get_executor_account, send_tx
    import hyperevm_bridge

    cfg = get_evm_chain_config(998)
    w3 = get_web3(cfg)
    account = get_executor_account(w3, 998)
    # Dust: $1 USDC
    amount_wei = 1_000_000
    tx = hyperevm_bridge.deposit_usdc_to_core(
        w3, account, 998, amount_wei, to_perps=True, send_tx=send_tx,
    )
    _ok(f"deposit tx={tx}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--live-deposit", action="store_true")
    args = ap.parse_args()
    print("e2e_hyperevm_perps - HyperEVM Testnet private perps wiring")
    stage_catalog()
    stage_hl_testnet()
    stage_bridge_addrs()
    stage_hl_ping()
    stage_live_deposit(args.live_deposit)
    print("\nPASS - catalog + HL testnet OK"
          + (" (live deposit attempted)" if args.live_deposit else ""))


if __name__ == "__main__":
    main()
