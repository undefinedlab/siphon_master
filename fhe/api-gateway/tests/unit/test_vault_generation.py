from app.services.vault_generation import resolve_deposit_generation, validate_strategy_generation


def test_gateway_accepts_only_the_configured_active_generation(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    monkeypatch.setenv("EXIT_ONLY_VAULT_GENERATIONS", "base-legacy-2026-07")
    ok = validate_strategy_generation(8453, "base-hard-asp-v1")
    wrong = validate_strategy_generation(8453, "base-legacy-2026-07")
    assert ok == {"valid": True, "code": None}
    assert wrong == {"valid": False, "code": "VAULT_EXIT_ONLY"}


def test_gateway_rejects_missing_generation(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-hard-asp-v1")
    result = validate_strategy_generation(8453, None)
    assert result == {"valid": False, "code": "VAULT_GENERATION_REQUIRED"}


def test_gateway_fails_closed_when_chain_has_no_active_generation(monkeypatch):
    monkeypatch.delenv("ACTIVE_VAULT_GENERATION_999", raising=False)
    result = validate_strategy_generation(999, "anything")
    assert result == {"valid": False, "code": "VAULT_GENERATION_UNAVAILABLE"}


def test_deposit_generation_is_server_selected_and_fails_closed(monkeypatch):
    monkeypatch.delenv("ACTIVE_VAULT_GENERATION_8453", raising=False)
    assert resolve_deposit_generation(8453) == {
        "valid": False, "code": "VAULT_GENERATION_UNAVAILABLE", "generation_id": None,
    }
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_11155111", "sepolia-hard-asp-v1")
    monkeypatch.setenv("EXIT_ONLY_VAULT_GENERATIONS", "base-legacy-2026-07,sepolia-soft-era")
    assert resolve_deposit_generation(11155111) == {
        "valid": True, "code": None, "generation_id": "sepolia-hard-asp-v1",
    }


def test_deposit_rejects_misconfigured_exit_only_active_generation(monkeypatch):
    monkeypatch.setenv("ACTIVE_VAULT_GENERATION_8453", "base-legacy-2026-07")
    monkeypatch.setenv("EXIT_ONLY_VAULT_GENERATIONS", "base-legacy-2026-07")
    assert resolve_deposit_generation(8453)["code"] == "VAULT_EXIT_ONLY"
