import gzip
import hashlib
import json as _json
import time
from functools import lru_cache

import requests
from config import FHE_ENGINE_URL, FHE_ENGINE_TREE_URL, FHE_ENGINE_BATCH_URL

# The FHE engine no longer decrypts. These helpers return the *encrypted* result ciphertext
# (hex) that the scheduler stores on the strategy; the user's browser decrypts it locally.

# One keep-alive session for all engine calls — the scheduler makes many per tick.
_session = requests.Session()


@lru_cache(maxsize=16)
def _key_hash(server_key_hex):
    """sha256 of the key hex — the engine's KeyCache reference. lru_cache keys on the
    string object (CPython caches str.__hash__), so the ~24MB digest runs once per key."""
    return hashlib.sha256(server_key_hex.encode()).hexdigest()


def post_engine(payload, server_key, url=FHE_ENGINE_URL, timeout=120):
    """POST to the engine hash-first: send server_key_hash alone so a warm engine skips
    the 24MB upload AND the seconds-long key expansion. On 428 (engine cache miss) retry
    once with the full key inline. Returns parsed JSON; raises on HTTP/network errors."""
    body = dict(payload, server_key_hash=_key_hash(server_key))
    resp = _session.post(url, json=body, timeout=timeout)
    if resp.status_code == 428:  # key_not_cached — cold engine, send the real thing
        body["server_key"] = server_key
        # gzip the one big body (24MB key hex → ~7MB); level 1 is fast and plenty for hex
        data = gzip.compress(_json.dumps(body).encode(), compresslevel=1)
        resp = _session.post(url, data=data, timeout=timeout, headers={
            "Content-Type": "application/json", "Content-Encoding": "gzip",
        })
    resp.raise_for_status()
    return resp.json()


# The frontend labels simple limit orders LIMIT_BUY / LIMIT_SELL, but the FHE engine's
# /evaluateStrategy only knows LIMIT_BUY_DIP (price <= lower) / LIMIT_SELL_RALLY (price >= upper).
# The semantics are identical, so translate at the boundary.
ENGINE_STRATEGY_TYPE = {
    "LIMIT_BUY": "LIMIT_BUY_DIP",
    "LIMIT_SELL": "LIMIT_SELL_RALLY",
}


def build_strategy_payload(strategy, current_price):
    """Engine payload for a single-strategy eval (sans server_key), or None if malformed.
    Shared by the per-strategy path and the batch pre-pass."""
    # TWAP / DCA / RANGE_GRID are multi-leg: they MUST be evaluated per-leg (build_leg_payload),
    # never as a single strategy. A leg-less one here means a malformed submission — skip it so a
    # degenerate TWAP_SLICE/grid eval can't be sent to the engine. Keep this set in step with
    # app.py's `is_multi_leg`; DCA was added there and missed here, so a leg-less DCA fell through
    # and shipped the engine a literal "DCA" strategy_type it has no arm for.
    if strategy.get('strategy_type') in ('TWAP', 'DCA', 'RANGE_GRID'):
        print(f"   -> [FHE Client] ⚠️ {strategy.get('strategy_type')} '{strategy['id']}' has no legs — skipping (multi-leg only)")
        return None
    strategy_type = strategy["strategy_type"]
    if strategy_type == "POLYMARKET":
        # Odds trigger rides the engine's one-sided price arms: "odds fall below X" is a
        # buy-the-dip compare (price <= lower), "odds rise above X" a sell-rally compare
        # (price >= upper). "Execute now" is encoded by the frontend as below-100, which is
        # always true for a 0..100 odds feed. Direction travels in poly_meta.trigger_dir.
        meta = strategy.get("poly_meta") or {}
        direction = str(meta.get("trigger_dir") or "below").lower()
        strategy_type = "LIMIT_SELL_RALLY" if direction == "above" else "LIMIT_BUY_DIP"
    elif strategy_type == "HYPERLIQUID":
        # Entry trigger on mark USD: above → LIMIT_SELL_RALLY, below → LIMIT_BUY_DIP.
        # "Execute now" = below a huge bound (frontend sets lower_bound very high).
        meta = strategy.get("hl_meta") or {}
        direction = str(meta.get("trigger_dir") or "below").lower()
        strategy_type = "LIMIT_SELL_RALLY" if direction == "above" else "LIMIT_BUY_DIP"
    else:
        strategy_type = ENGINE_STRATEGY_TYPE.get(strategy_type, strategy_type)
    return {
        "strategy_type": strategy_type,
        "encrypted_upper_bound": strategy.get("encrypted_upper_bound") or "",
        "encrypted_lower_bound": strategy.get("encrypted_lower_bound") or "",
        "current_price_cents": int(current_price * 100),
    }


def get_encrypted_result(strategy, current_price, server_key):
    """Call /evaluateStrategy and return the encrypted result hex (or None on error)."""
    payload = build_strategy_payload(strategy, current_price)
    if payload is None:
        return None
    print(f"   -> [FHE Client] Evaluating strategy '{strategy['id']}' on the FHE engine...")
    try:
        result = post_engine(payload, server_key, url=FHE_ENGINE_URL, timeout=60)
        if result.get("error"):
            print(f"   <- [FHE Client] ❌ engine error: {result['error']}")
            return None
        return result.get("encrypted_result")
    except Exception as e:
        print(f"   <- [FHE Client] ❌ An error occurred: {e}")
        return None


