"""Load Devnet Sepolia ASP env and run aspv2."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONTRACTS_ENV = ROOT.parent / "siphon-contracts-v2" / "evm" / ".env"


def _load(path: Path, *, override: bool = False) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if not k:
            continue
        if override or k not in os.environ:
            os.environ[k] = v


_load(ROOT / ".env.devnet", override=True)
_load(CONTRACTS_ENV)
pk = (os.environ.get("PRIVATE_KEY") or "").strip()
if pk:
    os.environ.setdefault("ASP_POSTMAN_KEY", pk)
    os.environ.setdefault(f"ASP_POSTMAN_KEY_11155111", pk)

(ROOT / "instance").mkdir(exist_ok=True)

from app import app  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("ASP_PORT", "5056"))
    print(f"aspv2 Devnet Sepolia on http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
