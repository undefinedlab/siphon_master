/**
 * Regression checks for the merge -> immediate-withdraw race and cross-vault backup recovery.
 *
 * Run: bun src/lib/v3/stateLeafFreshness.check.ts
 */
import assert from "node:assert";

import { backupV3VaultId, sameV3VaultId } from "./noteStoreV3";
import { waitForStateLeaf, type StateLeavesResult } from "./stateLeavesClient";

async function main() {
  const current = "v3-0x94242AE27e0E17000Fb9d28B43118B8A7904c51A";
  const retired = "v3-0x1111111111111111111111111111111111111111";

  assert.ok(sameV3VaultId(current.toLowerCase(), current), "vault-id comparison must ignore address casing");
  assert.ok(!sameV3VaultId(retired, current), "a retired v3 kernel must never become current");
  assert.strictEqual(backupV3VaultId({ vaultId: retired }), retired);
  assert.strictEqual(
    backupV3VaultId({ vaultAddress: current.slice(3) }),
    current,
    "encrypted vaultAddress must recover generation when the plaintext column is absent",
  );
  assert.strictEqual(backupV3VaultId({}), null, "missing generation must fail closed");
  assert.strictEqual(backupV3VaultId({ vaultId: "1", vaultAddress: current.slice(3) }), null,
    "an explicit legacy generation must not be relabelled from a fallback address");

  const absent: StateLeavesResult = {
    available: true,
    data: { leaves: [1n, 2n], root: 9n, count: 2 },
  };
  const present: StateLeavesResult = {
    available: true,
    data: { leaves: [1n, 2n, 3n], root: 10n, count: 3 },
  };
  let calls = 0;
  await waitForStateLeaf(8453, 3n, {
    attempts: 3,
    delayMs: 0,
    fetchSnapshot: async () => (++calls < 2 ? absent : present),
  });
  assert.strictEqual(calls, 2, "the merge output should be retried until it reaches a fresh snapshot");

  await assert.rejects(
    waitForStateLeaf(8453, 4n, {
      attempts: 2,
      delayMs: 0,
      fetchSnapshot: async () => absent,
    }),
    /funds are safe; retry the withdrawal/i,
    "a bounded timeout must explain that the mined consolidation did not lose funds",
  );

  console.log("stateLeafFreshness.check: OK — stale merge outputs wait; retired backups stay retired");
}

main();
