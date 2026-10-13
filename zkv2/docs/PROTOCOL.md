# Siphon Spend Protocol v3


|                  |                                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| **Version**      | 4.0.0                                                                    |
| **Status**       | Normative                                                                |
| **Field**        | BN254 scalar field (same as Groth16 / `CommitmentLib`)                   |
| **Architecture** | `[docs/ARCHITECTURE-GREENFIELD.md](docs/ARCHITECTURE-GREENFIELD.md)`     |
| **Security**     | OMEGA pass 1–5 — see §15; SDK closure [`OMEGA-CLOSURE.md`](OMEGA-CLOSURE.md) |
| **Tests**        | `[../siphon-tests/zkv2/](../siphon-tests/zkv2/)` — not in this repo tree |


This document is the **single source of truth** for spend validation, public inputs, and on-chain binding. Implementations (`spend-core`, Circom circuits, Vault, SDK) MUST conform. JSON fixtures in `test-vectors/` are the executable contract.

**Layering:**


| Layer                           | Scope                                                | Location                             |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| **Core** (this doc §1–7, §9–15) | Witness, ASP+SMT, actions, 25 public *semantics*     | Portable across chains               |
| **Chain profile**               | Identity encoding, swap mux meaning, payout calldata | `chain-profiles/*.json`              |
| **Verification artifact**       | Proof format verified on-chain                       | EVM: Circom Groth16/BN254 — see §4.6 |


**Compliance model:** **ASP inclusion** (KYT-gated admission) + **SMT non-inclusion** (revocation).

**Proving stack (normative):** **Circom → Groth16 SNARK (BN254)** only. `spend-core` is the Rust reference that MUST match circuit semantics. There is **no** STARK / zkVM guest / SP1 path in this protocol.

**Terminology:** Where older drafts said “guest,” read **circuit** (Circom) + **`spend-core` validate** — the same spend rules, not a zkVM ELF.

---

## 1. Constants


| Name                | Value |
| ------------------- | ----- |
| `MAX_INPUTS`        | 6     |
| `MAX_SPLIT_OUTPUTS` | 8     |
| `TREE_DEPTH`        | 32    |
| `ADMIT_TREE_DEPTH`  | 32    |
| `SMT_DEPTH`         | 32    |
| `PUBLIC_WIDTH`      | 25    |
| `PROGRAM_VERSION`   | 4     |


Domain separators (BN254 field elements, fixed in `test-vectors/domains.json`):


| Name                 | Usage                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- |
| `DOMAIN_SMT_KEY`     | `smtKey(label) = Poseidon(DOMAIN_SMT_KEY, label)`                                       |
| `DOMAIN_SMT_LEAF`    | Occupied revocation SMT leaf node hash                                                  |
| `DOMAIN_VAULT_SCOPE` | Label mint domain — §2.3                                                                |
| `DOMAIN_PAYEE`       | `payeeId = Poseidon(DOMAIN_PAYEE, payeeField)` — §1.2                                   |
| `DOMAIN_CHAIN_EVM`   | EVM `vaultScopeId` — §16                                                                |
| `DOMAIN_CHAIN_SOL`   | Reserved for future Solana profile                                                      |
| `DOMAIN_DEPOSITOR`   | `ownerBind = Poseidon(DOMAIN_DEPOSITOR, depositorPayeeField)` — ragequit owner (§2.2.1) |


### 1.2 Chain profiles and `PROGRAM_VERSION`

**Chain profile** maps raw chain identities (addresses, pubkeys) to field elements and defines swap mux semantics. Normative EVM profile: `[chain-profiles/evm-v1.json](chain-profiles/evm-v1.json)`.

`PROGRAM_VERSION` (public index 16) pins a Vault deployment to one tuple:

```
(circuitLogicId, chainProfileId, verifyArtifactId)
```

Manifest field `guestLogicId` is the historical name for **`circuitLogicId`** (Circom family + spend-core revision). It does **not** denote a zkVM ELF.
Manifest: `[manifest/universal-spend-v1.json](manifest/universal-spend-v1.json)`. **Do not** put `chainId` in the 25 public limbs — chain scope is encoded in `vaultScopeId` per deployment.

**Payee binding (portable):**

```
payeeField = chainProfile.encodePayee(rawPayee)   // profile-defined
payeeId    = Poseidon(DOMAIN_PAYEE, payeeField)
```

The circuit proves `payeeId` in public inputs. Chain adapter pays `rawPayee` from **action calldata** after verifying `payeeId == chainProfile.payeeId(rawPayee)`.

Implementation: `spend-core::chain_profile` (`EvmProfile` for current work).

### 1.1 Spend actions


| `action` | Name       | `inputCount` |
| -------- | ---------- | ------------ |
| 0        | `WITHDRAW` | 1 … 6        |
| 1        | `MERGE`    | 2 … 6        |
| 2        | `SWAP`     | 1            |
| 3        | `SPLIT`    | 1            |
| 4        | `RAGEQUIT` | 1            |


---

## 2. Cryptographic primitives

### 2.1 Poseidon (BN254)

Use the same Poseidon parameters as `circomlib` / on-chain `PoseidonT3` / `CommitmentLib`. All implementations MUST pass shared fixtures in `test-vectors/poseidon.json`.

### 2.2 Note commitment (D1 — asset-bound)

Spend-note formula (`CommitmentLib` / circom `commitment.circom`, `PROGRAM_VERSION=4`):

```
precommitment = Poseidon(nullifier, secret)
inner         = Poseidon(amount, label, assetId)
commitment    = Poseidon(inner, precommitment)
nullifierHash = Poseidon(nullifier)
```

**`assetId` (EVM):** `uint160(tokenAddress)` as a BN254 field element (same encoding as swap mux `dstToken`). Native ETH is **not** a note asset in D1 — use WETH.

**Fake-amount protection** is not in this hash alone — anyone can hash a bogus `amount`. The vault MUST bind **measured** token delta to that `amount` **and** `assetId` at deposit (§2.7). The circuit then opens the same `amount` and `assetId` on spend. MERGE/SPLIT require every active note to share one `assetId`.

### 2.2.1 Ragequit owner bind (no public depositor map)

Do **not** store `depositsByLabel[label].depositor`. Ragequit pays the **secret-holder** bound in the proof:

```
public[17] == payeeId(rawPayee)     // calldata
circuit: rawPayee is the ragequit claimant who opens the note
```

Opening the note (nullifier, secret, amount, label) **is** ownership. Redirecting ragequit without secrets is impossible. (Optional later: fold `Poseidon(DOMAIN_DEPOSITOR, payeeField)` into `commitment` — new `PROGRAM_VERSION`, new notes.)

### 2.3 Label mint (vault + user salt — 3.4)

**FORBIDDEN:** user-supplied `label` calldata (label-borrow / piggyback on someone else’s ASP leaf).  
**FORBIDDEN:** `label = Poseidon(scope, publicNonce)` with no salt (enumerable join graph).

```
vaultScopeId = chainProfile.vaultScope(vaultInstance)
nonceStem    = Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce)
label        = Poseidon(nonceStem, userSalt)
```

`depositNonce` is the vault’s public counter (uniqueness). `userSalt` is a **non-zero** field chosen by the depositor, **never** emitted and **never** accepted as a raw `label`. The vault / deposit circuit **computes** `label`; it does not take `label` as an argument.

