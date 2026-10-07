# Siphon Protocol — Onboarding Guide

> For teammates and AI agents. Read this before touching any code.

---

## Repo Structure

This is a **multi-repo monorepo**: four separate git repos checked out under one parent directory.

```
Siphon/                          ← you are here (no .git at this level)
├── siphon-app/                  ← Next.js 15 frontend (EVM + Solana UI)
├── siphon-contracts/            ← Solidity (EVM) + Anchor/Rust (Solana) contracts
├── siphon-zk/                   ← Circom Groth16 ZK circuits (chain-agnostic)
└── siphon-fhe/                  ← Rust FHE engine + Python trade-executor + relayer
```

Each subdirectory has its own `.git`. **Always `cd` into the repo you want to commit before running any git command.** Git ops at the `Siphon/` level will fail or do nothing.

The old monorepo is archived at `/Users/adityamane/Siphon_Money/archive/` — do not touch it.

---

## Service Map

| Service | Language | Port | Directory |
|---|---|---|---|
| Frontend | Next.js 15 | 3000 | `siphon-app/` |
| Trade Executor | Python / Flask | 5005 | `siphon-fhe/trade-executor/` |
| FHE Engine | Rust | 5001 | `siphon-fhe/fhe/` |
| Payload Generator | Rust | 5009 | `siphon-fhe/siphon-payload-generator-demo/` |
| Proving Relayer | Python / Flask | 5010 | `siphon-fhe/proving-relayer/` |

---

## Quick Start (dev — all services local)

### Prerequisites
- Node.js 20+, `bun` (never npm/yarn — the project uses bun)
- Python 3.11+
- Rust + Cargo (stable)
- `circom` 2.x and `snarkjs` (for circuit changes only)
- `rapidsnark` binary at `/opt/homebrew/bin/rapidsnark` (ARM64 Mac)

### Step 1 — Environment

Create `siphon-fhe/trade-executor/.env`. Required vars:

```env
# EVM
ETH_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<YOUR_KEY>
ENTRYPOINT_ADDRESS=0x8Be4A7A074468F571271192A0A0824cf6F08a1f6
UNISWAP_V3_ROUTER=0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b
WETH_ADDRESS=0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
EXECUTOR_PRIVATE_KEY=<base58 or hex private key>

# Auth (must match what frontend sends)
API_TOKEN=<shared secret>

# FHE engine
FHE_ENGINE_URL=http://localhost:5001/evaluateStrategy
FHE_ENGINE_CONDITION_URL=http://localhost:5001/evaluateCondition

# Pyth
PYTH_HERMES_URL=https://hermes.pyth.network

# Scheduler
CHECK_INTERVAL_SECONDS=10

# ZK — set to true for local dev only, NEVER in prod
SKIP_ZK_VERIFY=false
```

`DATABASE_URI` is optional — omit it and the trade-executor uses local SQLite (`instance/siphon.db`).

### Step 2 — Start services in order

**Terminal 1 — FHE Engine:**
```bash
cd siphon-fhe/fhe
cargo run --release
```

**Terminal 2 — Payload Generator:**
```bash
cd siphon-fhe/siphon-payload-generator-demo
cargo run --release
```

**Terminal 3 — Trade Executor + Scheduler:**
```bash
cd siphon-fhe/trade-executor
source venv/bin/activate
gunicorn -w 1 -b 0.0.0.0:5005 --timeout 700 app:app
```
`--timeout 700` is required — strategy execution waits up to 600s for tx confirmation.
The scheduler runs automatically in a background thread spawned by `app.py`.

**Terminal 4 — Frontend:**
```bash
cd siphon-app
bun dev
```

Frontend is at `http://localhost:3000`.

---

## ZK Circuit Artifacts

Built artifacts live in `siphon-zk/circuits/build/`. The critical files:

| File | Purpose |
|---|---|
| `zkey_final.zkey` | Groth16 proving key (trusted setup) |
| `main_js/main.wasm` | Circuit WASM for witness generation |
| `main_js/generate_witness.js` | Node.js witness generator |
| `verification_key.json` | Verification key for off-chain checks |

**Do not regenerate the zkey without a new trusted setup ceremony.** The current zkey is devnet-only.

