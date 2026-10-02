"""Load Devnet Sepolia env and run the full trade-executor (strategies + bridge)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONTRACTS_ENV = ROOT.parents[1] / "siphon-contracts-v2" / "evm" / ".env"


def _load(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load(ROOT / ".env.devnet")
_load(CONTRACTS_ENV)
# Map deployer key to bridge + Sepolia executor signing
pk = (os.environ.get("PRIVATE_KEY") or "").strip()
if pk:
    os.environ.setdefault("DEVNET_BRIDGE_KEY", pk)
    os.environ.setdefault("ETH_SEPOLIA_EXECUTOR_KEY", pk)
    os.environ.setdefault("EVM_EXECUTOR_KEY", pk)

os.environ.setdefault("PORT", "5020")
os.environ.setdefault("DB_ALLOW_DEFAULT_KEY", "1")
os.environ.setdefault("SERVER_HMAC_SECRET", "devnet-local-hmac-secret-do-not-use-prod")
os.environ.setdefault("ADMIN_GATED_CHAIN_IDS", "")
os.environ.setdefault(
    "NOTE_DB_URI",
    f"sqlite:///{(ROOT / 'instance' / 'notes_devnet.db').as_posix()}",
)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
(ROOT / "instance").mkdir(exist_ok=True)

# Import after env is populated
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from app import app  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5005"))
    print(f"trade-executor Devnet Sepolia on http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