**EVM profile (**`evm-v1`**):**

```
vaultScopeId = Poseidon(DOMAIN_CHAIN_EVM, chainId, uint160(vaultAddress))
```

Fixture: `test-vectors/chain-profile-evm.json` (scope + payee). Salted mint: `test-vectors/deposit-guards.json`.

ASP insert (§2.6.1) is still **one leaf per label**. Combined with vault-unique `(scope, nonce)` and unknown `userSalt`, an attacker cannot mint Bob’s label.

Labels are minted at deposit. **Spend requires** cryptographic admission (§2.6) and non-revocation (§2.5). Deposit alone does not authorize spend (§7).

### 2.7 Deposit bind (fake-amount protection)

On `deposit(token, …)` (multi-token vault):

1. `token` MUST be allowlisted. Measure `received` for that token (balance delta). `received > 0`.
2. Take `userSalt ≠ 0` (and `precommitment` / deposit proof witness). **Do not** take `label` or `amount` from the user as the note value.
3. `label = mint(vaultScopeId, depositNonce, userSalt)` (§2.3).
4. `assetId = uint160(token)`; `C = commitment(received, label, assetId, nullifier, secret)` — note `amount` **is** `received`.
5. Insert `C` into the state tree. Emit at most `C` and the new `stateRoot` (no label, no precommitment, no depositor index).

A deposit proof (same Circom family or a dedicated deposit circuit) MAY additionally constrain steps 3–4. **Normative for D1:** on-chain `VaultKernel.deposit(token, amount, userSalt, precommitment)` binds measured `received` and `assetId = uint160(token)` before insert; off-chain reference is `spend-core::deposit`. A Circom deposit circuit is **deferred** (not required when the vault measurement bind is audited).

**Fail closed:** `userSalt == 0`, `received == 0`, non-allowlisted token, user-supplied `label` argument, or `claimedAmount != received`.

### 2.4 State Merkle tree

Binary Poseidon Merkle tree, depth `TREE_DEPTH = 32`. Stores **note commitments** (pool balances).

**Inclusion path** for leaf `L`, siblings `pathElements[i]`, indices `pathIndices[i] ∈ {0,1}`:

```
current := L
for i in 0 .. TREE_DEPTH-1:
    if pathIndices[i] == 0:
        current := Poseidon(current, pathElements[i])
    else:
        current := Poseidon(pathElements[i], current)
root := current
```

Constraint: `pathIndices[i] * (1 - pathIndices[i]) == 0` for all levels.

Empty siblings use zero (`0`) matching on-chain `MerkleTree` convention.

### 2.5 Revocation sparse Merkle tree (SMT)

Presence-only set of **revoked** labels. Revocation is **only** via this tree — not via ASP tree eviction (v2 retired).

**Key derivation:**

```
smtKey(label) := Poseidon(DOMAIN_SMT_KEY, label)
```

**Path index bits:** bit `j` of `smtKey` (MSB-first, `j ∈ [0, SMT_DEPTH)`) is the level-`j` branch bit (`0` = left, `1` = right), matching §2.4.

**Leaf node (revoked):**

```
leafHash(label) := Poseidon(DOMAIN_SMT_LEAF, label)
```

**Empty leaf (unrevoked slot):** `EMPTY_LEAF` — constant in `test-vectors/smt/empty-subtrees.json`.

**Internal node:** `Poseidon(left, right)`.

**Empty tree at depth** `d`**:** `EMPTY_SUBTREE[d]` built bottom-up:

```
EMPTY_SUBTREE[0] := EMPTY_LEAF
EMPTY_SUBTREE[d+1] := Poseidon(EMPTY_SUBTREE[d], EMPTY_SUBTREE[d])
EMPTY_REVOKED_ROOT := EMPTY_SUBTREE[SMT_DEPTH]
```

**Non-inclusion** for `label` at root `R` (PROTOCOL 3.4.3 / F-5):

```
claimedLeaf := actual leaf at path smtKey(label)   // EMPTY_LEAF, or leafHash(L') of an occupant
prove Merkle(claimedLeaf, path) == R
constrain claimedLeaf ≠ leafHash(label)
```

Depth stays `SMT_DEPTH = 32` (32 MSBs of `smtKey`). A birthday collision that places
another label’s `leafHash` in the same slot **must not** freeze an unrevoked spender —
only `claimedLeaf == leafHash(self)` fails (true revocation).

**Inclusion** (postman / tests / ragequit-revoked): prove leaf at path `smtKey(label)` equals `leafHash(label)`.

All implementations MUST share `test-vectors/smt/`.

### 2.6 Admission association Merkle tree (ASP)

Binary Poseidon Merkle tree, depth `ADMIT_TREE_DEPTH = 32`. Stores **KYT-passed label leaves** (association set). Leaf value at a slot is the **label field element** itself.

Same path convention as §2.4. Empty siblings use `0`.

**Inclusion** for label `L` at root `A`: standard Merkle sibling path proving `L` is a leaf of `admittedRoot`.

`admittedRoot` **on ComplianceHub:** single **current** root (`ComplianceHub.admittedRoot`). Historical admitted roots MUST NOT be accepted at spend (no v2 32-slot ring).

Postman updates `admittedRoot` when KYT-passed labels are inserted. Off-chain association-set mirrors are for **forensic audit**; spend authorization is the on-chain root + ZK inclusion proof.

Fixtures: `test-vectors/asp/`.

#### 2.6.1 ASP insert (normative)

Postman maintains `admittedLeafCount` (monotonic, starts at `0`).

To admit label `L`:

1. `L` MUST NOT already be present in the tree (no duplicate labels).
2. Assign leaf index `i = admittedLeafCount`; insert leaf value `L` at index `i`.
3. Increment `admittedLeafCount`.
4. Recompute `admittedRoot` using §2.4 path convention with empty sibling `0`.
5. Publish `ComplianceHub.admittedRoot = newRoot` (`updateAdmittedRoot`).

**Prover path binding:** `admittedPathIndices[i][j]` MUST equal bit `j` of leaf index `i` (**LSB-first** at level 0 — same as on-chain incremental `MerkleTree` insert / Circom `Num2Bits`). Note: SMT keys (§2.5) use MSB-first path bits; ASP leaf-index binding is LSB-first.

**Cross-implementation rule:** all postman/prover pairs MUST derive identical roots for identical admission sequences. Fixtures: `test-vectors/asp/inclusion-path.json`.

#### 2.6.2 Admit publish cadence (ops — does not weaken the gate)

Off-chain, the postman **MAY** insert many KYT-passed labels into the ASP tree before publishing. On-chain, `ComplianceHub.admittedRoot` is still a **single current root**. Private spend still requires inclusion in **that** current root (§5.1.4). Pending notes (label not yet in the published root) cannot private-spend; they MAY ragequit (§5.2).

**Default product cadence:** publish `admittedRoot` on a **5-minute epoch** (wall-clock). Do **not** treat per-deposit root publishes as the default — that is a timing join (`deposit tx` → `+1 leaf`).

**Revoke is not epoch-batched.** SMT inserts MAY publish `revokedRoot` immediately. Spend always uses the **current** `revokedRoot`.

Events: `AdmittedRootUpdated(newRoot)` only. Do **not** emit admitted labels.

---

## 3. Witness (private prover input)

Never committed except via the fixed `PUBLIC_WIDTH` layout (§4).

