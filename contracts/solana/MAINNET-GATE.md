# Solana Mainnet Gate

> **Mainnet:** still parked — Solana UI funds **Arbitrum** via Li.Fi
> ([`../docs/SOLANA-WRAPPER.md`](../docs/SOLANA-WRAPPER.md)).
> **Devnet product:** `siphon-vault-zk` with Groth16, settled on Meteora — see
> [`../docs/DEVNET-SOL-E2E.md`](../docs/DEVNET-SOL-E2E.md). That deployment does **not**
> satisfy this gate. `siphon-vault-onchain` is a retired scaffold.
> Do **not** burn mainnet SOL on program + VK rent until this checklist is intentionally cleared.

This repository is production-shaped, but it is **not approved for mainnet** until every pending
operations item has dated, reproducible evidence attached to a release record.

Status meanings:

- **DONE (code):** enforced or represented in this tree and covered by host tests.
- **PENDING (ops):** must be measured or verified against the exact deployment artifact/cluster.

## Required release checklist

- [ ] **PENDING (ops)** Confirm both `alt_bn128` and `sol_poseidon` feature gates are active on the
  target cluster/epoch. Record cluster, feature IDs, activation slots, and RPC evidence.
- [ ] **PENDING (ops)** Benchmark compute-unit headroom for the full 25-limb Groth16 verification
  path plus note-tree, SPL asset, settlement/Jupiter, and nullifier-PDA adapters. Pin a limit from
  measured p95/p99 values; pairing-only estimates do not pass this gate.
- [ ] **PENDING (ops)** Create and rent-exempt fund all **14 verifying-key accounts**. Verify owner,
  PDA/addresses, immutable content hashes, and release-manifest hashes for every circuit slot.
- [ ] **PENDING (ops)** Configure and independently review the production program and hub/CPI
  allowlists, including the deployed vault program, token programs, Jupiter/settlement programs,
  mints, and upgrade-authority policy.
- [ ] **PENDING (ops)** Complete a continuous **7-day devnet soak** with mixed
  Deposit/Withdraw/Merge/Swap/Split/Ragequit traffic, stale roots, duplicate nullifiers, pauses,
  compliance-root rotations, adapter failures, and rollback/retry scenarios.
- [ ] **PENDING (ops)** Run the frozen Base/EVM regression suite against the release commit and
  archive green CI evidence. Solana work must not modify `evm/`.
- [x] **DONE (code)** The default verifier is fail-closed, and `StructuralAcceptBackend` plus
  `host_scaffold_verifier` are compiled only for tests or the explicit, non-default
  `scaffold-verify` feature. Release CI must reject that feature and inspect the artifact to confirm
  no structural-accept symbols are present.

## Additional blockers

- [ ] **PENDING (ops/code)** Complete and audit `AltBn128SyscallBackend`; the current on-chain
  integration point deliberately returns `VerifyFailed`.
- [ ] **PENDING (ops)** Replace placeholder program identity, lock the upgrade-authority policy,
  and verify signer, owner, PDA bump, replay, account-close, and rent behavior.
- [ ] **PENDING (ops)** Confirm PDA-per-nullifier accounts cannot be closed or reinitialized in a
  way that resurrects a spent nullifier.
- [ ] **PENDING (ops)** Add production monitoring and alerting for verification failures, root
  drift, adapter deltas, CU exhaustion, account funding, and CPI errors.
- [ ] **PENDING (ops)** Complete an independent security review, incident runbook, staged rollout,
  and rollback rehearsal.
