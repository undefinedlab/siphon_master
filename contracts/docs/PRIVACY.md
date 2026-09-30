# Privacy claim (contracts-v2)

Maps [`siphon-contracts/docs/PRIVACY_TARGET.md`](../../siphon-contracts/docs/PRIVACY_TARGET.md) onto PROTOCOL **3.4.3**. Normative spend rules: [`siphon-zkv2/PROTOCOL.md`](../../siphon-zkv2/PROTOCOL.md).

## Honest claim

Siphon is a **screened privacy pool**. A casual chain observer sees pool inflows, roots, nullifiers, occasional vault AMM legs, and attributed ragequits. They cannot join a depositor to a later private spend, swap, or strategy.

Compliance is **proof-verifiable** (guest vs current `admittedRoot` + `revokedRoot`), not explorer-enumerable labels.

## Dual knowledge

| Store | Holds | Who |
| --- | --- | --- |
| Chain | Roots, nullifiers, token physics, 25 public limbs | Everyone |
| ASP | Screened identity ↔ label, Merkle paths | Operator / regulator under process |
| Note | Amount, label, nullifier, secret | User |

ASP membership is on-chain as a **Merkle commitment** (`admittedRoot`), not as a public leaf list.

## 3.4.3 product choices (do not weaken the gate)

| Choice | Privacy | Compliance / security |
| --- | --- | --- |
| MERGE `public[5]=0` | Hides merged note size | Sum still bound in `outCommitment`; vault inserts hash only |
| Keep `changeValue` / withdraw amount | Needed to pay and insert change | Unchanged |
| Spend relayer | Explorer `tx.from` ≠ Alice | Payee / dest `C` proof-bound |
| No deposit relayer as the privacy lever | ERC-20 `Transfer` names the source anyway | Amount bind unchanged |
| 5-minute admit epoch | Hides per-deposit `+1 leaf` timing | Spend still requires **current** published root; pending MAY ragequit; revoke is immediate |
| Same label on swap dest (private) | No explorer join (`public[8]=0`) | Association sticks for disclosure |
| Revoke events root-only | No public revoked-label set | SMT root still gates spend |

## Residual (accepted)

Deposit `from` + amount; unshield `to` + amount; unique amounts / tight timing; vault AMM logs; ASP operator knowledge; ragequit attribution.