```
action: SpendAction
inputCount: u8
boundaryIndex: u8                    // private k

// Per slot i in 0 .. MAX_INPUTS-1 (active iff i < inputCount):
inValue[i]: field
inNullifier[i]: field
inSecret[i]: field
inLabel[i]: field
statePathElements[i][TREE_DEPTH]: field
statePathIndices[i][TREE_DEPTH]: 0|1
admittedPathElements[i][ADMIT_TREE_DEPTH]: field
admittedPathIndices[i][ADMIT_TREE_DEPTH]: 0|1
revokedSmtPathElements[i][SMT_DEPTH]: field
revokedSmtPathIndices[i][SMT_DEPTH]: 0|1

// Single-output actions (withdraw / merge / swap / ragequit):
outNullifier: field
outSecret: field

// Split only:
outNullifier[8]: field
outSecret[8]: field
outValue[8]: field

// Withdraw / swap — raw payee in witness; public binds payeeId (§1.2):
rawPayee: bytes                         // chain profile length (EVM: 20 bytes)

// Swap mux (also in public indices 17–21; meaning from chain profile):
pool, dstToken, fee, minAmountOut, outputPrecommitment: field

// Ragequit (public mux index 17):
rawDepositor: bytes                     // EVM: 20 bytes; public[17] = payeeId(rawDepositor)
```

---

## 4. Public outputs (`PUBLIC_WIDTH = 25`)

Committed field elements in **fixed order**. Circom / `spend-core` MUST produce exactly this array.

### 4.1 Core fields (all actions)


| Index | Name                  | Description                                                                                                 |
| ----- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0     | `action`              | §1.1                                                                                                        |
| 1     | `inputCount`          | §1.1 bounds                                                                                                 |
| 2     | `stateRoot`           | State note tree root (§2.4)                                                                                 |
| 3     | `admittedRoot`        | Current ASP association root (§2.6)                                                                         |
| 4     | `revokedRoot`         | Current revocation SMT root (§2.5)                                                                          |
| 5     | `primaryValue`        | See §4.3                                                                                                    |
| 6     | `secondaryValue`      | See §4.3                                                                                                    |
| 7     | `outCommitment`       | Output note; `0` if zero-change / N/A (split)                                                               |
| 8     | `outLabel`            | **MUST be** `0` **(3.4).** Inheritance stays a **private** circuit constraint. Do not publish the join key. |
| 9–14  | `nullifierHash[0..5]` | Padding: indices ≥ `inputCount` MUST be `0`                                                                 |
| 15    | `payeeId`             | `Poseidon(DOMAIN_PAYEE, encodePayee(rawPayee))`; `0` if unused                                              |
| 16    | `programVersion`      | MUST equal `PROGRAM_VERSION`                                                                                |


### 4.2 Action-muxed payload (indices 17–24)

Unused mux slots MUST be `0`.

**Swap mux (indices 17–23):** semantics defined by active **chain profile** `swapMux`. EVM profile `evm-v1`:


| Index | Field                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 17    | `pool`                                                                                                                                   |
| 18    | `dstToken` (= dest note `assetId`)                                                                                                       |
| 19    | `fee`                                                                                                                                    |
| 20    | `minAmountOut`                                                                                                                           |
| 21    | `outputPrecommitment`                                                                                                                    |
| 22    | `destCommitment` — `commitment(minAmountOut, destLabel, dstAssetId, outputPrecommitment)` with `destLabel` **private** `== inLabel[0]` |
| 23    | `srcAssetId` — MUST equal opened input note `assetId`                                                                                    |
| 24    | `0`                                                                                                                                      |


Chain: settlement `fill(pool, srcToken, dstToken, …)`; `measuredOut >= minAmountOut`; insert `public[22]` (note value = minOut; surplus is not in the note). Do **not** require `destLabel` in publics. Change note (if any) keeps **src** `assetId`.

**Other actions:**


| Index | WITHDRAW              | MERGE | SPLIT       | RAGEQUIT                          |
| ----- | --------------------- | ----- | ----------- | --------------------------------- |
| 17    | `assetId` (note token)| 0     | `splitRoot` | `payeeId(secret-holder)`          |
| 18    | 0                     | 0     | 0           | `assetId` (note token)            |
| 19–24 | 0                     | 0     | 0           | 0                                 |


### 4.3 Primary / secondary value by action


| Action   | `primaryValue`   | `secondaryValue` |
| -------- | ---------------- | ---------------- |
| WITHDRAW | `withdrawnValue` | `changeValue`    |
| MERGE    | `0`              | `0`              |
| SWAP     | `amountIn`       | `changeValue`    |
| SPLIT    | `0`              | `0`              |
| RAGEQUIT | `amount`         | `0`              |


**MERGE:** the merged amount is **not** a public limb. Conservation is a **private** circuit constraint: `outCommitment = commitment(Σ inValue[i], outLabel_witness, …)`. The vault only inserts `public[7]`. Publishing `mergedValue` does not help settlement (no token movement) and fingerprints note size. `changeValue` on WITHDRAW/SWAP **stays** public — the vault needs it to decide whether to insert a change note and, with the ERC-20 transfer, to pay the right amount.

### 4.4 Split root (normative — single rule)

For each slice `i ∈ [0, 7]`:

```
if outValue[i] == 0:
    outCommitment[i] == 0
else:
    outCommitment[i] = commitment(outValue[i], outLabel, assetId, outNullifier[i], outSecret[i])
    // assetId MUST equal the spent input note's assetId (D1)
    outNullifier[i] pairwise distinct across active slices
```

```
splitRoot = MerkleRoot8(outCommitment[0], …, outCommitment[7])
```

`MerkleRoot8` is a depth-3 binary Poseidon tree over eight leaves **in order**. Definition in `test-vectors/split-root.json`.

**Vault (after verify):**

1. `splitCommitments[i] == outCommitment[i]` for all `i`.
2. `splitRoot(splitCommitments) == publicInputs[17]`.

For split: `publicInputs[7] == 0`, `publicInputs[15] == 0` (no payee).

### 4.5 Witness ↔ public consistency (mandatory)

Before action rules, the circuit MUST enforce:

```
public[0]  == witness.action
public[1]  == witness.inputCount
public[16] == PROGRAM_VERSION
```

**Action bounds** — reject invalid pairs (MUST abort):


| `action`   | Required `inputCount` |
| ---------- | --------------------- |
| 0 WITHDRAW | 1 … 6                 |
| 1 MERGE    | 2 … 6                 |
| 2 SWAP     | 1                     |
| 3 SPLIT    | 1                     |
| 4 RAGEQUIT | 1                     |
| any other  | — (invalid)           |


**Root binding** (private spend — WITHDRAW, MERGE, SWAP, SPLIT):

```
public[2] == stateRoot   from active input note paths (§2.4)
public[3] == admittedRoot witness field used in ASP paths (§2.6)
public[4] == revokedRoot  witness field used in SMT paths (§2.5)
```

**Root binding (RAGEQUIT escape hatch — §5.2):**

```
public[3] == admittedRoot   current (ASP non-inclusion branch uses this root)
public[4] == revokedRoot    current (SMT inclusion branch uses this root)
public[8] == 0
```

Vault MUST require `admittedRootIsCurrent` / `revokedRootIsCurrent` for RAGEQUIT as well (3.4). Do **not** zero compliance roots.

