from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix
import threading
import time
import os
import json
import hashlib
from datetime import datetime
from database import (
    db,
    Strategy,
    StrategyLeg,
    UserFheKey,
    get_server_key,
    ExecutionEvent,
    RelaySubmission,
)

from note_db import init_note_db, NoteSession
from scheduler import worker_loop
from config import DATABASE_URI, PYTH_PRICE_FEED_IDS
from auth import rate_limit, require_admin, require_auth

from wallet_auth import (
    verify_wallet_sig,
    verify_wallet_sig_gated,
    verify_wallet_write,
    verify_strategy_sig,
    reject_api_token_on_user_routes,
    require_siphon_user_api_key,
    create_challenge_payload,
)
import fee_config as fee_cfg  # used by the FEE_ENABLED gate (main); import lived on main's side of the merge


def _wallet_authorizes(wallet, claimed_user_id):
    """Ownership check. Fail-closed: ENFORCE_WALLET_AUTH defaults to on.

    Set ENFORCE_WALLET_AUTH=0 only for local grace during frontend rollout.
    Solana pubkeys are case-sensitive — compare exact when either side looks non-EVM.
    """
    if (os.getenv('ENFORCE_WALLET_AUTH', '1') or '1').strip() != '1':
        return True
    if not wallet:
        return False
    claimed = claimed_user_id or ""
    # EVM addresses are case-insensitive; Solana base58 is case-sensitive.
    if claimed.startswith("0x") and str(wallet).startswith("0x"):
        return wallet.lower() == claimed.lower()
    return str(wallet) == claimed
from address_validator import validate_recipient, validate_note_label
from evm_chain_config import SUPPORTED_EXECUTOR_CHAIN_IDS
from admin_wallets import (
    chain_is_gated, is_wallet_allowed, add_wallet, remove_wallet, list_wallets,
)


# Error tracking. Must be initialised BEFORE the Flask app is created so the integration can
# wrap it. No-ops unless SENTRY_DSN is set, and never blocks startup — see observability.py for
# the redaction rules, which are what make an external reporter acceptable in a process that
# handles note secrets.
from observability import init_sentry
init_sentry("trade-executor")

app = Flask(__name__)
# Production exposes Flask only through the loopback-bound Caddy container. Trust exactly that
# one proxy hop so request.remote_addr is the real client IP for endpoint-scoped rate limits.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


# NoteSession is a scoped_session shared across requests. If a request dies mid-flush (e.g. a
# dropped Supabase pooler connection), the session is left in a PendingRollbackError state and
# EVERY later request that touches it 500s until the process restarts. Removing the scoped session
# after each request rolls back any pending txn and returns the connection to the pool, so a
# poisoned session can never leak to the next request.
@app.teardown_appcontext
def _remove_note_session(exc=None):
    NoteSession.remove()


# Transparent gzip request bodies (the browser gzips the ~24MB server-key upload down to ~7MB).
# Capped so a tiny gzip bomb can't balloon into RAM before auth runs.
_MAX_GUNZIP_BYTES = 128 * 1024 * 1024

@app.before_request
def _gunzip_request():
    if request.headers.get("Content-Encoding", "").lower() != "gzip":
        return
    import gzip as _gzip, io as _io
    try:
        raw = _gzip.GzipFile(fileobj=_io.BytesIO(request.get_data())).read(_MAX_GUNZIP_BYTES + 1)
    except OSError:
        return jsonify({"error": "invalid gzip body"}), 400
    if len(raw) > _MAX_GUNZIP_BYTES:
        return jsonify({"error": "decompressed body too large"}), 413
    # Werkzeug caches body in _cached_data; get_json() reads from it.
    request._cached_data = raw
    request.environ["CONTENT_LENGTH"] = str(len(raw))
    request.environ.pop("HTTP_CONTENT_ENCODING", None)
# Allowed browser origins. Extra origins can be added without a code change via the
# CORS_ALLOWED_ORIGINS env var (comma-separated).
_DEFAULT_CORS_ORIGINS = [
    "https://siphon.money",
    "https://www.siphon.money",
    "https://siphon-app.vercel.app",
    "https://siphon-judge.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
# Extra exact origins via CORS_ALLOWED_ORIGINS (comma-separated). Preview deploys must be
# listed explicitly — a regex wildcard on *.vercel.app lets any tenant origin call browser-gated
# executor routes with stolen wallet signatures.
_CORS_ORIGINS = _DEFAULT_CORS_ORIGINS + [
    o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()
]
CORS(
    app,
    resources={r"/*": {
        "origins": _CORS_ORIGINS,
        "allow_headers": [
            "Content-Type",
            # Browser gzips the ~24MB server-key upload; the header triggers a CORS preflight.
            "Content-Encoding",
            "X-Wallet-Address",
            "X-Tag",
            "X-Auth-Token",
            # Wallet-sig flow (verify_wallet_sig, e.g. POST /polymarket/exit) still signs
            # "Siphon auth v1:<ts>" and sends these — the HMAC X-Auth-Token only replaced
            # them for the tag-auth note endpoints.
            "X-Signature",
            "X-Timestamp",
            "X-Write-Signature",
            "X-Write-Nonce",
            # Session-key delegation. The browser signs auth messages with an ephemeral key the
            # wallet authorized once, and proves the link with this header. Omitting it here does
            # not degrade to wallet signing — the browser blocks the whole request at preflight
            # ("x-session-delegation is not allowed by Access-Control-Allow-Headers") before any
            # auth code runs, so every call fails with a CORS error rather than a 401.
            "X-Session-Delegation",
            "X-Session-Key",
            # Phantom Devnet session (GET /strategies and the other Solana reads). Same failure
            # mode as the session-key headers: the browser preflights x-solana-session and drops
            # the request before wallet_auth ever sees it.
            "X-Solana-Address",
            "X-Solana-Session",
            "X-Solana-Expires",
            "X-API-TOKEN",
            "X-ADMIN-TOKEN",
            "X-Client-ID",
            "X-Request-ID",
            "Authorization",
        ],
        "methods": ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }},
    supports_credentials=False,
)

# Ensure instance directory exists before setting database URI
import os
if DATABASE_URI and 'sqlite' in DATABASE_URI and 'instance' in DATABASE_URI:
    instance_dir = os.path.join(os.path.dirname(__file__), 'instance')
    os.makedirs(instance_dir, exist_ok=True)
    # Convert relative path to absolute path for SQLite
    if DATABASE_URI.startswith('sqlite:///instance'):
        db_path = os.path.join(instance_dir, 'strategies.db')
        # Extract timeout if present
        timeout = '?timeout=20000'
        if 'timeout' in DATABASE_URI:
            timeout = '?' + DATABASE_URI.split('?')[1] if '?' in DATABASE_URI else ''
        DATABASE_URI = f'sqlite:///{db_path}{timeout}'

app.config['SQLALCHEMY_DATABASE_URI'] = DATABASE_URI
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# SQLite concurrency fix: use NullPool to avoid connection sharing issues
# and set busy_timeout to wait instead of failing on lock
if DATABASE_URI and 'sqlite' in DATABASE_URI:
    from sqlalchemy.pool import NullPool
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'poolclass': NullPool,
        'connect_args': {'timeout': 30, 'check_same_thread': False}
    }

db.init_app(app)

# ── Supabase (note DB) — standalone SQLAlchemy engine, separate from main SQLite ──
# init_note_db() creates tables on Supabase if they don't exist. Safe every startup.
init_note_db()

from precommitments import precommitments_bp
from commitments import commitments_bp
from notes import notes_bp
from vault_index import vault_index_bp
from receipts import receipts_bp
app.register_blueprint(precommitments_bp)
app.register_blueprint(commitments_bp)
app.register_blueprint(notes_bp)
app.register_blueprint(vault_index_bp)
app.register_blueprint(receipts_bp)

# Schema bootstrap + additive migrations.
# db.create_all() creates missing TABLES only — it never ALTERs existing ones. Solana
# Railway uses Postgres (DATABASE_URI=postgresql://…); these ALTERs must run for every
# backend, not only the historical SQLite docker-compose.prod.yml path.
if DATABASE_URI:
    from sqlalchemy import text

    def _migrate_add_column(conn, sql: str) -> None:
        # Each DDL must be its own transaction. On Postgres, one failed ALTER
        # (e.g. SQLite-only types like BLOB/DATETIME) aborts the connection; without
        # an explicit rollback every later ADD COLUMN — including leg_kind — is skipped.
        try:
            conn.execute(text(sql))
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            msg = str(e).lower()
            if any(
                s in msg
                for s in (
                    "already exists",
                    "duplicate column",
                    "duplicate column name",
                )
            ):
                return
            # Keep startup alive; log so silent schema drift is visible in Railway logs.
            print(f"Warning: schema migration skipped: {sql[:96]}… ({e})")

    _is_postgres = "postgres" in (DATABASE_URI or "").lower()
    # SQLite accepts BLOB/DATETIME; Postgres needs BYTEA/TIMESTAMP for raw ALTER.
    _blob = "BYTEA" if _is_postgres else "BLOB"
    _dt = "TIMESTAMP" if _is_postgres else "DATETIME"

    with app.app_context():
        db.create_all()
        try:
            with db.engine.connect() as conn:
                for col, typedef in [
                    ("condition_tree", "TEXT"),
                    ("to_chain", "VARCHAR(20)"),
                    ("from_chain", "VARCHAR(20)"),
                    ("vault_generation_id", "VARCHAR(100)"),
                    ("arm_strategy_id", "VARCHAR(120)"),
                    ("encrypted_result", _blob),
                    ("result_updated_at", _dt),
                    ("execution_error", "TEXT"),
                ]:
                    _migrate_add_column(
                        conn,
                        f"ALTER TABLE strategy ADD COLUMN {col} {typedef} DEFAULT ''",
                    )

                # Multi-leg (TWAP / RANGE_GRID) columns — proper NULL/0 defaults (not '').
                for col, typedef in [
                    ("leg_count", "INTEGER"),
                    ("interval_sec", "INTEGER"),
                    ("grid_levels", "INTEGER"),
                    ("max_slippage_bps", "INTEGER"),
                    ("start_delay_sec", "INTEGER"),
                    ("executed_count", "INTEGER DEFAULT 0"),
                    ("eval_mode", "VARCHAR(10)"),
                    ("schedule_anchor", "INTEGER"),
                    ("execution_window_sec", "INTEGER"),
                    ("poly_meta", "TEXT"),
                    ("hl_meta", "TEXT"),
                    ("billing_ref", "VARCHAR"),
                ]:
                    _migrate_add_column(
                        conn, f"ALTER TABLE strategy ADD COLUMN {col} {typedef}"
                    )

                # Strategy payouts (output_mode='bridge'): the destination, and the order it fired.
                for _sql in (
                    "ALTER TABLE strategy ADD COLUMN payout TEXT",
                    "ALTER TABLE bridge_orders ADD COLUMN strategy_id VARCHAR",
                    # Devnet settlement records (solana_devnet_strategy._record).
                    "ALTER TABLE strategy ADD COLUMN settlement TEXT",
                    "ALTER TABLE strategy_legs ADD COLUMN settlement TEXT",
                ):
                    _migrate_add_column(conn, _sql)

                # Per-leg vault-output precommitment (output_mode='vault').
                _migrate_add_column(
                    conn,
                    "ALTER TABLE strategy_legs ADD COLUMN output_precommitment VARCHAR",
                )

                # Bounded fire-time prove retries for v3 enclave-armed legs (see StrategyLeg).
                _migrate_add_column(
                    conn,
                    "ALTER TABLE strategy_legs ADD COLUMN prove_attempts INTEGER DEFAULT 0",
                )

                # Sequential private multi-hop (PIPELINE) vs TWAP/grid parallel legs.
                _migrate_add_column(
                    conn,
                    "ALTER TABLE strategy_legs ADD COLUMN leg_kind VARCHAR(20)",
                )

                # Same counter for enclave-armed SINGLE-leg strategies, which have no leg row.
                _migrate_add_column(
                    conn,
                    "ALTER TABLE strategy ADD COLUMN prove_attempts INTEGER DEFAULT 0",
                )

                # Decrypt-time key-consistency canary (hex encrypt(0) under the user's ClientKey).
                _migrate_add_column(
                    conn, "ALTER TABLE user_fhe_keys ADD COLUMN canary VARCHAR"
                )

                # Wallet-wrapped ClientKey (FHE popup reduction).
                for _col, _type in (
                    ("enc_client_key", "TEXT"),
                    ("client_key_iv", "VARCHAR"),
                    ("client_key_fp", "VARCHAR"),
                    ("client_key_v", "INTEGER"),
                ):
                    _migrate_add_column(
                        conn,
                        f"ALTER TABLE user_fhe_keys ADD COLUMN {_col} {_type}",
                    )

                # A confirmed arming-fee transfer can fund only one strategy. The partial unique
                # index preserves NULL/non-arming execution-fee rows while making replay races
                # impossible at the database boundary.
                try:
                    conn.execute(
                        text(
                            "CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_accruals_arming_tx_hash "
                            "ON fee_accruals(tx_hash) "
                            "WHERE kind = 'arming' AND tx_hash IS NOT NULL"
                        )
                    )
                    conn.commit()
                except Exception as e:
                    print(f"Warning: fee_accruals unique index migration skipped: {e}")

                # Migrate notes.spent from boolean (0/1) to string ('false'/'true'/'pending')
                try:
                    conn.execute(
                        text(
                            "UPDATE notes SET spent = 'true' WHERE spent = '1' OR spent = 'True'"
                        )
                    )
                    conn.execute(
                        text(
                            "UPDATE notes SET spent = 'false' "
                            "WHERE spent = '0' OR spent = 'False' OR spent = ''"
                        )
                    )
                    conn.commit()
                except Exception:
                    pass
        except Exception as e:
            print(f"Warning: Could not apply schema migrations: {e}")

# SQLite concurrency: DELETE journal + per-connection busy_timeout (not WAL).
if DATABASE_URI and "sqlite" in DATABASE_URI:
    from sqlalchemy import event, text

    # DELETE journal mode — WAL's -wal/-shm sidecar files are unreliable on
    # this Docker volume and cause "disk I/O error" / "database disk image is
    # malformed" corruption under concurrent access. Do NOT switch to WAL here.
    #
    # The real fix for the "database is locked" 500s is a reliable PER-CONNECTION
    # busy_timeout: NullPool opens a fresh connection on every checkout, so a
    # one-time startup PRAGMA doesn't stick. We set it via a connect-event
    # listener so every connection waits (up to 30s) for a lock instead of
    # failing immediately. DELETE mode + per-connection busy_timeout handles the
    # scheduler-thread vs web-worker contention without WAL's corruption risk.
    @event.listens_for(db.engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _connection_record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=DELETE")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()

    try:
        with app.app_context():
            with db.engine.connect() as conn:
                conn.execute(text("PRAGMA journal_mode=DELETE"))
                conn.execute(text("PRAGMA busy_timeout=30000"))
                conn.execute(text("PRAGMA synchronous=NORMAL"))
                conn.commit()
    except Exception as e:
        print(f"Warning: Could not set SQLite PRAGMA: {e}")

# Health check endpoint (no auth required)
@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "healthy", "service": "trade-executor"}), 200


@app.route('/solana/fundBase/plan', methods=['POST'])
@rate_limit(max_requests=20, window_seconds=60, bucket="solana_fund_base")
def solana_fund_base_plan():
    """Solana wallet USDC → Base/Arbitrum vault fund plan (wrapper cut)."""
    data = request.get_json(silent=True) or {}
    required = ("from_chain_id", "amount", "asset", "recipient", "solana_owner")
    missing = [field for field in required if data.get(field) in (None, "")]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400
    try:
        from intent_bridge import execute_wallet_fund_hop
        from solana_runtime import SOLANA_CHAIN_IDS

        from_cid = int(data["from_chain_id"])
        to_cid = int(data.get("to_chain_id") or 8453)
        if from_cid not in SOLANA_CHAIN_IDS:
            return jsonify({"error": f"from_chain_id must be Solana; got {from_cid}"}), 400
        valid, err = validate_recipient(str(data["recipient"]), str(to_cid))
        if not valid:
            return jsonify({"error": err}), 400
        result = execute_wallet_fund_hop(
            from_chain_id=from_cid,
            to_chain_id=to_cid,
            amount=data["amount"],
            asset=data["asset"],
            recipient=data["recipient"],
            solana_owner=data["solana_owner"],
            mint=data.get("mint"),
            bridge_adapter=data.get("bridge_adapter", "lifi"),
        )
        return jsonify(result), 202 if result.get("pending") else 200
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route('/vault/bridge/plan', methods=['POST'])
@rate_limit(max_requests=20, window_seconds=60, bucket="vault_bridge_plan")
def vault_bridge_plan():
    """Quote Base↔Arbitrum vault Li.Fi hop (USDC/ETH). Source executor must hold the asset."""
    data = request.get_json(silent=True) or {}
    required = ("from_chain_id", "to_chain_id", "amount", "asset", "recipient")
    missing = [field for field in required if data.get(field) in (None, "")]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400
    try:
        from vault_bridge import plan_vault_bridge
        from evm_executor import get_web3, get_executor_account

        from_cid = int(data["from_chain_id"])
        to_cid = int(data["to_chain_id"])
        recipient = str(data["recipient"]).strip()
        valid, err = validate_recipient(recipient, str(to_cid))
        if not valid:
            return jsonify({"error": err}), 400
        w3 = get_web3(from_cid)
        account = get_executor_account(w3, from_cid)
        from_address = str(data.get("from_address") or account.address).strip()
        result = plan_vault_bridge(
            from_chain_id=from_cid,
            to_chain_id=to_cid,
            amount=int(data["amount"]),
            asset=str(data["asset"]),
            from_address=from_address,
            recipient=recipient,
        )
        return jsonify(result), 200
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route('/vault/bridge/execute', methods=['POST'])
@rate_limit(max_requests=10, window_seconds=60, bucket="vault_bridge_exec")
@require_admin
def vault_bridge_execute():
    """Operator-only: bridge `amount` out of the executor's OWN wallet.

    Nothing ties the amount to a payout, so open to users this drained the float to any recipient.
    Users go through /bridgeWithdraw, which only ever bridges what its own spend paid in.
    """
    data = request.get_json(silent=True) or {}
    required = ("from_chain_id", "to_chain_id", "amount", "asset", "recipient")
    missing = [field for field in required if data.get(field) in (None, "")]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400
    try:
        from vault_bridge import execute_vault_bridge

        to_cid = int(data["to_chain_id"])
        recipient = str(data["recipient"]).strip()
        valid, err = validate_recipient(recipient, str(to_cid))
        if not valid:
            return jsonify({"error": err}), 400
        timeout = int(data.get("timeout") or 600)
        result = execute_vault_bridge(
            from_chain_id=int(data["from_chain_id"]),
            to_chain_id=to_cid,
            amount=int(data["amount"]),
            asset=str(data["asset"]),
            recipient=recipient,
            timeout=max(60, min(timeout, 900)),
        )
        return jsonify(result), 200
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route('/solana/devnetBridge/plan', methods=['POST'])
@rate_limit(max_requests=20, window_seconds=60, bucket="solana_devnet_bridge")
def solana_devnet_bridge_plan():
    """Plan Devnet USDC → Sepolia test-USDC mint (no mint)."""
    data = request.get_json(silent=True) or {}
    try:
        from solana_devnet_bridge import describe_devnet_bridge_plan

        amount = int(data.get("amount") or data.get("usdc_amount") or 0)
        result = describe_devnet_bridge_plan(
            amount=amount,
            solana_owner=str(data.get("solana_owner") or ""),
            recipient=str(data.get("recipient") or ""),
        )
        return jsonify(result), 202
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400


