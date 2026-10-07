# About Siphon

**Siphon Protocol** is a platform for private DeFi execution — *trade without a trace*. It lets traders deposit funds into an encrypted vault, define trading strategies with hidden parameters, and execute swaps and withdrawals without exposing intent, positions, or strategy logic on-chain.

---
## What Is Siphon?

Siphon is a unified stack for **private, anonymous, and secure DeFi execution**. Users interact through a web dapp where they can:

- Deposit assets into a **privacy vault** (ZK commitments on-chain)
- Build **visual trading flows** with an AI-assisted canvas builder
- Run **encrypted strategies** (limit orders, stop loss, take profit, DCA loops, and more)
- Withdraw or swap through **zero-knowledge proofs** so balances and nullifiers stay private

The tagline captures the core promise: your strategies, order sizes, and trigger prices should not be visible to front-runners, MEV bots, or on-chain surveillance.

---

## The Problem Siphon Solves

Modern DeFi is powerful but **fully transparent**. Every swap, liquidity move, and strategy is visible on-chain. That creates real costs:

| Pain point | What happens today | How Siphon addresses it |
|------------|-------------------|-------------------------|
| Front-running | Bots see your pending trade and jump ahead | Strategy bounds encrypted (FHE); execution intent hidden until trigger |
| Strategy copying | Profitable logic is copied from mempools and wallets | Trigger prices and amounts never leave the browser in plaintext |
| MEV extraction | Value leaked on every public transaction | ZK withdrawals break the link between deposit and spend |
| Surveillance | Wallets and flows are tracked end-to-end | Vault notes use commitments; only the user holds spend secrets |
| Fragmented privacy tools | Dark pools, sealed orders, and ZK require deep crypto expertise | One platform composes vault + builder + encrypted runtime |

Until now, traders often had to choose between **transparency** (standard DeFi) and **protection** (specialized, hard-to-use privacy tools). Siphon aims to unify both.

---

## How It Works

