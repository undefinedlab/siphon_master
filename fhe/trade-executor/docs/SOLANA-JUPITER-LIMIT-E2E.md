# Solana faucet + Jupiter SOL/USDC limit (public bootstrap)

Private `siphon-vault` spend is not live. Until then, Solana Limit Orders use **public Jupiter Trigger**.

## Flow

```text
Phantom connect (solana-devnet or mainnet)
    → Faucet 1 SOL (devnet only)     POST /solana/faucet
    → Craft Trigger deposit           POST /solana/jupiter/limit/craft
    → Phantom signs deposit tx
    → Submit price order              POST /solana/jupiter/limit/submit
```

## App

1. Switch network to **Solana Devnet** in the nav.
2. Open **UserDash** — `SolanaDepositPanel` + **Jupiter SOL/USDC Limit** panel.
3. Set `NEXT_PUBLIC_EXECUTOR_URL` to the trade-executor.
4. Click **Faucet 1 SOL** (devnet).
5. For a live Jupiter limit (mainnet): fund wallet, set executor `JUPITER_API_KEY`, switch cluster/RPC to mainnet, **Place Jupiter limit**.

## CLI

```bash
cd siphon-fhe/trade-executor
set SOLANA_NETWORK=devnet
python scripts/e2e_jupiter_limit_sol_usdc.py --faucet --pubkey <PHANTOM>

set JUPITER_API_KEY=...
python scripts/e2e_jupiter_limit_sol_usdc.py --craft --pubkey <PHANTOM> --amount 100000000 --price 200 --side LIMIT_SELL
```

## Honest privacy note

Bridge/Jupiter legs are **public**. Siphon private notes resume only after vault deposit once BPF verify is live.