@app.route('/solana/devnetBridge/execute', methods=['POST'])
@rate_limit(max_requests=10, window_seconds=60, bucket="solana_devnet_bridge_exec")
def solana_devnet_bridge_execute():
    """Legacy Sepolia test-USDC credit (not the Devnet native vault deposit path)."""
    data = request.get_json(silent=True) or {}
    try:
        from solana_devnet_bridge import execute_devnet_bridge_mint

        amount = int(data.get("amount") or data.get("usdc_amount") or 0)
        result = execute_devnet_bridge_mint(
            amount=amount,
            solana_owner=str(data.get("solana_owner") or ""),
            recipient=str(data.get("recipient") or ""),
        )
        code = 200 if result.get("ok") else 202
        return jsonify(result), code
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route('/solana/deposit/confirm', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60, bucket="solana_deposit_confirm")
def solana_deposit_confirm():
    """Confirm a Solana Devnet vault deposit tx (thin RPC check)."""
    data = request.get_json(silent=True) or {}
    try:
        from solana_runtime import confirm_solana_deposit, describe_solana_runtime

        sig = str(data.get("signature") or data.get("tx") or "")
        if not sig:
            return jsonify({"error": "signature required", "runtime": describe_solana_runtime()}), 400
        result = confirm_solana_deposit(sig)
        code = 200 if result.get("ok") else 202
        return jsonify(result), code
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route('/solana/settlement', methods=['GET'])
@rate_limit(max_requests=60, window_seconds=60, bucket="solana_settlement")
def solana_settlement():
    """Public settlement wallet + Devnet venue metadata the browser proves a spend against."""
    try:
        from solana_devnet_strategy import (
            settlement_pubkey,
            JL_USDC_MINT,
            EARN_ASSET_MINT,
            LENDING_PROGRAM,
            JITO_SOL_MINT,
            JITO_STAKE_POOL,
        )
        pubkey = settlement_pubkey()
    except Exception as exc:
        return jsonify({"error": str(exc)}), 503
    pool = (os.getenv("METEORA_POOL") or "").strip()
    jl_pool = (os.getenv("METEORA_JLUSDC_SOL_POOL") or "").strip()
    jito_pool = (os.getenv("METEORA_JITOSOL_SOL_POOL") or "").strip()
    usdc = (
        os.getenv("SOLANA_USDC_MINT")
        or os.getenv("NEXT_PUBLIC_SOLANA_USDC_MINT")
        or EARN_ASSET_MINT
    )
    body = {
        "pubkey": pubkey,
        "usdcMint": usdc,
        "jlUsdcMint": JL_USDC_MINT,
        "jitoSolMint": JITO_SOL_MINT,
        "jitoStakePool": JITO_STAKE_POOL,
        "lendingProgram": LENDING_PROGRAM,
        "assetMint": EARN_ASSET_MINT,
        "venues": ["meteora-dlmm", "jupiter-earn", "jito-stake"],
    }
    if jl_pool:
        body["meteoraJlUsdcSolPool"] = jl_pool
    if jito_pool:
        body["meteoraJitoSolPool"] = jito_pool
    if pool:
        body["meteoraPool"] = pool
        body["venue"] = "meteora-dlmm"
        body["programId"] = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
        return jsonify(body), 200
    # Earn/stake-only deployments may omit METEORA_POOL; still return settlement for lend/stake arms.
    body["venue"] = "jupiter-earn"
    body["meteoraPool"] = ""
    body["warning"] = "METEORA_POOL unset — Meteora swaps unavailable; Jupiter Earn / Jito stake ok."
    return jsonify(body), 200


@app.route('/solana/relayWithdraw', methods=['POST'])
@rate_limit(max_requests=10, window_seconds=60, bucket="solana_relay_withdraw")
@verify_wallet_write
def solana_relay_withdraw(wallet=None):
    """Devnet: submit the browser's ZK withdraw (or note split) from the settlement wallet. No
    Phantom popup, no fee — the relayer pays the network costs. A withdraw's proof binds the
    payee to `recipient`; a split pays no one."""
    data = request.get_json(silent=True) or {}
    pkg = data.get("package")
    recipient = str(data.get("recipient") or "").strip()
    split = isinstance(pkg, dict) and isinstance(pkg.get("split_commitments_hex"), list)
    if not isinstance(pkg, dict) or not (recipient or split):
        return jsonify({"error": "package and recipient are required"}), 400
    if recipient:
        try:
            from solders.pubkey import Pubkey
            Pubkey.from_string(recipient)
        except Exception:
            return jsonify({"error": "recipient is not a Solana address"}), 400
    from solana_devnet_strategy import relay_withdraw
    result = relay_withdraw(pkg, None if split else recipient)
    if result.get("ok"):
        return jsonify(result), 200
    code = result.get("code")
    status = 400 if code == "BAD_PACKAGE" else 409 if code in ("NEEDS_REPROOF", "SPENT") else 502
    return jsonify(result), status


@app.route('/auth/challenge', methods=['POST'])
@rate_limit(max_requests=60, window_seconds=60, bucket="auth_challenge")
def auth_challenge():
    """Issue a single-use nonce for write authentication.

    Body: {"chain_id": <int>}. The client signs `Siphon auth v2:write:<chain_id>:<nonce>` — built
    from the chain IT intends, never from text the server returns — and sends X-Wallet-Address,
    X-Write-Signature, X-Write-Nonce on mutating routes. The chain must be one this executor serves
    (WRITE_AUTH_CHAIN_IDS), so a signature made for one host cannot be replayed at another.
    """
    body = request.get_json(silent=True) or {}
    chain_id = body.get("chain_id") if isinstance(body, dict) else None
    try:
        return jsonify(create_challenge_payload(chain_id)), 200
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route('/auth/tag-bind', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60, bucket="tag_bind")
@verify_wallet_sig
def auth_tag_bind(wallet=None):
    """Pin a tag auth token (sha256). First bind only — re-bind with a different token is rejected.

    Uses long-lived wallet read auth (Siphon auth v1:<ts>) so connect UX does not need an
    extra write-challenge popup. Token is still wallet-bound (v2); unbound sig alone cannot
    forge X-Auth-Token.
    """
    from wallet_auth import _upsert_tag_verifier, _hash_id, _audit, _lookup_tag_verifier, _token_hash
    import hmac as hmac_lib

    tag = (request.headers.get("X-Tag") or "").lower()
    auth_token = (request.headers.get("X-Auth-Token") or "").lower()
    if not tag or not auth_token or len(auth_token) < 32:
        return jsonify({"error": "X-Tag and X-Auth-Token required"}), 400

    existing = _lookup_tag_verifier(tag)
    if existing is not None:
        if hmac_lib.compare_digest(existing.token_hash, _token_hash(auth_token)):
            return jsonify({"status": "ok", "tag_bound": True, "already_bound": True}), 200
        return jsonify({"error": "tag already bound to a different token"}), 409

    try:
        _upsert_tag_verifier(tag, auth_token)
    except PermissionError as e:
        return jsonify({"error": str(e)}), 409
    except Exception as e:
        return jsonify({"error": f"bind failed: {e}"}), 500
    _audit("tag_bind_route", wallet_hash=_hash_id(wallet or ""), tag_hash=_hash_id(tag))
    return jsonify({"status": "ok", "tag_bound": True}), 200

_scheduler_started = threading.Lock()
_scheduler_running = {"started": False}


def start_scheduler():
    """Start the background scheduler thread EXACTLY ONCE per process.

    The scheduler must run in exactly one place. Two concurrent scheduler loops
    will both pick up the same ARMED+triggered strategy, both call run_execution(),
    and both attempt the same ZK withdraw with the same nullifier -> one succeeds
    on-chain, the other reverts NullifierAlreadySpent().

    Why this used to start twice:
      1. entrypoint.sh runs `python init_db.py`, which does `from app import app`,
         executing this module top-to-bottom and starting a scheduler thread in the
         (short-lived) init process.
      2. gunicorn `--preload app:app` imports this module again in the MASTER process,
         starting another scheduler thread in the master.
    Starting the scheduler at import time means every importer (init_db, the gunicorn
    master, any worker) gets its own loop.

    Fix: never start at import time. We start the scheduler from gunicorn's
    `post_fork` hook (see gunicorn.conf.py) so it runs once, inside the single sync
    worker that actually owns the shared DB session. For the dev `python app.py`
    path we start it from the __main__ block. A per-process guard + lock makes a
    double-call a no-op.
    """
    with _scheduler_started:
        if _scheduler_running["started"]:
            print("--- Scheduler already running in this process; skipping ---")
            return
        _scheduler_running["started"] = True
        print("--- Starting the background scheduler thread ---")
        scheduler_thread = threading.Thread(target=worker_loop, args=(app,), daemon=True)
        scheduler_thread.start()

