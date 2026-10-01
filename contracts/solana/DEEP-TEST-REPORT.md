# Solana deep-test report (host)

**Date:** 2026-09-20  
**Scope:** Host-side deep verification of Solana production rails (no BPF/devnet).  
**Plan:** Solana Deep Test (host)

## Summary

All in-scope host suites **PASS**. Vector parity triangle (spend-core ↔ vault ↔ app) holds against `chain-profile-solana.json`. Base `evm/` is untouched.

## Command matrix

| Suite | Command | Result |
| --- | --- | --- |
| Solana workspace | `cargo test --workspace` in `siphon-contracts-v2/solana` | **PASS** — 2 + 17 + 3 property = 22 |
| Fail-closed / no default scaffold | `cargo test -p siphon-vault --no-default-features` + property_kernel | **PASS** |
| spend-core | `cargo test --lib` in `siphon-zk-v2/spend-core` | **PASS** — 29 (incl. `solana_scope_and_payee_stable`) |
| ASP Solana | `pytest tests/test_solana_bind.py -q` | **PASS** — 8 |
| Executor runtime | `pytest tests/test_solana_runtime.py -q` | **PASS** — 5 |
| Intent hop | `pytest tests/test_intent_bridge.py -q` | **PASS** — 3 |
| Indexer | `bun test tests/solana.test.ts` | **PASS** — 3 |
| App Solana vectors | `npx tsx src/lib/v3/noteCryptoSolana.check.ts` | **PASS** |
| App product gates | `npx tsx src/lib/chains/productGates.check.ts` | **PASS** |
| App typecheck | `npm run typecheck` | **PASS** |
| Base intact | `git diff --name-only evm/` under contracts-v2 | **empty** |

## Vector parity triangle

Frozen fixture: [`siphon-zk-v2/test-vectors/chain-profile-solana.json`](../../siphon-zk-v2/test-vectors/chain-profile-solana.json)

| Runtime | Check | Status |
| --- | --- | --- |
| spend-core `SolanaProfile` | `solana_scope_and_payee_stable` | PASS |
| siphon-vault `SolanaPayeeCodec` | `matches_frozen_solana_profile_vectors` | PASS |
| siphon-app | `noteCryptoSolana.check.ts` (scope, label stem, payeeField, payeeId) | PASS |

Pinned decimals (program=`0x11…`, vault=`0x22…`, payee=`0x33…`, nonce=7):

- `vaultScopeId` = `19183590508245192203012639644333567682872289463675851048584515047362978462210`
- `payeeId` = `16251131778136927336947831390974037088188521032891601592675718001963620016178`

## Added coverage this pass

- [`siphon-app/src/lib/v3/noteCryptoSolana.check.ts`](../../siphon-app/src/lib/v3/noteCryptoSolana.check.ts)
- [`siphon-app/src/lib/chains/productGates.ts`](../../siphon-app/src/lib/chains/productGates.ts) + `.check.ts`
- [`siphon-fhe/trade-executor/tests/test_solana_runtime.py`](../../siphon-fhe/trade-executor/tests/test_solana_runtime.py)
- ASP edge cases in `tests/test_solana_bind.py` (EVM depositor reject, invalid base58, allowlist miss)
- Base→Solana ordered intent hop in `tests/test_intent_bridge.py`
- Indexer fixture parse + store: `parseSiphonVaultLogs.ts` + extended `solana.test.ts`

## NOT RUN (cluster / MAINNET-GATE)

See [`MAINNET-GATE.md`](./MAINNET-GATE.md). Explicitly **not** exercised this pass:

- Mollusk / Anchor BPF / live `alt_bn128` pairing
- 14 VK account rent + CU p95 with adapters
- Helius against real enhanced txs (only in-memory fixture hooks)
- ASP confirmed-tx deposit parse + postman Compliance PDA write
- Playwright Phantom e2e ([`siphon-app/e2e/solana-mode.spec.md`](../../siphon-app/e2e/solana-mode.spec.md) remains the acceptance stub)
- 7-day devnet soak

## Failures fixed in-pass

None — baseline was green; new tests passed on first run after aligning intent hop field name `step` (not `name`).

## Verdict

**Host deep-test: GREEN.** Production-shaped Solana rails are consistent across ZK profile, vault host logic, ASP bind, executor scaffold, indexer fixture path, and app crypto/gates. Mainnet readiness remains blocked on ops items in MAINNET-GATE, not on host unit parity.
