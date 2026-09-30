# Multi-chain

PROTOCOL layers spend into **core** (25-limb semantics) and **chain profile** (identity encoding, swap mux, payout). This repo mirrors that split: kernel checklist is portable; **adapters + verifier artifact + profile JSON** are not.

`PROGRAM_VERSION` (public index 16) pins:

```text
(guestLogicId, chainProfileId, verifyArtifactId)
```

Do **not** put `chainId` in the 25 limbs. Scope is `vaultScopeId` inside the label mint.

## Modularity

| Layer | Where | Rule |
| --- | --- | --- |
| Guest / circuits | `siphon-zk-v2` | One 25-limb family for all chains |
| Profile JSON | **`siphon-zk-v2/chain-profiles/`** (canonical) | [`../profiles/README.md`](../profiles/README.md) re-exports |
| Module contract | [`../spec/runtime-modules.md`](../spec/runtime-modules.md) | Kernel checklist + adapter ports |
| EVM runtime | `evm/` | Foundry — production Base path |
| Solana runtime | `solana/` | Workspace — `siphon-kernel-types` + `siphon-vault` |

Adding a chain: new profile JSON + new runtime tree implementing the same ports. **Not** a new circuit family.

---

## Shared (all chains)

| Item | Rule |
| --- | --- |
| Public vector | `uint256[25]` BN254 limbs, order in `spec/public-inputs.md` |
| Actions | 0 WITHDRAW … 4 RAGEQUIT |
| Trees | State depth 32, ASP depth 32, SMT depth 32, Poseidon BN254 |
| Compliance | Current `admittedRoot` + current `revokedRoot` only (5-min admit epoch default; revoke immediate) |
| Proof-first | No duplicate amount/label calldata; MERGE `public[5]=0` |
| Nullifiers | Burn `[9 .. 9+inputCount)` |
| Ragequit | Current roots in `[3]`/`[4]`; attributed payout to secret-holder |
| Relayer | `spend` permissionless; submitter is not identity |

A chain that cannot verify a wrap of the **same** 25-limb guest is not a Siphon v3 chain. It is a different product.

---

## EVM (`evm-v1`)

Canonical profile: [`siphon-zk-v2/chain-profiles/evm-v1.json`](../../siphon-zk-v2/chain-profiles/evm-v1.json).

| Binding | Encoding |
| --- | --- |
| `vaultScopeId` | `Poseidon(DOMAIN_CHAIN_EVM, chainId, uint160(vault))` |
| `label` | `Poseidon(Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce), userSalt)` — salt never calldata |
| `payeeField` | 12 zero bytes \|\| 20-byte address, big-endian, mod field |
| `payeeId` | `Poseidon(DOMAIN_PAYEE, payeeField)` |
| Swap mux 17–22 | `pool`, `dstToken`, `fee`, `minAmountOut`, `outputPrecommitment`, `destCommitment` |
| Artifact | Circom Groth16 / BN254 → `ISpendVerifier` |
| Settlement | Uniswap v4 (or v3) via `ISettlementAdapter` |

Foundry code lives in `evm/`. **Do not break this path when extending Solana.**

---

## Solana (`solana-v1`)

Canonical profile: [`siphon-zk-v2/chain-profiles/solana-v1.json`](../../siphon-zk-v2/chain-profiles/solana-v1.json).  
Code: [`../solana/`](../solana/) (`siphon-kernel-types` + `programs/siphon-vault`).

**Product cut:** Mainnet UI still funds an EVM vault. **Devnet** custody is `siphon-vault-zk`
(Groth16, Meteora settle) — [`DEVNET-SOL-E2E.md`](./DEVNET-SOL-E2E.md). Native mainnet
deploy is **parked** ([`../solana/MAINNET-GATE.md`](../solana/MAINNET-GATE.md)).

**Status:** Devnet BPF program verifies Groth16 on `alt_bn128`. The host crate under
`programs/siphon-vault` is the portable kernel and its tests still use a structural backend.
`siphon-vault-onchain` is retired; its spend and pool swap fail closed.

| Binding | Encoding (sketch) |
| --- | --- |
| `vaultScopeId` | `Poseidon(DOMAIN_CHAIN_SOL, programId_field, vaultPda_field)` |
| Payee | 32-byte pubkey does **not** fit one limb; profile hashes to `payeeField` then `payeeId` |
| Swap mux | Jupiter / route bind fields (same indices 17–22, different meaning) |
| Artifact | **Circom Groth16 + alt_bn128 syscalls** (`groth16-bn254-solana-altbn128-v1`) — same guest as EVM. Not pure-BPF; not relayer trust. See [`../solana/VERIFY-RESEARCH.md`](../solana/VERIFY-RESEARCH.md) |
| Public inputs | Prefer **pending-inputs PDA** (25×32 B); spend tx carries proof only — classic 1232 B tx cannot hold 25 limbs + proof |
| Accounts | Vault PDA, Compliance PDA, nullifier store, SPL token accounts, VK accounts, pending-inputs PDA |

Do not ship a fake verifier. PROTOCOL §A.5 “not Groth16-on-BPF by default” referred to emulating pairings in BPF; **syscall-backed Groth16 is the intended artifact.**

### Why Solana is an adapter, not a rewrite

The guest already treats `rawPayee` and swap mux as **profile-defined**. Kernel checklist is identical:

1. Verify artifact over 25 limbs.
2. Pin `programVersion`.
3. `stateRoot` in known historical set.
4. If private spend: current ASP + SMT roots; `public[8]==0`; MERGE `[5]==[6]==0`.
5. If ragequit: **current** compliance roots; guest Pending or Revoked; payout to proof-bound payee.
6. Burn nullifiers; action-dispatch insert/payout. Relayer MAY submit.

Only step 1 and the byte encoding of payee/mint differ.

---

## Later chains

| Chain | Profile id | Notes |
| --- | --- | --- |
| EVM L2s | often reuse `evm-v1` | Distinct `chainId` inside `vaultScopeId` |
| Move / Cosmos | new JSON | New `DOMAIN_CHAIN_*` in zkv2 `domains.json`; bump `PROGRAM_VERSION` if encodePayee / vaultScope change |

---

## Deployment topology (one “Siphon world”)

```text
Compliance roots (per runtime hub) ── admittedRoot / revokedRoot
     │
     ├── Vault EVM (Base, …) ── ERC-20 / native adapters + Uniswap
     └── Vault Solana        ── SPL adapters + Jupiter

VerifySpend port ──── programVersion → artifact  (per runtime)
Intent / bridge  ──── Li.Fi-class hop between vaults (public leg; not atomic cross-note)
```

Cross-runtime (ETH vault ↔ SOL vault) is **not** a v3 atomic swap. That is the **intent-bridge-v1** profile ([INTENT-BRIDGE.md](./INTENT-BRIDGE.md), [`intent-bridge-v1.json`](../../siphon-zk-v2/chain-profiles/intent-bridge-v1.json)). Same guest still applies per hop; Li.Fi-class adapters only cover the public bridge leg.
