import os
import threading
import time
from collections import defaultdict, deque

from flask import Flask, request, jsonify
from flask_cors import CORS
from prover import generate_proof
from config import PORT, VALID_CIRCUITS
from wallet_auth import _check_wallet_sig

app = Flask(__name__)

_DEFAULT_CORS_ORIGINS = [
    "https://siphon.money",
    "https://www.siphon.money",
    "https://siphon-app.vercel.app",
    "https://siphon-judge.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
_CORS_ORIGINS = _DEFAULT_CORS_ORIGINS + [
    o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()
]
CORS(
    app,
    resources={r"/*": {
        "origins": _CORS_ORIGINS,
        "allow_headers": [
            "Content-Type",
            "X-API-TOKEN",
            "Authorization",
            "X-Wallet-Address",
            "X-Signature",
            "X-Timestamp",
            "X-Forwarded-For",
        ],
        "methods": ["GET", "POST", "OPTIONS"],
    }},
)

# Dual-accept for zero-downtime token rotation: accept API_TOKEN and (optionally) API_TOKEN_OLD,
# mirroring the trade-executor. Deploy accepting {new, old}, roll the frontend to the new token,
# then drop API_TOKEN_OLD.
_API_TOKENS = {t for t in (os.getenv('API_TOKEN', ''), os.getenv('API_TOKEN_OLD', '')) if t}

# --- Resource control -------------------------------------------------------------------------
# Proof generation is CPU-bound and takes seconds. Without a bound, N concurrent requests become N
# concurrent rapidsnark processes on a 2-vCPU box: everything thrashes, healthy proofs time out,
# and the failure looks like "proving is broken" rather than "proving is overloaded". A semaphore
# turns overload into a fast, honest 503 instead of a slow collapse.
def _num_env(name: str, default, cast):
    """os.getenv(name, default) returns '' when the var is SET BUT EMPTY, and int('') raises.

    Compose writes exactly that for `- FOO=${FOO:-}`, which is the idiomatic way to say "no
    default, inherit if present" — so the obvious `int(os.getenv(...))` crashes the service at
    import on a perfectly ordinary compose file. Treat empty as absent.
    """
    raw = (os.getenv(name) or '').strip()
    if not raw:
        return default
    try:
        return cast(raw)
    except ValueError:
        print(f"[config] {name}={raw!r} is not a valid number; using {default}")
        return default


PROVE_CONCURRENCY = max(1, _num_env('PROVE_CONCURRENCY', max(1, (os.cpu_count() or 2) - 1), int))
# How long a request waits for a slot before giving up. Short on purpose: the caller falls back to
# browser-side snarkjs on a non-200, so a fast rejection is better than a long hold.
PROVE_QUEUE_WAIT_S = _num_env('PROVE_QUEUE_WAIT_S', 3.0, float)
# Per-caller fixed window. Generous for a real user (a withdrawal needs one proof), tight enough
# that a single caller cannot monopolise the queue.
PROVE_RATE_PER_MIN = max(1, _num_env('PROVE_RATE_PER_MIN', 20, int))

_slots = threading.BoundedSemaphore(PROVE_CONCURRENCY)
_hits: dict[str, deque] = defaultdict(deque)
_hits_lock = threading.Lock()


def _check_token() -> bool:
    if not _API_TOKENS:
        return False
    token = (
        request.headers.get('X-API-TOKEN') or
        request.headers.get('Authorization', '').removeprefix('Bearer ')
    ).strip()
    return token in _API_TOKENS


def _caller_id() -> str:
    """Best available identity for rate limiting, most specific first.

    The shared API token is deliberately NOT an identity: every browser reaches us through one
    server-side proxy holding one token, so keying on it would put every user in a single bucket —
    one abuser would deny proving to everyone. A wallet signature identifies an actual user; the
    forwarded client IP is the fallback when the caller has not signed.
    """
    wallet = _check_wallet_sig()
    if wallet:
        return f"wallet:{wallet}"
    # First hop of X-Forwarded-For is the client as seen by our own proxy. Only trusted because
    # this service is not internet-facing — it sits behind Caddy and the app's server-side route.
    xff = (request.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
    if xff:
        return f"ip:{xff}"
    return f"ip:{request.remote_addr or 'unknown'}"


def _rate_ok(caller: str) -> bool:
    now = time.monotonic()
    with _hits_lock:
        q = _hits[caller]
        while q and now - q[0] > 60.0:
            q.popleft()
        if len(q) >= PROVE_RATE_PER_MIN:
            return False
        q.append(now)
        # Bound the dict so a flood of distinct IPs cannot grow it without limit.
        if len(_hits) > 10_000:
            for k in [k for k, v in _hits.items() if not v][:5_000]:
                del _hits[k]
        return True


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'service': 'proving-relayer',
        'concurrency': PROVE_CONCURRENCY,
        'rate_per_min': PROVE_RATE_PER_MIN,
    }), 200


@app.route('/prove', methods=['POST'])
def prove():
    if not _check_token():
        return jsonify({'error': 'Unauthorized'}), 401

    caller = _caller_id()
    if not _rate_ok(caller):
        return jsonify({'error': 'Rate limit exceeded'}), 429, {'Retry-After': '60'}

    data    = request.json or {}
    inputs  = data.get('inputs')
    circuit = data.get('circuit', '').lower()

    if not inputs or not isinstance(inputs, dict):
        return jsonify({'error': 'Missing or invalid inputs'}), 400
    if circuit not in VALID_CIRCUITS:
        return jsonify({'error': f"Invalid circuit '{circuit}'. Valid: {sorted(VALID_CIRCUITS)}"}), 400

    # Validate BEFORE taking a slot — a malformed request must not occupy capacity a real proof
    # is waiting for.
    if not _slots.acquire(timeout=PROVE_QUEUE_WAIT_S):
        return jsonify({
            'error': 'Prover busy, retry shortly',
            'concurrency': PROVE_CONCURRENCY,
        }), 503, {'Retry-After': '5'}

    t0 = time.monotonic()
    try:
        result = generate_proof(inputs, circuit)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except RuntimeError as e:
        return jsonify({'error': str(e)}), 500
    finally:
        # In finally, not after the return: an exception path that leaked a slot would shrink
        # capacity permanently until restart.
        _slots.release()

    elapsed_ms = (time.monotonic() - t0) * 1000
    print(f"[Benchmark] circuit={circuit} proof={elapsed_ms:.1f}ms caller={caller}")
    return jsonify({**result, 'elapsed_ms': elapsed_ms}), 200


if __name__ == '__main__':
    # threaded=True is explicit: the semaphore above only bounds anything if requests can actually
    # run concurrently, and a single-threaded server would serialise everything behind one slow proof.
    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True)
