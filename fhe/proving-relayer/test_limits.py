"""Checks for the prove-endpoint resource controls.

Runnable standalone: `python test_limits.py`. No pytest, no fixtures — the point is that the two
things protecting the box (a per-caller rate limit and a hard concurrency cap) fail loudly if
someone removes them, plus the empty-env parse that would otherwise crash the service at import.
"""
import os
import threading
import time

os.environ.setdefault('API_TOKEN', 'testtoken')
# Deliberately EMPTY, exactly as `- PROVE_CONCURRENCY=${PROVE_CONCURRENCY:-}` writes it.
os.environ['PROVE_CONCURRENCY'] = ''
os.environ['PROVE_RATE_PER_MIN'] = '3'
os.environ['PROVE_QUEUE_WAIT_S'] = '0.2'

import app as relayer  # noqa: E402


def test_empty_env_does_not_crash():
    """`FOO=${FOO:-}` sets '' not unset; int('') raises. Regression guard for the import crash."""
    assert relayer.PROVE_CONCURRENCY >= 1
    assert relayer.PROVE_RATE_PER_MIN == 3
    assert abs(relayer.PROVE_QUEUE_WAIT_S - 0.2) < 1e-9
    assert relayer._num_env('NOPE_NOT_SET', 7, int) == 7
    os.environ['BAD_NUM'] = 'twelve'
    assert relayer._num_env('BAD_NUM', 9, int) == 9  # garbage must not crash either


def test_rate_limit_is_per_caller():
    """One caller exhausting its window must not affect a different caller."""
    a, b = 'wallet:0xaaa', 'wallet:0xbbb'
    assert all(relayer._rate_ok(a) for _ in range(3)), "first 3 should pass"
    assert not relayer._rate_ok(a), "4th must be limited"
    assert relayer._rate_ok(b), "a different caller must be unaffected"


def test_concurrency_cap_rejects_rather_than_queues_forever():
    """Slots are bounded, and exhaustion returns promptly instead of blocking indefinitely."""
    n = relayer.PROVE_CONCURRENCY
    got = [relayer._slots.acquire(timeout=0.1) for _ in range(n)]
    assert all(got), "should be able to take exactly PROVE_CONCURRENCY slots"

    t0 = time.monotonic()
    assert not relayer._slots.acquire(timeout=0.2), "over-cap acquire must fail"
    waited = time.monotonic() - t0
    assert waited < 1.0, f"must fail fast, waited {waited:.2f}s"

    for _ in range(n):
        relayer._slots.release()


def test_slot_is_released_when_proving_raises():
    """A leaked slot shrinks capacity permanently until restart — the worst failure mode here."""
    before = relayer.PROVE_CONCURRENCY

    def boom(*_a, **_k):
        raise RuntimeError("prover exploded")

    orig = relayer.generate_proof
    relayer.generate_proof = boom
    try:
        client = relayer.app.test_client()
        r = client.post('/prove',
                        json={'inputs': {'a': 1}, 'circuit': 'w1'},
                        headers={'X-API-TOKEN': 'testtoken', 'X-Forwarded-For': '9.9.9.9'})
        assert r.status_code == 500, r.status_code
    finally:
        relayer.generate_proof = orig

    taken = [relayer._slots.acquire(timeout=0.1) for _ in range(before)]
    assert all(taken), "capacity must be intact after a failed proof"
    for _ in range(before):
        relayer._slots.release()


def test_unauthenticated_is_rejected_before_any_work():
    client = relayer.app.test_client()
    r = client.post('/prove', json={'inputs': {'a': 1}, 'circuit': 'w1'})
    assert r.status_code == 401, r.status_code


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f"ok  {name}")
    print("\nall checks passed")