**Derived public limbs** — indices 5–15, 17–24 MUST equal `spend-core::validate(witness, chainProfile)`.

For each `i >= inputCount`: `public[9 + i] == 0`.

**Inactive witness slots** (`i >= inputCount`): MUST constrain `inValue[i] == inLabel[i] == inNullifier[i] == 0`.

Action-specific zero constraints (§6.0) MUST also hold.

### 4.6 Public encoding pipeline

1. `spend-core::validate(witness, chainProfile) -> PublicOutputs`
2. `PublicOutputs::to_bn254_limbs() -> [field; 25]`
3. Circom Groth16 public signals bind exactly these 25 limbs (or a circuit-family subset that MUST map into this layout).
4. **Verification artifact** (chain-specific) binds those limbs:
  - **EVM (**`evm-v1`**):** Circom Groth16 over BN254 → Solidity verifier
  - **Future chains:** own artifact; same 25-limb semantics, different verifier program
5. Chain adapter verifies proof, then reads state **only** from `publicInputs[]` + profile calldata.

Implementations MUST pass `test-vectors/public-encoding.json`.

---

## 5. Input rules

### 5.1 Private spend (WITHDRAW, MERGE, SWAP, SPLIT)

Applies to **all private-spend actions**. For each active index `i < inputCount`:

1. `inValue[i] > 0`
2. `inLabel[i] ≠ 0`
3. `commitment(inValue[i], inLabel[i], inNullifier[i], inSecret[i])` ∈ `stateRoot` (§2.4, `public[2]`)
4. `inLabel[i]` **∈** `admittedRoot` — ASP Merkle inclusion path (§2.6, `public[3]`)
5. `nullifierHash[i] = Poseidon(inNullifier[i])` equals `public[9 + i]`
6. Pairwise distinct `inNullifier[i]`
7. Pairwise distinct `inLabel[i]` across active inputs
8. `SMT-NonInclusion(public[4], smtKey(inLabel[i]), path_i)` (§2.5):
  - `revokedSmtPathIndices[i][j]` equals bit `j` of `smtKey(inLabel[i])` MSB-first
  - leaf at path equals `claimedLeaf` with `claimedLeaf ≠ leafHash(inLabel[i])` (§2.5 F-5)
9. ASP path indices MUST match leaf index bits per §2.6.1 (**LSB-first** at level 0 — not MSB-first like SMT keys).

For inactive slots `i >= inputCount`: `public[9 + i] == 0`; no input constraints.

**Privacy note:** `inLabel[i]` remain private in the witness; ASP inclusion is proved in ZK. `outLabel` (index 8) MUST be `0` on-chain (3.4). Inheritance (`outLabel_witness = inLabel[k]`) is a **private** constraint only.

### 5.2 RAGEQUIT escape hatch (exempt from §5.1 rules 4, 8, 9 as written; 3.4 crypto gate)

`RAGEQUIT` is the **attributed exit** for deposits that cannot (or must not) use private spend:

- KYT-failed / never-admitted (label ∉ current ASP)
- Compliance-revoked (label **∈** current SMT)

For `action = RAGEQUIT` only:

1. Rules §5.1.1–3 and §5.1.5–6 apply to slot `i = 0` only (state inclusion + nullifier).
2. Rules §5.1.4, §5.1.8, §5.1.9 **do not all apply**. Instead the circuit proves **exactly one** eligibility branch (§5.2.1):
  - **Pending (v1):** SMT non-inclusion of `inLabel[0]` **and** `public[3] == EMPTY_ASP_ROOT` (no labels published yet). ASP non-inclusion of the label is implied when the ASP is still empty.
  - **Revoked:** SMT **inclusion** of `inLabel[0]` against `public[4]` (KYT fail / compliance flag → postman inserts label in SMT).
3. Circuit MUST set `public[3]` / `public[4]` to the roots used in those paths (current). MUST set `public[8] = 0`.
4. **Forbidden:** ASP inclusion **and** SMT non-inclusion (that is Admitted → private withdraw only).
5. **Forbidden (v1):** Pending branch when `public[3] != EMPTY_ASP_ROOT` — once any label is admitted, a label not yet in ASP cannot pending-ragequit; KYT-failed labels MUST use the revoked path after SMT insert.
6. Do **not** look up `depositsByLabel[outLabel].status`. There is no public status map.

#### 5.2.1 v1 secure ragequit policy (normative)

ASP admission is **global membership** in the single published `admittedRoot` — not a per-user ticket. A label is either a leaf in the current published tree or it is not.

| Journey state | ASP | SMT | `admittedRoot` | RAGEQUIT branch |
| --- | --- | --- | --- | --- |
| Pre-first-admit deposit (bootstrap only) | label ∉ ASP | label ∉ SMT | `EMPTY_ASP_ROOT` | **Pending** (dev / pre-go-live) |
| KYT failed / flagged / pre-admit exit | label ∉ ASP (typical) | label **∈** SMT | current (non-empty) | **Revoked** |
| KYT passed, awaiting epoch | label ∉ published ASP yet | label ∉ SMT | **non-empty** | **Forbidden** — wait for admit publish |
| Admitted | label **∈** ASP | label ∉ SMT | current | **Forbidden** — private withdraw only |

**F-8 (accepted v1 product):** Production assumes a **non-empty** ASP after the first admit bus. Empty-ASP pending ragequit is bootstrap/test only — not the live path. While not yet admitted under a live ASP, exit is **revoked ragequit** after postman SMT-insert (KYT fail, or ops exit ticket). Once the indexer has an inclusion proof vs the published root, the note is **admitted** → private spend only. **UI is not a security boundary** — activity “admitted” is display; scripts cannot ragequit an admitted note because the circuit rejects ASP∈ ∧ SMT∉. Keyed ASP non-inclusion is **out of v1**.

**Nullifier burn (§8.3):** vault burns `publicInputs[9]` on finalize. The note **cannot** be private-spent again (nullifier set). Ragequit does **not** Merkle-insert `outCommitment`; the commitment may remain in the state tree as a dead UTXO.

Payout: `payeeId` mux 17 vs calldata (§2.2.1). No Merkle insert.

---

## 6. Action rules

Let `N = inputCount`, `k = boundaryIndex` (private).

### 6.0 Action-specific public constraints


| Action   | `payeeId` (15)      | `outCommitment` (7)         | Mux 17–24                                                         |
| -------- | ------------------- | --------------------------- | ----------------------------------------------------------------- |
| WITHDRAW | `payeeId(rawPayee)` | §6.1                        | 17 = `assetId`; 18–24 `0`                                         |
| MERGE    | `0`                 | non-zero                    | all `0`                                                           |
| SWAP     | `0` (D1 pool)       | §6.3                        | 17–22 per chain profile; 23 = `srcAssetId`; 24 `0`                |
| SPLIT    | `0`                 | `0`                         | 17 = `splitRoot`; 18–24 `0`                                       |
| RAGEQUIT | `0`                 | non-zero, binds opened note | 17 = `payeeId`; 18 = `assetId`; 19–24 `0`; **§5.2**               |


### 6.1 WITHDRAW (`action = 0`)