@app.route('/createStrategy', methods=['POST'])
@rate_limit(max_requests=50, window_seconds=60, bucket="create_strategy")
@require_siphon_user_api_key
@reject_api_token_on_user_routes
@verify_strategy_sig
@verify_wallet_write
def create_strategy(wallet=None):
    data = request.json
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400
    if not _wallet_authorizes(wallet, data.get('user_id')):
        return jsonify({"error": "wallet signature does not match user_id"}), 403

    try:
        strategy_type = data.get("strategy_type", "")
        if strategy_type == "POLYMARKET" and os.getenv("POLYMARKET_ENABLED", "0").lower() not in (
            "1", "true", "yes"
        ):
            return jsonify({
                "error": "Polymarket strategies are not enabled",
                "code": "POLYMARKET_DISABLED",
            }), 503
        if strategy_type == "HYPERLIQUID":
            import hyperliquid_client
            refusal = hyperliquid_client.prepare_strategy(data)
            if refusal:
                return jsonify(refusal[0]), refusal[1]
        token_symbol = data.get('asset_in') if "LONG" in strategy_type or "SELL" in strategy_type else data.get('asset_out')

        # Validate recipient address matches destination chain
        to_chain = data.get('to_chain', '8453')
        from_chain = str(data.get('from_chain', '8453'))
        recipient = data.get('recipient_address', '')
        valid, err = validate_recipient(recipient, str(to_chain))
        if not valid:
            return jsonify({"error": err}), 400

        # Hard ASP: membership check is ephemeral — never store note_label on Strategy.
        note_label = data.get("note_label") or data.get("label")
        try:
            _from_cid_asp = int(from_chain)
        except (TypeError, ValueError):
            _from_cid_asp = 0
        if _from_cid_asp != 900_002:
            if note_label is not None and str(note_label).strip() != "":
                ok_label, label_err = validate_note_label(note_label, chain_id=from_chain)
                # Drop plaintext label from request dict so it is not logged / re-serialized later.
                data.pop("note_label", None)
                data.pop("label", None)
                if not ok_label:
                    # The reason names the set state, never the label — the caller already knows its
                    # own label, and "rejected" with no reason cost a full round of debugging once.
                    return jsonify({"error": "ASP label rejected", "reason": label_err}), 403
            elif os.getenv("ASP_REQUIRE_NOTE_LABEL", "1").lower() not in ("0", "false", "no"):
                return jsonify({"error": "note_label required for Hard ASP arming"}), 400
        else:
            data.pop("note_label", None)
            data.pop("label", None)

        try:
            if int(from_chain) not in SUPPORTED_EXECUTOR_CHAIN_IDS:
                return jsonify({
                    "error": f"from_chain {from_chain} is not supported by the executor. "
                             f"Supported: {sorted(SUPPORTED_EXECUTOR_CHAIN_IDS)}"
                }), 400
        except (TypeError, ValueError):
            return jsonify({"error": f"Invalid from_chain: {from_chain}"}), 400

        # The caller identifies its proof generation, but only the server-owned active-generation
        # setting can make that generation strategy-capable. Reject before FHE work or fee collection.
        #
        # Attested v3 arms are exempt — see vault_generation.is_attested_strategy for why that is
        # not a relaxation. The client injects `vault_generation_id` from its own network config
        # (strategySubmit.ts) on every chain, so a v3 arm arrives naming the RETIRED v1 generation
        # and was rejected with "these funds are in an older vault" while sitting in the kernel.
        from vault_generation import generation_decision, is_attested_strategy, strategy_generation_message
        # Solana Devnet (900002) settles a ZK spend on Meteora — no EVM vault generation.
        solana_devnet = False
        try:
            solana_devnet = int(from_chain) == 900_002
        except (TypeError, ValueError):
            solana_devnet = False
        generation_result = {"ok": True, "code": None} if solana_devnet else generation_decision(data)

        # An attested strategy's legs are already sealed in the enclave under an id the BROWSER
        # chose — it had to arm before this row existed to give it one. Without that id we can
        # never find the leg again, and the strategy sits PENDING until it expires with the arming
        # fee already paid. Refuse now, while the client can still fix it.
        arm_strategy_id = str(data.get("arm_strategy_id") or "").strip() or None
        if is_attested_strategy(data) and not arm_strategy_id:
            return jsonify({
                "error": "arm_strategy_id is required for an enclave-armed strategy",
                "hint": "send the id the legs were armed under (POST /spend/arm strategyId)",
            }), 400

        if not generation_result["ok"]:
            code = generation_result["code"]
            return jsonify({"error": strategy_generation_message(code), "code": code}), 409

        # Admin allow-list gate: on gated chains (e.g. ETH Sepolia) only allow-listed wallets
        # may create strategies. The wallet is the strategy owner (user_id), falling back to the
        # recipient address. Applies if either the source or destination chain is gated.
        gate_wallet = (data.get('user_id') or recipient or '')
        for gated_cid in {c for c in (from_chain, to_chain) if chain_is_gated(c)}:
            if not is_wallet_allowed(gate_wallet, gated_cid):
                return jsonify({
                    "error": f"Wallet {gate_wallet or '(none)'} is not allow-listed for chain "
                             f"{int(gated_cid)}. This chain is restricted to admin wallets."
                }), 403

        # Client-side FHE: bounds are encrypted in the browser; the user's server key must have
        # been uploaded once via /uploadServerKey. The client key never reaches us.
        if not get_server_key(data['user_id']):
            return jsonify({"error": "No FHE server key on file for this user. Upload it via /uploadServerKey first."}), 400

        verified_arming = None
        # Solana Devnet settles on Meteora — no EVM arming-fee rail.
        if fee_cfg.FEE_ENABLED and not solana_devnet:
            from arming_fee import verify_arming_transfer
            from database import FeeAccrual
            try:
                verified_arming = verify_arming_transfer(data, wallet)
            except Exception as fee_error:
                return jsonify({"error": f"arming fee verification failed: {fee_error}"}), 402
            if FeeAccrual.query.filter_by(
                kind='arming', tx_hash=verified_arming['tx_hash']
            ).first():
                return jsonify({"error": "arming fee transaction was already used"}), 409

        # Support condition_tree (new) OR legacy upper/lower bound (old)
        condition_tree = data.get('condition_tree')

        # Multi-leg strategies (TWAP / DCA / RANGE_GRID) carry a `legs` array: each leg is an
        # independent shielded sub-trade with its own slice-note ZK proof + encrypted trigger.
        # DCA = N equal time-scheduled buys, identical mechanics to TWAP (encrypted fire-times).
        legs = data.get('legs') or []
        # Leg cap (pricing sheet, Definitions). One arming + one window fee covers the whole
        # strategy however many legs it holds, so the cap is what bounds the compute that buys.
        # Rejecting here leaves the arming tx unrecorded, so the same payment can be reused on a
        # corrected strategy.
        if len(legs) > fee_cfg.MAX_LEGS:
            return jsonify({
                "error": f"strategy has {len(legs)} legs; the cap is {fee_cfg.MAX_LEGS} per strategy"
            }), 400
        is_pipeline = strategy_type == 'PIPELINE' and len(legs) > 0
        is_multi_leg = (strategy_type in ('TWAP', 'DCA', 'RANGE_GRID') and len(legs) > 0) or is_pipeline

        # Payout to another chain: the enclave-armed leg withdraws to this executor and the fired
        # leg's receipt funds a bridge order (executor_runner). Single enclave-armed orders only —
        # multi-leg payouts would need one order per leg.
        payout = None
        if data.get('output_mode') == 'bridge' or data.get('payout'):
            import bridge_payout
            if data.get('output_mode') != 'bridge' or legs or not is_attested_strategy(data):
                return jsonify({"error": "a payout needs output_mode 'bridge' on a single "
                                         "enclave-armed order"}), 400
            try:
                bridge_payout.source_token(int(from_chain), data.get('asset_in'))
                payout = bridge_payout.parse_payout(data.get('payout'), int(from_chain))
            except (TypeError, ValueError, RuntimeError) as exc:
                return jsonify({"error": f"payout: {exc}"}), 400
            why = bridge_payout.screen_order(payout, int(from_chain))
            if why:
                return jsonify({"error": f"payout {why}"}), 403
        # 'time' for TWAP/DCA, 'price' for grid, 'pipeline' for sequential multi-hop.
        eval_mode = (
            'pipeline' if is_pipeline else
            'time' if strategy_type in ('TWAP', 'DCA') else
            ('price' if strategy_type == 'RANGE_GRID' else None)
        )

        # Pack the client Groth16 spend. The executor submits it; it never sees note secrets.
        zkp_payload = data.get('zkp_data') or data.get('zk_proof') or {}
        if isinstance(zkp_payload, str):
            try:
                zkp_payload = json.loads(zkp_payload)
            except Exception:
                zkp_payload = {}
        if not isinstance(zkp_payload, dict):
            zkp_payload = {}
        if solana_devnet:
            from solana_devnet_strategy import (
                settlement_pubkey,
                validate_devnet_zk_package,
                validate_pipeline_hop_skeleton,
                JL_USDC_MINT,
                EARN_ASSET_MINT,
                LENDING_PROGRAM,
                JITO_SOL_MINT,
                JITO_STAKE_POOL,
            )
            try:
                settle_wallet = settlement_pubkey()
            except Exception as exc:
                return jsonify({"error": f"Devnet settlement wallet not configured: {exc}"}), 503
            vault_out = (data.get('output_mode') or 'address') == 'vault'
            pool_env = (os.getenv("METEORA_POOL") or "").strip()
            jl_pool_env = (os.getenv("METEORA_JLUSDC_SOL_POOL") or "").strip()
            jito_pool_env = (os.getenv("METEORA_JITOSOL_SOL_POOL") or "").strip()

            def _devnet_package(pkg):
                """Normalise one Devnet package (Meteora / Earn / Jito) and validate it."""
                pkg.pop("solana_note_pda", None)
                venue = str(pkg.get("venue") or "").strip() or "meteora-dlmm"
                pkg["venue"] = venue
                if venue == "jupiter-earn":
                    pkg.setdefault("asset_mint", EARN_ASSET_MINT)
                    pkg.setdefault("jl_token_mint", JL_USDC_MINT)
                    pkg.setdefault("lending_program", LENDING_PROGRAM)
                    if not pkg.get("action"):
                        st = str(data.get("strategy_type") or "").upper()
                        pkg["action"] = "exit" if "EXIT" in st else "enter"
                elif venue == "jito-stake":
                    pkg.setdefault("jito_sol_mint", JITO_SOL_MINT)
                    pkg.setdefault("stake_pool", JITO_STAKE_POOL)
                    if not pkg.get("action"):
                        st = str(data.get("strategy_type") or "").upper()
                        pkg["action"] = "exit" if "EXIT" in st or "UNSTAKE" in st else "enter"
                else:
                    pkg["venue"] = "meteora-dlmm"
                    for key in ("solana_side", "solana_mint", "solana_usdc_mint", "meteora_pair"):
                        if data.get(key):
                            pkg[key] = data.get(key)
                    pair = str(pkg.get("meteora_pair") or "").strip().lower()
                    if not pkg.get("meteora_pool"):
                        if pair in ("jlusdc_sol", "jl_usdc_sol") and jl_pool_env:
                            pkg["meteora_pool"] = jl_pool_env
                        elif pair in ("jitosol_sol", "jito_sol") and jito_pool_env:
                            pkg["meteora_pool"] = jito_pool_env
                        elif pool_env:
                            pkg["meteora_pool"] = pool_env
                return validate_devnet_zk_package(pkg, settlement=settle_wallet, vault_output=vault_out)

            # Multi-leg / pipeline: one package per leg. Pipeline hop 0 is fully proved in the
            # browser; hops 1..N carry venue skeletons only (TEE proves after the prior return).
            packages = ([(leg.get('zk_proof') or leg.get('zkp_data') or {}) for leg in legs]
                        if is_multi_leg else [zkp_payload])
            for i, pkg in enumerate(packages):
                if not isinstance(pkg, dict):
                    pkg_err = "zkp_data must be an object"
                elif is_pipeline and i > 0:
                    pkg_err = validate_pipeline_hop_skeleton(pkg)
                else:
                    pkg_err = _devnet_package(pkg)
                if pkg_err:
                    where = f"leg {i}: " if is_multi_leg else ""
                    return jsonify({
                        "error": where + pkg_err,
                        "hint": "prove a ZK spend to the settlement wallet; venue=meteora-dlmm, jupiter-earn, or jito-stake",
                    }), 400
            if is_pipeline:
                sealed = data.get("pipeline_sealed") or data.get("sealed_bundle")
                if not sealed:
                    return jsonify({"error": "PIPELINE requires pipeline_sealed (attestAndSeal of PipelineNoteBundle)"}), 400
                # Parent meta: sealed secrets + hop cursor. Per-leg proofs live on StrategyLeg.
                zkp_payload = {
                    "pipeline": True,
                    "sealed_bundle": sealed,
                    "hop_cursor": 0,
                    "hop_count": len(legs),
                }
            elif is_multi_leg:
                zkp_payload = {}

        new_strategy = Strategy(
            user_id=data['user_id'],
            strategy_type=strategy_type,
            asset_in=data['asset_in'],
            asset_out=data['asset_out'],
            amount=data['amount'],
            price_feed_id=data.get('price_feed_id'),  # e.g. 'polymarket:<token_id>' for POLYMARKET
            billing_ref=data.get('billing_ref'),
            recipient_address=recipient,

            encrypted_upper_bound=data.get('encrypted_upper_bound'),
            encrypted_lower_bound=data.get('encrypted_lower_bound'),
            zkp_data=json.dumps(zkp_payload) if zkp_payload else None,
            condition_tree=json.dumps(condition_tree) if condition_tree else None,
            to_chain=str(to_chain),
            from_chain=from_chain,
            vault_generation_id=generation_result.get("generation_id"),
            arm_strategy_id=arm_strategy_id,
            output_mode=data.get('output_mode', 'address'),
            output_precommitment=data.get('output_precommitment'),
            payout=json.dumps(payout) if payout else None,
            # multi-leg schedule/ladder metadata
            leg_count=(len(legs) if is_multi_leg else None),
            interval_sec=data.get('interval_sec'),
            grid_levels=data.get('grid_levels'),
            max_slippage_bps=data.get('max_slippage_bps'),
            start_delay_sec=data.get('start_delay_sec'),
            executed_count=0,
            eval_mode=eval_mode,
            schedule_anchor=data.get('schedule_anchor'),
            execution_window_sec=data.get('execution_window_sec'),
            # POLYMARKET order params (market_id, token_id, outcome, side, entry_odds).
            poly_meta=json.dumps(data.get('poly_meta')) if data.get('poly_meta') else None,
            # HYPERLIQUID order params (coin, side, leverage, TP/SL, trigger_dir).
            hl_meta=json.dumps(data.get('hl_meta')) if data.get('hl_meta') else None,
        )

        db.session.add(new_strategy)
        db.session.flush()  # assign new_strategy.id before inserting child legs

        # Persist each leg as a StrategyLeg row. Each leg carries its own per-leg withdrawal
        # proof (zk_proof) and encrypted trigger bound. Missing/partial legs are rejected so a
        # multi-leg order can never silently degrade to fewer legs.
        if is_multi_leg:
            for i, leg in enumerate(legs):
                leg_proof = leg.get('zk_proof') or leg.get('zkp_data')
                nh = None
                if isinstance(leg_proof, dict):
                    nhs = (leg_proof.get('nullifierHashes') or leg_proof.get('nullifier_hashes')
                           or leg_proof.get('nullifiers_hex'))
                    if isinstance(nhs, list) and nhs:
                        nh = str(nhs[0])
                    elif leg_proof.get('nullifierHash') is not None:
                        nh = str(leg_proof.get('nullifierHash'))
                # Pipeline: only hop 0 is triggerable; hops 1..N wait (QUEUED) until prior EXECUTED.
                if is_pipeline:
                    leg_status = 'PENDING' if i == 0 else 'QUEUED'
                    leg_eval = leg.get('eval_mode') or ('price' if i == 0 else 'pipeline')
                    leg_kind = 'pipeline'
                    # Hop 0 may carry the FHE trigger; client often encrypts on the parent only.
                    enc_u = leg.get('encrypted_upper_bound') or (data.get('encrypted_upper_bound') if i == 0 else None)
                    enc_l = leg.get('encrypted_lower_bound') or (data.get('encrypted_lower_bound') if i == 0 else None)
                else:
                    leg_status = 'PENDING'
                    leg_eval = leg.get('eval_mode', eval_mode or 'price')
                    leg_kind = None
                    enc_u = leg.get('encrypted_upper_bound')
                    enc_l = leg.get('encrypted_lower_bound')
                db.session.add(StrategyLeg(
                    strategy_id=new_strategy.id,
                    leg_index=leg.get('leg_index', i),
                    amount=leg['amount'],
                    side=leg.get('side'),
                    eval_mode=leg_eval,
                    # target_price deliberately NOT persisted: the rung price must exist only inside
                    # the encrypted band. Storing it plaintext next to the ciphertext defeated the
                    # FHE threshold privacy against anyone with DB access. Nothing reads it.
                    encrypted_upper_bound=enc_u,
                    encrypted_lower_bound=enc_l,
                    zkp_data=json.dumps(leg_proof) if leg_proof else None,
                    nullifier_hash=nh,
                    output_precommitment=leg.get('output_precommitment'),
                    leg_kind=leg_kind,
                    status=leg_status,
                ))

        # Part A is a confirmed direct USDC transfer to the executor. Record the exact tx hash so
        # it cannot be replayed for another strategy. `swept=True` is retained as the historical
        # ledger flag for "no further automated movement required".
        if verified_arming:
            from database import FeeAccrual
            from arming_fee import ARMING_ONLY_USDC_WEI
            paid = int(verified_arming['amount_wei'])
            # One transfer, two priced legs — record them separately so the fee report can show
            # what the pricing sheet charges instead of one opaque lump. Any surplus (the payer
            # may overpay across the window-fee cutover) lands on the window leg, which is the
            # variable one. The replay guard is the partial unique index on kind='arming', so the
            # second row sharing this tx_hash is fine and the arming leg stays unique.
            arming_wei = min(paid, ARMING_ONLY_USDC_WEI)
            common = dict(chain_id=verified_arming['chain_id'], asset='USDC',
                          strategy_id=new_strategy.id, tx_hash=verified_arming['tx_hash'],
                          swept=True)
            db.session.add(FeeAccrual(amount_wei=str(arming_wei), kind='arming', **common))
            if paid > arming_wei:
                db.session.add(FeeAccrual(amount_wei=str(paid - arming_wei), kind='window', **common))

        db.session.commit()

        # Devnet: settle at once only for an order that asks to (a market/quick swap). A resting
        # order waits for its trigger — the env flag alone used to fire every order at arm time.
        auto_exec = None
        if solana_devnet and data.get('execute_now') and os.getenv(
            "SOLANA_DEVNET_AUTO_EXECUTE", "0").strip().lower() in ("1", "true", "yes", "on"):
            try:
                if is_pipeline:
                    from executor_runner import run_leg_execution
                    hop0 = StrategyLeg.query.filter_by(
                        strategy_id=new_strategy.id, leg_index=0).first()
                    if hop0 is None:
                        raise RuntimeError("PIPELINE missing hop 0")
                    # Leave PENDING so run_leg_execution's _claim_leg (PENDING|ARMED→EXECUTING)
                    # can win. Pre-setting EXECUTING made claim fail and aborted hop 0.
                    auto_exec = run_leg_execution(
                        hop0.to_dict(), new_strategy.to_dict(), current_price=0)
                else:
                    from executor_runner import run_execution
                    auto_exec = run_execution(new_strategy.to_dict(), current_price=0)
                print(f"[createStrategy] Solana Devnet auto-execute {new_strategy.id}: {auto_exec}")
                # A market order the pool cannot fill now ends here (nothing was sent) rather than
                # resting with the user's note reserved until liquidity appears.
                if isinstance(auto_exec, dict) and auto_exec.get("status") == "NO_ROUTE":
                    row = Strategy.query.get(new_strategy.id)
                    if row is not None and row.status == "ARMED":
                        row.status = "FAILED"
                        db.session.commit()
                    auto_exec = {**auto_exec, "status": "FAILED"}
            except Exception as auto_err:
                print(f"[createStrategy] Solana Devnet auto-execute failed: {auto_err}")
                auto_exec = {"status": "FAILED", "error": str(auto_err)}

        return jsonify({
            "status": "success",
            "strategy_id": new_strategy.id,
            "leg_count": new_strategy.leg_count,
            **({"auto_execute": auto_exec} if auto_exec is not None else {}),
        }), 201

    except Exception as e:
        print(f"Error creating strategy: {e}")
        db.session.rollback()
        return jsonify({"error": f"An unexpected error occurred: {e}"}), 500


# ----------------------- Admin wallet allow-list (gated chains) -----------------------
# All endpoints require the X-ADMIN-TOKEN header (ADMIN_API_TOKEN). Used to restrict gated
# chains (e.g. ETH Sepolia) to a managed set of wallets that may create/run strategies.

