"""
Read-only API over Ponder's indexed on-chain data
(merkle leaves + vault deposits + vault swaps).

Connects to independent chain-scoped Ponder schemas in the siphon_indexer database.

Agents (Builder / MCP) and the dapp hit /vault-index/anonymity-set, /leaves, /swaps, etc.
"""
import os
from flask import Blueprint, request, jsonify
from sqlalchemy import create_engine, text

INDEXER_DB_URI_BASE = os.environ.get("INDEXER_DB_URI_BASE", "")
INDEXER_DB_URI_BASE_CURRENT = os.environ.get("INDEXER_DB_URI_BASE_CURRENT", "")
INDEXER_DB_URI_SEPOLIA = os.environ.get("INDEXER_DB_URI_SEPOLIA", "")
# Compatibility fallback for a single-schema local environment. Production compose sets both
# chain-specific URIs; never point both at the same Ponder schema in production.
INDEXER_DB_URI = os.environ.get("INDEXER_DB_URI", "")


def _new_engine(uri):
    return create_engine(uri, pool_pre_ping=True) if uri else None


_engines = {
    8453: _new_engine(INDEXER_DB_URI_BASE or INDEXER_DB_URI),
    11155111: _new_engine(INDEXER_DB_URI_SEPOLIA or INDEXER_DB_URI),
}

# Strategy provenance must never consult the Base legacy schema. Base stays closed until a
# separately indexed current-generation schema is configured. Sepolia's normal schema is current.
_active_generation_engines = {
    8453: _new_engine(INDEXER_DB_URI_BASE_CURRENT),
    11155111: _new_engine(INDEXER_DB_URI_SEPOLIA or INDEXER_DB_URI),
}

# Retired (EXIT_ONLY) generations, served under /vault-index-legacy/* so legacy-vault migration
# can read the old tree while /vault-index/* stays on the ACTIVE generation. Both lanes must be
# reachable at once: the migration withdraw proof needs the retired tree, and the redeposit
# needs the current one. Without this the two lanes can only be served by separate hosts.
_legacy_engines = {
    8453: _new_engine(os.environ.get("INDEXER_DB_URI_BASE_LEGACY", "")),
    11155111: _new_engine(os.environ.get("INDEXER_DB_URI_SEPOLIA_LEGACY", "")),
}

vault_index_bp = Blueprint("vault_index", __name__)

ASSET_ALIASES = {
    "ETH": "ETH",
    "USDC": "USDC",
    "NATIVE": "ETH",
}

MAX_PAGE = 100_000


def _engine_for_chain(chain_id, legacy=False):
    if legacy:
        return _legacy_engines.get(chain_id)
    return _engines.get(chain_id)


def _configured_engines():
    return {chain_id: engine for chain_id, engine in _engines.items() if engine is not None}


def is_known_root(chain_id: int, asset: str, root: str) -> bool:
    """Return whether this root was produced by the chain-scoped active indexer."""
    normalized_asset = ASSET_ALIASES.get(str(asset or "").upper())
    engine = _active_generation_engines.get(int(chain_id))
    if engine is None or not normalized_asset or not str(root or "").strip():
        return False
    try:
        with engine.connect() as conn:
            row = conn.execute(
                text(
                    "SELECT 1 FROM merkle_leaf "
                    "WHERE chain_id = :chain_id AND asset = :asset AND root = :root LIMIT 1"
                ),
                {"chain_id": int(chain_id), "asset": normalized_asset, "root": str(root)},
            ).first()
        return row is not None
    except Exception:
        return False


