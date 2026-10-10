# Architecture — Siphon Master

End-to-end map of how **real cryptography** and services connect. This document is the reviewer’s entry point.

## System diagram

```text
┌──────────────────────────── app (browser) ────────────────────────────┐
│  Wallet  ·  TFHE keygen (WASM/tfhe-rs)  ·  Groth16 prove (snarkjs)   │
│  IndexedDB: client FHE key  ·  public/zk/* proving + verification keys │
└───────────────┬───────────────────────────────┬───────────────────────┘
                │ encrypt bounds / decrypt bit  │ proof + publicInputs
                ▼                               ▼
┌──────────────────────┐              ┌──────────────────────────────┐
│ fhe/trade-executor   │              │ contracts VaultKernel.spend  │
│  store ciphertext +  │              │  Groth16 verify → nullifiers │
│  server key (no CTK) │              │  NoteTree / adapters         │
└──────────┬───────────┘              └──────────────▲───────────────┘
           │ evaluateStrategy                        │ roots
           ▼                                         │
┌──────────────────────┐              ┌──────────────┴───────────────┐
│ fhe/fhe (Rust/Axum)  │              │ asp  Association Set Provider│
│  tfhe-rs compare     │              │  screen → admit/revoke SMTs  │
│  return ciphertext   │              │  postman → ComplianceHub     │
└──────────────────────┘              └──────────────────────────────┘
```

## Path A — Encrypted strategies (FHE)

1. Browser generates TFHE keypair once (~seconds). **Client key stays in IndexedDB.**
2. User sets strategy bounds; browser encrypts locally and posts **ciphertext only** to trade-executor.
3. Scheduler pulls oracle prices (e.g. Pyth Hermes) and calls the FHE engine with ciphertext + price.
4. Engine runs **homomorphic comparison** (tfhe-rs). It cannot decrypt; it returns an encrypted trigger.
5. Browser polls, decrypts locally; if triggered, authorizes `executeStrategy`.
6. Executor submits the on-chain action (Solana / configured EVM venue).

**Property:** plaintext bounds and the trigger bit are never available to the server process.

## Path B — Private spend (ZK)

1. User builds a spend witness (notes, nullifiers, action).
2. Client proves with Circom Groth16 using artifacts in `app/public/zk/` (per-action zkeys + WASM).
3. Relayer or wallet calls `VaultKernel.spend(publicInputs[25], proof, actionCalldata)`.
4. On-chain router verifies against VKs registered by `programVersion`.
5. Kernel updates note tree / nullifier set and runs the action adapter (withdraw, merge, swap, split, ragequit).

**Property:** amounts and payee binding are constrained by the proof; MERGE does not publish merged amount (`public[5]=0` per protocol).

## Path C — Compliance roots (ASP)

1. Deposits emit vault events; ASP watcher screens depositor (lists → oracle → optional zkMe KYT).
2. Admit labels enter the association set; revokes update the revocation SMT.
3. Postman publishes current `admittedRoot` / `revokedRoot` to ComplianceHub (admit epoch ~5 minutes; revoke immediate).
4. Spend proofs bind to the **current** roots — no on-chain label dump to “close” membership.

## Trust boundaries

| Component | May see | Must not see |
|-----------|---------|--------------|
| Browser | Client FHE key, plaintext bounds, witnesses | — |
| FHE engine | Ciphertexts, public server evaluation key | Client key, plaintext bounds |
| Trade executor | Ciphertexts, server key, execution auth | Client key, plaintext trigger without browser |
| Vault / verifiers | Public inputs + proof | Witness secrets |
| ASP | Depositor identity for screening | Note plaintexts / FHE bounds |

## Package ownership

| Concern | Package |
|---------|---------|
| UI + WASM FHE + ZK artifacts | `app/` |
| On-chain kernel & profiles | `contracts/` |
| Homomorphic eval + execution services | `fhe/` |
| Screening trees & hub publisher | `asp/` |
| Human docs site | `docs/` |

## Related normative docs (in-package)

- `contracts/docs/ARCHITECTURE.md`, `PRIVACY.md`, `DEPLOY.md`, `OMEGA-CLOSURE.md`
- `asp/docs/ARCHITECTURE.md`, `COMPLIANCE_FLOWS.md`
- `fhe/README.md`, `AWS_DEPLOYMENT.md`
- Protocol binding: Circom / spend-core lives alongside the wider Siphon ZK stack; this monorepo carries the **product + chain + FHE + ASP** review surface.
