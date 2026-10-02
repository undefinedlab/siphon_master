# Trade Executor (`trade-executor`)

The **Trade Executor** is the Python backend that:

- receives **encrypted** strategies directly from the browser (`POST /createStrategy`)
- stores strategies in **SQLite** (encrypted/compressed fields handled in the model layer)
- runs a background **scheduler** that fetches live prices and evaluates pending strategies via the Rust **FHE Engine**
- when a strategy triggers, performs **on-chain execution** (EVM or Solana Devnet Meteora)

For the full multi-service architecture, see `../README.md`.

---

## Solana Devnet (`900002`)

Venue: Meteora DLMM on Devnet. The client proves a ZK spend; this process submits it and swaps. `siphon-pool-v1` is not used.

```powershell
python run_devnet_executor.py   # :5020 — loads .env.devnet
node ../../siphon-contracts-v2/solana/scripts/e2e-devnet-zk-meteora.mjs
```

Key env: `SOLANA_DEVNET_ARM_OPEN=1`, `SOLANA_DEVNET_AUTO_EXECUTE=1`,
`REQUIRE_USER_API_KEY=0`, `METEORA_POOL`, `SIPHON_ZK_PROGRAM_ID`,
`SOLANA_USDC_MINT`. Relayer key = `SOLANA_RELAYER_KEYPAIR` or `~/.config/solana/id.json`
(the settlement address the proof pays).

Docs: [`siphon-contracts-v2/docs/DEVNET-SOL-E2E.md`](../../siphon-contracts-v2/docs/DEVNET-SOL-E2E.md).

---

## Service API

- `GET /health`
- `POST /createStrategy`
- `POST /executeStrategy`

Default port: `5005` (Devnet runner uses `5020`)

---

## Running the full stack (recommended)

From `strategies-executor/`:

```bash
docker compose up --build
```

This starts:
- Trade Executor: `http://localhost:5005`
- FHE Engine: `http://localhost:5001/evaluateStrategy`

---

## Run locally (dev)

### Prereqs

- Python 3.9+
- Rust toolchain

### 1) Trade Executor (Python)

```bash
cd strategies-executor/trade-executor
pip install -r requirements.txt
python init_db.py
gunicorn --bind 0.0.0.0:5005 --workers 1 --timeout 3000 "app:app"
```

Minimum environment (`.env` file):

```bash
DATABASE_URI="sqlite:///instance/strategies.db?timeout=20000"
FHE_ENGINE_URL="http://localhost:5001/evaluateStrategy"
SOLANA_NETWORK="devnet"
HELIUS_API_KEY="your_helius_key"
EXECUTOR_PRIVATE_KEY="your_base58_private_key"
```

### 2) FHE Engine (Rust)

```bash
cd strategies-executor/fhe
cargo run --release
```

---

## On-chain execution

For the Trade Executor to submit Solana transactions after a trigger, configure:

```bash
HELIUS_API_KEY="your_helius_api_key"
# OR: SOLANA_RPC_URL="https://api.devnet.solana.com"
SOLANA_NETWORK="devnet"
EXECUTOR_PRIVATE_KEY="your_base58_private_key"
```

---

## Quick checks

```bash
curl http://localhost:5005/health
```