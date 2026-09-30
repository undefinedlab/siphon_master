# siphon-contracts-v2 architecture

**Build this.** Single target: `[siphon-zkv2/PROTOCOL.md](../../siphon-zkv2/PROTOCOL.md)` **v3.5.0 (D1)**.  
Do not implement PROTOCOL 3.3 Phase A (`outLabel` public, `depositsByLabel`, ASP ring leftovers).

Gate notes: `[GATE-REVIEW.md](GATE-REVIEW.md)`. Closure tracker: `[OMEGA-CLOSURE.md](OMEGA-CLOSURE.md)`. Cross-stack: `[INTEGRATION.md](INTEGRATION.md)`. Privacy: `[PRIVACY.md](PRIVACY.md)`.

If this file and PROTOCOL disagree on spend validation, **PROTOCOL wins**.

**D1 (shipped):** asset-bound commitments `Poseidon(amount, label, assetId)`; multi-token `deposit(token,…)`; WITHDRAW `public[17]=assetId`; RAGEQUIT `public[18]=assetId`; SWAP `public[23]=srcAssetId` + dest uses `dstToken` as assetId; `UniswapV3SettlementAdapter` / bootstrap `Erc20SettlementAdapter`; `PROGRAM_VERSION=4` (fractional withdraw change — §6.1.4; requires zkey/verifier redeploy).

**D4 deferred:** solver/RFQ settlement — same `ISettlementAdapter` surface later.

---

## 1. What a public observer must not learn

They may see: deposit `tx.from` + amount, later unshield `to` + amount, nullifiers, roots, a vault AMM fill.

They must **not** join Alice → later spend / swap / strategy. That means:


| Do not put on-chain                    | Why                         |
| -------------------------------------- | --------------------------- |
| `public[8] = outLabel`                 | N=1 join key                |
| `depositsByLabel` / `labelStatus`      | World-readable graph        |
| User-chosen `label` calldata           | Borrow Bob’s ASP leaf       |
| `label = Poseidon(scope, publicNonce)` | Enumerable from the counter |
| `precommitment` in events              | Opens the note              |


Compliance stays **proof-verifiable**: guest + current `admittedRoot` + current `revokedRoot`. Not explorer-enumerable.

---



## 2. Kernel (keep)

```text
Relayer  →  spend(uint256[25], proof, extra)     // default submitter; msg.sender is not identity
              │
              ├─ VerifierRegistry   register-only, vault-pinned programVersion
              ├─ public[8] == 0
              ├─ MERGE: public[5] == public[6] == 0
              ├─ current admittedRoot + revokedRoot   (private spend AND ragequit)
              ├─ historical stateRoot
              ├─ burn nullifiers
              └─ adapters: asset / settlement / fee
```

- One `spend` ABI. No per-N Groth16 selectors required long-term (action family may still map).
- **Circom Groth16** verifies on EVM; `spend-core` is the Rust reference for the same rules.
- **Every private-spend input:** ASP inclusion + SMT non-inclusion. No `inLabel[]` publics.
- **Global** `admittedRoot` / `revokedRoot` (H-04 without a label map).
- Register-only registry. Pause = no new value in; exits live.
- ERC-20 / native / SPL = `IAssetAdapter`. Uniswap / Jupiter = `ISettlementAdapter`.

---



## 3. Protections this vault MUST enforce



### 3.1 Fake amount (insolvency)

`spend-core::bind_deposit`. Note `amount` **is** the measured token delta. User cannot pass a larger `claimedAmount`. Fail on `received == 0`.

### 3.2 Label borrow (piggyback ASP)

Vault **mints** `label = Poseidon(Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, nonce), userSalt)`.

- `userSalt ≠ 0`, never logged.
- **No** `label` argument. Supplying one is a revert (`UserSuppliedLabel`).
- ASP: one leaf per label (`AspTree::insert` rejects duplicates).



### 3.3 Fabricated label / unscreened private spend

Impossible without forging ASP inclusion against the **current** `admittedRoot`.

### 3.4 Revoke

SMT non-inclusion on every private-spend input vs **current** `revokedRoot`. No belt-and-suspenders `status[outLabel]` (that forced the join key and missed inner notes).

### 3.5 Swap dest theft (OMEGA-C-01)

`public[21] = outputPrecommitment`, `public[22] = destCommitment = commitment(minOut, destLabel, pre)` with `destLabel == inLabel[0]` **private**. Insert `public[22]`. `measuredOut >= minOut`. **Surplus** (`measured − minOut`) → `protocolClaimable[dst]` on swap; gov `mintProtocolSurplusNote` consumes a **unique** queued pre (duplicate enqueue rejected). Kernel rejects `src == dst`, `amountIn == 0`, and bad `fee`. Uniswap adapter: `pool` mux limb unused (fee+pair select pool).

### 3.6 Relayer (spend)

`spend` is permissionless. Product default: a **relayer** submits private spends and pays gas. `msg.sender` is not identity. Proof still binds `payeeId` and dest `C` (relayer cannot steal).

