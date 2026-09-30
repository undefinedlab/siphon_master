# Architecture gate — privacy, compliance, security

**Date:** 2026-08-23 (updated 2026-08-25)  
**Scope:** `siphon-contracts-v2` architecture gate — docs + shipped EVM kernel (`VaultKernel`, `ComplianceHub`, Groth16 router).  
**Question:** is this the right thing to build, or will we ossify v1’s join graph under a new ABI?  
**Verdict (updated 2026-08-23):** **PROTOCOL 3.4.3 is the build target.** Fake-amount, label-borrow, hidden `outLabel`, and cryptographic ragequit are in `siphon-zkv2` + `VaultKernel`. Do **not** implement the Phase A data model. See [`ARCHITECTURE.md`](ARCHITECTURE.md), [`OMEGA-CLOSURE.md`](OMEGA-CLOSURE.md).

Companion canvas (Cursor IDE): `siphon-contracts-v2-architecture-gate.canvas.tsx`

---

## 1. Three goals, one conflict

| Goal | Meaning here | Phase A (PROTOCOL 3.3 as written) | Privacy-first kernel (recommended) |
| --- | --- | --- | --- |
| **Secure** | Notes cannot be stolen; revoked notes cannot privately exit; relayer cannot bind dest/payee/depositor | **Pass** — SMT + current roots, mux 21, proof-first ABI, one kernel | **Pass** — same, without a public status map |
| **Compliant** | No private spend unless in `S_screened`; revoke works; attributed exit when policy requires | **Pass** — ASP inclusion in guest + SMT + ragequit | **Pass, stronger** — eligibility is cryptographic, not a public enum |
| **Private** | Casual L1 observer cannot join depositor → spend / swap (`PRIVACY_TARGET.md` §1) | **Fail** — by spec: public `outLabel`, public `depositsByLabel`, enumerable mint | **Pass vs observer** — residual leaks remain (amounts, timing, AMM leg) |

PROTOCOL 3.3 and `PRIVACY_TARGET.md` are **different snapshots**. Our docs already admitted that, then proposed shipping the non-private snapshot first. That is the wrong product sequence: the first `PROGRAM_VERSION` is the one every note is born under. A later bump is a **migration**, not a flag.

---

## 2. What is already the right choice (keep)

Do not throw away the greenfield kernel. These pieces are how v2 is better than v1:

1. **One `spend(uint256[25], proof, extra)`** — kills 14 Groth16 selectors and duplicate calldata (OMEGA-H-03).
2. **Circom Groth16 on EVM** — same 25-limb semantics; other chains may use a different artifact (`docs/MULTI-CHAIN.md`).
3. **ASP inclusion + SMT non-inclusion in the guest, current roots only** — this *is* the C-02 fix that does **not** publish `inLabel[]`. Forbidden: ASP ring, last-K recency as revoke, `inLabel[]` publics.
4. **Proof-first** — amounts, roots, nullifiers, `payeeId`, dest precommitment come from verified limbs.
5. **Adapters, not subclasses** — one `VaultKernel`; ERC-20 vs native vs SPL cannot diverge on `creditNote` (H-01).
6. **Settlement adapter, not a second vault** — Uniswap v4 / Jupiter cannot ship a weaker ASP (P-07 / M-03).
7. **Register-only `VerifierRegistry` + immutable `programVersion` per vault** (H-03 class: no live verifier swap).
8. **Atomic `updateRevokedRoot`** (O-7). **Revoked is one-way** (H-02).
9. **Pause = no new value in; exits stay live** (L-02).
10. **No plaintext ASP IPFS as a spend gate.**
11. **Global compliance *roots*** (one `admittedRoot` / `revokedRoot` per deployment) — this part of the hub is correct and is how H-04 is solved **without** a label map: every vault’s guest must hit the same current SMT.

---

## 3. What is the wrong choice (do not build)

### 3.1 Phase A as M4

Shipping PROTOCOL 3.3 storage/events first encodes:

| Surface | Observer join |
| --- | --- |
| `publicInputs[8] = outLabel` | N=1 spend = deposit lineage (OMEGA-P-01). Default path. |
| `depositsByLabel[L] = {depositor, amount, commitment, status}` | World-readable graph (P-02). |
| `label = Poseidon(scope, depositNonce)` | Nonce is a public counter → **every label is enumerable** (`PRIVACY_TARGET.md` §6.4). Event hygiene cannot save this. |
| `swapAndDeposit` reuses `outLabel` on dst | Hop join (P-06). |
| Hub `labelStatus[label]` | **Worse than v1:** one global enumerable compliance table, and `spend` must publish `outLabel` to read it. |