At a high level, Siphon combines **three privacy layers** with a **visual strategy builder** and **off-chain execution services**.

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (siphon-app)                                           │
│  · Wallet connect · Vault deposit/withdraw                        │
│  · FHE keypair + encrypt strategy bounds locally                │
│  · ZK proof generation (Groth16) for spends                     │
│  · Visual builder + AI assistant                                │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Off-chain services (siphon-fhe)                                │
│  · Trade Executor — stores encrypted strategies, schedules runs │
│  · FHE Engine — homomorphic price vs. trigger comparison        │
│  · Proving Relayer — server-side ZK proof generation (optional) │
└───────────────┬─────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  On-chain (siphon-contracts)                                    │
│  · EVM Entrypoint — deposits, ZK withdraws, execution fees        │
│  · Solana program — alternate execution path                      │
│  · Uniswap / DEX routing for swaps after private withdraw         │
└─────────────────────────────────────────────────────────────────┘
```

### Typical strategy lifecycle

1. **Deposit** — User sends tokens into the Siphon vault. A ZK **note** (nullifier + secret + commitment) is created and encrypted; only the user can spend it.
2. **Build** — User describes a strategy in plain language or on the canvas (e.g. “limit buy ETH at $3,000” or “DCA 100 USDC into ETH every 24 hours”).
3. **Encrypt** — Strategy trigger bounds are encrypted in the browser with **FHE** (Fully Homomorphic Encryption). The client secret key never leaves the device.
4. **Monitor** — The trade executor polls **Pyth** price feeds and asks the FHE engine whether conditions are met — without ever seeing plaintext targets.
5. **Trigger** — The browser decrypts the encrypted result bit locally. If triggered, it authorizes execution.
6. **Execute** — The executor performs a **ZK withdraw** (proving ownership without revealing which deposit), swaps on DEX if needed, and optionally withdraws to the user’s wallet or re-deposits as a new private note.

> **Browser-in-the-loop:** Because the FHE client key stays in the browser, autonomous server-side triggering requires a TEE path (Phala decryptor) for production; the default model keeps decryption user-controlled.

---

## Main Features

### Privacy vault

- **ZK commitments** on-chain — deposits are Merkle leaves; spends use Groth16 proofs.
- **Encrypted notes** — nullifier and secret encrypted with a wallet-derived key before sync to the server.
- **Spendable balance tracking** — the dapp reconciles local notes with on-chain leaf sets and server state.

### Visual strategy builder

- **Block-based canvas** — Deposit, Strategy, Schedule, Loop, Swap, and Withdraw blocks compose into executable flows.
- **AI assistant** — natural-language prompts map to valid graphs (limits, stops, DCA loops, schedules, etc.).
- **Smoke test** — sequential validation on the canvas without live on-chain execution.
- **Pay & Run** — port canvas values into a funded execution flow with execution fees.

See [building_blocks/README.md](./building_blocks/README.md) for block types and collaboration rules.

### Encrypted strategies (FHE)

- **Limit / stop / take profit** — price triggers evaluated homomorphically against live oracle data.
- **Range and TWAP** — scheduled multi-leg execution (spec-level; some UI surfaces still expanding).
- **DCA / recurring buys** — implemented via **Loop** blocks (not a separate DCA strategy kind).

### Multi-chain support

| Network | Role |
|---------|------|
| **Base Mainnet** (8453) | Primary production chain |
| **Ethereum Sepolia** (11155111) | Testnet / development |
| **Solana Devnet** | Alternate program path via trade executor |

Supported tokens today include **ETH** and **USDC** per chain configuration.

### Execution & fees

- **Execution fee** — flat base (~$5) plus hourly monitoring cost; paid on-chain before strategy registration.
- **DEX integration** — Uniswap V3 on EVM; swaps route through the executor after ZK withdraw.
- **Note lifecycle** — three-state spent tracking (`false` → `pending` → `true`) prevents double-spend races during execution.

---

## Platform Layers

Siphon is designed in three conceptual layers (from the protocol vision):

1. **Private Execution Layer** — vault, ZK circuits, on-chain entrypoints, encrypted note storage.
2. **Builder Layer** — visual flow editor, AI strategy advisor, smoke simulation, templates.
3. **Runtime & Deployment Layer** — trade executor, FHE engine, schedulers, proving relayer, Docker/AWS deployment.

The goal is to make cryptographic privacy **composable** — chain vault → sealed strategy → encrypted order — without requiring developers to learn circuits or homomorphic math.

---

## Privacy Stack

| Technology | Role in Siphon |
|------------|----------------|
| **ZK (Groth16 / Circom)** | Prove vault ownership and withdraw without revealing which deposit was spent |
| **FHE (tfhe-rs)** | Compare encrypted trigger prices against live prices without decrypting bounds |
| **AES-GCM note encryption** | Protect note secrets at rest on the trade-executor database |
| **Wallet signatures** | Derive encryption keys and authenticate API requests without sharing private keys |
| **TEE (Phala, planned)** | Optional autonomous decryption of trigger bits without exposing strategy inputs |

Plaintext strategy parameters and the FHE client key **never leave the browser** in the default architecture.

---

## Repository Structure

Siphon is a **multi-repo monorepo** — four git repos under one parent directory:

| Directory | Purpose |
|-----------|---------|
| `siphon-app/` | Next.js 15 frontend — dapp, builder, ZK/FHE WASM, API routes |
| `siphon-contracts/` | Solidity (EVM) and Anchor/Rust (Solana) smart contracts |
| `siphon-zk/` | Circom Groth16 circuits and trusted-setup artifacts |
| `siphon-fhe/` | Rust FHE engine, Python trade executor, proving relayer, decryptor |

Each subdirectory has its own `.git`. Run git commands from inside the repo you intend to commit.

---

## Who Is Siphon For?

- **Traders** who want limit orders, DCA, and exits without broadcasting intent.
- **Builders** who want a visual + AI workflow for private strategy composition.
- **Developers** researching unified private DeFi execution — vault primitives, FHE evaluation, and ZK spend paths in one stack.

---

## Mission

> We are building Siphon Protocol — a unified platform for private, anonymous DeFi execution. Our goal is to make cryptographic privacy as accessible and composable as modern trading infrastructure.

The future of DeFi is not choosing between transparency and privacy — it is having both. Siphon is the foundation for that unification.

---

## Further Reading

| Document | Contents |
|----------|----------|
| [building_blocks/README.md](./building_blocks/README.md) | Builder blocks, flow patterns, AI mapping |
| [building_blocks/strategies_l2.md](./building_blocks/strategies_l2.md) | Strategy kinds, runtime tiers, payloads |
| [../ONBOARDING.md](../ONBOARDING.md) | Dev setup, service map, architecture for contributors |
| [../UPDATES.md](../UPDATES.md) | Fee model, note API, recent protocol changes |
| In-app docs (`/docs`) | Vision, manifesto, and platform narrative |

---

*Siphon Protocol — private execution, composable by default.*