1. `N ∈ [1, 6]`, `k < N`
2. `primaryValue > 0`, `sum = Σ inValue[i]`, `secondaryValue = sum - primaryValue`
3. **Asset bind:** every active input shares one `assetId`; `public[17] == assetId`; change note (if any) keeps that `assetId`
4. **Fractional change (v4):** `secondaryValue ≤ inValue[k]` (circuit `LessEqThan(128)`); for each `i ≠ k`, `inValue[i]` is fully consumed in the sum. Change note is carved from the boundary note `k` and may be any value in `[0, inValue[k]]` (0 = no change). Replaces the v3 `secondaryValue = inValue[k] OR 0` rule so arbitrary-amount withdrawals are a single proof.
5. `outLabel = inLabel[k]`
6. Zero-change: if `secondaryValue = 0` then `outCommitment = 0`; else `outCommitment = commitment(secondaryValue, outLabel, assetId, outNullifier, outSecret)`
7. Vault pays `primaryValue` of token `address(uint160(public[17]))` to `rawPayee`

### 6.2 MERGE (`action = 1`)

1. `N ∈ [2, 6]`, `k < N`
2. **Public:** `primaryValue = 0`, `secondaryValue = 0` (MUST). The vault MUST revert if `public[5] ≠ 0` or `public[6] ≠ 0`.
3. **Private conservation:** `sum = Σ inValue[i]`; `outLabel_witness = inLabel[k]`; `inValue[k] ≥ inValue[i]` for all active `i`
4. **Asset bind:** every active input shares one `assetId`; `outCommitment = commitment(sum, outLabel_witness, assetId, outNullifier, outSecret)`
5. `public[8] = 0` (inheritance is private only)

Disclosure: opening the output note (or ASP selective disclosure of `outLabel_witness`) still shows the **same association label** as the boundary input. Swap dest notes use the same rule (`destLabel == inLabel[0]`, private). Chain observers do not see that label.

### 6.3 SWAP (`action = 2`)

1. `N = 1`, `k = 0`
2. `primaryValue > 0`, `primaryValue ≤ inValue[0]`, `secondaryValue = inValue[0] - primaryValue`
3. Change `outLabel_witness = inLabel[0]` (**private**); change note rules as §6.1 with **src** `assetId`; `public[8] = 0`
4. Public mux 17–23 constrained in circuit (§4.2)
5. `outputPrecommitment` (index 21) binds destination note precommitment
6. **Src asset bind:** `public[23] == inNote.assetId`
7. **On-chain:** settlement fill with `srcToken=public[23]`, `dstToken=public[18]`; measured `amountOut ≥ minAmountOut` (index 20)
8. **Destination label bind (mandatory, private):** `destLabel == inLabel[0]` in the circuit. **Not** a public limb.
9. **Destination note binding:**

```
dstAssetId == public[18]
destCommitment == commitment(minAmountOut, destLabel, dstAssetId, publicInputs[21])
publicInputs[22] == destCommitment
insertedLeaf == publicInputs[22]
```

Vault MUST reject swap finalize if `insertedLeaf != publicInputs[22]` or `amountOut < minAmountOut`. User dest note value is `minAmountOut`. **Surplus** `measuredOut − minAmountOut` (if any) accrues to `protocolClaimable[dstToken]` (does **not** consume the protocol pre queue on the permissionless path). Governance mints a protocol-owned note via `mintProtocolSurplusNote(token, amount)` using a **unique** queued `childPre` (duplicate enqueue rejected). Kernel MUST reject `srcToken == dstToken`, `amountIn == 0`, and out-of-range Uniswap `fee`.

**SWAP payeeId (index 15):** D1 pool settlement (Uniswap / inventory adapter) has no EOA payout in the same action — circuit and spend-core **MUST** set `public[15] == 0`. Non-zero SWAP payee is deferred (would require `PayeeIdEvm` bind like WITHDRAW).

### 6.4 SPLIT (`action = 3`)

1. `N = 1`, `k = 0`, `outLabel = inLabel[0]`
2. `Σ outValue[i] = inValue[0]`
3. Every slice commitment uses the **same** `assetId` as the input note
4. Slice commitments and `splitRoot` per §4.4
5. `primaryValue = secondaryValue = 0`

### 6.5 RAGEQUIT (`action = 4`) — escape hatch

1. `N = 1`, `k = 0`
2. Eligibility **in the circuit** — §5.2.1 (Pending = empty ASP ∧ SMT non-inclusion; Revoked = SMT inclusion). Admitted (ASP ∧ ¬SMT) MUST fail.
3. `primaryValue = inValue[0]`; `public[8] = 0`
4. `outCommitment = commitment(primaryValue, inLabel[0], assetId, inNullifier[0], inSecret[0])` (binds opened note; not inserted)
5. Circuit: `public[3]`/`[4]` = current roots used in the paths; `public[17] == payeeId(witness.rawPayee)`; `public[18] == assetId`
6. Vault **before finalize:**
  - `admittedRootIsCurrent(publicInputs[3]) && revokedRootIsCurrent(publicInputs[4])`
  - `publicInputs[8] == 0`
  - `publicInputs[15] == 0` (ragequit payee is mux 17)
  - `publicInputs[17] == payeeId(rawPayee)` from calldata
7. Vault pays `primaryValue` of token `address(uint160(public[18]))` to `rawPayee`; **MUST** burn nullifier at `publicInputs[9]` (§8.3); **MUST NOT** Merkle-insert `outCommitment`; **MUST NOT** read a public label-status map

**Product mapping (F-8 accepted):** Live ASP is non-empty. **Pending** empty-ASP ragequit is bootstrap only. Pre-admit / KYT-fail exits → postman SMT insert → **revoked** ragequit. After admit bus + indexed inclusion proof → private spend only; ragequit forbidden in-circuit (UI cannot override). Admitted funds MUST use private spend (§5.1).

---

## 7. Compliance and admission policy

### 7.1 KYT gate (mandatory)

1. **Deposit:** §2.7 — measure tokens, mint salted label, insert `C`. No public `DepositInfo` graph.
2. **KYT / screening** (off-chain operator): pass or fail (typically fast relative to the admit epoch).
3. **Fail:** label MUST NOT be inserted into the association tree; private spend MUST fail (§5.1.4). Postman inserts the label into the **revocation SMT** (§7.3); depositor exits via **revoked RAGEQUIT** (§5.2.1). Absence from ASP alone is **not** the reject signal — SMT insert is.
4. **Pass:** postman inserts the label leaf off-chain per §2.6.1; publishes `ComplianceHub.admittedRoot` on the **admit epoch** (§2.6.2). The published root is a **shared** membership set for all admitted labels (no per-user relative ticket). Emergency single-leaf publishes are allowed but are not the default (timing join).
5. **Private spend:** only after the label is in the **published** current root — circuit proves §5.1 rules 4 and 8.

Operational latency is the epoch (default **5 minutes**) plus KYT. The epoch exists mainly for **privacy** (§2.6.2 timing-join avoidance), not because KYT is slow. The gate is **cryptographic**, not honor-system / UI. App activity may flip deposit → **admitted** when the indexer has an inclusion path vs the published root; that display is not authoritative. Before the first `admittedRoot` publish, pending deposits MAY use **pending RAGEQUIT** (§5.2.1 bootstrap). After ASP is non-empty (normal prod), pre-admit exit is **SMT → revoked RAGEQUIT** (F-8 accepted).

Off-chain association-set HTTP mirrors are for **forensics and ops**; they MUST NOT be the sole spend gate.

