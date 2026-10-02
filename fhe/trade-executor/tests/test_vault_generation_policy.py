from vault_generation import validate_strategy_generation, validate_strategy_provenance


def test_active_generation_is_strategy_eligible(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    result = validate_strategy_generation(
        {"from_chain": "8453", "vault_generation_id": "base-hard-asp-v1"}
    )
    assert result == {"ok": True, "code": None, "generation_id": "base-hard-asp-v1"}


def test_legacy_generation_is_exit_only(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    monkeypatch.setenv("EXIT_ONLY_VAULT_GENERATIONS", "base-legacy-2026-07,sepolia-soft-era")
    result = validate_strategy_generation(
        {"from_chain": "8453", "vault_generation_id": "base-legacy-2026-07"}
    )
    assert result["ok"] is False
    assert result["code"] == "VAULT_EXIT_ONLY"


def test_missing_generation_fails_closed_for_old_rows(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    result = validate_strategy_generation({"from_chain": "8453"})
    assert result["ok"] is False
    assert result["code"] == "VAULT_GENERATION_REQUIRED"


def test_client_cannot_select_an_unknown_generation(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    result = validate_strategy_generation(
        {"from_chain": "8453", "vault_generation_id": "made-up-current"}
    )
    assert result["ok"] is False
    assert result["code"] == "VAULT_GENERATION_NOT_ACTIVE"


def test_strategy_proof_is_bound_to_active_indexer_and_entrypoint(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1")
    monkeypatch.setenv("INDEXER_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1")
    monkeypatch.setenv(
        "ACTIVE_VAULT_ENTRYPOINT_11155111",
        "0x1111111111111111111111111111111111111111",
    )
    payload = {
        "from_chain": "11155111",
        "vault_generation_id": "sepolia-hard-asp-v1",
        "asset_in": "USDC",
        "zk_proof": {"stateRoot": "1234", "aspRoot": "5678"},
    }
    result = validate_strategy_provenance(
        payload,
        configured_entrypoint="0x1111111111111111111111111111111111111111",
        root_lookup=lambda chain_id, asset, root: (chain_id, asset, root)
        == (11155111, "USDC", "1234"),
    )
    assert result == {"ok": True, "code": None, "generation_id": "sepolia-hard-asp-v1"}


def test_strategy_provenance_rejects_indexer_generation_mismatch(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    monkeypatch.setenv("INDEXER_VAULT_GENERATION_8453", "base-legacy-2026-07")
    result = validate_strategy_provenance({
        "from_chain": "8453",
        "vault_generation_id": "base-hard-asp-v1",
    })
    assert result["ok"] is False
    assert result["code"] == "VAULT_INDEXER_GENERATION_MISMATCH"


def test_strategy_provenance_rejects_unknown_active_indexer_root(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1")
    monkeypatch.setenv("INDEXER_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1")
    monkeypatch.setenv(
        "ACTIVE_VAULT_ENTRYPOINT_11155111",
        "0x1111111111111111111111111111111111111111",
    )
    result = validate_strategy_provenance(
        {
            "from_chain": "11155111",
            "vault_generation_id": "sepolia-hard-asp-v1",
            "asset_in": "ETH",
            "zk_proof": {"stateRoot": "9999", "aspRoot": "1"},
        },
        configured_entrypoint="0x1111111111111111111111111111111111111111",
        root_lookup=lambda *_args: False,
    )
    assert result["ok"] is False
    assert result["code"] == "VAULT_PROOF_ROOT_UNKNOWN"


def test_strategy_provenance_rejects_any_malformed_multileg_proof(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1")
    monkeypatch.setenv("INDEXER_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1")
    monkeypatch.setenv("ACTIVE_VAULT_ENTRYPOINT_11155111", "0x1111111111111111111111111111111111111111")
    result = validate_strategy_provenance(
        {
            "from_chain": "11155111",
            "vault_generation_id": "sepolia-hard-asp-v1",
            "asset_in": "USDC",
            "legs": [
                {"zk_proof": {"stateRoot": "1234"}},
                {"zk_proof": None},
            ],
        },
        configured_entrypoint="0x1111111111111111111111111111111111111111",
        root_lookup=lambda *_args: True,
    )
    assert result["ok"] is False
    assert result["code"] == "VAULT_PROOF_ROOT_UNKNOWN"
