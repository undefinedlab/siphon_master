# Devnet strategy E2E (Sepolia vault + tSOL)

## What was wired

- SOL in Quick Swap / Build / Discover token lists
- Devnet Solana product → EVM Quick Swap (vault on Sepolia), not Jupiter-only
- Executor `SOL` → tSOL address
- Empty ASP roots published to ComplianceHub
- Local ASP `:5056` + full trade-executor `:5005` + app `:3005`

## Run

```powershell
# terminals
cd siphon-asp-v2; python run_devnet_asp.py
cd siphon-fhe/trade-executor; python run_devnet_executor.py   # :5020
cd siphon-app; $env:NEXT_DIST_DIR=".next-dev-sepolia-strat2"; npx next dev -p 3006
# optional admit loop:
cd siphon-asp-v2; python postman.py loop --chain-id 11155111
cd siphon-asp-v2; python scripts/watch_deposits.py --chain-id 11155111 --loop
```

App: http://localhost:3006 → Devnet → MetaMask Sepolia.

## Still required for fire/swap

1. **Admit existing notes** — prior deposits were screened with ASP off. **Re-deposit** (or re-screen with `userSalt`+commitment) so the watcher can admit; then postman publishes roots.
2. **Decryptor / FHE** — strategy fire needs decryptor (`DECRYPTOR_URL`, Phala) or browser decrypt + FHE engine `:5001`. Arm/create may work; autonomous fire will not without these.
3. **tSOL/WETH Uniswap liquidity** — pool `0x8230af07…` exists but needs NPM liquidity for SOL↔ETH Quick Swap fills.

## Li.Fi

Still unavailable on Solana Devnet — Mainnet only.