### 7.2 On-chain checks (no public label status)

**Private spend** (after verify, before finalize):

```solidity
require(publicInputs[0] != RAGEQUIT);
require(publicInputs[8] == 0);
require(complianceHub.admittedRootIsCurrent(publicInputs[3]));
require(complianceHub.revokedRootIsCurrent(publicInputs[4]));
require(merkleTree.rootExists(publicInputs[2]));
```

Revocation is **SMT non-inclusion in the circuit** for every input. Do **not** look up `depositsByLabel[outLabel]` — that map MUST NOT exist (3.4).

**RAGEQUIT** (§8.4): current compliance roots + circuit eligibility (§5.2). No status enum. Do **not** zero `public[3]` / `public[4]`.

### 7.3 Revoke (atomic postman batch)

For each label `L` in the off-chain batch:

1. Insert `L` into the **revocation SMT**; compute `newRevokedRoot`.
2. In the **same transaction**: call `ComplianceHub.updateRevokedRoot(newRevokedRoot)`.

**Atomicity (mandatory):** a partial SMT update that does not publish the new root (or the reverse) is forbidden. One tx, one new current root.

Revocation MUST NOT rely on removing `L` from the association tree (ASP may still contain historical membership; SMT blocks private spend).

There is **no** `Vault.markLabelsRevoked` and **no** public label-status map. Events: `RevokedRootUpdated(prev, newRoot)` only — **MUST NOT** emit `labels[]`.

Historical `admittedRoot` / `revokedRoot` values MUST NOT be accepted at private spend.

```solidity
function updateAdmittedRoot(uint256 newRoot) external onlyPostman {
    admittedRoot = newRoot;
    emit AdmittedRootUpdated(newRoot);
}

function updateRevokedRoot(uint256 newRoot) external onlyPostman {
    uint256 prev = revokedRoot;
    revokedRoot = newRoot;
    emit RevokedRootUpdated(prev, newRoot);
}
```

---

## 8. On-chain spend API

Single entrypoint: `spend(publicInputs, proof, actionCalldata)`.

### 8.1 Proof-first invariant

Vault MUST NOT accept duplicate calldata for values in `publicInputs[5]`, `[6]`, `[8]`, roots, or nullifiers.


| Action          | Extra calldata                | Binding                                                       |
| --------------- | ----------------------------- | ------------------------------------------------------------- |
| WITHDRAW        | `rawPayee` bytes              | `publicInputs[15] == payeeId(rawPayee)`; payout to `rawPayee` |
| SPLIT           | `uint256[8] splitCommitments` | Per §4.4 and §8.4                                             |
| SWAP            | ActionRouter / swap mux args | `publicInputs[15] == 0` (D1 pool; no EOA payout); mux `[17..23]` |
| RAGEQUIT        | `rawPayee` (secret-holder)    | `publicInputs[17] == payeeId(rawPayee)`; no depositor map     |


### 8.2 Pre-checks (all actions)

After `registry.verifySpend(publicInputs, proof)`:

```solidity
require(publicInputs[16] == vaultPinnedProgramVersion);
require(merkleTree.rootExists(publicInputs[2]));
_burnNullifiers(publicInputs, publicInputs[1]);
```

**Private-spend additional checks** (`action` ∈ {WITHDRAW, MERGE, SWAP, SPLIT}):

```solidity
require(publicInputs[8] == 0);
require(complianceHub.admittedRootIsCurrent(publicInputs[3]));
require(complianceHub.revokedRootIsCurrent(publicInputs[4]));
if (publicInputs[0] == MERGE) {
    require(publicInputs[5] == 0 && publicInputs[6] == 0);
}
```

**RAGEQUIT additional checks** (`action == RAGEQUIT`):

```solidity
require(publicInputs[8] == 0);
require(complianceHub.admittedRootIsCurrent(publicInputs[3]));
require(complianceHub.revokedRootIsCurrent(publicInputs[4]));
require(publicInputs[17] == payeeId(rawPayee));
```

### 8.3 Nullifier burn

Burn `publicInputs[9 .. 9+inputCount-1]` only.

### 8.4 Action-dispatched finalize (normative)

Same structure as v3.0.2 §8.4 with updated indices (`primaryValue` = `[5]`, `secondaryValue` = `[6]`, `outCommitment` = `[7]`, `outLabel` = `[8]`, `payeeId` = `[15]`, split root = `[17]`, ragequit depositor payeeId = `[17]`).

- **WITHDRAW:** verify `payeeId(rawPayee)`; `_payout(rawPayee, publicInputs[5])`; `_maybeInsertChange`
- **MERGE:** require `publicInputs[5] == 0`; `_insertSingleOutput(publicInputs[7])` only (amount lives in the commitment; label not public)
- **SWAP:** `_maybeInsertChange`; insert `publicInputs[22]` as dest leaf (§6.3.8)
- **SPLIT:** `_finalizeSplit` — per-index equality; skip zero inserts
- **RAGEQUIT:** `_finalizeRagequit` — §6.5; **no** Merkle insert; **no** label-status map

`_maybeInsertChange` uses `publicInputs[6]` (changeValue) and `publicInputs[7]` (outCommitment). Relayer MUST NOT supply a depositor.

### 8.5 Verifier registry

Unchanged from v3.0.2: pin one `programVersion` per Vault; register-only registry; manifest pins **Circom zkey hash(es)** + **Solidity Groth16 verifier bytecode** (not a zkVM ELF).

### 8.6 Relayer (spend)

`spend` MUST be callable by any address. `msg.sender` is **not** identity. The product default is a **relayer** (or bundler) that broadcasts the proof and pays gas.


| Path                                                                               | Relayer default                                              | Why                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Private spend** (withdraw-to-pool / merge / swap / split, and unshield *submit*) | **Yes**                                                      | Explorer `tx.from` is the relayer, not Alice. Payee / dest `C` stay proof-bound so the relayer cannot steal.                                                           |
| **Deposit**                                                                        | No (optional)                                                | ERC-20 `Transfer(from, vault, X)` still names the token source. Relaying `deposit()` only hides the caller. Deposit privacy is a **fresh funding EOA**, not a relayer. |
| **Unshield payout**                                                                | Relayer submits `spend`; `rawPayee` is a **fresh** recipient | Relayer does not change the public `vault → Bob` transfer. Using Alice’s deposit address as `rawPayee` is a self-join.                                                 |
| **Ragequit**                                                                       | Relayer MAY submit                                           | Payout is still attributed (`rawPayee` / amount public by design).                                                                                                     |


The vault MUST NOT take depositor, change amount, dest precommitment, or merge amount from relayer calldata (proof-first, §8.1).

---

## 9. Proving tiers (Groth16 SNARK)


| Tier | Description                                         | Production default |
| ---- | --------------------------------------------------- | ------------------ |
| T0   | Local Circom Groth16 (browser snarkjs / CLI)        | **Yes**            |
| T1   | Self-hosted rapidsnark / prove API (sealed witness) | Opt-in             |


STARKs, zkVM guests (SP1, etc.), and remote STARK networks are **out of scope** for this protocol.

Client MUST recompute `PublicOutputs` locally and match Groth16 public inputs before submit.

**Note storage:** ZK note secrets MUST remain **device-local** by default. Server-side account sync (e.g. Supabase) is out of scope and MUST NOT be required for spend. Optional encrypted export files only.

---

