"""Self-check for window expiry (scheduler._is_expired / _anchor_epoch).
  venv/bin/python test_expiry.py
Regression guard for "1h window never expired": expiry must not silently no-op when
schedule_anchor is null — it falls back to created_at, parsed as UTC (not local tz)."""
import time
from scheduler import _is_expired, _anchor_epoch

# created_at is a naive-UTC ISO string (datetime.utcnow().isoformat()). epoch 1e9 == this, in UTC.
assert _anchor_epoch({'created_at': '2001-09-09T01:46:40'}) == 1_000_000_000.0, \
    "created_at must be read as UTC, not local time"

# schedule_anchor wins when present.
assert _anchor_epoch({'schedule_anchor': 123, 'created_at': '2001-09-09T01:46:40'}) == 123

now = int(time.time())
# Windowed order older than its window → expired, even with NO schedule_anchor (the bug: it didn't).
old_iso = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(now - 7200))
assert _is_expired({'execution_window_sec': 3600, 'created_at': old_iso}) is True, \
    "1h window, created 2h ago, no anchor → must expire via created_at fallback"
# Fresh order within window → not expired.
fresh_iso = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(now - 60))
assert _is_expired({'execution_window_sec': 3600, 'created_at': fresh_iso}) is False
# No window set → never expires (unbounded order).
assert _is_expired({'created_at': old_iso}) is False
# Neither anchor nor created_at → safe False, no crash.
assert _is_expired({'execution_window_sec': 3600}) is False

print("OK — expiry falls back to created_at (UTC) when schedule_anchor is missing")
