"""Log redaction — known-sensitive field names are masked wherever they appear in a log line."""
import logging

from app.logging_config import JsonFormatter, RedactionFilter, _redact


def test_redact_masks_sensitive_values():
    assert "0xdead" not in _redact("nullifier=0xdead")
    assert "REDACTED" in _redact("nullifier=0xdead")
    assert "hunter2" not in _redact('{"private_key": "hunter2"}')
    assert "sk_live_abc" not in _redact("api_key=sk_live_abc")


def test_non_sensitive_values_are_preserved():
    out = _redact("chain_id=8453 amount=1000")
    assert "8453" in out and "1000" in out


def test_formatter_emits_json_with_redaction():
    rec = logging.LogRecord("t", logging.INFO, __file__, 1,
                            "witness=0xbeef and ok=1", args=(), exc_info=None)
    RedactionFilter().filter(rec)
    line = JsonFormatter().format(rec)
    assert "0xbeef" not in line
    assert "ok=1" in line
    import json
    assert json.loads(line)["level"] == "INFO"   # valid JSON
