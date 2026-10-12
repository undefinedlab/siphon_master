# Siphon Master

**Private monorepo for Siphon Protocol** — end-to-end private DeFi execution with real cryptography on the critical path: browser TFHE (tfhe-rs / WASM), Circom Groth16 spends, on-chain verification, and an Association Set Provider for compliance roots.

> **Status (Oct 2026):** Cryptographic and application paths are implemented and exercised end-to-end on testnets. Remaining work is **production infrastructure cutover** (managed Postgres, RPC failover pinning, mainnet deployer keys, CDN for proving artifacts) — tracked in [`STATUS.md`](./STATUS.md).

---

## What this monorepo contains

| Path | Role |
|------|------|
| [`app/`](./app) | Next.js client — wallet UX, browser FHE keygen/encrypt/decrypt, Groth16 prove UI, vault interactions |
| [`contracts/`](./contracts) | PROTOCOL 3.4 VaultKernel (EVM Foundry + Solana ZK vault) — proof-first `spend`, ComplianceHub roots |
| [`fhe/`](./fhe) | Off-chain stack — tfhe-rs evaluation engine, trade executor, API gateway, keepers / relayers |
| [`asp/`](./asp) | Association Set Provider — screening, admit/revoke SMTs, deposit watcher, ComplianceHub publisher |
| [`docs/`](./docs) | Public documentation site (Fumadocs) for `docs.siphon.money` |

This is the **judge / review surface**: one private repo, five production packages, no “demo-only mock crypto” on the spend or strategy path.

---

## Cryptography (what is real)

| Layer | Implementation | Not a mock |
|-------|----------------|------------|
| **Strategy privacy** | Browser generates TFHE client/server keys; bounds encrypted client-side; engine evaluates **homomorphically** and returns ciphertext | Server never holds the client key; plaintext bounds never leave the device |
| **Private spend** | Circom Groth16 circuits + proving keys under `app/public/zk/` | On-chain verifiers check real proofs against registered VKs |
| **Vault kernel** | `VaultKernel.spend(publicInputs[25], proof, actionCalldata)` | Amounts, nullifiers, roots, and payee binding come from verified public inputs |
| **Compliance** | ASP builds admit + revoke trees; hub publishes current roots on a timed admit epoch | Revocation is SMT non-inclusion against the live `revokedRoot` — labels are not leaked on-chain to close sets |
| **Execution** | Trade executor submits chain txs only after browser-authorized decrypt of the FHE trigger bit | Browser-in-the-loop by design for the FHE path |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full data flow.

---

## Quick orientation

```text
siphon_master/
├── README.md              ← you are here
├── ARCHITECTURE.md        ← E2E crypto & service map
├── STATUS.md              ← what’s live vs infra remaining
├── app/                   ← product UI + WASM FHE + ZK artifacts
├── contracts/             ← EVM + Solana on-chain kernel
├── fhe/                   ← tfhe-rs engine + executors
├── asp/                   ← association set / compliance
└── docs/                  ← documentation site
```

### Local boots (high level)

```bash
# Contracts (EVM)
cd contracts/evm && forge test

# FHE stack
cd fhe && docker compose up --build

# ASP
cd asp && pip install -r requirements.txt && python app.py

# App
cd app && bun install && bun run dev

# Docs
cd docs && npm install && npm run dev
```

Each package keeps its own README with env templates (`.env.example` / `.env.prod.template`). **Do not commit live secrets.**

---

## Design principles

1. **Proof-first** — chain state transitions require verified Groth16 public inputs; adapters do not invent amounts.
2. **Client-held FHE secrets** — strategy bounds and trigger bits decrypt only in the browser.
3. **PROTOCOL.md wins** — when comments and code disagree, the normative protocol doc is source of truth (see contracts + ZK packages).
4. **One semantic core** — EVM and Solana share limb / action semantics; chain differences live in profiles and adapters.
5. **Ship real artifacts** — verification keys, WASM witnesses, and proving keys for spend actions live in-tree under `app/public/zk/` so reviewers can inspect real circuit outputs, not stubs.

---

## Reviewer notes

- Prefer reading [`ARCHITECTURE.md`](./ARCHITECTURE.md) then package READMEs over hunting for “mock” toggles — production paths use tfhe-rs and Groth16.
- Testnet deployments and executor wiring exist; **mainnet / hardened infra** is the open checklist in [`STATUS.md`](./STATUS.md).
- Large proving keys are intentional protocol artifacts. Toolchains and `target/` builds are gitignored.

---

## License / visibility

Private repository under [`undefinedlab`](https://github.com/undefinedlab). Not an open-source release surface — treat as confidential review material.