## 10. Privacy limitations (accepted)

- `public[8] == 0` (3.4). Publishing `outLabel` is **forbidden** (was the N=1 join key).
- Public `admittedRoot` and `revokedRoot` per spend — compliance snapshot (does not publish `inLabel[]`).
- Public `payeeId` on withdraw exit (hash-bound; raw payee in calldata). Ragequit payout is attributed by design.
- Deposit `tx.from` and token amount remain L1-public. Unlinkability starts **after** the note is in the pool.
- AMM logs on a real Uniswap/Jupiter fill still show the vault leg (not the user), unless a netting adapter is used.
- Do **not** publish `inLabel[]` as a compliance shortcut.
- Association **sticks** across merge / split / swap (`outLabel_witness` / `destLabel == inLabel[k]`). That is how disclosure (user opening or ASP records) can still follow funds. It is **not** an explorer join (`public[8] = 0`).
- Admit-epoch publishes hide per-deposit root timing; they do not hide deposit `tx.from` / amount.

---

## 11. Versioning


| Change                                            | Requirement                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Circuit / `spend-core` logic                      | Bump `PROGRAM_VERSION`; new zkey(s) + Solidity verifier registry entry           |
| Chain profile `encodePayee` / `vaultScope` change | **MUST** bump `PROGRAM_VERSION` (even if circuit logic unchanged)                |
| Chain profile swap mux only                       | Bump `chainProfileId`; MAY share circuit if mux enforced off-chain               |
| Verification artifact                             | New verifier registration (e.g. Solana program)                                  |
| Public layout                                     | Bump `PUBLIC_WIDTH` — breaking                                                   |


---

## 12. Forbidden in v3 implementations

- v2 **32-slot** `aspRoots` **ring** + `aspRootIsRecent` historical roots
- Revocation by **ASP tree eviction only** (must use SMT §2.5)
- Spend without **ASP inclusion** proof per active input (§5.4)
- Spend without **SMT non-inclusion** per active input (§5.8)
- Dual incompatible compliance paths (ASP inclusion + alternate admit gate)
- Raw `label` bits as SMT path indices
- N-specific spend verifiers on new vaults
- Duplicate value calldata on spend entrypoints
- Relayer-supplied `depositor` for `_writeLatestNote`
- Universal Merkle insert on `outCommitment != 0` without action dispatch
- Merkle insert of zero commitments (split)
- Required server-side note sync for proving
- Private spend (§5.1) while label ∉ `admittedRoot`
- Private spend while label **∈** current SMT (revoked)
- RAGEQUIT while ASP inclusion ∧ SMT non-inclusion (Admitted — use private withdraw)
- RAGEQUIT with stale `publicInputs[3]` / `publicInputs[4]` (must be **current** roots — 3.4)
- `publicInputs[8] != 0` on any spend (3.4)
- MERGE with `publicInputs[5] != 0` or `publicInputs[6] != 0` (3.4.1)
- `RevokedRootUpdated` (or admit events) emitting plaintext `labels[]`
- Relayer-supplied merge amount / depositor / dest pre (must be proof-first)
- User-supplied `label` at deposit; `userSalt == 0`; note `amount !=` measured tokens (§2.7)
- Public `depositsByLabel` / `labelStatus` maps
- Partial revoke batch (SMT updated without publishing `revokedRoot`, or reverse)
- Swap dest insert where `insertedLeaf != publicInputs[22]`

Legacy name `aspRoot` MAY appear in comments mapping to `admittedRoot`. New code MUST use `admittedRoot`.

---

## 13. Required test vectors (M0 gate)

Fixtures in `siphon-zkv2/test-vectors/`. Tests in `siphon-tests/zkv2/`.


| File                                    | Asserts                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `domains.json`                          | Domain separators incl. `DOMAIN_VAULT_SCOPE`, `DOMAIN_PAYEE`   |
| `chain-profile-evm.json`                | EVM `vaultScopeId`, label mint, `payeeId`                      |
| `poseidon.json`                         | Hash parity                                                    |
| `asp/empty-root.json`                   | Empty association tree root                                    |
| `asp/inclusion-path.json`               | Label inclusion + path index bind (§2.6.1)                     |
| `smt/empty-subtrees.json`               | Revocation empty tree                                          |
| `smt/smt-key-path.json`                 | Hashed SMT keys                                                |
| `smt/path-index-bind.json`              | SMT path bits                                                  |
| `public-encoding.json`                  | 25-limb order                                                  |
| `withdraw-w3-ok.json`                   | Valid withdraw (ASP + SMT)                                     |
| `withdraw-w3-not-admitted-fail.json`    | Private spend, label ∉ ASP → fail                              |
| `withdraw-w3-revoked-fail.json`         | Private spend, revoked label → fail                            |
| `ragequit-pending-not-admitted-ok.json` | RAGEQUIT, pre-first-admit (`EMPTY_ASP_ROOT`) → ok |
| `ragequit-revoked-ok.json`              | RAGEQUIT, SMT inclusion (revoked path) → ok        |
| `ragequit-admitted-fail.json`           | RAGEQUIT while Admitted → fail                     |
| `split-root.json`                       | Split root                                         |
| `split-calldata-mismatch.json`          | Vault per-index revert                             |
| `swap-output-precommitment-fail.json`   | Wrong mux 21 → fail                                |
| `swap-destination-bind.json`            | Destination commitment bind                                    |
| `merge-m2-ok.json`                      | Valid merge; `expectedPublic[5]==0`; amount in `outCommitment` |
| `deposit-guards.json`                   | Fake amount + label-borrow MUST fail (§2.3, §2.7)              |
| `swap-destination-label-bind.json`      | Circuit destLabel == inLabel (private); public[8]==0           |


---

## 14. Migration from v2 Hard ASP


| v2                                       | v3.2                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `aspRoot` public signal                  | `admittedRoot` (index 3)                                                   |
| 32-root ring                             | Single current `admittedRoot`                                              |
| Revoke via ASP root rotation             | `revokedRoot` SMT + `ComplianceHub.updateRevokedRoot` (root-only; no label map) |
| 14 circom circuits (v2 ASP ring layouts) | Circom Groth16 family aligned to v3.4 publics (`spend-core` + `circuits/`) |
| `Poseidon(uint160(vault), nonce)` label  | `Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, nonce)` — §2.3                 |
| v2 ragequit (no ASP in circuit)          | v3.4 RAGEQUIT escape §5.2 — pending/revoked branches; **current** `public[3]`/`[4]` (do not zero) |
| Raw `recipient` in proof                 | `payeeId` + calldata — §1.2                                                |
| `aspPath*` witness                       | `admittedPath*` + `revokedSmtPath*`                                        |


---

## 16. Appendix A — EVM chain profile (`evm-v1`)

Normative JSON: `[chain-profiles/evm-v1.json](chain-profiles/evm-v1.json)`.

### A.1 Vault scope and label

```
vaultScopeId = Poseidon(DOMAIN_CHAIN_EVM, chainId, uint160(vaultAddress))
nonceStem    = Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce)
label        = Poseidon(nonceStem, userSalt)    // userSalt ≠ 0; never calldata as `label`
```

### A.2 Payee encoding

```
payeeField = BigUint( zero_pad_12 || address_20 ) mod FIELD   // 12 zero bytes, then 20-byte EVM address BE
payeeId    = Poseidon(DOMAIN_PAYEE, payeeField)
```