Do **not** default-relay **deposit** — ERC-20 `Transfer` still names the token source. Deposit privacy is a fresh funding EOA. Unshield: relayer submits; `rawPayee` is a fresh recipient (the `vault → Bob` transfer stays public physics).

Proof-first amounts. No depositor / change-value / dest-pre / merge-amount calldata duplicates.

---



## 4. Deposit / spend / ragequit

**Deposit**

1. Measure `received`.
2. `bind_deposit(received, received, scope, nonce, salt, …, user_supplied_label=None)`.
3. Insert `C`. Event: new `stateRoot` (optional `C`). No label, no salt, no precommitment, no indexed depositor.

**Admit (postman):** insert labels off-chain; publish `admittedRoot` on a **5-minute epoch** (PROTOCOL §2.6.2). Pending notes cannot private-spend until the published root contains them; they MAY ragequit. Revoke (`revokedRoot`) is **not** epoch-batched. Events: root only, never `labels[]`.

**Private spend** (`public[8]==0`, MERGE also `public[5]==public[6]==0`, current ASP+SMT roots, state root exists, burn nullifiers, dispatch). Default submitter = relayer.

**Ragequit** (attributed): current roots; guest proves Pending (∉ ASP ∧ ∉ SMT) **or** Revoked (∈ SMT); pay `payeeId` calldata (secret-holder). No insert. No status map. Admitted (∈ ASP ∧ ∉ SMT) → revert, use withdraw.

**Label inheritance (private):** merge / split / swap dest keep `inLabel[k]` inside the new note. Explorer does not see it. Disclosure (user opening or ASP records) still follows association.

---



## 5. On-chain state (allowed vs forbidden)

**Allowed:** state Merkle tree of commitments; nullifier set; current `admittedRoot` / `revokedRoot`; known historical **state** roots; token balances.

**Forbidden:** `depositsByLabel`, hub `labelStatus`, ASP plaintext CID as a gate, NativeVault fork, V4-only vault, ASP ring, revoke/admit events that emit label lists.

---



## 6. Public limbs (25)

Index **8 MUST be 0**. **MERGE `public[5]` MUST be 0** (amount is inside `outCommitment` only). Swap mux 17–22 per `profiles/evm-v1.json`. Full table: PROTOCOL §4.

---



## 7. Modules (shipped in `evm/`)


| Module               | Status | Role                                            |
| -------------------- | ------ | ----------------------------------------------- |
| `VaultKernel`        | ✅ M4  | deposit + `spend` (relayer-callable)            |
| `ComplianceHub`      | ✅ M3  | current ASP + SMT roots, postman, atomic revoke, 5-min admit epoch |
| `VerifierRegistry`   | ✅ M3  | register-only                                   |
| `SpendActionGroth16Router` | ✅ M7/M8 | 14 action Circom verifiers              |
| `IAssetAdapter`       | ✅     | Multi-token measured pull/push (D1)             |
| `ISettlementAdapter` | ✅     | Uniswap V3 + bootstrap inventory; insert `public[22]` |
| `IFeeModule`         | —      | delayed config (future)                         |
| `UniswapV3SettlementAdapter` | ✅ | Measured V3 `exactInputSingle` fill             |


Production kernel bytecode is shipped in `evm/`. Remaining ops gap: MPC ceremony for production Circom zkeys (see alignment checklist §8). **D4 (solver/RFQ) deferred.**

## 8. Alignment checklist

- [x] PROTOCOL 3.5.0 / D1 — asset-bound notes, multi-token vault, SWAP src/dst asset binds, `PROGRAM_VERSION=3`
- [x] PROTOCOL 3.4.3 — `public[8]=0`, MERGE `public[5]=0`, salted labels, deposit bind, crypto ragequit, dest `public[22]`, spend relayer, 5-min admit epoch
- [x] `spend-core::deposit` — AmountMismatch / UserSuppliedLabel / ZeroSalt / duplicate ASP
- [x] `spend-core::merge` — witness sum bound in `outCommitment`; public limb 5 is 0
- [x] Policy — no on-chain Revoked lookup; ragequit uses current roots; revoke events root-only
- [x] M3 — `VerifierRegistry` + `ComplianceHub` + `PublicInputs` + Foundry guest-commit bind
- [x] M4 — `VaultKernel.spend` (nullifiers, state roots, action finalize; real Groth16 router)
- [x] M7 — `SpendActionGroth16Router` + 14 per-action Circom verifiers
- [x] Wire Groth16 router into `VaultKernel` M4/M5 spend path
- [x] Production PoseidonT3 hasher (`PoseidonHasher2` — replace `KeccakHasher2`)
- [x] M5 — swap + split guest validators + Foundry finalize tests
- [x] Deposit path — `spend-core` deposit guest + `VaultKernel.deposit(token,…)` (Poseidon bind + assetId)
- [ ] MPC ceremony for production Circom zkeys
- [x] Circom Groth16 product path — **not** zkVM
- [ ] D4 solver/RFQ `ISettlementAdapter` (deferred)