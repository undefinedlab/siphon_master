# Public inputs — on-chain binding

Normative: `siphon-zkv2/PROTOCOL.md` **v3.5.0** §4. Width **25**. Field: BN254 scalar.

## Layout

| Index | Name | Rule |
| --- | --- | --- |
| 0 | `action` | 0 WITHDRAW … 4 RAGEQUIT |
| 1 | `inputCount` | WITHDRAW 1–6, MERGE 2–6, others 1 |
| 2 | `stateRoot` | Historical vault state root |
| 3 | `admittedRoot` | **Current** ASP root (private spend **and** ragequit) |
| 4 | `revokedRoot` | **Current** SMT root (private spend **and** ragequit) |
| 5 | `primaryValue` | withdrawn / amountIn / ragequit amount; **MERGE MUST be 0** |
| 6 | `secondaryValue` | change; **0** for merge / ragequit / split |
| 7 | `outCommitment` | 0 if zero-change or split; MERGE output note (amount inside hash) |
| 8 | `outLabel` | **MUST be 0** — not a join key |
| 9–14 | `nullifierHash[i]` | `i >= inputCount` ⇒ 0 |
| 15 | `payeeId` | WITHDRAW; SWAP MUST be 0 (D1 pool); else 0 |
| 16 | `programVersion` | Vault pin (**3** as of PROTOCOL 3.5.0 / D1) |
| 17–24 | mux | Unused ⇒ 0 |

## Mux

**WITHDRAW:** 17 = `assetId` (`uint160` token).

**SWAP:** 17 pool, 18 dstToken (= dest `assetId`), 19 fee, 20 minAmountOut, 21 outputPrecommitment, **22 destCommitment**, **23 srcAssetId**, 24 = 0.

**SPLIT:** 17 = `splitRoot`.

**RAGEQUIT:** 17 = `payeeId(rawPayee)` (secret-holder); **18 = `assetId`**.

## Commitment (D1)

```
inner = Poseidon(amount, label, assetId)
C     = Poseidon(inner, precommitment)
```

## Kernel rules (PROTOCOL 3.5.0)

1. Verify proof; read values **only** from these limbs + profile calldata.
2. `publicInputs[16] == vault.programVersion`.
3. `publicInputs[8] == 0`.
4. MERGE: `publicInputs[5] == 0` and `publicInputs[6] == 0`; insert `[7]` only.
5. Private spend **and** ragequit: current `admittedRoot` / `revokedRoot`.
6. No `labelStatus` / `depositsByLabel` lookup.
7. Swap: `fill(src=public[23], dst=public[18], …)`; insert `publicInputs[22]`; `measuredOut >= minAmountOut`.
8. Withdraw / ragequit: push token from mux asset limb (`[17]` / `[18]`).
9. No duplicate amount/label calldata (incl. no relayer merge amount).
10. `spend` callable by a relayer; `msg.sender` is not identity.
