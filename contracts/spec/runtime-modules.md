# Runtime modules (chain-agnostic)

Portable contract for every Siphon vault runtime (`evm-v1`, `solana-v1`, future profiles).
On-chain languages differ; **module boundaries and checklist do not**.

Normative limb indices: [`public-inputs.md`](./public-inputs.md).  
Chain encoding: [`../siphon-zk-v2/chain-profiles/`](../../siphon-zk-v2/chain-profiles/).  
Multi-chain overview: [`../docs/MULTI-CHAIN.md`](../docs/MULTI-CHAIN.md).

---

## Layers

```text
┌─────────────────────────────────────────────────────────┐
│  Profile JSON   (identity, mux, assetId, verifyArtifact) │
├─────────────────────────────────────────────────────────┤
│  Verify adapter  (Groth16 Solidity / Solana artifact TBD)│
├─────────────────────────────────────────────────────────┤
│  Kernel          (deposit + spend checklist — same rules)│
├──────────────┬──────────────────┬───────────────────────┤
│ AssetAdapter │ SettlementAdapter│ Compliance (roots)    │
└──────────────┴──────────────────┴───────────────────────┘
```

| Module | Responsibility | Must NOT |
| --- | --- | --- |
| **Profile** | Map chain bytes → field limbs; name mux 17–22 | Change guest action semantics |
| **Verify** | Check proof over exactly 25 public limbs for `programVersion` | Trust relayer instead of proof |
| **Kernel** | Deposit mint, spend verify→nullify→dispatch | Encode EVM/Solana types into guest |
| **AssetAdapter** | Measured pull/push of local asset | Interpret ZK labels |
| **SettlementAdapter** | Fill SWAP using mux + remaining accounts/calldata | Bypass kernel nullifier burn |
| **Compliance** | Expose current `admittedRoot` + `revokedRoot` | Store per-label status on-chain |

---

## Kernel checklist (every `spend`)

Identical on Base and Solana (from MULTI-CHAIN.md):

1. Verify artifact over `publicInputs[25]` for pinned `programVersion` (limb 16).
2. `stateRoot` (limb binding) ∈ known historical set for this vault.
3. If private spend: current ASP + SMT roots; `public[8]==0`; MERGE `[5]==[6]==0`.
4. If ragequit: **current** compliance roots; guest Pending or Revoked; payout to proof-bound payee.
5. Burn nullifiers for used inputs.
6. Action-dispatch: insert outputs / payout / settlement fill. Relayer MAY submit; submitter is not identity.

Deposit:

1. Pull assets via **AssetAdapter** (measured delta = note amount).
2. Mint label from `(vaultScopeId, depositNonce, userSalt)` — never user-supplied label calldata.
3. Insert note commitment into state tree; emit index for indexer/ASP screen.

---

## Adapter interfaces (logical)

Runtime-specific types (`address` vs `Pubkey`) stay behind these ports:

### AssetAdapter

- `pull(assetId, from, amount) → measuredIn`
- `push(assetId, to, amount) → measuredOut`
- `assetId` encoding is **profile-defined** (EVM: `uint160(token)`; Solana: mint pubkey mod field).

### SettlementAdapter

- `fill(mux[17..22], remainingAccountsOrCalldata) → measuredDstOut`
- Binds destination commitment rules from the profile (same limb indices).

### PayeeCodec

- `rawPayeeBytes → payeeField → payeeId = Poseidon(DOMAIN_PAYEE, payeeField)`
- EVM: 20-byte address zero-padded.
- Solana: 32-byte pubkey compressed per `solana-v1` (must not pretend a pubkey fits one limb raw).

### VerifySpend

- `verify(programVersion, publicInputs[25], proofBytes) → bool`
- EVM: `VerifierRegistry` + Groth16 router.
- Solana: **artifact TBD** — implement behind this port only.

---

## Folder mapping

| Module | EVM (`evm/`) | Solana (`solana/`) |
| --- | --- | --- |
| Kernel | `VaultKernel.sol` | `programs/siphon-vault` |
| Verify | `VerifierRegistry.sol`, `verifiers/*` | `programs/siphon-vault` verify port (stub) |
| Compliance | `ComplianceHub.sol` | Compliance PDA module |
| Asset | `adapters/*Asset*` | `adapters/asset` |
| Settlement | `adapters/*Settlement*` | `adapters/settlement` |
| Payee | `payees/PayeeCodecEvm.sol` | `profile/payee.rs` |
| Shared limb types | Solidity `uint256[25]` | `crates/siphon-kernel-types` |

---

## Adding a chain cleanly

1. Add `siphon-zk-v2/chain-profiles/<id>.json`.
2. Add `siphon-contracts-v2/<runtime>/` implementing the checklist + adapters.
3. Pin `(guestLogicId, chainProfileId, verifyArtifactId)` → new `PROGRAM_VERSION` when artifact or encoding changes.
4. Wire ASP `chainId` / program id bind; indexer; executor relay — **no guest rewrite**.