Honest Phase A copy (“N=1 is attributed”) is true. It is also **not** the product in `PRIVACY_TARGET.md` §1. If we implement it, we will spend the next year migrating notes.

### 3.2 Belt-and-suspenders `status != Revoked` on `outLabel`

PROTOCOL §7.2 still requires:

```solidity
require(depositsByLabel[publicInputs[8]].status != LabelStatus.Revoked);
```

This check:

- Only sees the **boundary** label (v1 C-02 class — inner inputs never appear).
- **Forces** `outLabel` to be a public limb.
- Is **redundant** if every private-spend input already proves SMT non-inclusion against the **current** `revokedRoot` (PROTOCOL §5.1.8).

v1 needed a public status gate because revoke was “hope the ring rotated.” v3 SMT **is** the revoke gate. Re-implementing `labelStatus` on `ComplianceHub` re-creates the leak the SMT was meant to retire.

H-04 (cross-vault inherited labels) is already solved by a **deployment-global SMT**, not by a global `label → enum` map.

### 3.3 Ragequit via public `DepositRecord`

PROTOCOL §5.2 / §6.5 zeros `admittedRoot`/`revokedRoot` and looks up storage. That is simple for the guest and fatal for privacy (depositor, amount, commitment, status by label).

Compliance does **not** need that map. Ragequit eligibility is:

| Note state | ASP | SMT | Private spend | Ragequit |
| --- | --- | --- | --- | --- |
| Pending (KYT not passed) | ∉ | ∉ | no | yes (ASP **non**-inclusion) |
| Admitted | ∈ | ∉ | yes | **no** |
| Revoked | maybe still ∈ | ∈ | no | yes (SMT **inclusion**) |

Depositor binding: hash depositor into the commitment at deposit (`PRIVACY_TARGET.md` §6.8 Option A). Payout `msg.sender == depositor` in the opening. Observer sees attributed exit **only at ragequit**, which is the accepted valve.

That is a PROTOCOL bump (publics 3–4 are **current** roots on ragequit too; guest branches; no `depositsByLabel` amounts). It is the correct v2, not a later cleanup.

### 3.4 Label mint from a public counter

Phase A mint is still enumerable. Salt-only without a deposit proof still puts `label` in calldata (public). The privacy-preserving bind of **amount** (must match tokens received or the pool is insolvent) to a hidden label is a **deposit proof**: prove `C = commitment(measuredAmount, label, pre)` without revealing `label` / `pre`. Amount stays public (L1 transfer physics). That is an extra guest action or a dedicated shield circuit — design it before Solidity, or we will “temporarily” put label in calldata and never remove it.

---

## 4. Recommended build target (privacy-first kernel)

Call this **PROTOCOL 3.4 / contracts-v2 v1** — the first implementation, not “Phase B later.”

```text
User (local prove)
    └─ spend(pi[25], proof, extra)     // extra = payee bytes / split C[8] / settlement
           │
           ├─ VerifierRegistry          // register-only, vault-pinned version
           ├─ current admittedRoot      // ASP inclusion, every private-spend input
           ├─ current revokedRoot       // SMT non-inclusion, every private-spend input
           ├─ historical stateRoot      // notes remain spendable
           ├─ burn nullifiers
           └─ dispatch insert / payout / settlement adapter
```

**On-chain state that may exist**

- Incremental state Merkle tree (commitments only).
- Nullifier set.
- `admittedRoot`, `revokedRoot` (current).
- Token balances / adapters.
- Known historical **state** roots (not ASP).

**On-chain state that must not exist in v1 of this repo**

- `depositsByLabel` graph (depositor, amount, commitment, status).
- `ComplianceHub.labelStatus[label]`.
- ASP leaf plaintext / IPFS CID as a gate.
- Per-N verifiers, ASP ring, NativeVault fork, V4-only vault.

**Public limbs that must not include**

- `inLabel[]` (already true).
- `outLabel` as a join key — drop from publics; inheritance stays a **private** guest constraint. Swap dest leaf is still `commitment(amountOut, destLabel, mux21)` with `destLabel` private-equal to spent label inside the guest. Chain checks leaf vs measured `amountOut` + mux 21; it does **not** need the label integer.
- Relayer depositor / change value.

