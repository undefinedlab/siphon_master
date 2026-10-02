import vault_index


def test_chain_reads_are_routed_to_independent_schema_engines(monkeypatch):
    base = object()
    sepolia = object()
    monkeypatch.setattr(vault_index, "_engines", {8453: base, 11155111: sepolia})

    assert vault_index._engine_for_chain(8453) is base
    assert vault_index._engine_for_chain(11155111) is sepolia


def test_unsupported_chain_never_falls_through_to_another_schema(monkeypatch):
    monkeypatch.setattr(vault_index, "_engines", {8453: object(), 11155111: object()})

    assert vault_index._engine_for_chain(1) is None


def test_base_strategy_roots_never_use_legacy_indexer(monkeypatch):
    legacy = object()
    current = object()
    monkeypatch.setattr(vault_index, "_engines", {8453: legacy})
    monkeypatch.setattr(vault_index, "_active_generation_engines", {8453: current})

    assert vault_index._engine_for_chain(8453) is legacy
    assert vault_index._active_generation_engines[8453] is current


def test_aggregate_health_keeps_chain_failures_independent(monkeypatch):
    monkeypatch.setattr(vault_index, "_engines", {8453: object(), 11155111: object()})
    monkeypatch.setattr(
        vault_index,
        "_chain_health",
        lambda _engine, chain_id: (
            {"ok": True, "leafCount": 57, "tipBlockNumber": 100}
            if chain_id == 8453
            else {"ok": False, "error": "Sepolia unavailable"}
        ),
    )

    from flask import Flask
    flask_app = Flask(__name__)
    flask_app.register_blueprint(vault_index.vault_index_bp)
    response = flask_app.test_client().get("/vault-index/health")

    assert response.status_code == 200
    assert response.json["ok"] is False
    assert response.json["chains"]["8453"]["ok"] is True
    assert response.json["chains"]["11155111"]["ok"] is False
