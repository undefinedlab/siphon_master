# Production status

Last updated: **2026-10-13**

## Verdict for reviewers

The **cryptographic and application system works end-to-end** on testnets: real TFHE evaluation, real Groth16 prove/verify, real vault kernel spends, and a live ASP → ComplianceHub root loop.

What remains is **final infrastructure deployment and hardening** — ops work, not a rewrite of the crypto stack.

## Done (protocol / product)

| Area | Evidence in-tree |
|------|------------------|
| VaultKernel spend path (EVM) | `contracts/evm` — Foundry tests, adapters, verifier registry |
| Solana ZK vault sources | `contracts/solana/programs/siphon-vault-zk` |
| Groth16 artifacts | `app/public/zk/**` — WASM, verification keys, proving keys |
| Browser TFHE | `app/fhe-wasm` + app client flows |
| Homomorphic engine | `fhe/fhe` (Rust / tfhe-rs / Axum) |
| Trade executor + gateway | `fhe/trade-executor`, `fhe/api-gateway` |
| ASP screening + trees | `asp/` API, watcher, postman |
| Docs site | `docs/` Fumadocs |

## In progress (infrastructure)

| Item | Notes |
|------|-------|
| Managed Postgres cutover for ASP / executor | Templates exist; pinning production URIs |
| RPC failover + rate-limit budgets | `fhe/rpc-failover` present; production endpoints TBD |
| Mainnet deployer / executor key custody | Testnet keys only in operator runbooks — never in git |
| CDN / artifact hosting for large zkeys | Keys are in-repo for review; CDN for prod clients |
| Observability (metrics, alerts, log drains) | `/metrics` and compose healthchecks exist; SRE wiring open |
| Domain TLS / edge (app + docs + API) | Compose + Caddy templates; DNS cutover pending |

## Explicit non-goals for this snapshot

- Replacing Groth16 with a different proof system
- Moving FHE client keys server-side
- Shipping mock verifiers as the production path

## How to verify quickly

```bash
cd contracts/evm && forge test
cd ../../fhe && docker compose config   # service graph
cd ../asp && python -m pytest -q        # if deps installed
```

Inspect `app/public/zk/*/verification_key.json` and circuit WASM — these are production proving artifacts, not placeholder stubs.