**Deposit**

- Measure token delta (FoT-safe).
- Insert `C` only if a **deposit proof** binds `C` to that delta (recommended), or accept a documented interim that `amount` is public and `C` is user-supplied **with** an on-chain proof. Do not emit `precommitment`. Do not index depositor. Do not emit label.

**Ragequit**

- Guest: state inclusion + (ASP non-inclusion **OR** SMT inclusion) + depositor opening.
- `public[3]`/`[4]` = **current** roots (so the vault can require recency). Opposite of 3.3 zeros.
- No Merkle insert. Pay opened depositor. Attributed event is acceptable.

**Swap**

- Keep mux 21 bind (C-01). Keep net `minAmountOut` (M-01).
- Do not require `L_dst` in publics; bind in guest.
- L2 netting (hide *what*) is an adapter/profile later; do not unbind pool/minOut in EVM v1 until a solver profile exists (theft vs privacy).

**Cross-chain**

- Same 25-limb *semantics* after the 3.4 public-layout bump (if `outLabel` is dropped, `PUBLIC_WIDTH` or index 8 meaning changes — bump `PROGRAM_VERSION`).
- Solana still an artifact + profile, not a second guest.

---

## 5. OMEGA map under the recommended kernel

| ID | Phase A plan | Privacy-first kernel |
| --- | --- | --- |
| C-01 dest precommitment | mux 21 + `L_dst` public | mux 21 + `L_dst` **private** in guest; chain binds `C_dst(amountOut, pre)` |
| C-02 inner revoke | SMT + still public boundary status | SMT per input; **no** public boundary status |
| H-01 native fork | adapters | adapters |
| H-02 re-Admit | status machine | no Admit enum on-chain; SMT insert is revoke |
| H-03 relayer metadata | proof-first | proof-first + depositor in commitment |
| H-04 cross-vault | global `labelStatus` | global **SMT root** |
| P-01 N=1 join | accepted | closed (no public `outLabel`) |
| P-02 storage graph | accepted | closed (no `depositsByLabel`) |
| P-03–P-05 events | hygiene | hygiene + no label mint event |
| P-06 dest label reuse | accepted | private inheritance; optional later fresh dest + association bind |

---

## 6. Residual honesty (even after 3.4)

Still public: deposit `tx.from` and amount; unshield `to` and amount; nullifiers; roots; AMM logs for any Uniswap/Jupiter leg; `payeeId` hash on withdraw. Unique amounts and timing still correlate (`PRIVACY_TARGET.md` §7). ASP operator still knows the screened set. Ragequit is identifying. That is the claim we *want* to make — not “invisible money.”

---

## 7. Gate

| Check | Result |
| --- | --- |
| Implement Solidity against Phase A (3.3) data model? | **No — shipped 3.4.3 kernel instead** |
| Kernel modules, adapters, registry, current roots, SMT+ASP in guest? | **Yes — shipped in `evm/`** |
| PROTOCOL 3.3 as frozen SoT? | **No** — 3.4.3 is the freeze |
| `ComplianceHub.labelStatus` | **Do not implement** |
| Deposit bind amount↔`C` without revealing label | **Yes — `spend-core::deposit` + `VaultKernel.deposit`** |

**Next:** PROTOCOL 3.4.3 + vectors are the freeze. Shipped EVM kernel in `evm/` — see [`OMEGA-CLOSURE.md`](OMEGA-CLOSURE.md), [`INTEGRATION.md`](INTEGRATION.md).

---

## 8. Addendum — PROTOCOL 3.4.3 (2026-08-25)

Aligned without loosening ASP/SMT:

- MERGE `public[5]=0` — merged size is not a settlement parameter; conservation stays in the guest + `outCommitment`.
- Spend relayer default — `msg.sender` is not identity; payee/dest still proof-bound. Deposit relayer is not the privacy lever.
- 5-minute admit epoch — current-root gate unchanged; pending still fail-closed for private spend; revoke still immediate; events still root-only.
- Label inheritance on swap remains **private** (`destLabel == inLabel[0]`) so disclosure still traces association.

Docs re-audit (2026-08-25): spec + `PRIVACY.md` bumped to 3.4.3; ARCHITECTURE §7 reflects shipped modules; CI runs `npm run test:docs` + `test:env` (see `evm/scripts/docs-alignment.test.cjs`).