# Map a grid leg's side to the engine's one-sided price arm:
#   buy rung  fires when price <= rung  -> LIMIT_BUY_DIP   (encrypted_lower_bound)
#   sell rung fires when price >= rung  -> LIMIT_SELL_RALLY (encrypted_upper_bound)
_GRID_SIDE_ENGINE_TYPE = {
    "LIMIT_BUY": "LIMIT_BUY_DIP",
    "LIMIT_SELL": "LIMIT_SELL_RALLY",
    "BUY": "LIMIT_BUY_DIP",
    "SELL": "LIMIT_SELL_RALLY",
}


def build_leg_payload(leg, current_price, now_ts=None):
    """Engine payload for ONE leg of a multi-leg strategy (sans server_key), or None.
    Shared by the per-leg path and the batch pre-pass."""
    eval_mode = (leg.get("eval_mode") or "price").lower()
    if eval_mode == "time":
        engine_type = "TWAP_SLICE"
    else:
        side = (leg.get("side") or "").upper()
        engine_type = _GRID_SIDE_ENGINE_TYPE.get(side)
        if not engine_type:
            print(f"   <- [FHE Client] ❌ grid leg missing/unknown side '{side}'")
            return None
    # The engine's EvaluationPayload requires both bounds as String (not nullable). A leg only
    # sets the bound it uses (TWAP/buy-rung → lower, sell-rung → upper), so send "" for the
    # unused one — the chosen arm only deserializes the bound it needs.
    return {
        "strategy_type": engine_type,
        "encrypted_upper_bound": leg.get("encrypted_upper_bound") or "",
        "encrypted_lower_bound": leg.get("encrypted_lower_bound") or "",
        "current_price_cents": int(current_price * 100),
        "current_time": int(now_ts if now_ts is not None else time.time()),
    }


def get_encrypted_leg_result(leg, current_price, server_key, now_ts=None):
    """Evaluate ONE leg of a multi-leg strategy and return the encrypted trigger hex.

    A TWAP slice (eval_mode 'time') compares an encrypted fire-time against the public current
    unix time (TWAP_SLICE). A grid rung (eval_mode 'price') is a one-sided price trigger keyed
    by the leg's side. The encrypted bound never leaves ciphertext on the server.

    `leg` is a StrategyLeg.to_dict() (or any dict with eval_mode/side/encrypted_* fields).
    """
    payload = build_leg_payload(leg, current_price, now_ts)
    if payload is None:
        return None
    try:
        result = post_engine(payload, server_key, url=FHE_ENGINE_URL, timeout=60)
        if result.get("error"):
            print(f"   <- [FHE Client] ❌ engine error (leg {leg.get('leg_index')}): {result['error']}")
            return None
        return result.get("encrypted_result")
    except Exception as e:
        print(f"   <- [FHE Client] ❌ leg eval error: {e}")
        return None


def get_encrypted_tree_result(condition_tree, prices_cents, server_key):
    """Call /evaluateTree (homomorphic AND/OR/NOT) and return the encrypted result hex.

    prices_cents: { price_feed_id -> int price in cents }
    """
    try:
        payload = {
            "tree": condition_tree,
            "prices": prices_cents,
        }
        result = post_engine(payload, server_key, url=FHE_ENGINE_TREE_URL, timeout=120)
        if result.get("error"):
            print(f"[FHE Client] ❌ evaluateTree error: {result['error']}")
            return None
        return result.get("encrypted_result")
    except Exception as e:
        print(f"[FHE Client] ❌ get_encrypted_tree_result error: {e}")
        return None


def get_batch_results(items, prices_cents=None, timeout=300):
    """Evaluate every job of a scheduler tick in ONE engine round trip (/evaluateBatch).

    items: list of (job_id, payload, server_key) where payload is build_strategy_payload /
    build_leg_payload output or {"tree": condition_tree}. Jobs go hash-only; the engine
    evaluates them in parallel (rayon). Jobs whose key the engine hasn't cached come back in
    `missing_keys` and are retried individually via post_engine (whose 428 path uploads the key).

    Returns {job_id: encrypted_result_hex} (errored ids absent), or None if the batch call
    itself failed — callers fall back to the per-strategy path.
    """
    if not items:
        return {}
    jobs = [dict(p, id=jid, server_key_hash=_key_hash(sk)) for jid, p, sk in items]
    try:
        resp = _session.post(FHE_ENGINE_BATCH_URL,
                             json={"prices": prices_cents or {}, "jobs": jobs},
                             timeout=timeout)
        resp.raise_for_status()
        out = resp.json()
    except Exception as e:
        print(f"[FHE Client] ❌ evaluateBatch failed: {e}")
        return None
    results = out.get("results") or {}
    missing = set(out.get("missing_keys") or [])
    for jid, msg in (out.get("errors") or {}).items():
        if msg != "key_not_cached":
            print(f"[FHE Client] ❌ batch job {jid}: {msg}")
    for jid, payload, sk in items:
        if jid in results or _key_hash(sk) not in missing:
            continue
        url = FHE_ENGINE_TREE_URL if "tree" in payload else FHE_ENGINE_URL
        if "tree" in payload:
            payload = dict(payload, prices=prices_cents or {})
        try:
            r = post_engine(payload, sk, url=url, timeout=timeout)
            if r.get("encrypted_result"):
                results[jid] = r["encrypted_result"]
            elif r.get("error"):
                print(f"[FHE Client] ❌ cold-key retry {jid}: {r['error']}")
        except Exception as e:
            print(f"[FHE Client] ❌ cold-key retry {jid}: {e}")
    return results
