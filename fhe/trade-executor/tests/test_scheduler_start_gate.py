import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


def _load_gunicorn_config():
    path = Path(__file__).parents[1] / "gunicorn.conf.py"
    spec = importlib.util.spec_from_file_location("siphon_gunicorn_config", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_scheduler_is_not_imported_or_started_when_gate_is_disabled(monkeypatch):
    monkeypatch.setenv("RUN_SCHEDULER_IN_WORKER", "0")
    module = _load_gunicorn_config()
    server = SimpleNamespace(log=SimpleNamespace(warning=Mock(), info=Mock()))

    module.post_fork(server, SimpleNamespace(pid=123))

    server.log.warning.assert_called_once()
    server.log.info.assert_not_called()

