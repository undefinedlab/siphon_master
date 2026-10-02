import solana_runtime as runtime


def test_describe_devnet_mvp_status():
    d = runtime.describe_solana_runtime()
    assert d["programId"] == runtime.SIPHON_PROGRAM_ID
    assert d["status"] in ("devnet-mvp", "scaffold")
    assert d["chainId"] in runtime.SOLANA_CHAIN_IDS


def test_configured_accounts_derive_vault_pda():
    accounts = runtime._configured_accounts()
    assert accounts["vault"]
    assert accounts["compliance"]
    assert accounts["vault"] != accounts["compliance"]


def test_confirm_missing_tx_is_pending():
    result = runtime.confirm_solana_deposit(
        "1111111111111111111111111111111111111111111111111111111111111111"
    )
    assert result["ok"] is False
    assert result["pending"] is True
    assert result["status"] in ("not_found", "rpc_error")
