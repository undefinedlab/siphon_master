# app

> Part of **`siphon_master`** — Siphon product UI and client cryptography.

Next.js application for private DeFi: wallet onboarding, **browser TFHE** (keygen / encrypt / decrypt via `fhe-wasm` + tfhe-rs), and **Groth16 private spends** using circuit artifacts under `public/zk/`.

## Cryptography in this package

| Asset | Path | Role |
|-------|------|------|
| FHE WASM | `fhe-wasm/` | Client-side TFHE keypair + encrypt/decrypt |
| Proving keys | `public/zk/*/zkey_final.zkey` | Real Circom Groth16 proving keys (per action) |
| Circuits WASM | `public/zk/*/*.wasm` | Witness generation |
| Verification keys | `public/zk/*/verification_key.json` | Mirror of on-chain VKs for client checks |

There is no “fake proof” mode on the private spend path — proofs are generated against these artifacts and verified on-chain by `contracts` verifiers.

## Quick start

```bash
bun install   # or npm install
cp .env.example .env.local   # fill RPCs / Supabase / executor URLs
bun run dev
```

See [`ONBOARDING.md`](./ONBOARDING.md) for deeper setup. Production env vars and deploy notes live alongside Amplify / Docker configs in this folder.

## Related packages

- [`../fhe`](../fhe) — homomorphic evaluation + trade executor
- [`../contracts`](../contracts) — VaultKernel + ComplianceHub
- [`../asp`](../asp) — association set / screening
- [`../docs`](../docs) — public documentation site
