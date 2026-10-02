"""Boot a self-contained sandbox gateway and print a ready-to-use API key.

No Postgres, no Redis, no executor, no chain, no wallet. SQLite + in-process fake Redis + the
`sk_test_` fixture path, which is enough to exercise the entire platform surface end to end.

    python scripts/run_sandbox.py                # localhost:8000
    python scripts/run_sandbox.py --host 0.0.0.0 # reachable from another machine
    python scripts/run_sandbox.py --reset        # start from a clean database

Share it publicly with any TCP tunnel, e.g.:

    cloudflared tunnel --url http://localhost:8000
    ngrok http 8000

The key is printed once at boot and re-created on --reset. Because sandbox is decided by the key's
plan, a tunnel exposes fixtures only — there is no chain access and no real funds behind it.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXECUTOR = ROOT.parent / "trade-executor"
sys.path.insert(0, str(EXECUTOR))
sys.path.insert(0, str(ROOT))

DB_PATH = ROOT / "siphon_sandbox.db"


def _configure(reset: bool) -> None:
    if reset and DB_PATH.exists():
        DB_PATH.unlink()

    os.environ.setdefault("DATABASE_URL", f"sqlite:///{DB_PATH.as_posix()}")
    os.environ.setdefault("REDIS_URL", "memory://")
    os.environ.setdefault("SIPHON_ENV", "dev")
    os.environ.setdefault("RECONCILE_ENABLED", "false")
    os.environ.setdefault("RUN_RECONCILER_IN_WORKER", "0")
    os.environ.setdefault("API_KEY_PEPPER", "dev-pepper-change-me")
    os.environ.setdefault("BASE_MAINNET_RPC", "https://mainnet.base.org")
    os.environ.setdefault("ETH_SEPOLIA_RPC", "https://ethereum-sepolia-rpc.publicnode.com")


def _ensure_key() -> str:
    """Return a usable sandbox key, minting one on first boot."""
    from app.repository.models import ApiKey, Base
    from app.repository.session import SessionLocal, _engine
    from app.services import api_key_service

    Base.metadata.create_all(_engine)
    db = SessionLocal()
    try:
        existing = db.query(ApiKey).filter_by(integrator_id="sandbox", status="active").first()
        if existing is not None:
            return ""  # already minted; plaintext is unrecoverable by design
        raw, _row = api_key_service.mint_key(db, integrator_id="sandbox", plan="test", test=True)
        db.commit()
        return raw
    finally:
        db.close()


BANNER = """
================================================================================
  SIPHON SANDBOX GATEWAY — running (this terminal is now BLOCKED)
================================================================================
  Docs      http://{host}:{port}/docs          <- easiest: click, Authorize, try it
  OpenAPI   http://{host}:{port}/openapi.json  <- import to Postman/Insomnia/Bruno

--------------------------------------------------------------------------------
  THIS TERMINAL IS SERVING. Open a SECOND terminal for requests — anything typed
  here goes to the server's stdin and will not run.

  In that second terminal, load BASE and KEY (no copy-pasting the key):

      cd {cwd}
      source {envfile}

  Then, ready to run as-is:

      curl -s $BASE/v1/strategies/functions -H "Authorization: Bearer $KEY"

      # policy is enforced server-side -> 403 naming the rule
      curl -s -X PUT $BASE/v1/policy -H "Authorization: Bearer $KEY" \\
        -H 'Content-Type: application/json' \\
        -d '{{"rules":{{"max_amount_minor":1000}}}}'

      # force any error path (sandbox only) -> 451
      curl -s -X POST $BASE/v1/batches -H "Authorization: Bearer $KEY" \\
        -H 'Content-Type: application/json' -H 'X-Simulate: sanctioned' \\
        -d '{{"chain_id":8453,"asset":"USDC","items":[{{"recipient":"0xabc","amount_minor":100}}]}}'

  Share it:  cloudflared tunnel --url http://localhost:{port}
  Stop it:   Ctrl-C here
================================================================================
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--reset", action="store_true", help="delete the sandbox DB and re-mint a key")
    args = ap.parse_args()

    _configure(args.reset)

    key = _ensure_key()

    # Write BASE/KEY to a sourceable file rather than asking anyone to copy a key out of a banner.
    # A pasted placeholder is the single most likely way a first run fails, and a sandbox key is not
    # a secret (test plan, no chain access), so a file on disk is the right trade here.
    envfile = ROOT / ".sandbox-env"
    if key:
        envfile.write_text(
            f'export BASE="http://{args.host}:{args.port}"\nexport KEY="{key}"\n'
        )
    elif not envfile.exists():
        envfile.write_text(
            f'export BASE="http://{args.host}:{args.port}"\n'
            'export KEY=""  # re-run run_sandbox.py --reset to mint a key\n'
        )

    # flush=True: uvicorn takes over the process before an unflushed buffer would drain.
    print(
        BANNER.format(host=args.host, port=args.port, cwd=ROOT, envfile=envfile.name),
        flush=True,
    )

    import uvicorn

    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
