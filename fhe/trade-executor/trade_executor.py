def execute_private_withdrawal(strategy, current_price, on_withdraw_confirmed=None):
    """
    Execute a private withdrawal with ZK proof, then swap. EVM-only (Base / ETH Sepolia).

    on_withdraw_confirmed: optional callable(tx_hash) invoked the instant the ZK
    withdraw receipt confirms on-chain (status==1), so the caller can mark the
    nullifier spent before the subsequent swap runs.
    """
    print("\n" + "=" * 60)
    print(f"✅ PRIVATE EXECUTION: Strategy '{strategy['id']}'")

    raw_chain = strategy.get("from_chain") or strategy.get("chain_id") or strategy.get("to_chain") or "8453"
    asset_in = (strategy.get("asset_in") or "").upper()
    asset_out = (strategy.get("asset_out") or "").upper()
    print(f"   [Route] EVM executor (chain={raw_chain}, asset_in={asset_in or '∅'} → {asset_out or '∅'})")

    from evm_executor import execute_evm_trade
    return execute_evm_trade(strategy, current_price, on_withdraw_confirmed=on_withdraw_confirmed)