The frontend's `/api/prove` route uses these artifacts via `rapidsnark` (server-side, ~200ms). Env overrides:
```env
ZK_BUILD_DIR=/path/to/siphon-zk/circuits/build
RAPIDSNARK_BIN=/opt/homebrew/bin/rapidsnark
```

---

## Key Deployed Addresses

| Contract | Network | Address |
|---|---|---|
| Entrypoint (EVM) | Sepolia | `0x8Be4A7A074468F571271192A0A0824cf6F08a1f6` |
| Siphon Program (Solana) | Devnet | `3CVsp1zayXhNsT8Ktrh85rTewvBJxWy8VcUtQAKdnQMb` |

---

## Architecture in One Page

```
User Browser
  └─ siphon-app (Next.js)
       ├─ /api/prove         → rapidsnark (server-side Groth16 proof, ~200ms)
       ├─ lib/noteStore.ts   → AES-GCM encrypted notes, stored on trade-executor DB
       ├─ lib/zkHandler.ts   → commitment gen, Merkle proof, proof inputs
       ├─ lib/handler.ts     → EVM deposit / withdraw / payExecutionFee
       └─ lib/strategy.ts    → sends strategy payload to payload-generator

Payload Generator (Rust :5009)
  └─ builds encrypted strategy payload → stored on trade-executor

FHE Engine (Rust :5001)
  └─ evaluates encrypted conditions without seeing plaintext

Trade Executor (Python :5005)
  ├─ scheduler.py  → polls PENDING strategies, calls FHE engine, triggers execution
  ├─ evm_executor.py
  │    ├─ ZK withdraw via Entrypoint.sol (Sepolia)
  │    ├─ Same-chain ETH→token: Uniswap UniversalRouter (WRAP_ETH + V3_SWAP_EXACT_IN)
  │    └─ Cross-chain: Li.Fi (mainnet only — not supported on Sepolia)
  ├─ notes.py      → REST API for note CRUD (wallet-authenticated)
  └─ database.py   → SQLite/Postgres, stores strategies + encrypted notes
```

---

## Note Lifecycle (Three-State Spent Tracking)

Notes track nullifier state across the execution window to prevent double-spend races:

| `spent` value | Meaning |
|---|---|
| `'false'` | Unspent — available for a new strategy |
| `'pending'` | Strategy triggered, tx broadcast, awaiting on-chain confirmation |
| `'true'` | Nullifier confirmed spent on-chain |

**Revert rules (in `scheduler.py`):**
- `FatalExecutionError` (tx failed before ZK withdraw) → revert to `'false'`
- `NullifierSpentSwapFailed` (ZK withdraw confirmed, swap failed) → set `'true'` (nullifier IS spent, funds in executor wallet)
- Successful execution → set `'true'`

---

## Note Encryption (Frontend)

`noteStore.ts` uses two separate signatures to prevent key disclosure to the server:

1. **Encryption key** — derived from signing the stable string `'Siphon-Encryption-Key-v1'`. This signature is **never transmitted**. Cached in memory per session (user signs once).
2. **Auth headers** — derived from signing `'Siphon auth v1:<timestamp>'`. This goes in `X-Signature` / `X-Timestamp` headers for every request to the trade-executor.

---

## RBF / Nonce Management (evm_executor.py)

When a tx is stuck in the mempool (pending nonce > confirmed nonce), `send_tx()` automatically:
1. Bumps priority fee to 15 gwei
2. Sets max fee to `4 × base_fee + priority`
3. Forces `nonce = confirmed_nonce` to replace the stuck tx

---

## Docker (Production)

```bash
cd siphon-fhe
docker compose up --build
```

See `siphon-fhe/AWS_DEPLOYMENT.md` for EC2 setup.

---

## Things an Agent Should Never Do

- Run `npm` or `yarn` — always use `bun`
- Push without explicit instruction from Aditya
- Commit without showing the proposed message and getting approval
- Touch anything under `/Users/adityamane/Siphon_Money/archive/`
- Set `SKIP_ZK_VERIFY=true` anywhere except local dev
- Run gunicorn without `--timeout 700`
- Start `app.py` directly with `python app.py` (debug mode — use gunicorn)
