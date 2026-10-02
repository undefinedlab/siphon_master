"""Guards the TWAP-eval-throttling fix: skip legs whose earliest possible fire slot
(plaintext anchor + leg_index*interval, NOT the encrypted fire-time itself) is still far off,
without ever needing to decrypt the actual rung. Grid (price) legs are never skipped."""
import importlib.util
from pathlib import Path


def _load_scheduler():
    path = Path(__file__).parents[1] / "scheduler.py"
    spec = importlib.util.spec_from_file_location("siphon_scheduler_under_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_far_future_twap_leg_is_skipped():
    scheduler = _load_scheduler()
    # leg 5 of a 60s-interval TWAP fires earliest at t=300s; we're only 10s into the strategy.
    assert scheduler._leg_not_yet_due('time', leg_index=5, interval_sec=60, elapsed=10) is True


def test_twap_leg_near_its_slot_is_evaluated():
    scheduler = _load_scheduler()
    # leg 5 fires earliest at t=300s; at t=295s (within slop) it must be evaluated.
    assert scheduler._leg_not_yet_due('time', leg_index=5, interval_sec=60, elapsed=295) is False


def test_twap_leg_past_its_slot_is_evaluated():
    scheduler = _load_scheduler()
    assert scheduler._leg_not_yet_due('time', leg_index=0, interval_sec=60, elapsed=1000) is False


def test_grid_price_leg_is_never_skipped_by_time():
    scheduler = _load_scheduler()
    # eval_mode='price' (RANGE_GRID) has no time bound — must always be evaluated regardless
    # of how "early" it looks by leg_index*interval.
    assert scheduler._leg_not_yet_due('price', leg_index=5, interval_sec=60, elapsed=0) is False


def test_missing_interval_never_skips():
    scheduler = _load_scheduler()
    assert scheduler._leg_not_yet_due('time', leg_index=5, interval_sec=0, elapsed=0) is False
    assert scheduler._leg_not_yet_due('time', leg_index=5, interval_sec=None, elapsed=0) is False
