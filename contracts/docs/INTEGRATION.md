# Cross-stack integration (contracts-v2 + aspv2 + zkv2)

End-to-end compliance clock for PROTOCOL **3.4.3**. No siphon-app required.

| Repo | Role |
|------|------|
| **siphon-contracts-v2** | `VaultKernel`, `ComplianceHub`, Groth16 verifiers |
| **siphon-aspv2** | Screen, KYT fee, ASP/SMT paths, postman root publish |
| **siphon-zkv2** | Prove (`proveSpend`), spend-core publics, Circom artifacts |

Normative spec: [`siphon-zkv2/docs/PROTOCOL.md`](../../siphon-zkv2/docs/PROTOCOL.md).

---

## 1. Deploy (EVM)

```bash
cd evm
cp .env.example .env   # GOVERNANCE_ADDRESS, POSTMAN_ADDRESS
forge script script/DeployVaultStack.s.sol --rpc-url $RPC --broadcast
```

Output: `deployments/chain-<id>/deployed_addresses.json` (`ComplianceHub`, `VaultKernel`, `Postman`, …).

See [`DEPLOY.md`](DEPLOY.md) for mainnet hardening (multisig postman, registry timelock).

---

## 2. Wire aspv2

From [`siphon-aspv2/scripts/export_aspv2_env.sh`](../../siphon-aspv2/scripts/export_aspv2_env.sh):

```bash
cd ../siphon-aspv2
eval "$(./scripts/export_aspv2_env.sh ../siphon-contracts-v2/evm/deployments/chain-31337/deployed_addresses.json | grep -v '^#')"
```

Sets (both naming conventions):

- `ASP_COMPLIANCE_HUB_<chainId>` / `COMPLIANCE_HUB_ADDRESS`
- `VAULT_KERNEL_<chainId>` / `VAULT_KERNEL`
- `ASP_POSTMAN_ADDRESS`, `ADMITTED_ROOT`, `REVOKED_ROOT` (empty-tree bootstrap)

Full local walkthrough: [`siphon-aspv2/scripts/BOOTSTRAP.md`](../../siphon-aspv2/scripts/BOOTSTRAP.md).

---

## 3. Publish bootstrap compliance roots

Before any spend, postman publishes initial roots on `ComplianceHub`:

```bash
cd evm
# ADMITTED_ROOT / REVOKED_ROOT from export_aspv2_env (or fixtures/zkv2/test-vectors/asp/empty-root.json)
forge script script/BootstrapVault.s.sol:PublishComplianceRoots \
  --rpc-url $RPC --broadcast
```

Empty ASP and empty SMT roots are the same depth-32 Poseidon empty tree (`21443…56601`). Pending ragequit (pre-first-admit) requires this root published as **current** `admittedRoot` — not zero (`ComplianceHub.admittedRootIsCurrent` rejects `0`).

---

## 4. Deposit → screen → admit (aspv2)

1. **KYT fee** (if zkMe enabled): `GET /compliance-fee/check` → pay vault → `POST /compliance-fee/verify`  
   Treasury: `ASP_COMPLIANCE_VAULT` (aspv2 env — not deployed by contracts-v2).
2. **Screen:** `POST /screen` with `{ chainId, depositor, commitment, userSalt?, vault? }` — not `precommitment`.
3. **Deposit:** `VaultKernel.deposit(token, amount, userSalt, precommitment)` — emits `Deposited` (token indexed; depositor **not** indexed per PROTOCOL §2.7; commitment; no label). Token must be allowlisted. Note `assetId = uint160(token)`.
4. **Admit:** postman `POST /set/admit` or `watch_deposits.py` → epoch publish `admittedRoot`.

API: [`siphon-aspv2/docs/ASP-V2-API.md`](../../siphon-aspv2/docs/ASP-V2-API.md).

---

## 5. Prove + spend (zkv2 SDK)

`PROGRAM_VERSION=4` (D1 + fractional withdraw change §6.1.4). SWAP proofs bind `public[23]=srcAssetId` and dest note asset = `public[18]` (dstToken). Relayer submits `vault.spend(publicInputs, proof, extra)`.

On FHE trigger (limit order): executor should call `VaultKernel.spend` with a SWAP proof — **not** v1 `Entrypoint.swapAndDeposit`. Settlement is `UniswapV3SettlementAdapter` (or bootstrap inventory adapter on testnets).

```javascript
const asp = require("siphon-zkv2/sdk/aspClient");
const { proveSpend, deriveExpectedPublics } = require("siphon-zkv2/sdk");

const vaultRoots = {
  stateRoot: await vault.stateRoot(),
  admittedRoot: await hub.admittedRoot(),
  revokedRoot: await hub.revokedRoot(),
};

const compliance = await asp.loadComplianceWitnessMulti({
  aspBaseUrl: process.env.ASP_URL,
  screenToken: process.env.ASP_SCREEN_TOKEN,
  labels: witness.inputs.map((i) => i.inLabel),
});
const merged = asp.applyComplianceWitness(witness, compliance); // label-bound merge

const expectedPublics = deriveExpectedPublics(merged);
await proveSpend({
  action: merged.action,
  inputCount: merged.inputCount,
  input: circomInput,
  witnessJson: merged,
  expectedPublics,
  vaultRoots, // mandatory — GF-M1 TOCTOU gate
  prefer: "local",
});
// Relayer submits: vault.spend(publicInputs, proof, extra)
```

ASP client security: loopback default; set `ASP_ALLOWED_ORIGINS` in production. See zkv2 [`README.md`](../../siphon-zkv2/README.md).

---

## 6. Fixture sync

Vendored vectors for CI: `fixtures/zkv2/`. Refresh after zkv2 changes:

```bash
./scripts/sync-zkv2-fixtures.sh
```

---

## 7. Env cheat sheet

| Variable | Where | Purpose |
|----------|-------|---------|
| `COMPLIANCE_HUB_ADDRESS` | contracts forge | `PublishComplianceRoots` |
| `ADMITTED_ROOT` / `REVOKED_ROOT` | contracts forge | Bootstrap empty trees |
| `ASP_COMPLIANCE_HUB_*` | aspv2 | Postman + chain_verify |
| `VAULT_KERNEL_*` | aspv2 | Deposit watcher + admit verify |
| `ASP_COMPLIANCE_VAULT` | aspv2 | KYT fee recipient |
| `ASP_URL` / `ASP_SCREEN_TOKEN` | zkv2 client | Paths + screen |
