# Module contracts

Interfaces in `evm/src/interfaces/`. Implementations swap behind interfaces; kernels depend on interfaces only.

| Module | Interface | Role (PROTOCOL 3.5.0 / D1) |
| --- | --- | --- |
| Public vector | `PublicInputs` library | 25 limbs; MERGE `[5]=[6]=0`; `[8]=0`; asset mux |
| Verify | `ISpendVerifier` / `IVerifierRegistry` | Register-only; pin `programVersion=3` |
| Compliance | `IComplianceHub` | Current `admittedRoot` + `revokedRoot` only. Postman: 5-min admit epoch; immediate revoke. Root events, no `labels[]`. |
| Notes | `IVaultKernel` | Poseidon tree + nullifiers; multi-token `deposit(token,…)`; relayer-callable `spend` |
| Assets | `IAssetAdapter` | Multi-token ERC-20 measured `pull/push(token,…)` (WETH for ETH) |
| Settlement | `ISettlementAdapter` | Uniswap V3 (D1) / future RFQ (D4); `fill(pool, src, dst, fee, amountIn, minOut)`; insert `public[22]` |
| Fees | `IFeeModule` | Delayed config |

**Do not implement** `ILabelStore` / `depositsByLabel` / `labelStatus`. Ragequit pays the secret-holder bound in the proof.

**D4 deferred:** solver/RFQ settlement adapter — same `ISettlementAdapter` surface; not in D1.

## Call graph

```text
User (prove locally)
    └─ Relayer
           └─ VaultKernel.spend(pi[25], proof, extra)
                  ├─ VerifierRegistry.verify(version, pi, proof)
                  ├─ SpendRules.checkPre(pi, hub, tree)   // current roots; MERGE [5]=0
                  ├─ burn nullifiers
                  └─ dispatch
                       ├─ WITHDRAW → payee bind → push(public[17], …)
                       ├─ MERGE    → insert public[7] only (same assetId in guest)
                       ├─ SWAP     → fill(src=23, dst=18, …) → insert public[22]
                       ├─ SPLIT    → extra.commitments vs mux17
                       └─ RAGEQUIT → push(public[18], …); no insert
```

Postman never calls `spend`. Postman calls `ComplianceHub.updateAdmittedRoot` (epoch) / `updateRevokedRoot` (immediate).
