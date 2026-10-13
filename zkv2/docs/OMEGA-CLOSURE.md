# OMEGA closure tracker (siphon-zkv2)

Living checklist for PROTOCOL §15 / ARCHITECTURE-GREENFIELD §12 guardrails.

Integration guide: [`../README.md`](../README.md) (Compliance clock + SDK table).

| ID | Guardrail | Status |
|----|-----------|--------|
| Z-1 | `expectedPublics` bound to spend-core derivation | Closed |
| Z-2 | `vaultRoots` required before prove (GF-M1) | Closed |
| Z-3 | Hosted consent scoped digest + freeze-list | Closed |
| Z-5 | VK pin fail-closed | Closed |
| F-1 | `circuitKeyForAction` whitelist only | Closed |
| F-2 | Hosted Groth16 verify vs pinned vkey | Closed |
| F-3 | Compliance merge label-bound | Closed |
| F-4 | ASP base URL allowlist / loopback | Closed |
| F-5 | Mandatory `vaultRoots` on `proveSpend` | Closed |
| F-6 | Recursive consent digest; ignore caller digest | Closed |
| F-7 | Witness via stdin to `siphon-prove` | Closed |
| F-8 | `input` ↔ `witnessJson` private-wire bind | Closed |
| F-9 | Dev CLI re-derives publics via spend-core | Closed |
| F-10 | Hosted consent is UX-only (remote prover must auth) | Documented |
| F-11 | Empty-ASP pending ragequit = bootstrap-only | Accepted product |
| F-12 | Compliance roots re-fetched after path loads | Closed |
| F-14 | `circomlibjs` exact pin | Closed |

See also: [`PROTOCOL.md` §15](PROTOCOL.md#15-omega-guardrails-summary) (O-30…O-35).

## D1 re-audit (2026-08-25)

Prior D1 OVERLORD F-1…F-6 remain closed. This pass remediates F-7…F-10:

| ID | Guardrail | Status |
|----|-----------|--------|
| D1-F-7 | `HOSTED_DISCLOSED_FIELDS` includes `assetIds` / `inAssetId` | Closed |
| D1-F-8 | PROTOCOL §8.1 / §16 SWAP `payeeId==0` (no WITHDRAW payout language) | Closed |
| D1-F-9 | spend-core SPLIT rejects slice nf == input nf (match Circom) | Closed |
| D1-F-10 | SWAP `fee` `Num2Bits(24)` + spend-core uint24 bound | Closed |

DELTA: `test/overlord-d1-f7-f10.test.js`; spend-core `swap_fee_above_u24_rejected`, `split_reuses_input_nullifier_rejected`.
