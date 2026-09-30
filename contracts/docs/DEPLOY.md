# Mainnet deploy checklist (OMEGA carry-forward)

Pre-deploy hardening for `siphon-contracts-v2/evm`. Ceremony / MPC is out of scope here.

## Governance & postman (F-3 / F-4)

| Item | Requirement |
| --- | --- |
| **Postman** | 2-of-2 multisig (Safe) as `ComplianceHub.postman` — single EOA is not prod |
| **Governance** | Multisig as `VaultKernel.governance` and `VerifierRegistry.governance` |
| **VerifierRegistry** | Deploy with `minDelay > 0` (e.g. 24–48h). Propose → wait → register Groth16 router |
| **Register-once** | First registered verifier for `programVersion=4` (D1 + fractional withdraw change) is permanent for that registry — audit VKs before register |
| **VK upgrade path** | New `programVersion` + **new vault** (immutable `programVersion` on kernel) |

## Bootstrap (ops)

1. Deploy stack — `evm/script/DeployVaultStack.s.sol` (see `evm/scripts/README.md`).
2. Publish initial `admittedRoot` and `revokedRoot` on `ComplianceHub` before user-facing spend.
3. Admitted publishes are **append-only** on-chain (`seenAdmittedRoots`) — never republish an old root snapshot.
4. Revoke publishes are immediate; reused revoke roots are rejected.
5. **Migration (C-1):** deploy with `PAUSE_DEPOSITS_ON_DEPLOY=true`, run `seedHistoricalRoot`, then unpause deposits.
6. **Asset outbound:** when broadcaster is governance, deploy script calls `VaultKernel.approveAssetOutbound(assetToken, assetAdapter, max)` so `Erc20AssetAdapter` can push vault custody on withdraw.

## Note state roots (F-1)

- `NoteTree.knownRoots` is **unbounded** — every historical state root remains valid for spends.
- `ROOT_HISTORY = 100` is an audit log ring only; it does not expire acceptance.

## Adapters (F-8 / D1)

- Production: wire audited multi-token `IAssetAdapter` + `UniswapV3SettlementAdapter` (`SWAP_ROUTER` env). Allowlist tokens via `VaultKernel.setTokenAllowed`.
- Local Anvil: `DeployVaultStack` deploys `SimpleErc20` + `Erc20AssetAdapter` + bootstrap `Erc20SettlementAdapter` when `SWAP_ROUTER` is unset.
- Adapters are **immutable** on `VaultKernel` — wrong adapter requires new vault.
- Deposit ABI: `deposit(token, amount, userSalt, precommitment)`.

## Incident response (F-6)

- `setDepositsPaused(true)` — stop new deposits; spends still live.
- `setAllActionsPaused(true)` — stop all spend actions (0–4) in one tx.
- Per-action: `setActionPaused(action, true)`.

## Client (GF-M1)

- Prover must pass **current** on-chain roots into `proveSpend({ vaultRoots })` (`siphon-zkv2` SDK — mandatory since 3.4.3).
- `vaultRoots` = `{ stateRoot, admittedRoot, revokedRoot }` from `VaultKernel` + `ComplianceHub` at submit time.
- Optional helper: `assertRootsCurrent(witnessRoots, vaultRoots)` before prove/submit.
- Full stack flow: [`docs/INTEGRATION.md`](INTEGRATION.md).

## Doc regression (CI)

After doc edits, run from `evm/`:

```bash
npm run test:docs
npm run test:env
```

Same gates run in `.github/workflows/ci.yml` after `forge test`.