@app.route('/admin/wallets', methods=['GET'])
@require_admin
def admin_list_wallets():
    chain_id = request.args.get('chain_id')
    try:
        return jsonify({"wallets": list_wallets(chain_id)}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/admin/wallets', methods=['POST'])
@require_admin
def admin_add_wallet():
    data = request.json or {}
    address = data.get('address')
    chain_id = data.get('chain_id', 11155111)
    label = data.get('label')
    if not address:
        return jsonify({"error": "address is required"}), 400
    try:
        row = add_wallet(address, chain_id, label)
        return jsonify({"status": "success", "wallet": row}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500


@app.route('/admin/wallets', methods=['DELETE'])
@require_admin
def admin_remove_wallet():
    data = request.json or {}
    address = data.get('address')
    chain_id = data.get('chain_id', 11155111)
    if not address:
        return jsonify({"error": "address is required"}), 400
    try:
        removed = remove_wallet(address, chain_id)
        return jsonify({"status": "success", "removed": removed}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500


@app.route('/admin/fee-pool', methods=['POST'])
@require_admin
def admin_fee_pool():
    """Upload protocol fee-note precommitments (frontend-generated) for the fee-vault sweep.
    Body: { chain_id, asset, precommitments: [str,...] }. Idempotent on precommitment uniqueness."""
    from database import ProtocolFeeNote
    data = request.json or {}
    chain_id = data.get('chain_id', 11155111)
    asset = (data.get('asset') or 'ETH').upper()
    precs = data.get('precommitments') or []
    if not isinstance(precs, list) or not precs:
        return jsonify({"error": "precommitments[] required"}), 400
    added = 0
    for p in precs:
        try:
            if ProtocolFeeNote.query.filter_by(precommitment=str(p)).first():
                continue
            db.session.add(ProtocolFeeNote(chain_id=int(chain_id), asset=asset, precommitment=str(p)))
            added += 1
        except Exception:
            continue
    db.session.commit()
    avail = ProtocolFeeNote.query.filter_by(chain_id=int(chain_id), asset=asset, status='available').count()
    return jsonify({"status": "success", "added": added, "available": avail}), 200


@app.route('/fee-pool/next', methods=['GET'])
@rate_limit(max_requests=30, window_seconds=60, bucket="fee_pool_next")
@reject_api_token_on_user_routes
@verify_wallet_write
def fee_pool_next(wallet=None):
    """Serve one available protocol fee-note precommitment for an arming-fee slice and mark it
    'reserved'. Requires write challenge — not a public unauthenticated endpoint."""
    from database import ProtocolFeeNote
    from datetime import datetime, timedelta
    chain_id = int(request.args.get('chain_id', 11155111))
    asset = (request.args.get('asset') or 'ETH').upper()
    # Reclaim stale reservations (>10 min) before serving.
    try:
        stale = datetime.utcnow() - timedelta(minutes=10)
        ProtocolFeeNote.query.filter(
            ProtocolFeeNote.status == 'reserved', ProtocolFeeNote.used_at.is_(None),
            ProtocolFeeNote.created_at < stale,
        ).update({"status": "available"})
        db.session.commit()
    except Exception:
        db.session.rollback()
    note = ProtocolFeeNote.query.filter_by(chain_id=chain_id, asset=asset, status='available').first()
    if not note:
        return jsonify({"error": "fee pool empty", "precommitment": None}), 200
    note.status = 'reserved'
    db.session.commit()
    return jsonify({"precommitment": note.precommitment}), 200


@app.route('/admin/sweep-fees', methods=['POST'])
@require_admin
def admin_sweep_fees():
    """Manually trigger a fee-vault sweep for (chain_id, asset). Body: { chain_id, asset, price }."""
    from fee_sweep import sweep_fees
    data = request.json or {}
    chain_id = data.get('chain_id', 11155111)
    asset = (data.get('asset') or 'ETH').upper()
    price = data.get('price')
    try:
        result = sweep_fees(int(chain_id), asset, float(price) if price else None)
        return jsonify(result), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500


@app.route('/admin/fees', methods=['GET'])
@require_admin
def admin_fees():
    """Fee-accrual dashboard: total protocol fees taken to date, grouped by asset/kind and
    retention state, with a live USD valuation. Read-only. Optional ?strategy_id= to see one order."""
    from database import FeeAccrual
    from collections import defaultdict
    import oracle, config as _cfg, fee_config as fc

    q = FeeAccrual.query
    sid = request.args.get('strategy_id')
    if sid:
        q = q.filter_by(strategy_id=sid)
    # ?days=N windows the executor-side ledger, matching /admin/usage. The on-chain leg below is a
    # running balance with no per-period view, so it is reported in full whatever this says.
    try:
        days = int(request.args.get('days') or 0)
    except (TypeError, ValueError):
        days = 0
    if days > 0:
        from datetime import datetime as _dt, timedelta
        q = q.filter(FeeAccrual.created_at >= _dt.utcnow() - timedelta(days=days))
    rows = q.all()

    def decimals(asset):
        return 6 if asset.upper() in fc.STABLE_SYMBOLS else 18

    # Live USD per asset (stables = $1), best-effort — a price miss just omits USD for that asset.
    # The vault assets are always priced, not just the ones that happen to appear in the DB: the
    # on-chain withdrawal leg below is denominated in them and would otherwise go unvalued the
    # first time a withdrawal fee lands before any executor fee in the same asset.
    assets = {r.asset.upper() for r in rows} | {"ETH", "USDC"}
    prices = {a: 1.0 for a in assets if a in fc.STABLE_SYMBOLS}
    feed_ids = {a: _cfg.PYTH_PRICE_FEED_IDS[a] for a in assets
                if a not in fc.STABLE_SYMBOLS and a in _cfg.PYTH_PRICE_FEED_IDS}
    if feed_ids:
        try:
            live = oracle.get_live_prices(list(feed_ids.values()))  # {feed_id: price}
            for a, fid in feed_ids.items():
                if live.get(fid):
                    prices[a] = float(live[fid])
        except Exception as e:
            print(f"[Fee] admin_fees price fetch failed: {e}")

    groups = defaultdict(lambda: {"count": 0, "amount_wei": 0})
    for r in rows:
        g = groups[(r.chain_id, r.asset.upper(), r.kind, bool(r.swept))]
        g["count"] += 1
        g["amount_wei"] += int(r.amount_wei)

    chain_names = {8453: "base", 11155111: "sepolia", 42161: "arbitrum", 1: "ethereum", 137: "polygon"}
    by_group, usd_accrued, usd_swept = [], 0.0, 0.0
    per_chain = defaultdict(lambda: {"accrued": 0.0, "swept": 0.0, "count": 0})
    for (chain_id, asset, kind, swept), g in sorted(groups.items()):
        dec = decimals(asset)
        amount = g["amount_wei"] / (10 ** dec)
        usd = round(amount * prices[asset], 4) if asset in prices else None
        by_group.append({
            "chain_id": chain_id, "chain": chain_names.get(chain_id, str(chain_id)),
            "asset": asset, "kind": kind, "swept": swept,
            "count": g["count"], "amount_wei": str(g["amount_wei"]),
            "amount": round(amount, 8), "usd": usd,
        })
        pc = per_chain[chain_id]
        pc["count"] += g["count"]
        if usd is not None:
            usd_accrued += usd
            pc["accrued"] += usd
            if swept:
                usd_swept += usd
                pc["swept"] += usd

    by_chain = [{
        "chain_id": cid, "chain": chain_names.get(cid, str(cid)), "count": v["count"],
        "accrued_usd": round(v["accrued"], 4), "swept_usd": round(v["swept"], 4),
        "unswept_usd": round(v["accrued"] - v["swept"], 4),
    } for cid, v in sorted(per_chain.items())]

    # Withdrawal fees never touch this database — the vault carves them out on-chain and holds
    # them as a pull-payment balance. Reading only fee_accruals therefore under-reports the take,
    # so the on-chain leg is folded in here and this endpoint stays the one place to look.
    # ?onchain=0 skips it (pure-DB view); ?claims=0 keeps the view calls but drops the log scan.
    onchain: list = []
    onchain_usd = 0.0
    if (request.args.get('onchain') or '1') != '0':
        try:
            from withdraw_fee_ledger import read_all_vault_fees
            onchain = read_all_vault_fees(scan_claims=(request.args.get('claims') or '1') != '0')
            for r in onchain:
                amount = r.get("lifetime")
                if amount is None:
                    amount = r.get("unclaimed")      # claim scan unavailable — count what is owed
                if amount and r.get("asset") in prices:
                    onchain_usd += amount * prices[r["asset"]]
        except Exception as e:
            print(f"[Fee] on-chain vault read failed: {e}")
            onchain = [{"error": str(e)}]

    return jsonify({
        "fee_enabled": fc.FEE_ENABLED,
        "strategy_id": sid,
        "total_accruals": len(rows),
        "usd": {
            "accrued": round(usd_accrued, 4),      # all fees ever taken (priced now)
            "swept": round(usd_swept, 4),          # already deposited to the fee-vault
            "unswept": round(usd_accrued - usd_swept, 4),  # sitting in the executor wallet
            "onchain_withdraw": round(onchain_usd, 4),     # held/claimed by the vaults themselves
            "total": round(usd_accrued + onchain_usd, 4),  # every fee Siphon has taken, all sources
        },
        "by_chain": by_chain,      # Base vs Sepolia (vs any other) rollup
        "by_group": by_group,      # full breakdown: chain × asset × kind × swept
        "onchain_withdraw": onchain,  # per-vault withdrawal fee: owed now + already claimed
    }), 200


@app.route('/admin/usage', methods=['GET'])
@require_admin
def admin_usage():
    """Platform usage dashboard: strategies, notional volume, executions, and fee take-rate.

    Optional ?days=N limits to strategies created in the last N days (0 / omitted = all time).
    Read-only — aggregates Strategy / StrategyLeg / FeeAccrual without exposing private fields.
    """
    from database import FeeAccrual, Strategy, StrategyLeg
    from collections import defaultdict
    from datetime import datetime, timedelta
    import fee_config as fc

    days_raw = request.args.get('days')
    since = None
    try:
        days = int(days_raw) if days_raw is not None and str(days_raw).strip() != '' else 0
    except (TypeError, ValueError):
        days = 0
    if days > 0:
        since = datetime.utcnow() - timedelta(days=days)

    sq = Strategy.query
    lq = StrategyLeg.query
    fq = FeeAccrual.query
    if since is not None:
        sq = sq.filter(Strategy.created_at >= since)
        lq = lq.filter(StrategyLeg.created_at >= since)
        fq = fq.filter(FeeAccrual.created_at >= since)

    strategies = sq.all()
    legs = lq.all()
    fees = fq.all()

    by_status = defaultdict(int)
    by_type = defaultdict(lambda: {"count": 0, "volume": 0.0, "executed": 0})
    by_chain = defaultdict(lambda: {"count": 0, "volume": 0.0, "executed": 0})
    by_pair = defaultdict(lambda: {"count": 0, "volume": 0.0})
    users = set()
    volume_total = 0.0
    volume_executed = 0.0
    with_tx = 0
    recent = []

    terminal_ok = {"EXECUTED", "COMPLETED", "FILLED", "SUCCESS"}
    terminal_fail = {"FAILED", "ABORTED", "CANCELLED", "EXPIRED", "ERROR"}

    for s in strategies:
        st = (s.status or "UNKNOWN").upper()
        typ = (s.strategy_type or "UNKNOWN").upper()
        chain = str(s.from_chain or s.to_chain or "?")
        amt = float(s.amount or 0)
        by_status[st] += 1
        by_type[typ]["count"] += 1
        by_type[typ]["volume"] += amt
        by_chain[chain]["count"] += 1
        by_chain[chain]["volume"] += amt
        pair = f"{(s.asset_in or '?').upper()}→{(s.asset_out or '?').upper()}"
        by_pair[pair]["count"] += 1
        by_pair[pair]["volume"] += amt
        volume_total += amt
        if s.user_id:
            users.add(s.user_id.lower())
        if s.tx_hash:
            with_tx += 1
        executed = st in terminal_ok or (s.executed_at is not None and st not in terminal_fail)
        if executed:
            by_type[typ]["executed"] += 1
            by_chain[chain]["executed"] += 1
            volume_executed += amt
        recent.append({
            "id": s.id,
            "type": typ,
            "status": st,
            "asset_in": (s.asset_in or "").upper(),
            "asset_out": (s.asset_out or "").upper(),
            "amount": amt,
            "from_chain": chain,
            "tx_hash": s.tx_hash,
            "executed_at": s.executed_at.isoformat() if s.executed_at else None,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "legs": int(s.leg_count or 0),
            "executed_count": int(s.executed_count or 0),
        })

    recent.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    recent = recent[:40]

    leg_by_status = defaultdict(int)
    legs_with_tx = 0
    for leg in legs:
        leg_by_status[(leg.status or "UNKNOWN").upper()] += 1
        if leg.tx_hash:
            legs_with_tx += 1

    def fee_decimals(asset):
        return 6 if (asset or "").upper() in fc.STABLE_SYMBOLS else 18

    fees_by_kind = defaultdict(lambda: {"count": 0, "amount": 0.0})
    fee_rows = []
    for f in fees:
        asset = (f.asset or "").upper()
        kind = f.kind or "unknown"
        amount = int(f.amount_wei or 0) / (10 ** fee_decimals(asset))
        fees_by_kind[kind]["count"] += 1
        fees_by_kind[kind]["amount"] += amount
        fee_rows.append({
            "kind": kind,
            "asset": asset,
            "chain_id": f.chain_id,
            "amount": round(amount, 8),
            "swept": bool(f.swept),
            "strategy_id": f.strategy_id,
            "tx_hash": f.tx_hash,
            "created_at": f.created_at.isoformat() if f.created_at else None,
        })
    fee_rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)

    arming_usd = round(fees_by_kind["arming"]["amount"], 4)  # USDC ≈ $1
    # Execution fees are in the input asset — treat stables as USD; leave non-stables as raw
    exec_amount = round(fees_by_kind["execution"]["amount"], 8)
    fee_take_bps = None
    if volume_executed > 0 and exec_amount > 0:
        fee_take_bps = round((exec_amount / volume_executed) * 10_000, 2)

    return jsonify({
        "window_days": days if days > 0 else None,
        "fee_model": {
            "arming_usdc": fc.ARMING_USDC,
            "window_tiers_usd": [{"max_hours": h, "usd": u} for h, u in fc.WINDOW_TIERS_USD],
            "window_fee_enabled": fc.WINDOW_FEE_ENABLED,
            "exec_bps": fc.EXEC_BPS,
            "exec_bps_api": fc.EXEC_BPS_API,
            "max_legs": fc.MAX_LEGS,
            "fee_enabled": fc.FEE_ENABLED,
        },
        "strategies": {
            "total": len(strategies),
            "unique_users": len(users),
            "with_tx_hash": with_tx,
            "by_status": dict(sorted(by_status.items())),
            "by_type": [
                {"type": k, "count": v["count"], "volume": round(v["volume"], 8),
                 "executed": v["executed"]}
                for k, v in sorted(by_type.items(), key=lambda x: -x[1]["count"])
            ],
            "by_chain": [
                {"chain": k, "count": v["count"], "volume": round(v["volume"], 8),
                 "executed": v["executed"]}
                for k, v in sorted(by_chain.items(), key=lambda x: -x[1]["count"])
            ],
            "by_pair": [
                {"pair": k, "count": v["count"], "volume": round(v["volume"], 8)}
                for k, v in sorted(by_pair.items(), key=lambda x: -x[1]["volume"])[:20]
            ],
        },
        "volume": {
            "total_notional": round(volume_total, 8),
            "executed_notional": round(volume_executed, 8),
            "pending_notional": round(volume_total - volume_executed, 8),
        },
        "legs": {
            "total": len(legs),
            "with_tx_hash": legs_with_tx,
            "by_status": dict(sorted(leg_by_status.items())),
        },
        "fees": {
            "by_kind": [
                {"kind": k, "count": v["count"], "amount": round(v["amount"], 8)}
                for k, v in sorted(fees_by_kind.items())
            ],
            "arming_usdc": arming_usd,
            "execution_amount": exec_amount,
            "exec_take_bps_vs_executed_volume": fee_take_bps,
            "recent": fee_rows[:30],
        },
        "recent_strategies": recent,
    }), 200


def _change_commitment(zkp):
    """Extract a strategy's change-note commitment from its (decompressed) zkp_data. None on miss.

    This is Poseidon(changeValue, precommitment) — the note the strategy WOULD mint on a successful
    withdraw. It is a PHANTOM until the withdraw tx fires, so on abort/failed (tx never fires) the
    client must mark it spent. Zero-value change notes are skipped (nothing spendable)."""
    if not zkp:
        return None
    try:
        data = json.loads(zkp) if isinstance(zkp, str) else zkp
        if isinstance(data, dict):
            c = data.get('newCommitment') or data.get('changeCommitment')
            return str(c) if c and str(c) not in ('0', '') else None
    except Exception:
        pass
    return None


@app.route('/strategies/<user_id>', methods=['GET'])
@reject_api_token_on_user_routes
@verify_wallet_sig
def get_user_strategies(user_id, wallet=None):
    """Get all strategies for a user with their execution status and tx_hash."""
    if not _wallet_authorizes(wallet, user_id):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    try:
        strategies = Strategy.query.filter_by(user_id=user_id).order_by(Strategy.created_at.desc()).all()
        
        return jsonify({
            "status": "success",
            "strategies": [{
                "id": s.id,
                "strategy_type": s.strategy_type,
                "asset_in": s.asset_in,
                "asset_out": s.asset_out,
                "amount": s.amount,
                "status": s.status,
                "tx_hash": s.tx_hash,
                "executed_at": s.executed_at.isoformat() if s.executed_at else None,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "has_encrypted_result": bool(s.encrypted_result),
                "result_updated_at": s.result_updated_at.isoformat() if s.result_updated_at else None,
                "execution_error": s.execution_error,
                # Single-unit (legless) strategies only: the phantom change-note commitment the
                # client marks spent when the strategy reaches a non-executed terminal state
                # (FAILED/ABORTED/…). TWAP/grid legs have real on-chain slices, so None here.
                "change_commitment": (_change_commitment(s.zkp_data) if s.leg_count in (None, 0) else None),
                # Payout strategies: where it pays out, and how that order is going once fired.
                "payout": json.loads(s.payout) if s.payout else None,
                "payout_order": s._payout_order(),
                # Devnet: the settlement record carries the RETURNED note's public data (commitment,
                # deposit nonce, leaf, amount, label salt) the browser needs to add it to the vault.
                "from_chain": s.from_chain,
                "output_mode": s.output_mode,
                "settlement": json.loads(s.settlement) if s.settlement else None,
                "leg_count": s.leg_count,
                "executed_count": s.executed_count,
                # PIPELINE: hop cursor from sealed parent meta (no note secrets).
                "zkp_data": (
                    {k: v for k, v in (json.loads(s.zkp_data) if isinstance(s.zkp_data, str) else (s.zkp_data or {})).items()
                     if k in ("pipeline", "hop_cursor", "hop_count")}
                    if s.strategy_type == "PIPELINE" and s.zkp_data else None
                ),
                "legs": ([{"leg_index": l.leg_index, "status": l.status, "tx_hash": l.tx_hash,
                           "settlement": json.loads(l.settlement) if l.settlement else None,
                           "leg_kind": l.leg_kind}
                          for l in s.legs] if str(s.from_chain) == "900002" and s.leg_count else None),
            } for s in strategies]
        }), 200

    except Exception as e:
        print(f"Error fetching strategies: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/strategies/<strategy_id>/abort', methods=['POST'])
@reject_api_token_on_user_routes
@verify_wallet_write
def abort_strategy(strategy_id, wallet=None):
    """Abort a strategy's UNFIRED work; leave anything already on-chain untouched.

    Partial semantics (per-leg): a leg/strategy that has NOT touched the chain
    (no tx_hash, status in PENDING/ARMED) is set to ABORTED and its reserved input
    note is reported back so the client can revert it pending→false. A leg that has
    already fired (has tx_hash or EXECUTED) is left exactly as-is — those funds really
    moved on-chain and must stay spent.

    Terminal strategy status:
      - no leg ever fired            → ABORTED
      - some fired, rest aborted      → PARTIALLY_EXECUTED
      - already fully EXECUTED        → 409 (nothing to abort)

    Fund recovery (client-side):
      • The input note stays a real unspent on-chain leaf (the withdraw proof was never
        submitted), so the client reverts its reservation (pending/true → false).
      • The CHANGE note the strategy would have minted (Poseidon(changeValue, precommitment),
        = zkp_data.newCommitment) is a PHANTOM for an aborted single-order: it was written to
        storage optimistically at submit but is only minted on-chain when the withdraw tx
        fires. On abort that tx never fires, so the phantom change note must be invalidated.
        We return its commitment value (a public hash) so the client can mark it spent — the
        executor can't do it itself (commitments are stored encrypted; only the client's key
        can find the row by commitment value).
      • TWAP/grid: no phantom — the split ran on-chain at submit, so unfired legs hold REAL
        slice-notes (no change_commitments returned for those).
    Setting ABORTED guarantees the stored proof is never submitted → no double-spend.
    """
    strat = Strategy.query.filter_by(id=strategy_id).first()
    if not strat:
        return jsonify({"error": "Strategy not found"}), 404
    if not _wallet_authorizes(wallet, strat.user_id):
        return jsonify({"error": "wallet signature does not match strategy owner"}), 403

    if strat.status in ('EXECUTED', 'ABORTED', 'PARTIALLY_EXECUTED', 'EXPIRED', 'FAILED'):
        return jsonify({"error": f"Strategy is already terminal ({strat.status}); nothing to abort"}), 409

    def _leg_fired(status, tx_hash):
        return bool(tx_hash) or status in ('EXECUTED', 'EXECUTING')

    # Abort is a state transition, and it must be ATOMIC against the executor's own EXECUTING
    # claim (executor_runner.py: `UPDATE strategy SET status='EXECUTING' WHERE ... status IN
    # ('PENDING','ARMED')`). Rule: a leg/strategy still PENDING/ARMED at the instant we flip it is
    # abortable; one that has already moved to EXECUTING/EXECUTED (or carries a tx_hash) is
    # PROCESSING and CANNOT be cancelled. We enforce this with the SAME compare-and-swap the
    # executor uses — flip only if the row is still PENDING/ARMED — so we can never abort (and tell
    # the client to reclaim funds for) something that is concurrently firing on-chain.
    from sqlalchemy import text as _sql_text

    aborted_legs = 0
    spent_amount = 0.0     # asset_in units that already fired on-chain (unrecoverable)
    returned_amount = 0.0  # asset_in units freed by the abort (restored to balance)
    # Phantom change-note commitments to invalidate client-side (single-order only — TWAP
    # slices are real on-chain leaves, no phantom).
    invalidate_commitments = []
    legs = strat.legs.all()

    try:
        if legs:
            any_fired = False
            for leg in legs:
                if _leg_fired(leg.status, leg.tx_hash):
                    any_fired = True
                    spent_amount += leg.amount or 0.0
                    continue  # already on-chain / executing — leave it exactly as-is
                # Atomic CAS: abort THIS leg only if it is still PENDING/ARMED. If a concurrent
                # executor claimed it (→ EXECUTING) between our read and here, rowcount==0 and we
                # do NOT count it as returned — it is processing and stays untouched.
                res = db.session.execute(
                    _sql_text("UPDATE strategy_legs SET status='ABORTED' "
                              "WHERE id=:id AND status IN ('PENDING','ARMED')"),
                    {"id": leg.id},
                )
                if res.rowcount == 1:
                    aborted_legs += 1
                    returned_amount += leg.amount or 0.0
                else:
                    # Lost the race — it just started executing; treat as fired (unrecoverable).
                    any_fired = True
                    spent_amount += leg.amount or 0.0
            # Strategy-level terminal status (also CAS-guarded so we don't stomp a status the
            # executor may have advanced concurrently).
            if any_fired:
                new_status = 'PARTIALLY_EXECUTED'
            elif aborted_legs:
                new_status = 'ABORTED'
            else:
                # No fired, no abortable legs (all already terminal) — nothing to do.
                db.session.rollback()
                return jsonify({"error": "No abortable legs (all already executed or terminal)"}), 409
            # Roll up the strategy status. CAS-guarded: only advance from PENDING/ARMED, so we never
            # stomp a status the scheduler advanced to EXECUTED/FAILED concurrently. (Legs were each
            # already atomically settled above, so the abort of unfired legs stands regardless.)
            srow = db.session.execute(
                _sql_text("UPDATE strategy SET status=:s WHERE id=:id "
                          "AND status IN ('PENDING','ARMED')"),
                {"s": new_status, "id": strategy_id},
            )
            if srow.rowcount == 1:
                strat.status = new_status
            else:
                # Scheduler finalized the strategy concurrently — report its real current status.
                cur = Strategy.query.filter_by(id=strategy_id).first()
                strat.status = cur.status if cur else new_status
            # TWAP/grid: unfired legs hold REAL on-chain slice-notes — no phantom change note
            # to invalidate. (The split already happened on-chain at submit.)
        else:
            # Single-unit strategy (e.g. LIMIT). Atomic CAS: abort ONLY if still PENDING/ARMED. If
            # the executor already claimed it (EXECUTING) or it executed, rowcount==0 → it is
            # processing and CANNOT be cancelled; return 409 so the UI shows "processing".
            res = db.session.execute(
                _sql_text("UPDATE strategy SET status='ABORTED' "
                          "WHERE id=:id AND status IN ('PENDING','ARMED')"),
                {"id": strategy_id},
            )
            if res.rowcount != 1:
                db.session.rollback()
                # Re-read for an accurate message (it may now be EXECUTING/EXECUTED).
                cur = Strategy.query.filter_by(id=strategy_id).first()
                cur_status = cur.status if cur else 'UNKNOWN'
                return jsonify({
                    "error": f"Strategy is {cur_status} and can no longer be cancelled (it is processing).",
                    "strategy_status": cur_status,
                }), 409
            strat.status = 'ABORTED'
            aborted_legs = 1
            returned_amount = strat.amount or 0.0
            # The change note this strategy would have minted is a phantom (never went on-chain).
            cc = _change_commitment(strat.zkp_data)
            if cc:
                invalidate_commitments.append(cc)

        db.session.commit()
    except Exception as e:
        db.session.rollback()
        print(f"Error aborting strategy {strategy_id}: {e}")
        return jsonify({"error": "Failed to abort strategy"}), 500

    return jsonify({
        "status": "success",
        "strategy_status": strat.status,
        "aborted_legs": aborted_legs,
        # Amount breakdown in asset_in units: what already fired on-chain (gone) vs what the
        # abort freed (restored to the user's spendable balance via the note re-sync below).
        "asset_in": strat.asset_in,
        "spent_amount": round(spent_amount, 8),
        "returned_amount": round(returned_amount, 8),
        # Phantom change-note commitments the client must mark spent (single-order only).
        # The client also reverts the reserved INPUT note to spendable (ABORTED reconciliation).
        "invalidate_commitments": invalidate_commitments,
    }), 200


@app.route('/polymarket/positions/<user_id>', methods=['GET'])
@rate_limit(max_requests=60, window_seconds=60, bucket="polymarket_positions")
@verify_wallet_sig
def get_polymarket_positions(user_id, wallet=None):
    """All Polymarket positions for a user (OPEN + REDEEMING + SETTLED/CLOSED), newest first.
    Backs the frontend positions panel + its Close button."""
    if not _wallet_authorizes(wallet, user_id):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    try:
        from database import PolymarketPosition
        rows = PolymarketPosition.query.filter_by(user_id=(user_id or "").lower()).order_by(
            PolymarketPosition.created_at.desc()).all()
        # Enrich with the market slug (from the owning strategy's poly_meta) so the panel can
        # link to polymarket.com/market/<slug>. Best-effort — older strategies have no slug.
        positions = []
        for p in rows:
            d = p.to_dict()
            try:
                strat = Strategy.query.get(p.strategy_id)
                if strat and strat.poly_meta:
                    d["slug"] = (json.loads(strat.poly_meta) or {}).get("slug")
            except Exception:
                pass
            positions.append(d)
        return jsonify({"status": "success", "positions": positions}), 200
    except Exception as e:
        print(f"Error fetching polymarket positions: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/polymarket/exit', methods=['POST'])
@rate_limit(max_requests=20, window_seconds=60, bucket="polymarket_exit")
@reject_api_token_on_user_routes
@verify_wallet_write
def polymarket_exit_route(wallet=None):
    """Close (or partially close) a Polymarket position before resolution: sell the outcome shares
    and shield the proceeds back to the user's vault.

    Wallet-sig authenticated (unlike the read routes): this endpoint MOVES FUNDS, and a partial
    close shields them to a caller-supplied output_precommitment — without the signature check,
    anyone who listed a victim's positions could redirect the proceeds into their own note. The
    recovered wallet is the authoritative owner; the body's user_id is ignored for authz.

    Body: { position_id, fraction? (0<f<=1, default 1), output_precommitment? }
    A partial close (fraction<1) MUST include a fresh output_precommitment for the sold portion;
    the position's original note is kept for the remainder.
    """
    data = request.json or {}
    position_id = data.get('position_id')
    if not position_id:
        return jsonify({"error": "position_id is required"}), 400
    try:
        from database import PolymarketPosition
        import polymarket_watcher
        pos = PolymarketPosition.query.get(position_id)
        if not pos or (pos.user_id or '').lower() != wallet:
            return jsonify({"error": "position not found"}), 404
        result = polymarket_watcher.exit_position(
            pos,
            fraction=float(data.get('fraction', 1.0)),
            new_precommitment=data.get('output_precommitment'),
        )
        return jsonify({"status": "success", **result}), 200
    except Exception as e:
        db.session.rollback()
        print(f"[Polymarket] exit failed for {position_id}: {e}")
        return jsonify({"error": str(e)}), 502


@app.route('/hyperliquid/config', methods=['GET'])
@rate_limit(max_requests=60, window_seconds=60, bucket="hyperliquid_config")
def hyperliquid_config():
    """What the perps UI needs before arming: is it on, which account LI.FI funds, the limits.

    `?coins=BTC,ETH` adds each coin's leverage cap. Public: nothing here is per-user.
    """
    import hyperliquid_client as hl
    enabled = os.getenv("HYPERLIQUID_ENABLED", "1").lower() in ("1", "true", "yes") and hl.is_configured()
    out = {"enabled": enabled, "network": "testnet" if hl.testnet() else "mainnet",
           "min_notional_usd": hl.MIN_NOTIONAL_USD, "payout_chains": list(hl.PAYOUT_CHAINS),
           "withdraw_fee_usd": hl.WITHDRAW_FEE_USD}
    if not enabled:
        return jsonify(out), 200
    out["account"] = hl.account()
    coins = [c.strip().upper() for c in (request.args.get("coins") or "").split(",") if c.strip()][:20]
    try:
        tradable = [c for c in coins if (m := hl.market(c)) and not m.get("onlyIsolated") and not m.get("isDelisted")]
        out["max_leverage"] = {c: hl.leverage_cap(c) for c in tradable}
    except Exception as exc:
        return jsonify({**out, "error": f"Hyperliquid meta unavailable: {exc}"}), 502
    return jsonify(out), 200


@app.route('/hyperliquid/positions/<user_id>', methods=['GET'])
@rate_limit(max_requests=60, window_seconds=60, bucket="hyperliquid_positions")
@verify_wallet_sig
def get_hyperliquid_positions(user_id, wallet=None):
    """The user's perps, newest first; open ones carry the live mark and equity."""
    if not _wallet_authorizes(wallet, user_id):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    from database import HyperliquidPosition
    import hyperliquid_client as hl
    import hyperliquid_watcher
    rows = HyperliquidPosition.query.filter_by(user_id=(user_id or "").lower()).order_by(
        HyperliquidPosition.created_at.desc()).limit(100).all()
    out = [p.to_dict() for p in rows]
    if any(p.status == "OPEN" for p in rows):
        try:
            mids = hl.all_mids()
        except Exception:
            mids = {}
        for p, d in zip(rows, out):
            mark = mids.get(p.coin.upper()) if p.status == "OPEN" else None
            if mark:
                d["mark_px"] = mark
                d["equity_usd"] = round(hyperliquid_watcher.equity(p, mark), 6)
    return jsonify({"status": "success", "positions": out}), 200


@app.route('/hyperliquid/exit', methods=['POST'])
@rate_limit(max_requests=20, window_seconds=60, bucket="hyperliquid_exit")
@reject_api_token_on_user_routes
@verify_wallet_write
def hyperliquid_exit_route(wallet=None):
    """Close an open perp now and pay it out to the address it was armed with."""
    data = request.json or {}
    position_id = data.get('position_id')
    if not position_id:
        return jsonify({"error": "position_id is required"}), 400
    from database import HyperliquidPosition
    import hyperliquid_watcher
    pos = HyperliquidPosition.query.get(position_id)
    if not pos or (pos.user_id or '').lower() != wallet:
        return jsonify({"error": "position not found"}), 404
    try:
        return jsonify({"status": "success", "position": hyperliquid_watcher.exit_position(pos)}), 200
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 409
    except Exception as e:
        db.session.rollback()
        print(f"[Hyperliquid] exit failed for {position_id}: {e}")
        return jsonify({"error": str(e)}), 502


# Wrapped-ClientKey bounds — see the note in upload_server_key.
_MAX_ENC_CLIENT_KEY = 64 * 1024
_MAX_IV = 32
_MAX_FP = 64


@app.route('/uploadServerKey', methods=['POST'])
@rate_limit(max_requests=20, window_seconds=60, bucket="upload_server_key")
@reject_api_token_on_user_routes
@verify_wallet_write
def upload_server_key(wallet=None):
    """Store a user's FHE server (public) key once. Idempotent upsert.

    The server key is large (~100 MB hex) but identical across all of a user's strategies, so
    it is uploaded a single time and reused. The client (secret) key is never uploaded IN THE
    CLEAR: this route also accepts a wallet-WRAPPED copy of it (enc_client_key / client_key_iv),
    which the server stores and cannot decrypt, and GET /fheKeyBlob/<user_id> hands back."""
    data = request.json
    if not data or not data.get('user_id'):
        return jsonify({"error": "user_id is required"}), 400
    # server_key is large (~24MB) and only changes when the key generation changes, so the browser
    # fast-skips re-sending it. The canary (~few KB) MUST refresh every arm, so allow a canary-only
    # POST: require server_key OR canary. Without this the canary rode on the skipped server-key
    # upload and never landed → NULL canary → scheduler couldn't gate → false trade fired.
    server_key = data.get('server_key')
    canary = data.get('canary')  # hex(encrypt(0)) under the ClientKey this generation's keys derive from
    # Wallet-wrapped ClientKey, riding this request's existing write challenge. It is deliberately
    # NOT a route of its own: getWalletWriteAuthHeaders signs a fresh nonce every call, so a
    # separate PUT would add a wallet popup to the very flow the wrapped-key work exists to quieten.
    enc_client_key = data.get('enc_client_key')
    client_key_iv = data.get('client_key_iv')
    client_key_fp = data.get('client_key_fp')
    has_blob = bool(enc_client_key and client_key_iv)
    if not server_key and not canary and not has_blob:
        return jsonify({"error": "server_key, canary or enc_client_key is required"}), 400
    if not _wallet_authorizes(wallet, data.get('user_id')):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    # SQLite ignores VARCHAR(n) and PRODUCTION IS SQLITE, so an over-long value would be silently
    # accepted in prod and only 500 on the dev Postgres. The handler is the only layer that
    # behaves identically on both.
    if has_blob and (len(enc_client_key) > _MAX_ENC_CLIENT_KEY
                     or len(client_key_iv) > _MAX_IV
                     or (client_key_fp and len(client_key_fp) > _MAX_FP)):
        return jsonify({"error": "enc_client_key payload too large"}), 400
    if has_blob:
        try:
            client_key_v = int(data.get('client_key_v') or 2)
        except (TypeError, ValueError):
            return jsonify({"error": "client_key_v must be an integer"}), 400
    else:
        client_key_v = None
    try:
        existing = UserFheKey.query.get(data['user_id'])
        if existing:
            if server_key:
                existing.server_key = server_key
            if canary:
                existing.canary = canary
            # Must persist on the CANARY-ONLY path too. The browser fast-skips the ~24MB
            # server_key whenever the executor already holds a matching fingerprint, so that is
            # the ordinary request — a blob only written alongside a full upload would almost
            # never land.
            if has_blob:
                existing.enc_client_key = enc_client_key
                existing.client_key_iv = client_key_iv
                existing.client_key_fp = client_key_fp
                existing.client_key_v = client_key_v
        else:
            if not server_key:
                # Can't create a row without the (NOT NULL) server_key — the first upload must carry it.
                return jsonify({"error": "server_key required for the first upload"}), 400
            db.session.add(UserFheKey(
                user_id=data['user_id'], server_key=server_key, canary=canary,
                enc_client_key=enc_client_key if has_blob else None,
                client_key_iv=client_key_iv if has_blob else None,
                client_key_fp=client_key_fp if has_blob else None,
                client_key_v=client_key_v))
        db.session.commit()
        return jsonify({"status": "success"}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error storing server key: {e}")
        return jsonify({"error": str(e)}), 500


# ── Wallet-wrapped ClientKey ──────────────────────────────────────────────────
# Lets a returning device restore its FHE client key instead of re-prompting for the seed
# signature on every tab. The value is AES-GCM ciphertext under a key derived from a wallet
# signature that never leaves the browser, so this server stores it and cannot open it.
#
# READ ONLY. The write rides /uploadServerKey's existing challenge — see the note there.


@app.route('/fheKeyBlob/<user_id>', methods=['GET'])
@verify_wallet_sig
def get_fhe_key_blob(user_id, wallet=None):
    """Return the wrapped ClientKey blob for a wallet, or 404 when there is none."""
    if not _wallet_authorizes(wallet, user_id):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    row = UserFheKey.query.get(user_id)
    if not row or not row.enc_client_key or not row.client_key_iv:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "enc_client_key": row.enc_client_key,
        "client_key_iv": row.client_key_iv,
        "client_key_fp": row.client_key_fp,
        "client_key_v": row.client_key_v,
    }), 200


@app.route('/hasServerKey/<user_id>', methods=['GET'])
@verify_wallet_sig
def has_server_key(user_id, wallet=None):
    """Lets the browser know whether it still needs to upload its server key.

    Returns a fingerprint of the stored server key so the browser can detect a WRONG-but-present
    key (e.g. uploaded from another device / an older generation) and re-upload — a presence-only
    check let a stale ServerKey survive, so the engine evaluated fresh bounds with an old key →
    garbage → decrypt mismatch. Fingerprint = sha256(server_key_hex)[:16], matching the browser's
    fingerprintClientKey() applied to the same server-key hex."""
    if not _wallet_authorizes(wallet, user_id):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    sk = get_server_key(user_id)
    fp = None
    if sk:
        import hashlib
        fp = hashlib.sha256(sk.encode()).digest()[:16].hex()
    return jsonify({"has_key": sk is not None, "fingerprint": fp}), 200


@app.route('/internal/hasServerKey/<user_id>', methods=['GET'])
@require_auth
def internal_has_server_key(user_id):
    """Gateway-only key preflight; authenticated by the fixed internal service token."""
    sk = get_server_key(user_id)
    fp = None
    if sk:
        import hashlib
        fp = hashlib.sha256(sk.encode()).digest()[:16].hex()
    return jsonify({"has_key": sk is not None, "fingerprint": fp}), 200


@app.route('/debugEval', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60)
@require_admin
def debug_eval():
    """DEV self-test: given a FRESH wasm (server_key, client_key) and a TWAP fire-time ciphertext,
    evaluate via the engine and decrypt via the decryptor under a throwaway user id. Isolates
    whether wasm-generated keys are compatible with the native engine.

    Double-gated: absent unless ENABLE_DEBUG_ENDPOINTS=1, and then admin-token only. Left ungated
    this was a public oracle that loads arbitrary ClientKeys into the enclave and runs expensive FHE."""
    if os.getenv('ENABLE_DEBUG_ENDPOINTS') != '1':
        return jsonify({"error": "not found"}), 404
    import requests as _rq
    from decryptor_client import upload_client_key, DECRYPTOR_URL
    import fhe_client
    data = request.json or {}
    for f in ('server_key', 'client_key', 'encrypted_lower_bound'):
        if not data.get(f):
            return jsonify({"error": f"{f} required"}), 400
    uid = (data.get('user_id') or '__selftest').lower()
    ctime = int(data.get('current_time', 100))
    up = upload_client_key(uid, data['client_key'])
    payload = {
        "strategy_type": "TWAP_SLICE",
        "encrypted_upper_bound": "",
        "encrypted_lower_bound": data['encrypted_lower_bound'],
        "server_key": data['server_key'],
        "current_price_cents": 0,
        "current_time": ctime,
    }
    er = _rq.post(fhe_client.FHE_ENGINE_URL, json=payload, timeout=180)
    if not er.ok:
        return jsonify({"stage": "engine", "status": er.status_code, "body": er.text[:300]}), 200
    enc = (er.json() or {}).get("encrypted_result")
    if not enc:
        return jsonify({"stage": "engine", "error": er.json()}), 200
    dr = _rq.post(f"{DECRYPTOR_URL}/decrypt",
                  json={"user_id": uid, "encrypted_result": enc}, timeout=120)
    return jsonify({"client_key_upload": up, "decrypt": dr.json(),
                    "current_time": ctime, "expect": "triggered=true (0<=%d)" % ctime}), 200


@app.route('/uploadClientKey', methods=['POST'])
@rate_limit(max_requests=20, window_seconds=60, bucket="upload_client_key")
@reject_api_token_on_user_routes
@verify_wallet_write
def upload_client_key(wallet=None):
    """Forward the user's FHE client key to the confidential-vm decryptor.

    The browser never talks to the decryptor directly (private VPC). The key is forwarded
  once and held only in the decryptor's memory; decryption of strategy inputs never happens."""
    from decryptor_client import upload_client_key as forward_client_key, decryptor_enabled

    if not decryptor_enabled():
        return jsonify({"error": "Confidential decryptor not configured (DECRYPTOR_URL)"}), 503
    data = request.json
    if not data or not data.get('user_id') or not data.get('client_key'):
        return jsonify({"error": "user_id and client_key are required"}), 400
    if not _wallet_authorizes(wallet, data.get('user_id')):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    result = forward_client_key(data['user_id'], data['client_key'])
    if not result.get('ok'):
        return jsonify({"error": result.get('error', 'upload failed')}), 502
    return jsonify({"status": "success"}), 200


@app.route('/selfCheckKeys', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60, bucket="self_check_keys")
@reject_api_token_on_user_routes
@verify_wallet_write
def self_check_keys(wallet=None):
    """Pre-arm key-consistency check — proves the decryptor's STORED ClientKey decrypts the engine's
    output correctly BEFORE a strategy is armed. The browser sends its CURRENT server_key plus a
    canary ciphertext = encrypt(0) under its client key. We evaluate 0<=100 on the engine (known
    answer: TRUE) and decrypt with the user's STORED key via the decryptor. If the stored key is
    stale/mismatched, the canary decrypts to garbage (!= true) → the caller must re-sync before
    arming. Nothing is uploaded here — the caller uploads keys first, this only verifies them.

    This closes the false-trigger class at the source: a strategy can only arm once its three keys
    (bound-encryption, engine server_key, decryptor client_key) are proven to be one generation."""
    import fhe_client
    from decryptor_client import decrypt_trigger, decryptor_enabled
    if not decryptor_enabled():
        # No server-side decrypt path (browser-only mode) → nothing to verify here.
        return jsonify({"consistent": True, "skipped": "decryptor not configured"}), 200
    data = request.json or {}
    user_id = data.get('user_id'); canary = data.get('encrypted_canary')
    if not user_id or not canary:
        return jsonify({"error": "user_id, encrypted_canary required"}), 400
    if not _wallet_authorizes(wallet, user_id):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    # CRITICAL: evaluate with the STORED server key — the exact one the scheduler will use — NOT a
    # key sent inline. Testing a fresh inline key would pass even when the stored key is stale,
    # letting a skewed strategy arm (the bug this endpoint exists to prevent).
    server_key = get_server_key(user_id)
    if not server_key:
        return jsonify({"consistent": False, "reason": "no server key on file — upload it first"}), 200
    payload = {
        "strategy_type": "TWAP_SLICE", "encrypted_upper_bound": "",
        "encrypted_lower_bound": canary,
        "current_price_cents": 0, "current_time": 100,   # 0 <= 100 → triggered TRUE
    }
    try:
        er = fhe_client.post_engine(payload, server_key, timeout=120)
        enc = (er or {}).get("encrypted_result")
    except Exception as e:
        return jsonify({"consistent": False, "stage": "engine", "error": str(e)}), 200
    if not enc:
        return jsonify({"consistent": False, "stage": "engine"}), 200
    triggered, err = decrypt_trigger(user_id, enc)
    # Known answer is TRUE. Consistent ONLY if the stored key decrypts it to exactly True; garbage
    # (fail-closed None, or a spurious False) means the decryptor's key is not the current one.
    return jsonify({"consistent": triggered is True, "triggered": triggered, "decrypt_error": err}), 200


@app.route('/decryptorAttestation', methods=['GET'])
@rate_limit(max_requests=20, window_seconds=60)
def decryptor_attestation():
    """Proxy the decryptor's TDX attestation (quote + enclave x25519 pubkey) to the browser.

    The browser verifies the quote and report_data binding itself, then HPKE-seals the
    ClientKey to the attested pubkey — so this proxy (and the Phala host) never see it."""
    from decryptor_client import get_attestation, decryptor_enabled

    if not decryptor_enabled():
        return jsonify({"error": "Confidential decryptor not configured (DECRYPTOR_URL)"}), 503
    att = get_attestation()
    status = 200 if not att.get("error") else 502
    return jsonify(att), status


@app.route('/hasClientKey/<user_id>', methods=['GET'])
@verify_wallet_sig
def has_client_key(user_id, wallet=None):
    """Whether the confidential decryptor already holds this user's client key."""
    from decryptor_client import has_client_key as decryptor_has_key, decryptor_enabled

    if not _wallet_authorizes(wallet, user_id):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    if not decryptor_enabled():
        return jsonify({"has_key": False, "decryptor": False}), 200
    return jsonify({"has_key": decryptor_has_key(user_id), "decryptor": True}), 200


@app.route('/tee/prove', methods=['POST'])
@rate_limit(max_requests=20, window_seconds=60, bucket="prove")
@verify_wallet_sig
def prove(wallet=None):
    """Prove a spend witness inside the enclave, because the browser cannot do it in time.

    Mounted at /tee/prove, NOT /prove: the Caddyfile already routes /prove* to the v1
    proving-relayer on :5010, so a route named /prove here is unreachable from the browser --
    Caddy would answer it before the request ever reached this process. Everything unmatched
    falls through to the trade-executor catch-all, so /tee/prove needs no Caddy change.

    The zkey for a spend is picked by its input count and runs 23MB..144MB; which one is needed is
    not known until the user picks an amount, so it cannot be prefetched. On a slow connection that
    download is minutes before proving starts. The enclave already has all 14 keys resident.

    This is a PASS-THROUGH of a witness holding note secrets: no logging of the body, no storage,
    no inspection. Rate-limited because rapidsnark on a 2-vCPU CVM is the scarce resource here and
    an unmetered prove endpoint is a trivial way to starve the strategy legs that share it.
    """
    from decryptor_client import prove_witness, decryptor_enabled

    if not decryptor_enabled():
        return jsonify({"ok": False, "error": "Confidential decryptor not configured (DECRYPTOR_URL)",
                        "retryable": True}), 503
    witness = request.get_json(silent=True)
    if not isinstance(witness, dict):
        return jsonify({"ok": False, "error": "body must be a PROTOCOL witness object"}), 400

    body = prove_witness(witness)
    return jsonify(body), (200 if body.get("ok") else 502)


@app.route('/clientMetrics', methods=['POST'])
@rate_limit(max_requests=60, window_seconds=60, bucket="client_metrics")
@verify_wallet_sig
def client_metrics(wallet=None):
    """Receive in-browser client-side-FHE timings and log them here, so the encryption
    performance is observable in the trade-executor terminal (it happens in the browser,
    not on the server). Best-effort; never affects the strategy flow."""
    d = request.json or {}
    if not _wallet_authorizes(wallet, d.get('user_id')):
        return jsonify({"error": "wallet signature does not match user_id"}), 403
    try:
        print(
            f"[ClientMetrics] strategy={d.get('strategy_id', '?')} user={str(d.get('user_id', '?'))[:10]}… | "
            f"keygen={float(d.get('keygenMs', 0)):.0f}ms  "
            f"serverKey(derive+upload)={float(d.get('serverKeyMs', 0)):.0f}ms  "
            f"encrypt={float(d.get('encryptMs', 0)):.0f}ms  "
            f"submit={float(d.get('submitMs', 0)):.0f}ms  "
            f"total={float(d.get('totalMs', 0)):.0f}ms"
        )
    except Exception as e:
        print(f"[ClientMetrics] received (unparseable): {d} ({e})")
    return jsonify({"ok": True}), 200


@app.route('/strategy/<strategy_id>/result', methods=['GET'])
@verify_wallet_sig
def get_strategy_result(strategy_id, wallet=None):
    """Return the latest encrypted evaluation result for a strategy. The browser decrypts it
    locally to decide whether to authorize execution."""
    s = Strategy.query.get(strategy_id)
    if not s:
        return jsonify({"error": "strategy not found"}), 404
    if not _wallet_authorizes(wallet, s.user_id):
        return jsonify({"error": "wallet signature does not match strategy owner"}), 403
    return jsonify({
        "status": s.status,
        "encrypted_result": s.encrypted_result,
        "result_updated_at": s.result_updated_at.isoformat() if s.result_updated_at else None,
    }), 200


@app.route('/executeStrategy', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60, bucket="execute_strategy")
@reject_api_token_on_user_routes
@verify_wallet_write
def execute_strategy_endpoint(wallet=None):
    """Browser-authorized execution. After the browser decrypts the result and sees it is
    triggered, it calls this to run the on-chain trade. We fetch a fresh price and execute."""
    from oracle import get_live_prices
    from executor_runner import run_execution

    data = request.json or {}
    strategy_id = data.get('strategy_id')
    user_id = data.get('user_id')
    if not strategy_id or not user_id:
        return jsonify({"error": "strategy_id and user_id are required"}), 400

    s = Strategy.query.get(strategy_id)
    if not s:
        return jsonify({"error": "strategy not found"}), 404
    if s.user_id != user_id:
        return jsonify({"error": "not authorized for this strategy"}), 403
    # Bind execution to a proven wallet: the caller must own the strategy, not merely know its
    # (public) user_id. Gated by ENFORCE_WALLET_AUTH until the frontend attaches the signature.
    if not _wallet_authorizes(wallet, s.user_id):
        return jsonify({"error": "wallet signature does not match strategy owner"}), 403
    if s.status in ('EXECUTED',):
        return jsonify({"status": "already_executed", "tx_hash": s.tx_hash}), 200
    if s.status not in ('PENDING', 'ARMED'):
        return jsonify({"error": f"strategy not executable (status={s.status})"}), 409

    try:
        from_cid = int(s.from_chain or 0)
    except (TypeError, ValueError):
        from_cid = 0
    refresh = data.get("zkp_data") or data.get("zk_proof")
    if from_cid == 900_002 and refresh:
        if isinstance(refresh, str):
            try:
                refresh = json.loads(refresh)
            except Exception:
                return jsonify({"error": "zkp_data is not valid JSON"}), 400
        if not isinstance(refresh, dict):
            return jsonify({"error": "zkp_data must be an object"}), 400
        from solana_devnet_strategy import settlement_pubkey, validate_devnet_zk_package
        pkg_err = validate_devnet_zk_package(
            refresh, settlement=settlement_pubkey(), vault_output=(s.output_mode or '') == 'vault')
        if pkg_err:
            return jsonify({"error": pkg_err}), 400
        if data.get("leg_index") is not None:
            # A multi-leg order's leg: same slice note, fresh roots. Legs never fire from here.
            from database import StrategyLeg
            try:
                leg_index = int(data.get("leg_index"))
            except (TypeError, ValueError):
                return jsonify({"error": "leg_index must be an integer"}), 400
            leg = StrategyLeg.query.filter_by(strategy_id=s.id, leg_index=leg_index).first()
            if leg is None:
                return jsonify({"error": f"no leg {leg_index}"}), 404
            if leg.status not in ('PENDING', 'ARMED'):
                return jsonify({"error": f"leg not refreshable (status={leg.status})"}), 409
            leg.zkp_data = json.dumps(refresh)
            leg.settlement = None
            db.session.commit()
            return jsonify({"status": "refreshed", "strategy_id": s.id, "leg_index": leg_index}), 200
        s.zkp_data = json.dumps(refresh)
        s.settlement = None  # clears the NEEDS_REPROOF wait (solana_devnet_strategy)
        s.execution_error = None
        db.session.commit()
        # A resting order only needed a fresh proof; it fires on its own trigger.
        if data.get("refresh_only"):
            return jsonify({"status": "refreshed", "strategy_id": s.id}), 200

    strategy_dict = s.to_dict()

    # Fresh price using the same selection logic as the scheduler.
    feed_ids = [fid for fid in PYTH_PRICE_FEED_IDS.values() if fid]
    live_prices = get_live_prices(feed_ids)
    eth_feed_id = PYTH_PRICE_FEED_IDS.get("ETH")
    sol_feed_id = PYTH_PRICE_FEED_IDS.get("SOL")
    asset_in = strategy_dict.get('asset_in', 'ETH').upper()
    feed = strategy_dict.get('price_feed_id') or PYTH_PRICE_FEED_IDS.get(asset_in)
    if feed and feed in live_prices:
        current_price = live_prices[feed]
    elif eth_feed_id in live_prices:
        current_price = live_prices.get(eth_feed_id, 0)
    else:
        current_price = live_prices.get(sol_feed_id, 0)

    try:
        result = run_execution(strategy_dict, current_price)
        return jsonify({"status": "success", **result}), 200
    except Exception as e:
        print(f"Error executing strategy {strategy_id}: {e}")
        db.session.rollback()
        return jsonify({"error": str(e)}), 500


def _relay_request_hash(payload):
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    ).hexdigest()


def _valid_relay_id(relay_id):
    return len(relay_id) == 64 and all(c in '0123456789abcdef' for c in relay_id)


def _claim_relay_execution(relay_id):
    """Atomically fence one leased relay worker before it begins transaction preparation."""
    changed = (
        db.session.query(RelaySubmission)
        .filter(RelaySubmission.id == relay_id, RelaySubmission.status == 'leased')
        .update({"status": "executing", "updated_at": datetime.utcnow()})
    )
    db.session.commit()
    return changed == 1


def _journal_prepared_transaction(relay_id, tx_hash, raw_transaction):
    """Publish signed bytes only if this worker still owns the unexpired execution fence.

    `send_tx` invokes this callback before broadcast. If the status endpoint expired the hashless
    execution first, this compare-and-set fails and raises, so the late worker never sends.
    """
    changed = (
        db.session.query(RelaySubmission)
        .filter(RelaySubmission.id == relay_id, RelaySubmission.status == 'executing')
        .update({
            "tx_hash": tx_hash,
            "raw_transaction": raw_transaction,
            "status": "submitted",
            "updated_at": datetime.utcnow(),
        })
    )
    db.session.commit()
    if changed != 1:
        raise RuntimeError("relay execution lease expired before transaction preparation")


@app.route('/internal/relay-submissions/<relay_id>/prepare', methods=['POST'])
@require_auth
def prepare_relay_submission(relay_id):
    """Create the durable executor-side lease before the gateway commits an authorization.

    The separate acknowledgement closes the HTTP-queue ambiguity: once the gateway records an
    authorized operation, the executor journal is guaranteed to exist. A missing journal is never
    used as evidence that a queued request cannot later execute.
    """
    relay_id = (relay_id or '').strip().lower()
    if not _valid_relay_id(relay_id):
        return jsonify({"error": "invalid relay id"}), 400
    data = request.json or {}
    payload = data.get('payload')
    wallet = (data.get('wallet') or '').strip().lower()
    if not isinstance(payload, dict) or not wallet:
        return jsonify({"error": "payload and wallet are required"}), 400
    try:
        chain_id = int(payload.get('chain_id'))
    except (TypeError, ValueError):
        return jsonify({"error": "payload.chain_id is required"}), 400
    request_hash = _relay_request_hash(payload)
    journal = db.session.get(RelaySubmission, relay_id)
    if journal:
        if (
            journal.request_hash != request_hash
            or journal.wallet.lower() != wallet
            or journal.chain_id != chain_id
        ):
            return jsonify({"error": "relay id was reused for a different request"}), 409
        return jsonify({"relay_id": journal.id, "status": journal.status}), 200
    journal = RelaySubmission(
        id=relay_id,
        request_hash=request_hash,
        wallet=wallet,
        chain_id=chain_id,
        status='leased',
    )
    db.session.add(journal)
    db.session.commit()
    return jsonify({"relay_id": journal.id, "status": journal.status}), 201


@app.route('/relayWithdraw', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60)
@reject_api_token_on_user_routes
@verify_wallet_write
def relay_withdraw_endpoint(wallet=None):
    """Relayer-submitted withdrawal. The client builds the full ZK withdraw proof (bound to a
    proof-locked recipient and to the fee-inclusive gross `amount`), then POSTs it here instead of
    signing the tx in-wallet. The executor hot wallet submits Entrypoint.withdraw(), so the tx
    `From` is the relayer — the withdrawer's own address never appears on-chain.

    Funds are NOT custodied: the recipient is a public signal inside the proof, and the vault sends
    funds directly vault→recipient. The withdrawal fee is applied on-chain by the vault regardless of
    who submits, so there is no fee logic here — the gasReimburse leg of that same fee is what refunds
    the relayer's gas.

    Body: { chain_id, asset, recipient, amount (gross wei, as string), proof:
            { stateRoot, aspRoot, changeLabel, nullifierHashes:[...], changeCommitment, pA, pB:[[..],[..]], pC } }
    Returns: { status, tx_hash }.
    """
    from evm_executor import get_web3, get_executor_account, zk_withdraw_from_vault, FatalExecutionError
    from evm_chain_config import get_evm_chain_config, SUPPORTED_EXECUTOR_CHAIN_IDS

    data = request.json or {}
    relay_id = (request.headers.get('X-Relay-Id') or '').strip().lower()
    if not _valid_relay_id(relay_id):
        return jsonify({"error": "X-Relay-Id must be a 64-character idempotency digest"}), 400
    request_hash = _relay_request_hash(data)
    journal = db.session.get(RelaySubmission, relay_id)
    if journal is None:
        return jsonify({"error": "relay submission was not prepared by the gateway"}), 409
    if journal.request_hash != request_hash or journal.wallet.lower() != (wallet or '').lower():
        return jsonify({"error": "X-Relay-Id was reused for a different payout"}), 409
    if journal.tx_hash:
        return jsonify({"status": journal.status, "tx_hash": journal.tx_hash}), 200
    if journal.status == 'failed':
        return jsonify({"error": journal.error or "relay preparation failed"}), 422
    if journal.status != 'leased':
        return jsonify({"error": "relay submission is already executing"}), 409
    chain_id = data.get('chain_id')
    asset = (data.get('asset') or '').upper()
    recipient = data.get('recipient')
    amount_raw = data.get('amount')
    proof = data.get('proof')

    # ── Input validation (reject before touching the chain) ──────────────────────
    try:
        chain_id = int(chain_id)
    except (TypeError, ValueError):
        return jsonify({"error": "chain_id is required (int)"}), 400
    if chain_id not in SUPPORTED_EXECUTOR_CHAIN_IDS:
        return jsonify({"error": f"unsupported chain_id {chain_id}; supported: {sorted(SUPPORTED_EXECUTOR_CHAIN_IDS)}"}), 400
    if not asset:
        return jsonify({"error": "asset is required"}), 400
    if not recipient:
        return jsonify({"error": "recipient is required"}), 400
    try:
        amount_wei = int(str(amount_raw))
    except (TypeError, ValueError):
        return jsonify({"error": "amount is required (integer wei as string)"}), 400
    if amount_wei <= 0:
        return jsonify({"error": "amount must be > 0"}), 400
    if (
        not isinstance(proof, dict)
        or not proof.get('pA')
        or not proof.get('stateRoot')
        or proof.get('aspRoot') in (None, '')
        or proof.get('changeLabel') in (None, '')
    ):
        return jsonify({
            "error": "proof{stateRoot,aspRoot,changeLabel,nullifierHashes,changeCommitment,pA,pB,pC} is required",
        }), 400

    # Sanctions + format screening on the proof-bound recipient (same gate as the strategy path).
    ok, reason = validate_recipient(recipient, str(chain_id))
    if not ok:
        return jsonify({"error": reason}), 400

    try:
        chain = get_evm_chain_config(chain_id)
        try:
            asset_address = chain.token_address(asset)
        except Exception:
            return jsonify({"error": f"unknown asset '{asset}' on chain {chain_id}"}), 400

        w3 = get_web3(chain)
        if not w3.is_connected():
            return jsonify({"error": f"RPC unavailable for chain {chain_id}"}), 502
        account = get_executor_account(w3, chain_id)

        # Change-note authority goes to the AUTHENTICATED wallet, not the recipient (a fresh,
        # deliberately unlinked address) and not the relayer. `wallet` comes from the write
        # challenge, so a caller cannot assign someone else's note to themselves.
        if not wallet:
            return jsonify({"error": "wallet signature required to assign change-note authority"}), 401
        if not _claim_relay_execution(relay_id):
            return jsonify({"error": "relay execution lease is no longer active"}), 409
        def journal_prepared(tx_hash, raw_transaction):
            _journal_prepared_transaction(relay_id, tx_hash, raw_transaction)

        tx_hash = zk_withdraw_from_vault(
            w3,
            account,
            chain,
            asset_address,
            recipient,
            amount_wei,
            proof,
            wallet,
            on_prepared=journal_prepared,
        )
        journal.status = 'mined'
        journal.tx_hash = tx_hash
        db.session.commit()
        return jsonify({"status": "success", "tx_hash": tx_hash}), 200
    except FatalExecutionError as e:
        # Proof/nullifier failures — retrying will never succeed. Surface as a client error.
        journal.status = 'failed'
        journal.error = str(e)[:1000]
        db.session.commit()
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        print(f"[relayWithdraw] error on chain {chain_id}: {e}")
        if journal.tx_hash:
            # The exact signed transaction was journaled before the ambiguous send/wait failure.
            # Return its deterministic hash; callers and the chain monitor can safely reconcile it.
            journal.status = 'submitted'
            journal.error = str(e)[:1000]
            db.session.commit()
            return jsonify({"status": "submitted", "tx_hash": journal.tx_hash}), 200
        journal.status = 'failed'
        journal.error = str(e)[:1000]
        db.session.commit()
        return jsonify({"error": str(e)}), 500


@app.route('/internal/relay-submissions/<relay_id>', methods=['GET'])
@require_auth
def relay_submission_status(relay_id):
    journal = db.session.get(RelaySubmission, (relay_id or '').lower())
    if not journal:
        return jsonify({"error": "relay submission not found"}), 404
    age = (datetime.utcnow() - journal.updated_at).total_seconds()
    expiry = 300 if journal.status == 'leased' else 900 if journal.status == 'executing' else None
    if expiry is not None and not journal.tx_hash and age > expiry:
        # Atomic status fencing makes expiry safe even if the original HTTP request was queued or
        # is still validating. A late route cannot claim `leased`; a late signer cannot change
        # `executing` to `submitted`, and therefore cannot reach broadcast.
        changed = (
            db.session.query(RelaySubmission)
            .filter(
                RelaySubmission.id == journal.id,
                RelaySubmission.status == journal.status,
                RelaySubmission.tx_hash.is_(None),
            )
            .update({
                "status": "failed",
                "error": f"hashless relay {journal.status} lease expired",
                "updated_at": datetime.utcnow(),
            })
        )
        db.session.commit()
        if changed:
            journal = db.session.get(RelaySubmission, journal.id)
    return jsonify({
        "relay_id": journal.id,
        "status": journal.status,
        "tx_hash": journal.tx_hash,
        "error": journal.error if journal.status == 'failed' else None,
    }), 200


@app.route('/internal/relay-submissions/<relay_id>/recover', methods=['POST'])
@require_auth
def recover_relay_submission(relay_id):
    """Safely rebroadcast the exact pre-journaled raw transaction after an ambiguous crash."""
    from evm_executor import get_web3, verified_prepared_transaction
    from evm_chain_config import get_evm_chain_config

    journal = db.session.get(RelaySubmission, (relay_id or '').lower())
    if not journal:
        return jsonify({"error": "relay submission not found"}), 404
    if not journal.tx_hash or not journal.raw_transaction:
        return jsonify({"error": "relay transaction has not been prepared"}), 409

    chain = get_evm_chain_config(journal.chain_id)
    w3 = get_web3(chain)
    try:
        existing = w3.eth.get_transaction(journal.tx_hash)
    except Exception:
        existing = None
    if existing is None:
        try:
            raw_bytes = verified_prepared_transaction(
                journal.raw_transaction, journal.tx_hash, w3
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 500
        try:
            broadcast_hash = w3.eth.send_raw_transaction(raw_bytes).hex()
            if broadcast_hash.lower() != journal.tx_hash.lower():
                return jsonify({"error": "rebroadcast returned a different transaction hash"}), 500
        except Exception as exc:
            # Concurrent original/recovery sends of identical signed bytes are safe. RPCs commonly
            # report them as already-known instead of returning the existing hash.
            message = str(exc).lower()
            if not any(marker in message for marker in ('already known', 'known transaction')):
                return jsonify({"error": f"relay rebroadcast failed: {exc}"}), 502
    journal.status = 'submitted'
    db.session.commit()
    return jsonify({"status": journal.status, "tx_hash": journal.tx_hash}), 200


@app.route('/relayMerge', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60)
@reject_api_token_on_user_routes
@verify_wallet_write
def relay_merge_endpoint(wallet=None):
    """Relayer-submitted note consolidation. The client builds a merge ZK proof (N input notes → 1
    consolidated note) and POSTs it here instead of signing the merge tx in-wallet. The executor hot
    wallet submits Entrypoint.merge() so consolidation is popup-free during a fragmented withdrawal.

    Merge moves **no funds** and has **no recipient** — the output is a proof-bound mergedCommitment,
    so the relayer cannot redirect anything; worst case is a liveness failure (client retries). There
    is no withdrawal fee / gasReimburse on merge, so the relayer absorbs the (infrequent) gas.

    Gated by the write-challenge (@verify_wallet_write) like every other mutating route — a fresh
    wallet signature is required, so the free-gas relayer path can't be driven anonymously. (Resolves
    the pre-hardening "add wallet-sig gating before mainnet" TODO this endpoint shipped with.)

    Body: { chain_id, asset, proof: { stateRoot, aspRoot, nullifierHashes:[...>=2],
            mergedCommitment, mergedLabel, pA, pB:[[..],[..]], pC } }
    Returns: { status, tx_hash }.
    """
    from evm_executor import get_web3, get_executor_account, zk_merge_from_vault, FatalExecutionError
    from evm_chain_config import get_evm_chain_config, SUPPORTED_EXECUTOR_CHAIN_IDS

    data = request.json or {}
    relay_id = (request.headers.get('X-Relay-Id') or '').strip().lower()
    if not _valid_relay_id(relay_id):
        return jsonify({"error": "X-Relay-Id must be a 64-character idempotency digest"}), 400
    request_hash = _relay_request_hash(data)
    journal = db.session.get(RelaySubmission, relay_id)
    if journal is None:
        return jsonify({"error": "relay submission was not prepared by the gateway"}), 409
    if journal.request_hash != request_hash or journal.wallet.lower() != (wallet or '').lower():
        return jsonify({"error": "X-Relay-Id was reused for a different consolidation"}), 409
    if journal.tx_hash:
        return jsonify({"status": journal.status, "tx_hash": journal.tx_hash}), 200
    if journal.status == 'failed':
        return jsonify({"error": journal.error or "relay preparation failed"}), 422
    if journal.status != 'leased':
        return jsonify({"error": "relay submission is already executing"}), 409
    chain_id = data.get('chain_id')
    asset = (data.get('asset') or '').upper()
    proof = data.get('proof')

    try:
        chain_id = int(chain_id)
    except (TypeError, ValueError):
        return jsonify({"error": "chain_id is required (int)"}), 400
    if chain_id not in SUPPORTED_EXECUTOR_CHAIN_IDS:
        return jsonify({"error": f"unsupported chain_id {chain_id}; supported: {sorted(SUPPORTED_EXECUTOR_CHAIN_IDS)}"}), 400
    if not asset:
        return jsonify({"error": "asset is required"}), 400
    if (
        not isinstance(proof, dict)
        or not proof.get('pA')
        or not proof.get('stateRoot')
        or proof.get('aspRoot') in (None, '')
        or proof.get('mergedLabel') in (None, '')
    ):
        return jsonify({
            "error": "proof{stateRoot,aspRoot,nullifierHashes,mergedCommitment,mergedLabel,pA,pB,pC} is required",
        }), 400
    _nh = proof.get('nullifierHashes')
    if not (isinstance(_nh, list) and len(_nh) >= 2):
        return jsonify({"error": "proof.nullifierHashes must have >=2 entries for a merge"}), 400
    if not (proof.get('mergedCommitment') or proof.get('changeCommitment')):
        return jsonify({"error": "proof.mergedCommitment is required"}), 400

    try:
        chain = get_evm_chain_config(chain_id)
        try:
            asset_address = chain.token_address(asset)
        except Exception:
            return jsonify({"error": f"unknown asset '{asset}' on chain {chain_id}"}), 400

        w3 = get_web3(chain)
        if not w3.is_connected():
            return jsonify({"error": f"RPC unavailable for chain {chain_id}"}), 502
        account = get_executor_account(w3, chain_id)

        if not wallet:
            return jsonify({"error": "wallet signature required to assign merged-note authority"}), 401
        if not _claim_relay_execution(relay_id):
            return jsonify({"error": "relay execution lease is no longer active"}), 409
        def journal_prepared(tx_hash, raw_transaction):
            _journal_prepared_transaction(relay_id, tx_hash, raw_transaction)

        tx_hash = zk_merge_from_vault(
            w3,
            account,
            chain,
            asset_address,
            proof,
            wallet,
            on_prepared=journal_prepared,
        )
        journal.status = 'mined'
        journal.tx_hash = tx_hash
        db.session.commit()
        return jsonify({"status": "success", "tx_hash": tx_hash}), 200
    except FatalExecutionError as e:
        journal.status = 'failed'
        journal.error = str(e)[:1000]
        db.session.commit()
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        print(f"[relayMerge] error on chain {chain_id}: {e}")
        if journal.tx_hash:
            journal.status = 'submitted'
            journal.error = str(e)[:1000]
            db.session.commit()
            return jsonify({"status": "submitted", "tx_hash": journal.tx_hash}), 200
        journal.status = 'failed'
        journal.error = str(e)[:1000]
        db.session.commit()
        return jsonify({"error": str(e)}), 500


@app.route('/withdrawCredit', methods=['GET'])
@rate_limit(max_requests=60, window_seconds=60)
@reject_api_token_on_user_routes
# READ auth, not write. verify_wallet_write consumes a one-shot nonce and the client helper for it
# signs on EVERY call ("a write is something the user just clicked"), so guarding this read popped
# a MetaMask signature on every dashboard load — and when it was not signed the client swallowed
# the failure into "no fee", showing a free withdrawal while the relayer was charging.
@verify_wallet_sig
def withdraw_credit_balance_endpoint(wallet=None):
    """Current prepaid withdrawal-fee balance and the per-withdrawal price.

    `enabled: false` means the relayer charges nothing today; the UI should then quote no fee
    rather than showing a price it will not take.
    """
    import withdraw_credit
    try:
        chain_id = int(request.args.get('chain_id') or 8453)
    except (TypeError, ValueError):
        return jsonify({"error": "chain_id must be an integer"}), 400
    try:
        balance = withdraw_credit.balance_wei(wallet, chain_id)
    except Exception:
        app.logger.exception("withdrawCredit: balance read failed")
        return jsonify({"error": "credit ledger unavailable"}), 503
    return jsonify({
        "enabled": withdraw_credit.enabled(),
        "chain_id": chain_id,
        "fee_wei": str(withdraw_credit.fee_wei()),
        "balance_wei": str(balance),
        "collector": withdraw_credit.collector_address(chain_id),
        "asset": "USDC",
        "decimals": 6,
    }), 200


@app.route('/withdrawCredit/topup', methods=['POST'])
@rate_limit(max_requests=10, window_seconds=60)
@reject_api_token_on_user_routes
@verify_wallet_write
def withdraw_credit_topup_endpoint(wallet=None):
    """Credit a confirmed USDC transfer to the collector.

    Body: { chain_id, tx_hash }. The transfer must come from the authenticated wallet, and each
    transaction can be credited exactly once — the ledger's UNIQUE tx_hash is what enforces that.
    """
    import withdraw_credit
    data = request.json or {}
    try:
        chain_id = int(data.get('chain_id') or 8453)
    except (TypeError, ValueError):
        return jsonify({"error": "chain_id must be an integer"}), 400
    tx_hash = str(data.get('tx_hash') or '').strip()
    try:
        return jsonify(withdraw_credit.verify_topup(wallet, chain_id, tx_hash)), 200
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("withdrawCredit topup failed")
        return jsonify({"error": f"top-up verification failed: {exc}"}), 502


@app.route('/relaySpend', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60)
@reject_api_token_on_user_routes
@verify_wallet_write
def relay_spend_endpoint(wallet=None):
    return _relay_spend(request.json or {}, wallet)


def _relay_spend(data, wallet, on_prepared=None):
    """Relayer-submitted v2/v3 spend. One endpoint for all five actions.

    The client builds the proof and POSTs it here instead of signing in-wallet, so the tx `From`
    is the relayer and the spender's own address never appears on-chain. The action is
    publicInputs[0] and VaultKernel routes to the matching verifier itself, so unlike the v1
    /relayWithdraw and /relayMerge pair this needs no per-action branch.

    Funds are not custodied: every value that moves is a public signal inside the proof and the
    payee is bound to publicInputs by the circuit, so the relayer cannot redirect anything. The
    VaultKernel address is resolved from server config by chain_id and is deliberately NOT taken
    from the request — a caller who could name the target contract could aim a valid proof at a
    contract of their choosing.

    Replay is prevented on-chain by the nullifier set: a resubmitted proof reverts with
    NullifierAlreadyUsed. There is no relay journal here (unlike /relayWithdraw) because nothing
    can be paid out twice; the worst case is the relayer wasting gas on a revert.

    Body: { chain_id, public_inputs: [25], proof: [8], extra: { rawPayee, splitCommitments? } }
    Returns: { status, tx_hash }.
    """
    from evm_executor import (
        get_web3, get_executor_account, vault_kernel_spend,
        SPEND_PUBLIC_WIDTH, SPEND_PROOF_WIDTH, SPEND_SPLIT_OUTPUTS, SPEND_COMPLIANCE_WIDTH,
    )
    from evm_chain_config import get_evm_chain_config, SUPPORTED_EXECUTOR_CHAIN_IDS

    try:
        chain_id = int(data.get('chain_id'))
    except (TypeError, ValueError):
        return jsonify({"error": "chain_id is required (int)"}), 400
    if chain_id not in SUPPORTED_EXECUTOR_CHAIN_IDS:
        return jsonify({"error": f"unsupported chain_id {chain_id}; supported: {sorted(SUPPORTED_EXECUTOR_CHAIN_IDS)}"}), 400

    def _field_list(raw, width, name):
        if not isinstance(raw, (list, tuple)) or len(raw) != width:
            raise ValueError(f"{name} must be a list of {width} values")
        out = []
        for v in raw:
            n = int(str(v), 0) if isinstance(v, str) else int(v)
            if n < 0:
                raise ValueError(f"{name} values must be non-negative")
            out.append(n)
        return out

    try:
        public_inputs = _field_list(data.get('public_inputs'), SPEND_PUBLIC_WIDTH, "public_inputs")
        proof = _field_list(data.get('proof'), SPEND_PROOF_WIDTH, "proof")
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    action = public_inputs[0]
    if action > 4:
        return jsonify({"error": f"unknown action {action}"}), 400

    # The compliance half — COMPLIANCE_CIRCUIT_SPLIT §2.2. Every action but RAGEQUIT must carry it;
    # ragequit is the exit for unadmitted or revoked labels and the kernel skips the conjuncts for
    # it entirely. Reject a missing half here rather than relaying zeros: on-chain that surfaces as
    # LabelCommitMismatch, which reads as a proving fault instead of a client that never sent it.
    try:
        if action == 4:
            compliance_public_inputs = [0] * SPEND_COMPLIANCE_WIDTH
            compliance_proof = [0] * SPEND_PROOF_WIDTH
        else:
            compliance_public_inputs = _field_list(
                data.get('compliancePublicInputs') or data.get('compliance_public_inputs'),
                SPEND_COMPLIANCE_WIDTH, "compliancePublicInputs",
            )
            compliance_proof = _field_list(
                data.get('complianceProof') or data.get('compliance_proof'),
                SPEND_PROOF_WIDTH, "complianceProof",
            )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    extra = data.get('extra') or {}
    raw_payee_str = str(extra.get('rawPayee') or extra.get('raw_payee') or '').strip()
    raw_payee_hex = raw_payee_str[2:] if raw_payee_str.startswith('0x') else raw_payee_str
    try:
        raw_payee = bytes.fromhex(raw_payee_hex)
    except ValueError:
        return jsonify({"error": "extra.rawPayee must be hex"}), 400

    # Only WITHDRAW (0) and RAGEQUIT (4) pay an EOA. MERGE/SWAP/SPLIT re-shield inside the vault
    # and carry no payee, so requiring 20 bytes for every action rejected them outright.
    if action in (0, 4):
        if len(raw_payee) != 20:
            return jsonify({"error": "extra.rawPayee must be a 20-byte address for WITHDRAW/RAGEQUIT"}), 400
        # Screen BEFORE relaying, not after: once the tx is broadcast the payout is unstoppable.
        # Fail-closed — an unavailable screening service blocks the relay rather than waving it on.
        ok, reason = validate_recipient('0x' + raw_payee.hex(), str(chain_id))
        if not ok:
            return jsonify({"error": f"Recipient blocked by compliance screening: {reason}"}), 451
    elif raw_payee and len(raw_payee) != 20:
        return jsonify({"error": "extra.rawPayee must be empty or a 20-byte address"}), 400

    try:
        splits = _field_list(
            (extra.get('splitCommitments') or [0] * SPEND_SPLIT_OUTPUTS),
            SPEND_SPLIT_OUTPUTS, "extra.splitCommitments",
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    chain = get_evm_chain_config(chain_id)
    if not chain.vault_kernel:
        return jsonify({"error": f"no VaultKernel configured for chain {chain_id}"}), 503

    # Withdrawal fee: charged here because the v3 kernel has no fee module and is immutable, so
    # there is nowhere on-chain to take it. Only ACTION_WITHDRAW pays — a merge, split or swap
    # moves nothing out of the vault, and charging those would tax rebalancing.
    #
    # It is SOFT by construction: spend() is permissionless so that a TEE outage can never trap
    # a user's funds, which means anyone can self-submit and pay nothing. This prices the relayer's
    # convenience, and is debited from a PREPAID balance rather than collected per withdrawal —
    # a fee transfer sent moments before a shielded exit would correlate the user's public wallet
    # with it by timing, which is exactly the linkage the vault exists to prevent.
    #
    # Off unless V3_WITHDRAW_FEE_ENABLED, so this cannot strand withdrawals if the frontend has
    # not shipped the top-up UI yet.
    import withdraw_credit
    fee_due = 0
    if action == 0 and withdraw_credit.enabled():
        fee_due = withdraw_credit.fee_wei()
        try:
            available = withdraw_credit.balance_wei(wallet, chain_id)
        except Exception:
            # A ledger read failure must not strand a withdrawal. Fail OPEN and relay unpriced:
            # losing a $0.05 convenience fee is the cheap error, blocking an exit is not.
            app.logger.exception("withdraw fee: balance read failed — relaying unpriced")
            fee_due = 0
            available = 0
        if fee_due and available < fee_due:
            return jsonify({
                "error": "insufficient_withdraw_credit",
                "required_wei": str(fee_due),
                "balance_wei": str(available),
                "detail": (
                    "Top up your withdrawal credit, or submit the proof yourself with "
                    "VaultKernel.spend() — that path is permissionless and costs only gas."
                ),
            }), 402

    try:
        w3 = get_web3(chain)
        account = get_executor_account(w3, chain_id)
        if on_prepared is None and raw_payee and raw_payee.hex() == account.address.lower()[2:]:
            # Only /bridgeWithdraw may relay a payout to the executor: it writes the order that
            # says whose funds these are. Relayed bare, the payout would vanish into the float.
            return jsonify({"error": "this proof pays the executor — submit it to /bridgeWithdraw"}), 400
        tx_hash = vault_kernel_spend(
            w3, account, chain,
            public_inputs=public_inputs,
            proof=proof,
            compliance_public_inputs=compliance_public_inputs,
            compliance_proof=compliance_proof,
            raw_payee=raw_payee,
            split_commitments=splits,
            on_prepared=on_prepared,
        )
    except ValueError as exc:
        # Log it: only the 502 branch below was recorded, so a rejected spend left the browser
        # holding the one copy of the reason and the server with a bare `400` access-log line.
        # These are the interesting failures — a simulated revert names the kernel error that
        # explains why an order died — and reconstructing one after the fact is guesswork.
        app.logger.warning(
            "relaySpend rejected: chain=%s action=%s payee=%s: %s",
            chain_id, action, (raw_payee or b"").hex() or "-", exc,
        )
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("relaySpend failed")
        return jsonify({"error": f"spend submission failed: {exc}"}), 502

    # Debit only after the spend is actually submitted: charging first would bill a user whose
    # withdrawal then reverted. A failed debit is logged and swallowed for the same reason the
    # balance read is — the money already moved on-chain, and the fee is the lesser concern.
    if fee_due:
        try:
            withdraw_credit.debit(wallet, chain_id, fee_due, ref=tx_hash)
        except Exception:
            app.logger.exception("withdraw fee: debit failed after a submitted spend")

    return jsonify({"status": "submitted", "tx_hash": tx_hash}), 200


def _bridge_executor(chain_id):
    from evm_chain_config import get_evm_chain_config, SUPPORTED_EXECUTOR_CHAIN_IDS
    from evm_executor import get_web3, get_executor_account

    if chain_id not in SUPPORTED_EXECUTOR_CHAIN_IDS:
        raise ValueError(f"unsupported chain_id {chain_id}")
    w3 = get_web3(get_evm_chain_config(chain_id))
    return w3, get_executor_account(w3, chain_id)


NO_ROUTE_MSG = "No route for this amount right now — try a larger amount or another destination."


@app.route('/bridgeQuote', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60, bucket="bridge_quote")
def bridge_quote_endpoint():
    """Quote a withdraw-to-any-chain hop. Read-only; tells the client which payee to prove for.

    Body: { chain_id, bridge: { to_chain_id, to_address, to_token?, amount, min_out, refund_address } }
    min_out may be 1 here — the client has not seen a price yet; it sends its real bound on submit.
    """
    import bridge_payout

    data = request.get_json(silent=True) or {}
    try:
        chain_id = int(data.get('chain_id'))
        # `from_token: "ETH"` quotes a strategy payout from an ETH note (it arrives as native ETH).
        from_token = bridge_payout.source_token(chain_id, (data.get('bridge') or {}).get('from_token'))
        native = from_token == bridge_payout.NATIVE
        order = bridge_payout.parse_order(data.get('bridge'), chain_id, native=native)
        _w3, account = _bridge_executor(chain_id)
    except (TypeError, ValueError, RuntimeError) as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        q = bridge_payout.get_quote(chain_id, order["amount"], order, account.address, from_token=from_token)
    except Exception as exc:
        # LI.FI's error embeds the full quote URL (both addresses); log it, don't hand it out.
        print(f"[bridge] no route for chain {order.get('to_chain_id')}: {exc}")
        return jsonify({"error": NO_ROUTE_MSG}), 422
    why = bridge_payout.check_quote(q, chain_id=chain_id, amount=order["amount"], min_out=1, order=order,
                                    from_address=account.address, from_token=from_token)
    if why:
        return jsonify({"error": f"route not executable: {why}"}), 422
    if native and float((q.get("estimate") or {}).get("fromAmountUSD") or 0) < bridge_payout.MIN_USD:
        return jsonify({"error": f"amount below the bridge minimum (${bridge_payout.MIN_USD:g})"}), 400
    return jsonify({"payee": account.address, **bridge_payout.summarize(q)}), 200


@app.route('/bridgeWithdraw', methods=['POST'])
@rate_limit(max_requests=10, window_seconds=60, bucket="bridge_withdraw")
@reject_api_token_on_user_routes
@verify_wallet_write
def bridge_withdraw_endpoint(wallet=None):
    """Withdraw-to-any-chain: relay a WITHDRAW paid to this executor, then bridge what it paid.

    Body: the /relaySpend body plus `bridge` (see /bridgeQuote). The order row is written before
    the spend is broadcast, so the payout is never in the executor wallet without a record of whose
    it is. Bridging happens in the scheduler (bridge_payout.process_bridge_orders); poll
    GET /bridgeOrders/<order_id>.
    """
    import bridge_payout
    from database import BridgeOrder

    data = request.get_json(silent=True) or {}
    try:
        chain_id = int(data.get('chain_id'))
        order = bridge_payout.parse_order(data.get('bridge'), chain_id)
        w3, account = _bridge_executor(chain_id)
        action = int(str((data.get('public_inputs') or [None])[0]), 0)
    except (TypeError, ValueError, IndexError) as exc:
        return jsonify({"error": str(exc)}), 400
    if action != 0:
        return jsonify({"error": "bridgeWithdraw relays WITHDRAW (action 0) only"}), 400
    # The proof, not the request, says what will be paid: [5] primaryValue, [17] assetId =
    # uint160(token) (siphon-contracts-v2 spec/public-inputs.md). Checking the declared order
    # against them is what makes the minimum and the pre-relay price check mean anything.
    try:
        pis = data['public_inputs']
        proof_amount = int(str(pis[5]), 0)
        proof_asset = int(str(pis[17]), 0)
        usdc = bridge_payout._usdc(chain_id)
    except (TypeError, ValueError, IndexError, KeyError) as exc:
        return jsonify({"error": f"bad public_inputs: {exc}"}), 400
    if proof_asset != int(usdc, 16):
        return jsonify({"error": "bridgeWithdraw bridges USDC notes only"}), 400
    if proof_amount != order["amount"]:
        return jsonify({"error": "bridge.amount must equal the proof's withdrawn amount"}), 400
    payee = str((data.get('extra') or {}).get('rawPayee') or '').lower()
    if payee.removeprefix('0x') != account.address.lower().removeprefix('0x'):
        # The kernel pays rawPayee (bound by the proof). Anything else would bridge funds that
        # never arrived, out of the executor's own float.
        return jsonify({"error": f"proof must pay the executor {account.address}", "payee": account.address}), 400
    blocked = bridge_payout.screen_order(order, chain_id)
    if blocked:
        return jsonify({"error": f"Blocked by compliance screening: {blocked}"}), 451

    # Price check BEFORE the irreversible step: no route or a price below the user's bound
    # rejects here, while the note is still in the vault.
    try:
        q = bridge_payout.get_quote(chain_id, order["amount"], order, account.address)
    except Exception as exc:
        # LI.FI's error embeds the full quote URL (both addresses); log it, don't hand it out.
        print(f"[bridge] no route for chain {order.get('to_chain_id')}: {exc}")
        return jsonify({"error": NO_ROUTE_MSG}), 422
    why = bridge_payout.check_quote(q, chain_id=chain_id, amount=order["amount"], min_out=order["min_out"],
                                    order=order, from_address=account.address, from_token=usdc)
    if why:
        return jsonify({"error": f"route not executable: {why}"}), 422

    o = BridgeOrder(
        wallet=(wallet or '').lower() or None, chain_id=chain_id,
        token=usdc.lower(), to_chain_id=str(order["to_chain_id"]),
        to_token=order["to_token"], to_address=order["to_address"], min_out=str(order["min_out"]),
        refund_address=order["refund_address"], status="RELAYING",
    )
    db.session.add(o)
    db.session.commit()

    resp, code = _relay_spend(
        data, wallet, on_prepared=lambda h, _raw: bridge_payout._save(o, spend_tx=bridge_payout._hex(h)),
    )
    body = resp.get_json() or {}
    if code != 200:
        # Not broadcast (validation, fee, simulated revert) → nothing moved. A 502 after broadcast
        # leaves spend_tx set, and the worker settles it from the receipt.
        if not o.spend_tx:
            bridge_payout._save(o, status="FAILED", error=str(body.get("error"))[:500])
        if code == 402:
            # Self-submitting a proof that pays the executor would strand the funds: no order.
            body["detail"] = "Top up your withdrawal credit to bridge. Do not submit this proof yourself."
        return jsonify({**body, "order_id": o.id}), code

    # send_tx already saw the receipt, but this provider may sit on a lagging backend: retry
    # briefly, then leave the order RELAYING for the worker rather than guessing.
    for _ in range(5):
        try:
            r = bridge_payout._receipt(w3, o.spend_tx)
        except Exception:
            r = None
        if r is not None:
            bridge_payout.mark_received(o, w3, r, account.address)
            break
        time.sleep(2)
    return jsonify({**body, "order_id": o.id, "order": o.to_dict()}), 200


@app.route('/bridgeOrders/<order_id>', methods=['GET'])
@rate_limit(max_requests=120, window_seconds=60, bucket="bridge_orders")
def bridge_order_status(order_id):
    """Order status. The id is a random UUID returned only to the submitter."""
    from database import BridgeOrder

    o = BridgeOrder.query.get(order_id)
    if not o:
        return jsonify({"error": "not found"}), 404
    return jsonify(o.to_dict()), 200


@app.route('/admin/bridgeOrders', methods=['GET'])
@require_admin
def admin_bridge_orders():
    from database import BridgeOrder

    # FAILED with a spend_tx means something was broadcast — keep it visible.
    rows = BridgeOrder.query.filter(
        BridgeOrder.status.notin_(["DONE", "REFUNDED", "FAILED"])
        | ((BridgeOrder.status == "FAILED") & BridgeOrder.spend_tx.isnot(None))
    ).order_by(BridgeOrder.created_at.desc()).limit(200).all()
    return jsonify({"orders": [o.to_dict() for o in rows]}), 200


@app.route('/admin/bridgeOrders/<order_id>/refund', methods=['POST'])
@require_admin
def admin_bridge_refund(order_id):
    """Operator verified a REVIEW order's funds are back in the executor: refund them."""
    from database import BridgeOrder

    o = BridgeOrder.query.get(order_id)
    if not o or o.status != "REVIEW" or not o.amount_in:
        return jsonify({"error": "only a REVIEW order with a known amount can be refunded"}), 409
    if o.refund_tx:
        return jsonify({"error": f"a refund was already broadcast ({o.refund_tx}) — check it on chain"}), 409
    o.status = "REFUND_DUE"
    db.session.commit()
    return jsonify(o.to_dict()), 200


@app.route('/admin/solana/process-staged', methods=['POST'])
@require_admin
def admin_solana_process_staged():
    """Finish SETTLING Devnet rows (spend already landed; swap/return still open)."""
    from database import Strategy
    from solana_devnet_strategy import process_staged, settle_strategy_row

    before = [
        {"id": s.id, "status": s.status}
        for s in Strategy.query.filter_by(status="SETTLING", from_chain=str(900002)).all()
    ]
    sid = (request.json or {}).get("strategy_id") if request.is_json else None
    if sid:
        result = settle_strategy_row(sid)
        row = Strategy.query.get(sid)
        return jsonify({
            "ok": True,
            "before": before,
            "result": {k: result.get(k) for k in ("ok", "status", "code", "error", "tx_hash")},
            "status": None if row is None else row.status,
        }), 200
    process_staged()
    after = [
        {"id": s.id, "status": s.status}
        for s in Strategy.query.filter(
            Strategy.id.in_([b["id"] for b in before]) if before else [None]
        ).all()
    ] if before else []
    return jsonify({"ok": True, "before": before, "after": after}), 200


@app.route('/pipeline/prove-hop', methods=['POST'])
@rate_limit(max_requests=30, window_seconds=60)
def pipeline_prove_hop_endpoint():
    """TEE/mock prove for the next private pipeline hop (MPC-shaped provePipelineHop).

    Body: { strategy_id, hop_index, public_context }. Loads sealed_bundle from the strategy row
    unless public_context supplies sealed_bundle (arm-time tests).
    """
    import pipeline_tee
    from database import Strategy

    data = request.json or {}
    sid = data.get("strategy_id")
    try:
        hop_index = int(data.get("hop_index"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "hop_index must be an integer"}), 400
    if not sid:
        return jsonify({"ok": False, "error": "strategy_id required"}), 400
    public_context = data.get("public_context") or {}
    if not isinstance(public_context, dict):
        return jsonify({"ok": False, "error": "public_context must be an object"}), 400

    row = Strategy.query.get(sid)
    if row is None:
        return jsonify({"ok": False, "error": "strategy not found"}), 404
    sealed = public_context.get("sealed_bundle") or pipeline_tee.sealed_bundle_of(row.to_dict())
    if not sealed:
        return jsonify({"ok": False, "error": "sealed_bundle missing on strategy"}), 400
    try:
        out = pipeline_tee.prove_pipeline_hop(
            str(sid), hop_index, sealed_bundle=str(sealed), public_context=public_context
        )
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    if not out.get("ok"):
        return jsonify(out), 502
    return jsonify({"ok": True, "package": out["package"]}), 200


@app.route('/spend/arm', methods=['POST'])
@rate_limit(max_requests=60, window_seconds=60)
def spend_arm_endpoint():
    """Hand one sealed v3 strategy leg to the enclave.

    The browser posts here (siphon-app/src/lib/v3/armLegV3.ts::submitArmedLeg) rather than to the
    CVM directly, because the CVM is not reachable from a browser origin. This route is a pure
    conduit: `sealedSecrets` is a crypto_box_seal blob bound to the enclave's ATTESTED x25519 key,
    which the browser verified against a DCAP quote before sealing. The executor cannot open it,
    and must not try to normalise it — re-encoding would corrupt the ciphertext.

    Deliberately not behind @verify_wallet_write: the browser sends no wallet signature on this
    path, and a signature would buy little. An attacker cannot forge a usable leg — that needs note
    secrets they do not have — so the only abuse is storage spam in the enclave, which the rate
    limit bounds. Anything stronger belongs at the CVM, via DECRYPTOR_AUTH_TOKEN.
    """
    from decryptor_client import arm_spend_leg, decryptor_enabled

    if not decryptor_enabled():
        return jsonify({"ok": False, "error": "DECRYPTOR_URL not configured"}), 503

    data = request.json or {}
    for field in ("strategyId", "legIndex", "sealedSecrets", "public"):
        if data.get(field) is None:
            return jsonify({"ok": False, "error": f"{field} is required"}), 400
    try:
        int(data["legIndex"])
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "legIndex must be an integer"}), 400

    leg_key, err = arm_spend_leg(data)
    if err:
        # Log it as well as returning it. The browser surfaces only the status code, so a 502 whose
        # reason lives solely in the response body is invisible on both sides at once.
        print(f"[Executor] /spend/arm rejected by the enclave: {err}", flush=True)
        # 502, not 500: the failure is downstream in the CVM, and the browser should be able to
        # tell "the enclave rejected this" from "the executor is broken".
        return jsonify({"ok": False, "error": err}), 502
    return jsonify({"ok": True, "legKey": leg_key}), 200


@app.route('/execution-events', methods=['GET'])
@require_auth
def get_execution_events():
    """Retrieve all execution events for reconciliation (gateway internal only)."""
    events = ExecutionEvent.query.order_by(ExecutionEvent.created_at.asc()).all()
    return jsonify([
        {
            "id": e.id,
            "strategy_id": e.strategy_id,
            "tx_hash": e.tx_hash,
            "billing_ref": e.billing_ref,
            "created_at": e.created_at.isoformat() if e.created_at else None
        } for e in events
    ]), 200


if __name__ == '__main__':

    # Dev path: gunicorn isn't involved; start scheduler unless explicitly disabled.
    if os.getenv('RUN_SCHEDULER_IN_WORKER', '1') == '1':
        start_scheduler()
    app.run(port=5005, debug=False)
