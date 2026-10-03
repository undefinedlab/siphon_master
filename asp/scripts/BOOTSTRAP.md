# Local bootstrap — aspv2 + contracts-v2 + zkv2 clock (Anvil chain 31337)

No siphon-app required. Goal: deposit → screen/admit → publish roots → fetch ASP/SMT paths → prove with zkv2 SDK.

## 1. Deploy contracts

```bash
cd ../siphon-contracts-v2/evm
anvil &   # RPC at :8545
forge script script/DeployVaultStack.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

## 2. Export env + publish empty compliance roots

```bash
cd ../siphon-aspv2
eval "$(./scripts/export_aspv2_env.sh | grep -v '^#')"

# Forge reads COMPLIANCE_HUB_ADDRESS, ADMITTED_ROOT, REVOKED_ROOT from the environment
cd ../siphon-contracts-v2/evm
forge script script/BootstrapVault.s.sol:PublishComplianceRoots \
  --rpc-url http://127.0.0.1:8545 --broadcast
```

Empty ASP and empty SMT roots are identical depth-32 Poseidon empty trees
(`21443…56601`) — must match `siphon-zkv2/test-vectors/asp/empty-root.json`.

## 3. Run aspv2 + postman + deposit watcher

```bash
cd ../siphon-aspv2
./scripts/export_aspv2_env.sh >> .env
# Set ASP_SCREEN_TOKEN, ASP_POSTMAN_TOKEN, ASP_ADMIN_TOKEN
# ASP_DATABASE_URL=postgresql+psycopg2://asp:asp@127.0.0.1:5432/aspv2

python app.py                                    # :5056
python postman.py loop --chain-id 31337          # 5-min admit epoch + revoke + reconcile
python scripts/watch_deposits.py --chain-id 31337 --loop
```

Screen with `commitment` + `userSalt` before deposit so the watcher can derive the label.

If `ZKME_MCH_NO` / `ZKME_API_KEY` are set locally, either pay via `/compliance-fee/*` or set **`ASP_ALLOW_SKIP_KYT_FEE=1`** (dev only). Leave zkMe unset to run lists + oracle only.

## 4. Smoke without chain

```bash
python scripts/e2e_journey.py          # screen → admit (mock) → paths
python -m pytest -q
```

## 5. Prove path (zkv2 SDK, no app)

```bash
cd ../siphon-zkv2
# After admit + publish, load paths from aspv2 and merge into SpendWitness:
node -e '
const asp = require("./sdk/aspClient");
(async () => {
  const c = await asp.loadComplianceWitnessMulti({
    aspBaseUrl: "http://127.0.0.1:5056",
    screenToken: process.env.ASP_SCREEN_TOKEN,
    labels: [process.env.LABEL],
  });
  console.log(JSON.stringify(c, null, 2));
})();
'
# Then: applyComplianceWitness(witness, c) → proveSpend({ witnessJson, input, ... })
```

See [siphon-zkv2/README.md](../siphon-zkv2/README.md) § Compliance clock.

## 6. Verify

```bash
curl -s -H "Authorization: Bearer $ASP_SCREEN_TOKEN" http://127.0.0.1:5056/set/root | jq
python postman.py status --chain-id 31337
cd ../siphon-contracts-v2/evm && forge test --match-path test/M4.t.sol -q
```
