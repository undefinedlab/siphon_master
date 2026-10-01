# Solana verify artifact — research notes (no commit required)

Status: **research dig**, 2026-09-20. Not a production pin yet.  
Goal: choose `verifyArtifactId` for `solana-v1` without breaking the 25-limb Circom guest.

---

## Dig 1 — What Solana actually supports

| Claim in old Siphon docs | Reality (verified) |
| --- | --- |
| “Not Groth16-on-BPF by default” ([PROTOCOL §A.5](../../../siphon-zk-v2/docs/PROTOCOL.md), MULTI-CHAIN) | **Outdated.** Solana has **native `alt_bn128` syscalls** (pairings + G1 ops) on mainnet since ~v1.16/1.18 — this is **not** “emulate Groth16 in pure BPF.” |
| Verifier must be STARK / wrap / trust relayer | **False as primary path.** Production reference: [Lightprotocol/groth16-solana](https://github.com/Lightprotocol/groth16-solana) — Circom-compatible Groth16 over BN254 via syscalls. |
| Poseidon on-chain impossible | **False.** `sol_poseidon` exists (Circom-compatible BN254 Poseidon, light-poseidon params). Needed for trees/labels; confirm feature-gate activation on target cluster before relying on it. |

**Implication:** Siphon’s normative stack (**Circom → Groth16 BN254**, same zkeys as Base) maps cleanly to Solana’s verify port. Prefer this over inventing a second guest.

---

## Dig 2 — Costs and fit for Siphon’s 25 limbs

### Compute units (Light benchmarks, plain Groth16)

| Public inputs | CU (verify) |
| ---: | ---: |
| 1 | ~78k |
| 2 | ~83k |
| 4 | ~91k |
| 8 | ~109k |

Rough linear extrapolation (~4.3k CU / extra input): **~25 inputs ≈ 180–200k CU** for pairing verify alone.  
Default ix budget 200k; tx cap **1.4M**. So CU is **tight but workable** if we `SetComputeUnitLimit` and keep non-verify work lean. Re-benchmark with a real Siphon vkey (25 IC points) — do not trust extrapolation for mainnet.

### Transaction size (harder problem)

| Payload | Bytes (approx) |
| --- | ---: |
| Groth16 proof (A,B,C uncompressed wire) | ~256 |
| Public inputs `25 × 32` | **800** |
| Subtotal | **~1056** |
| Legacy/v0 tx envelope | **1232 max** |

**25 limbs + proof will not fit reliably in a classic 1232-byte tx** once accounts, signatures, and ix headers are included. SuccinctLabs/`sp1-solana` docs call this out explicitly for large public values.

**Mitigations (pick for `solana-v1`):**

1. **Pending-inputs PDA (recommended now)** — prior tx(s) write `publicInputs[25]` into an account; spend tx carries **proof only** (~256 B) + reads the PDA. Pattern used in production-minded Solana verifiers (e.g. commit-then-verify).
2. **Solana v1 / SIMD-0296 4096-byte txs** — when widely available, may allow inline publics; still design for PDA path for compatibility.
3. **Hash publics into one limb** — would change the guest / circuits → **rejected** for Siphon (one guest forever).

### Verifying keys (14 action circuits)

EVM uses `SpendActionGroth16Router` → **14** Circom verifiers (withdraw1–6, merge2–6, swap, split, ragequit).

On Solana:

- Bake or store **one VK account per circuit** (IC length = `#public + 1` → 26 G1 points ≈ ~1.5KB+ per VK).
- Route by action + inputCount (same as EVM router).
- Do **not** put VKs in instruction data.

Reuse **same snarkjs zkeys** as Base; generate Solana VK consts via groth16-solana `circom-vk` tooling.

---

## Dig 3 — Candidate ranking (sense)

| Candidate | Verdict | Why |
| --- | --- | --- |
| **A. Circom Groth16 + `groth16-solana` + alt_bn128** | **Primary** | Same guest as Base; mainnet syscalls; Circom-compatible; CU OK; tx solved via PDA |
| B. Off-chain verify + on-chain attestation | Reject as core | Trust / committee — violates proof-first kernel |
| C. STARK / SP1 wrap of same limbs | Optional later | Extra prover stack; PROTOCOL says product prove = Groth16 only |
| D. Pure-BPF Groth16 (no syscalls) | Reject | What old docs feared; obsolete given syscalls |
| E. Fake / relayer-signed “proof” | Forbidden | Explicit in profile |

**Recommended `verifyArtifactId` (draft name):**  
`groth16-bn254-solana-altbn128-v1`  
= Light-style verifier + per-action VK accounts + pending-inputs PDA + same Circom proofs as EVM.

---

## Dig 4 — Modular port mapping (keep adapters clean)

```text
VerifySpend (port)
  └── SolanaGroth16AltBn128
        ├── VK registry accounts (14 circuits)
        ├── pending_public_inputs PDA
        └── groth16-solana::Groth16Verifier::<25>

Kernel (unchanged checklist)
AssetAdapter / SettlementAdapter / PayeeCodec (unchanged ports)
```

EVM keeps `SpendActionGroth16Router`. Same `programVersion` tuple shape:

`(guestLogicId, solana-v1, groth16-bn254-solana-altbn128-v1)`.

---

## Open verifies (dig again before coding VK wiring)

1. **Re-bench** one real Siphon action circuit (e.g. swap, 25 publics) under mollusk / light-program-profiler — CU + heap.
2. Confirm **endianness** pipeline: snarkjs LE/BE ↔ groth16-solana BE + proof_a negation (Light docs).
3. Confirm **`sol_poseidon`** activated on **devnet + mainnet** for our tree ops (feature gate historically lagged).
4. Size **VK accounts** for largest Siphon circuit; rent-exempt cost × 14.
5. Design **pending-inputs** lifecycle: commit → spend → consume (one-shot) to prevent replay of stale publics.
6. Track **SIMD-0296 / v1 tx** rollout — optional fast path later, not a dependency.

---

## Bottom line

- Old “don’t do Groth16 on Solana” guidance meant **don’t fake it in BPF**. Syscall-backed Groth16 is real and is the **sensible** artifact for Siphon.
- Hard engineering problem is **tx size for 25 limbs**, not pairing math → **commit publics to an account, verify with proof in a second tx**.
- Do **not** change the guest. Do **not** trust the relayer. Implement `VerifySpend` with Light-class Groth16.
