# Solana Devnet — Private Jupiter Earn (jlUSDC notes)

Private yield on Devnet: shielded USDC becomes a private **jlUSDC** note (Earn shares), then Exit redeems back to private USDC (+accrued yield). Same unlinkability model as Meteora (public settle wallet, private notes).

## Flow

```
Enter: USDC note → WITHDRAW to settlement → Jupiter Earn deposit → vault return (jlUSDC note)
Exit:  jlUSDC note → WITHDRAW to settlement → Jupiter Earn withdraw → vault return (USDC note)
```

## Programs / mints (Devnet)

| Item | Address |
|------|---------|
| Lending | `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3` |
| Liquidity | `5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL` |
| Circle USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| jlUSDC (`f_token_mint` PDA) | `2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu` |
| Siphon ZK vault | `NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID` / `SIPHON_ZK_PROGRAM_ID` |

The ZK vault must allow jlUSDC deposits (same allowlist path as WSOL). Redeploy/upgrade after pulling the `JL_USDC_MINT` constant in `siphon-vault-zk`.

## Env (executor)

```
SOLANA_RELAYER_KEYPAIR=…
SOLANA_RPC_URL=https://api.devnet.solana.com
SIPHON_ZK_PROGRAM_ID=…
JUPITER_JL_USDC_MINT=2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu
JUPITER_EARN_ASSET_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
JUPITER_LEND_PROGRAM=7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3
SOLASP_URL=…          # required for vault return screening
SOLASP_SCREEN_TOKEN=…
# optional script override:
# SIPHON_JUPITER_EARN_SCRIPT=/app/solana-scripts/execute-zk-jupiter-earn.mjs
```

Frontend:

```
NEXT_PUBLIC_JUPITER_JL_USDC_MINT=2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu
NEXT_PUBLIC_SOLANA_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
NEXT_PUBLIC_SOLANA_SETTLEMENT_PUBKEY=<relayer pubkey>
```

`METEORA_POOL` is optional for Earn-only; `/solana/settlement` still returns `pubkey` + jl mint metadata.

## Builder

Canvas block **Lend** with `lendAction=enter|exit`. LLM: “earn yield on Jupiter” → Enter; “exit earn / redeem jlUSDC” → Exit.

## Settle script

`siphon-fhe/trade-executor/solana-scripts/execute-zk-jupiter-earn.mjs`  
Package `venue: "jupiter-earn"`, `action: "enter"|"exit"`.

## Dry-run (no ZK)

With the settlement keypair funded in Devnet USDC:

```bash
cd siphon-fhe/trade-executor/solana-scripts
node -e "
const {Connection,Keypair,PublicKey}=require('@solana/web3.js');
// resolveEarnAccounts + buildDepositIx smoke — see execute-zk-jupiter-earn.mjs
console.log('see execute-zk-jupiter-earn.mjs resolveEarnAccounts');
"
```

## E2E smoke checklist

1. Deposit Devnet USDC into ZK vault → private USDC note.
2. Builder: Deposit → Lend(enter) → Run → jlUSDC note appears in UserDash (labeled Earn shares).
3. Lend(exit) → private USDC note ≥ prior amount (yield may be tiny on Devnet).
4. Confirm ASP admitted both return deposits.

## Non-goals

Borrow, on-chain vault CPI into Lending, mainnet, non-USDC Earn.
