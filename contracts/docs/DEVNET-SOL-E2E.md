# Devnet E2E — Solana vault (ZK product + Meteora)

Chain id **`900002`**. Phantom deposits USDC or SOL (SOL wraps to WSOL internally; UI always says SOL).

## Strategy settle — Meteora DLMM (public liquidity)

`siphon-pool-v1` is unused. A limit strategy spends a ZK note to the executor settlement wallet, then swaps on Meteora Devnet (`lb_clmm` `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, same program id as mainnet).

```text
Phantom deposit → encrypted local note
  → Builder proves Groth16 spend (secrets stay in the browser)
  → encrypted price bounds + proof package
  → executor commit_public_inputs + spend
  → Meteora DLMM swap → output to the recipient
```

If the note-tree root moves between prove and submit, the executor returns `NEEDS_REPROOF` and does not send a transaction. The Builder proves again and retries.

```powershell
cd siphon-contracts-v2/solana/scripts
npm install
node setup-meteora-devnet-pool.mjs
# writes solana/target/deploy/devnet-meteora.env (METEORA_POOL, mints, program id)

# trade-executor :5020
#   SOLANA_DEVNET_ARM_OPEN=1
#   SOLANA_DEVNET_AUTO_EXECUTE=1
#   METEORA_POOL=<from devnet-meteora.env>
#   SOLANA_RELAYER_KEYPAIR = the settlement key the proof pays (default ~/.config/solana/id.json)

node e2e-devnet-zk-meteora.mjs
```

The app reads `GET /solana/settlement` (pubkey + pool) unless `NEXT_PUBLIC_METEORA_POOL` and `NEXT_PUBLIC_SOLANA_SETTLEMENT_PUBKEY` are set.

Live Devnet pool (Oct 2026): `BY4cLgYMpE1AA5X5jiXHEMTrVkG7uhDvr6KxjU8YfCEZ` (WSOL / `DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie`, bin step 10, seeded). Set `METEORA_POOL` to that address.

## Product path — ZK vault (`siphon-vault-zk`)

Poseidon depth-32 tree, encrypted client notes, Groth16 over `alt_bn128` (**no** `scaffold-verify`).

```text
Phantom → UserDash Deposit (USDC / SOL)
  → Poseidon deposit + leaf index PDA
  → encrypted note in localStorage (solanaNoteStore)
  → withdraw: proveRemote → commit_public_inputs → spend → SPL payout
```

Env (see `solana/target/deploy/devnet-zk.env` after deploy):

```bash
NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID=<new ZK program id>
NEXT_PUBLIC_SIPHON_SOLANA_ZK=1
NEXT_PUBLIC_SOLANA_USDC_MINT=DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie
NEXT_PUBLIC_DEVNET_VAULT_CHAIN_ID=900002
LEGACY_FHE_PROGRAM_ID=Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj
```

Deploy / init (once):

```powershell
cd siphon-contracts-v2/solana
./scripts/deploy-devnet-zk.ps1
cd ../../siphon-app
# Load target/deploy/devnet-zk.env into the shell / .env.local first
node ../siphon-contracts-v2/solana/scripts/init-vault-devnet-zk.mjs
node ../siphon-contracts-v2/solana/scripts/upload-vk-devnet.mjs
node ../siphon-contracts-v2/solana/scripts/e2e-devnet-zk-deposit.mjs   # WSOL deposit smoke
node ../siphon-contracts-v2/solana/scripts/e2e-devnet-zk-withdraw.mjs  # deposit→prove→commit→spend
```

Live Devnet cutover (Oct 2026): program `F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH`, vault `FuBg5w5TnevKM887xFJ7zxCcQbUbzjE41wSPgSojoyQK` — see `solana/target/deploy/devnet-zk.env` and `devnet-zk-withdraw-e2e.json` (full withdraw1 E2E green).

Groth16 wire notes: VK/proof G2 limbs are `c1||c0` (Light); proof A is negated on-chain with **Fq** (not Fr).

Client: `siphon-app/src/lib/chains/solanaVaultZk.ts`. ZK mode when program id ≠ legacy FHE or `NEXT_PUBLIC_SIPHON_SOLANA_ZK=1`.

## Legacy — FHE scaffold vault (`siphon-vault-onchain`)

**Unused by the product path.** Plaintext note PDAs. In this tree `spend` and `strategy_swap` return `VerifyNotConfigured`. The program already on Devnet was built when those instructions still ran, so do not fund it. Devnet strategies settle on Meteora.

| | |
| --- | --- |
| Program | `Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj` |
| Vault | `5WaifRrg4CrGLSbyqVYcjUQystjj5HigMn1mgUWjPa2k` |
| Pool | `LXxanxpovDSDdwLTNibZSkqmerQQaLUR789SjnWB8Lg` |
| Compliance | `2a4x2vx4W9pqa1M7CnXiVKuPhS5RcnVKXBiK9dt1MBvv` |

Legacy deploy: `./scripts/deploy-devnet.ps1` → `devnet.env` (do not overwrite with ZK env).

Do not run `e2e-devnet-strategy.mjs` or `e2e-devnet-bidi.mjs` against this tree. Those scripts call `strategy_swap`, which now fails closed.

## Local services (legacy FHE demo)

| Service | Port | ZK withdraw | FHE pool |
| --- | --- | --- | --- |
| siphon-app | 3000 | Yes | Yes |
| Trade executor | 5020 | Optional | **Yes** |
| FHE engine | 5001 | No | Optional |

Mainnet product mode: Phantom → Li.Fi → Arbitrum `depositV3`.

## Scripts

```powershell
node siphon-contracts-v2/solana/scripts/verify-devnet-ready.mjs   # legacy readiness
node siphon-contracts-v2/solana/scripts/export-vk-accounts.mjs    # host-only VK pack
```

Not mainnet-safe until [`solana/MAINNET-GATE.md`](../solana/MAINNET-GATE.md) soak + CU evidence.

## Legacy bridge

`/solana/devnetBridge/*` (Sepolia tSOL credit) is **not** the Devnet product deposit path.
