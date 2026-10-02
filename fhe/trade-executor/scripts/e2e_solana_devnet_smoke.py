#!/usr/bin/env python3
"""Devnet strategy pipeline smoke (infra + settlement scripts). Full E2E still needs a browser arm."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "solana-scripts"
DEFAULT_EXECUTOR = os.getenv(
    "SOLANA_DEVNET_EXECUTOR_URL",
    "https://siphon-fhe-sol-production.up.railway.app",
).rstrip("/")


def _get(path: str) -> tuple[int, dict]:
    req = urllib.request.Request(f"{DEFAULT_EXECUTOR}{path}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode() or "{}"
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"raw": body[:300]}


def _node_smoke(script: Path) -> str | None:
    proc = subprocess.run(
        ["node", str(script)],
        input="{}",
        capture_output=True,
        text=True,
        cwd=str(SCRIPTS),
        timeout=60,
        check=False,
    )
    line = (proc.stdout or proc.stderr or "").strip().splitlines()
    last = line[-1] if line else ""
    if proc.returncode == 0:
        return f"{script.name}: unexpected success on empty input"
    if "BAD_PACKAGE" not in last and "publics must be 25" not in last:
        return f"{script.name}: bad exit {proc.returncode}: {last[:200]}"
    return None


def main() -> int:
    fails: list[str] = []

    code, health = _get("/health")
    if code != 200 or health.get("status") != "healthy":
        fails.append(f"/health -> {code} {health}")

    code, settle = _get("/solana/settlement")
    if code != 200 or not settle.get("pubkey"):
        fails.append(f"/solana/settlement -> {code} {settle}")
    else:
        print(f"settlement wallet: {settle.get('pubkey')}")
        print(f"meteora pool:      {settle.get('meteoraPool')}")

    code, att = _get("/decryptorAttestation")
    if code != 200 or not att.get("x25519_pubkey"):
        fails.append(f"/decryptorAttestation -> {code}")

    for name in (
        "execute-zk-meteora.mjs",
        "execute-zk-jupiter-earn.mjs",
        "execute-zk-jito-stake.mjs",
        "relay-zk-withdraw.mjs",
    ):
        p = SCRIPTS / name
        if not p.is_file():
            fails.append(f"missing bundled script {p}")
            continue
        err = _node_smoke(p)
        if err:
            fails.append(err)
        else:
            print(f"node smoke ok: {name}")

    meteora = SCRIPTS / "execute-zk-meteora.mjs"
    if meteora.is_file() and not (SCRIPTS / "node_modules").is_dir():
        fails.append("run npm install --omit=dev in solana-scripts before local node smoke")

    if fails:
        print("\nFAILED:")
        for f in fails:
            print(f"  - {f}")
        return 1

    print("\nSmoke passed. For full E2E: arm a Devnet order in the app (Phantom), wait for trigger or use market execute_now.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
