"""Boot the API gateway for local dashboard smoke (no Postgres/Redis/Docker).

  .venv/Scripts/python.exe scripts/run_local_dev.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTOR = ROOT.parent / "trade-executor"
sys.path.insert(0, str(EXECUTOR))
sys.path.insert(0, str(ROOT))

os.environ.setdefault("DATABASE_URL", f"sqlite:///{(ROOT / 'siphon_gateway_local.db').as_posix()}")
os.environ.setdefault("REDIS_URL", "memory://")
os.environ.setdefault("RECONCILE_ENABLED", "false")
os.environ.setdefault("RUN_RECONCILER_IN_WORKER", "0")
os.environ.setdefault("API_KEY_PEPPER", "dev-pepper-change-me")
os.environ.setdefault("BASE_MAINNET_RPC", "https://mainnet.base.org")
os.environ.setdefault("ETH_SEPOLIA_RPC", "https://ethereum-sepolia-rpc.publicnode.com")

if __name__ == "__main__":
    import uvicorn

    # Import after env is set so Settings / engine pick up sqlite + memory redis.
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "8000")),
        reload=False,
        factory=False,
    )
