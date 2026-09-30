# OMEGA closure tracker (siphon-contracts-v2)

On-chain guardrails aligned to [`siphon-zkv2/PROTOCOL.md`](../../siphon-zkv2/PROTOCOL.md) v3.4.3 and [`siphon-aspv2`](../../siphon-aspv2/).

Integration guide: [`INTEGRATION.md`](INTEGRATION.md). Foundry regressions: `evm/test/OmegaClosure.t.sol`, `evm/test/GammaSmoke.t.sol`.

| ID | Guardrail | Status | Test / location |
|----|-----------|--------|-----------------|
| C-1 | Migration seed one-shot (`seedHistoricalRoot`) | Closed | `OmegaClosure.t.sol` |
| C-2 | Verifier proposal cancel + re-propose | Closed | `OmegaClosure.t.sol` |
| C-3 | Zero payee reverts before asset push | Closed | `OmegaClosure.t.sol` |
| C-4 | Full freeze = deposits + actions pause | Closed | `OmegaClosure.t.sol` |
| F-1 | `NoteTree.knownRoots` unbounded (no ROOT_HISTORY expiry) | Closed | `OmegaClosure.t.sol` |
| F-2 | `seenAdmittedRoots` blocks root rollback | Closed | `OmegaClosure.t.sol`, `GammaSmoke.t.sol` |
| F-5 | Kernel pre-check before Groth16 verify | Closed | `OmegaClosure.t.sol` |
| F-6 | `setAllActionsPaused` kill switch | Closed | `OmegaClosure.t.sol`, `GammaSmoke.t.sol` |
| H-04 | Single current `admittedRoot` + `revokedRoot` (no label map) | Closed | `ComplianceHub.sol`, `M3.t.sol` |
| O-7 | Atomic revoke — root-only event, no `labels[]` | Closed | `GammaSmoke.test_revokeEmitsRootOnlyEvent` |
| O-18 | Ragequit: current roots; pending/revoked branches | Closed | `M4.t.sol`, zkv2 fixtures |
| O-29 | Revoke events root-only | Closed | `IComplianceHub` |
| GF-M1 | Client `vaultRoots` before prove (zkv2 SDK) | Documented | `DEPLOY.md`, `INTEGRATION.md` |
| Z-2 | `admittedRootIsCurrent` rejects zero roots at spend | Closed | `M3.t.sol`, `VaultKernel._checkCompliance` |
| Bootstrap | Empty ASP/SMT root matches zkv2 fixture | Closed | `GammaSmoke.test_emptyAspRoot_matchesFixture` |
| aspv2 | `Deposited` event + `userSalt` label mint | Closed | `M6-deposit.t.sol`, `chain_verify.py` |

See also: zkv2 [`OMEGA-CLOSURE.md`](../../siphon-zkv2/docs/OMEGA-CLOSURE.md) for SDK/prover guardrails (O-30…O-35).

## Surplus / SWAP re-audit (2026-08-25)

| ID | Guardrail | Status | Test / location |
|----|-----------|--------|-----------------|
| S-F-1 | Protocol surplus unique queued pre (no shared nullifier) | Closed → superseded by claimable+mint | `VaultKernel` |
| S-F-2 | Kernel rejects `srcToken == dstToken` | Closed | `OverlordContractsReaudit2.t.sol` |
| S-F-3 | Duplicate surplus commitments blocked by unique pres | Closed | covered by S-F-1 / R2-F-1 |
| S-F-4 | Kernel rejects `amountIn == 0` | Closed | kernel |
| S-F-5 | Uniswap `pool` limb documented unused + SameAsset guard | Closed | `UniswapV3SettlementAdapter.sol` |

## Re-audit 2 (2026-08-25)

| ID | Guardrail | Status | Test / location |
|----|-----------|--------|-----------------|
| R2-F-1 | Duplicate / reused protocol pre enqueue rejected | Closed | `OverlordContractsReaudit2.t.sol` |
| R2-F-2 | SWAP surplus accrues claimable; mint is gov-only (no queue grief) | Closed | `ProtocolSurplusNote.t.sol`, `OverlordContractsReaudit2.t.sol` |
| R2-F-3 | Kernel uint24-bounds SWAP `fee` | Closed | `OverlordContractsReaudit2.t.sol` |
| R2-F-4 | WITHDRAW/RAGEQUIT reject `primaryValue == 0` | Closed | `OverlordContractsReaudit2.t.sol` |
| R2-F-5 | `ProtocolSurplusNote` emits `queueIndex` | Closed | `OverlordContractsReaudit2.t.sol` |

## Docs alignment (re-audit 2026-08-25)

| ID | Item | Status | Test / location |
|----|------|--------|-----------------|
| D-1 | Residual PROTOCOL 3.4.1 refs in spec + privacy | Closed | `docs-alignment.test.cjs` |
| D-2 | CI docs + env gates | Closed | `.github/workflows/ci.yml` |
| D-3 | ARCHITECTURE §7 shipped-module header | Closed | `docs/ARCHITECTURE.md` §7 |