def _chain_health(engine, chain_id):
    try:
        with engine.connect() as conn:
            row = conn.execute(
                text(
                    "SELECT COUNT(*) AS n, MAX(block_number) AS tip "
                    "FROM merkle_leaf WHERE chain_id = :chain_id"
                ),
                {"chain_id": chain_id},
            ).mappings().first()
        return {
            "ok": True,
            "leafCount": int(row["n"]) if row else 0,
            "tipBlockNumber": int(row["tip"]) if row and row["tip"] is not None else None,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@vault_index_bp.route("/vault-index/health", methods=["GET"])
def vault_index_health():
    requested_chain = request.args.get("chainId", type=int)
    engines = (
        {requested_chain: _engine_for_chain(requested_chain)}
        if requested_chain
        else _configured_engines()
    )
    if not engines or any(engine is None for engine in engines.values()):
        return jsonify({"ok": False, "error": "chain indexer is not configured"}), 503
    chains = {
        str(chain_id): _chain_health(engine, chain_id)
        for chain_id, engine in engines.items()
    }
    # `chains` reports the v1/EXIT_ONLY lane, which on Base is deliberately frozen — its tip block
    # is ~1M behind head and that is CORRECT for a retired generation. Reported alongside it, not
    # instead of it: a reader comparing the two can see which generation is live, whereas the
    # legacy tip alone reads as a stalled indexer.
    for chain_id, engine in engines.items():
        active = _active_generation_engines.get(int(chain_id))
        # Compare by URL, not identity: both maps call _new_engine() separately, so a chain whose
        # active and legacy lanes are the SAME database still yields two distinct objects. An `is`
        # check misses that and reports a spurious "state_commitment does not exist" for chains
        # that simply have one generation.
        if active is None or str(active.url) == str(engine.url):
            continue
        try:
            with active.connect() as conn:
                row = conn.execute(
                    text(
                        "SELECT COUNT(*) AS n, MAX(block_number) AS tip "
                        "FROM state_commitment WHERE chain_id = :chain_id"
                    ),
                    {"chain_id": int(chain_id)},
                ).mappings().first()
            chains[str(chain_id)]["activeGeneration"] = {
                "ok": True,
                "leafCount": int(row["n"] or 0) if row else 0,
                "tipBlockNumber": int(row["tip"]) if row and row["tip"] is not None else None,
            }
        except Exception as e:
            chains[str(chain_id)]["activeGeneration"] = {"ok": False, "error": str(e)[:120]}

    ok = all(result["ok"] for result in chains.values())
    # A chain-specific readiness probe remains strict. The aggregate is an observational endpoint:
    # return both statuses so a Sepolia outage cannot hide a healthy Base data plane.
    status = 200 if requested_chain is None or ok else 503
    return jsonify({"ok": ok, "chains": chains}), status


@vault_index_bp.route("/vault-index/leaves", methods=["GET"], defaults={"lane": "current"})
@vault_index_bp.route("/vault-index-legacy/leaves", methods=["GET"], defaults={"lane": "legacy"})
def list_leaves(lane):
    """Ordered merkle leaves for chain+asset, optionally from fromIndex (incremental sync).

    Response includes tipRoot/totalCount/contiguous so clients can verify against chain and
    refuse to append a gapped page.

    The /vault-index-legacy variant reads the retired generation's schema instead, for
    legacy-vault migration. Same query contract, so clients only change the base URL.
    """
    chain_id = request.args.get("chainId", type=int)
    asset = ASSET_ALIASES.get((request.args.get("asset") or "").upper())
    if not chain_id or not asset:
        return jsonify({"error": "chainId and asset are required"}), 400
    engine = _engine_for_chain(chain_id, legacy=(lane == "legacy"))
    if engine is None:
        return jsonify({"error": "Indexer not configured for chain"}), 503

    from_index = request.args.get("fromIndex", default=0, type=int)
    if from_index is None or from_index < 0:
        return jsonify({"error": "fromIndex must be a non-negative integer"}), 400

    limit = request.args.get("limit", type=int)
    if limit is not None and limit < 1:
        return jsonify({"error": "limit must be a positive integer"}), 400
    if limit is not None:
        limit = min(limit, MAX_PAGE)

    try:
        with engine.connect() as conn:
            total = conn.execute(
                text(
                    """
                    SELECT COUNT(*) AS n
                    FROM merkle_leaf
                    WHERE chain_id = :chain_id AND asset = :asset
                    """
                ),
                {"chain_id": chain_id, "asset": asset},
            ).mappings().first()
            total_count = int(total["n"]) if total else 0

            tip = conn.execute(
                text(
                    """
                    SELECT leaf, leaf_index, root, block_number
                    FROM merkle_leaf
                    WHERE chain_id = :chain_id AND asset = :asset
                    ORDER BY leaf_index DESC
                    LIMIT 1
                    """
                ),
                {"chain_id": chain_id, "asset": asset},
            ).mappings().first()

            sql = """
                SELECT leaf, leaf_index, root
                FROM merkle_leaf
                WHERE chain_id = :chain_id AND asset = :asset
                  AND leaf_index >= :from_index
                ORDER BY leaf_index ASC
            """
            params = {"chain_id": chain_id, "asset": asset, "from_index": from_index}
            if limit is not None:
                sql += " LIMIT :lim"
                params["lim"] = limit

            rows = conn.execute(text(sql), params).mappings().all()

        contiguous = True
        for i, r in enumerate(rows):
            if int(r["leaf_index"]) != from_index + i:
                contiguous = False
                break

        tip_leaf_index = int(tip["leaf_index"]) if tip else None
        tip_block_number = int(tip["block_number"]) if tip else None
        if from_index == 0 and total_count > 0 and tip_leaf_index != total_count - 1:
            contiguous = False

        return jsonify({
            "chainId": chain_id,
            "asset": asset,
            "fromIndex": from_index,
            "count": len(rows),
            "totalCount": total_count,
            "nextIndex": from_index + len(rows) if contiguous else from_index,
            "tipRoot": tip["root"] if tip else None,
            "tipLeafIndex": tip_leaf_index,
            "tipBlockNumber": tip_block_number,
            "contiguous": contiguous,
            "leaves": [r["leaf"] for r in rows],
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500



def _find_v3_output_note(chain_id, precommitment):
    """Resolve a v3 vault-mode output note, which `vault_deposit` cannot answer.

    Two things changed under this endpoint at v3 and neither was carried over:

      1. A SWAP's user output is emitted as `swap_user_dest`, not `vault_deposit`.
      2. The v3 Ponder schema has no `precommitment` column at all — only `commitment` —
         so no query keyed on a precommitment can match, in either table.

    The precommitment is still the only handle the browser has, so the bridge is the strategies
    DB: it stores `output_precommitment` alongside the `tx_hash` the executor broadcast, and the
    indexer keys both v3 tables by that same tx. Returns the legacy response shape so the client
    needs no change.

    Reads the ACTIVE-generation engine only. The Base legacy schema must never answer here — it
    belongs to a retired generation, and a note resolved against a dead tree is worse than one
    that stays unresolved, because the caller would stop falling back to its RPC scan.
    """
    engine = _active_generation_engines.get(chain_id)
    if engine is None:
        return None

    tx_hash = None
    try:
        from database import Strategy

        row = (
            Strategy.query
            .filter(Strategy.output_precommitment == str(precommitment))
            .filter(Strategy.tx_hash.isnot(None))
            .order_by(Strategy.created_at.desc())
            .first()
        )
        tx_hash = row.tx_hash if row else None
    except Exception:
        # No app context, no such strategy, DB hiccup — fall through; the caller still returns
        # found:false and the browser still has its RPC scan.
        return None
    if not tx_hash:
        return None

    # A vault-mode output is a swap dest; a plain deposit lands in vault_deposit. Same tx either
    # way, so ask both rather than guessing which shape produced this note.
    for table in ("swap_user_dest", "vault_deposit"):
        try:
            with engine.connect() as conn:
                row = conn.execute(
                    text(
                        f"""
                        SELECT amount, commitment, block_number, tx_hash
                        FROM {table}
                        WHERE chain_id = :chain_id AND lower(tx_hash) = lower(:tx_hash)
                        ORDER BY block_number DESC
                        LIMIT 1
                        """
                    ),
                    {"chain_id": chain_id, "tx_hash": tx_hash},
                ).mappings().first()
        except Exception:
            continue  # table absent on this generation's schema
        if row:
            return {
                "found": True,
                "amount": str(row["amount"]),
                "commitment": str(row["commitment"]),
                "precommitment": str(precommitment),
                "blockNumber": int(row["block_number"]),
                "txHash": row["tx_hash"],
                "source": table,
            }
    return None


@vault_index_bp.route("/vault-index/deposits", methods=["GET"])
def find_deposit():
    """Look up a vault deposit by precommitment (for output-note resolution)."""
    chain_id = request.args.get("chainId", type=int)
    precommitment = (request.args.get("precommitment") or "").strip()
    if not chain_id or not precommitment:
        return jsonify({"error": "chainId and precommitment are required"}), 400
    engine = _engine_for_chain(chain_id)
    if engine is None:
        return jsonify({"error": "Indexer not configured for chain"}), 503

    try:
        with engine.connect() as conn:
            row = conn.execute(
                text(
                    """
                    SELECT amount, commitment, precommitment, label, nonce, block_number, tx_hash
                    FROM vault_deposit
                    WHERE chain_id = :chain_id AND precommitment = :precommitment
                    ORDER BY block_number DESC
                    LIMIT 1
                    """
                ),
                {"chain_id": chain_id, "precommitment": precommitment},
            ).mappings().first()
        if not row:
            # v3 lives in a different table, a different column set and a different schema —
            # see _find_v3_output_note.
            v3 = _find_v3_output_note(chain_id, precommitment)
            return jsonify(v3 or {"found": False}), 200
        return jsonify({
            "found": True,
            "amount": row["amount"],
            "commitment": row["commitment"],
            "precommitment": row["precommitment"],
            "label": row.get("label"),
            "nonce": row.get("nonce"),
            "blockNumber": int(row["block_number"]),
            "txHash": row["tx_hash"],
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500



def _v3_token_for_asset(chain_id, asset):
    """Asset symbol -> the token address v3 actually records. A native-ETH note names WETH."""
    try:
        from evm_chain_config import get_evm_chain_config

        cfg = get_evm_chain_config(int(chain_id))
        if asset == "ETH":
            return (cfg.weth or "").lower() or None
        if asset == "USDC":
            return (cfg.usdc or "").lower() or None
    except Exception:
        pass
    return None


def _v3_anonymity(chain_id, asset):
    """Anonymity counters from the ACTIVE generation, whose schema is shaped differently.

    v1 kept a per-asset `merkle_leaf` table; v3 has ONE NoteTree for the whole chain, recorded as
    `state_commitment`, so leafCount is chain-wide and is not filtered by asset — that is the real
    anonymity set, not a per-asset slice of it. Deposits and swaps key on `token` rather than
    `asset`, and a native-ETH note names WETH.

    Returns None when no active-generation engine is configured or its schema does not answer, so
    the caller falls back to the legacy lane rather than reporting zeros.
    """
    engine = _active_generation_engines.get(int(chain_id))
    if engine is None:
        return None
    token = _v3_token_for_asset(chain_id, asset)
    try:
        with engine.connect() as conn:
            leaf = conn.execute(
                text(
                    "SELECT COUNT(*) AS n, MAX(block_timestamp) AS t "
                    "FROM state_commitment WHERE chain_id = :chain_id"
                ),
                {"chain_id": int(chain_id)},
            ).mappings().first()

            def _count(table):
                if token is None:
                    return 0
                try:
                    row = conn.execute(
                        text(
                            f"SELECT COUNT(*) AS n FROM {table} "
                            "WHERE chain_id = :chain_id AND lower(token) = :token"
                        ),
                        {"chain_id": int(chain_id), "token": token},
                    ).mappings().first()
                    return int(row["n"] or 0) if row else 0
                except Exception:
                    return 0

            deposits = _count("vault_deposit")
            swaps = _count("swap_user_dest")
    except Exception:
        return None
    if leaf is None:
        return None
    return {
        "chainId": int(chain_id),
        "asset": asset,
        "leafCount": int(leaf["n"] or 0),
        "depositCount": deposits,
        "swapCount": swaps,
        "lastLeafAt": int(leaf["t"]) if leaf["t"] is not None else None,
        "source": "ponder-v3",
    }


@vault_index_bp.route("/vault-index/anonymity-set", methods=["GET"])
def anonymity_set():
    """Agent fallback: leaf/deposit/swap counters (mirrors Ponder /anonymity-set)."""
    chain_id = request.args.get("chainId", type=int)
    asset = ASSET_ALIASES.get((request.args.get("asset") or "").upper())
    if not chain_id or not asset:
        return jsonify({"error": "chainId and asset are required"}), 400
    # ACTIVE generation first. `_engines` is the v1/EXIT_ONLY lane — on Base it is frozen (its
    # indexer stopped when the generation was retired), so answering from it reports a dead
    # vault's anonymity set to an agent deciding whether it is safe to arm. Falls back to that
    # lane when no active-generation engine is configured, which is the pre-v3 behaviour.
    v3 = _v3_anonymity(chain_id, asset)
    if v3 is not None:
        return jsonify(v3), 200

    engine = _engine_for_chain(chain_id)
    if engine is None:
        return jsonify({"error": "Indexer not configured for chain"}), 503

    try:
        with engine.connect() as conn:
            leaf_row = conn.execute(
                text(
                    """
                    SELECT COUNT(*) AS leaf_count, MAX(block_timestamp) AS last_leaf_at
                    FROM merkle_leaf
                    WHERE chain_id = :chain_id AND asset = :asset
                    """
                ),
                {"chain_id": chain_id, "asset": asset},
            ).mappings().first()
            deposit_row = conn.execute(
                text(
                    """
                    SELECT COUNT(*) AS deposit_count
                    FROM vault_deposit
                    WHERE chain_id = :chain_id AND asset = :asset
                    """
                ),
                {"chain_id": chain_id, "asset": asset},
            ).mappings().first()
            swap_count = 0
            try:
                swap_row = conn.execute(
                    text(
                        """
                        SELECT COUNT(*) AS swap_count
                        FROM vault_swap
                        WHERE chain_id = :chain_id AND asset = :asset
                        """
                    ),
                    {"chain_id": chain_id, "asset": asset},
                ).mappings().first()
                swap_count = int(swap_row["swap_count"] or 0) if swap_row else 0
            except Exception:
                # Table may not exist until Ponder migrates Swapped indexing.
                swap_count = 0

        last_leaf = leaf_row["last_leaf_at"] if leaf_row else None
        return jsonify({
            "chainId": chain_id,
            "asset": asset,
            "leafCount": int(leaf_row["leaf_count"] or 0) if leaf_row else 0,
            "depositCount": int(deposit_row["deposit_count"] or 0) if deposit_row else 0,
            "swapCount": swap_count,
            "lastLeafAt": int(last_leaf) if last_leaf is not None else None,
            "source": "ponder",
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@vault_index_bp.route("/vault-index/swaps", methods=["GET"])
def list_swaps():
    """Recent Vault.Swapped rows (legacy swap + atomic swapAndDeposit)."""
    chain_id = request.args.get("chainId", type=int)
    limit = min(request.args.get("limit", default=10, type=int) or 10, 50)
    if not chain_id:
        return jsonify({"error": "chainId is required"}), 400
    engine = _engine_for_chain(chain_id)
    if engine is None:
        return jsonify({"error": "Indexer not configured for chain"}), 503

    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    """
                    SELECT id, asset, recipient, pool, amount_in, min_amount_out,
                           block_timestamp, tx_hash
                    FROM vault_swap
                    WHERE chain_id = :chain_id
                    ORDER BY block_timestamp DESC
                    LIMIT :lim
                    """
                ),
                {"chain_id": chain_id, "lim": limit},
            ).mappings().all()
        return jsonify({
            "chainId": chain_id,
            "swaps": [
                {
                    "id": r["id"],
                    "asset": r["asset"],
                    "recipient": r["recipient"],
                    "pool": r["pool"],
                    "amountIn": r["amount_in"],
                    "minAmountOut": r["min_amount_out"],
                    "blockTimestamp": int(r["block_timestamp"]),
                    "txHash": r["tx_hash"],
                }
                for r in rows
            ],
            "source": "ponder",
        }), 200
    except Exception as e:
        # Missing vault_swap until indexer redeploy — empty list, not 500.
        msg = str(e).lower()
        if "vault_swap" in msg or "does not exist" in msg:
            return jsonify({"chainId": chain_id, "swaps": [], "source": "ponder"}), 200
        return jsonify({"error": str(e)}), 500


@vault_index_bp.route("/vault-index/balance", methods=["GET"])
def vault_balance():
    """PROTOCOL-WIDE cumulative deposits per asset for a chain (never decremented on
    withdrawal) — an ops/TVL metric, NOT any user's balance. Per-user balances come
    from the user's own encrypted notes client-side.
    Returns: { chainId, balances: { ETH: "1230000000000000000", USDC: "5000000" } }
    """
    chain_id = request.args.get("chainId", type=int)
    if not chain_id:
        return jsonify({"error": "chainId is required"}), 400
    engine = _engine_for_chain(chain_id)
    if engine is None:
        return jsonify({"error": "Indexer not configured for chain"}), 503

    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    """
                    SELECT asset, SUM(CAST(amount AS NUMERIC)) AS total
                    FROM vault_deposit
                    WHERE chain_id = :chain_id
                    GROUP BY asset
                    """
                ),
                {"chain_id": chain_id},
            ).mappings().all()
        balances = {r["asset"]: str(int(r["total"])) for r in rows if r["total"] is not None}
        return jsonify({"chainId": chain_id, "balances": balances}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500
