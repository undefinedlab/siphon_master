"""Live ASGI smoke for public key-purchase endpoints.

Run from api-gateway/:
  .venv/Scripts/python.exe scripts/_smoke_keys.py
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTOR = ROOT.parent / "trade-executor"
# Gateway `app` package must win over trade-executor's top-level `app.py`.
sys.path.insert(0, str(EXECUTOR))
sys.path.insert(0, str(ROOT))

os.environ.setdefault("BASE_MAINNET_RPC", "https://mainnet.base.org")
os.environ.setdefault("ETH_SEPOLIA_RPC", "https://ethereum-sepolia-rpc.publicnode.com")

from fastapi.testclient import TestClient
from app.main import create_app

app = create_app(start_reconciler=False)
c = TestClient(app)

r = c.get("/v1/liveness")
print("liveness", r.status_code, r.json())
assert r.status_code == 200

r = c.get("/v1/keys/packs")
print("packs", r.status_code)
body = r.json()
print("pack_ids", [p["id"] for p in body.get("packs", [])])
print("collector", body.get("collector"))
assert r.status_code == 200
assert len(body["packs"]) == 3
print("SMOKE_OK")