Withdraw: calldata carries 20-byte `rawPayee`; Vault requires `publicInputs[15] == payeeId(rawPayee)` before transfer.
SWAP (D1 pool): `publicInputs[15] == 0` — no EOA payout in the same action.

Ragequit: `publicInputs[17] == payeeId(rawPayee)` from calldata (secret-holder). No `depositsByLabel`.

### A.3 Swap mux

Indices 17–23: `pool`, `dstToken`, `fee`, `minAmountOut`, `outputPrecommitment`, `destCommitment`, `srcAssetId`. Index 24 MUST be `0`.
`fee` MUST fit Uniswap V3 `uint24` (Circom `Num2Bits(24)` / spend-core reject otherwise).

Settlement: `ISettlementAdapter.fill(pool, srcToken, dstToken, fee, amountIn, minAmountOut)` with measured balance deltas. Dest note `assetId == dstToken`.

### A.4 Verification

Circom Groth16 (BN254) → `VerifierRegistry.verifySpend`. See `[manifest/universal-spend-v1.json](manifest/universal-spend-v1.json)`.

### A.5 Future Solana profile (non-normative sketch)

- `vaultScopeId = Poseidon(DOMAIN_CHAIN_SOL, programId, vaultPda)`
- `payeeField` from 32-byte pubkey via profile hash (pubkey does not fit one field directly)
- Swap mux maps to Jupiter/route bind fields
- Verification artifact TBD (not Groth16-on-BPF by default)

---

## 15. OMEGA guardrails (summary)


| ID   | Requirement                                                                          |
| ---- | ------------------------------------------------------------------------------------ |
| O-1  | `smtKey(label)` hashed SMT path — §2.5                                               |
| O-2  | SMT non-inclusion on **private spend** inputs — §5.1.8                               |
| O-3  | Witness ↔ public binding — §4.5                                                      |
| O-4  | Merge inserts `outCommitment` only; `public[5]=0` — §6.2, §8.4                       |
| O-5  | Split per-index calldata — §4.4                                                      |
| O-6  | Action mux zeros — §6.0                                                              |
| O-7  | Atomic revoke batch — §7.3                                                           |
| O-8  | Relayer cannot set owner — no depositor calldata; ragequit opens the note            |
| O-9  | Action-dispatched finalize — §8.4                                                    |
| O-10 | Ragequit no insert — §6.5                                                            |
| O-11 | SMT path indices bind — §5.1.8                                                       |
| O-12 | Swap destination bind — §6.3.7–8                                                     |
| O-13 | Distinct active `inLabel[i]` — §5.1.7                                                |
| O-14 | `stateRoot`/`admittedRoot`/`revokedRoot` bind — §4.5                                 |
| O-15 | **ASP inclusion per private-spend input** — §5.1.4                                   |
| O-16 | **KYT gate** before association insert — §7.1                                        |
| O-17 | No v2 ASP root ring — §2.6, §12                                                      |
| O-18 | **RAGEQUIT escape** — §5.2; current roots; Pending (ASP∉ ∧ SMT∉) or Revoked (SMT∈)   |
| O-19 | **Swap dest** — private `destLabel == inLabel[0]`; `public[22] == destCommitment`    |
| O-20 | **ASP append-only insert** — §2.6.1                                                  |
| O-21 | Inactive witness slots zeroed — §4.5 (MUST)                                          |
| O-22 | `payeeId` calldata bind — §1.2, §8.1                                                 |
| O-23 | **Deposit amount bind** — note amount == measured tokens (§2.7)                      |
| O-24 | **Label mint** — vault nonce + non-zero salt; no user-supplied label (§2.3)          |
| O-25 | `public[8] == 0` — no on-chain outLabel join key                                     |
| O-26 | **MERGE** `public[5]=0` — amount in commitment, not a public limb (§6.2)             |
| O-27 | **Admit epoch** — default 5-minute `admittedRoot` publish; revoke immediate (§2.6.2) |
| O-28 | **Spend relayer** — `msg.sender` is not identity; proof-first payee/dest (§8.6)      |
| O-29 | **Revoke events root-only** — no `labels[]` (§7.3)                                   |
| O-30 | **SDK public bind** — `expectedPublics` MUST match spend-core derivation (Z-1)         |
| O-31 | **SDK root gate** — `proveSpend` MUST take current `vaultRoots` (Z-2 / GF-M1)        |
| O-32 | **SDK hosted verify** — T1 proof MUST pass local Groth16 verify vs pinned vkey (F-2) |
| O-33 | **SDK compliance merge** — label-bound ASP/SMT path attach (F-3)                       |
| O-34 | **SDK ASP origin** — Bearer only to allowlisted / loopback origins (F-4)               |
| O-35 | **SDK witness hygiene** — derive publics via stdin; no witness secrets on disk (F-7)   |


---

## Changelog


| Version | Date       | Change                                                                                                                                                            |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.0.0   | 2026-08-26 | **Fractional withdraw change:** WITHDRAW change may be any value `≤ inValue[boundary]` (§6.1.4, circuit `LessEqThan(128)`), replacing the `= boundary OR 0` rule — arbitrary-amount withdrawals in a single proof. `PROGRAM_VERSION=4` (new zkeys/verifiers + MPC ceremony + contract redeploy required). |
| 3.5.0   | 2026-08-25 | **D1:** asset-bound commitments (`Poseidon3(amount,label,assetId)`); multi-token vault; WITHDRAW `public[17]=assetId`; RAGEQUIT `public[18]=assetId`; SWAP `public[23]=srcAssetId` + dest uses `dstToken` as assetId; `PROGRAM_VERSION=3`; Uniswap settlement `fill(src,dst,…)` |
| 3.4.3   | 2026-08-25 | SDK guardrails O-30…O-35; aspv2 align (`userSalt` screen, `claimedLeaf` SMT, mandatory `vaultRoots`); see `docs/OMEGA-CLOSURE.md`                                |
| 3.4.2   | 2026-08-24 | Proving stack = **Circom Groth16 SNARK only**; remove STARK/zkVM/ELF language; “guest” → circuit/`spend-core`                                                     |
| 3.4.1   | 2026-08-23 | MERGE `public[5]=0` (amount in `outCommitment` only); spend relayer as default submitter; 5-minute ASP admit epoch; revoke events root-only; `PROGRAM_VERSION=2`  |
| 3.4.0   | 2026-08-23 | Privacy-first kernel: `public[8]=0`; salted labels; deposit amount bind; no `depositsByLabel`; cryptographic ragequit (current roots); swap dest via `public[22]` |
| 3.3.0   | 2026-08-23 | OMEGA pass 5: RAGEQUIT escape (§5.2); swap `L_dst` bind; ASP insert §2.6.1; atomic revoke; action-dispatched pre-checks                                           |
| 3.2.0   | 2026-08-23 | Chain profiles: `vaultScopeId`, `payeeId`, swap mux; proof envelope split; §16 EVM appendix                                                                       |
| 3.1.0   | 2026-08-23 | ASP admission + SMT revocation; `PUBLIC_WIDTH=25`; KYT gate §7                                                                                                    |
| 3.0.2   | 2026-08-23 | OMEGA pass 4: action-dispatched finalize (superseded)                                                                                                             |
| 3.0     | 2026-08-23 | Initial normative spec                                                                                                                                            |


