// Runnable self-check: the Sepolia toggle is admin-only, and hiding it cannot strand anyone.
//   npx tsx src/lib/adminChainGate.check.ts
//
// This is UI visibility, NOT authorization — the allowlist is compiled into the client bundle by
// design (see adminWalletCore.ts). Real enforcement is the executor's ADMIN_GATED_CHAIN_IDS, which
// already defaults to {11155111}. The point of this gate is that the two AGREE: before it, a
// stranger could select Sepolia, deposit and withdraw, and only hit a wall when arming an order —
// where the refusal reads as a broken strategy rather than "not for you".
//
// The stranding case is what makes this more than a one-line list. Chain choice persists in
// localStorage, so a wallet that was admin (or a different wallet on a shared browser) can load
// straight onto a now-hidden chain with no toggle to leave by. UserDash forces DEFAULT_CHAIN_ID
// when that happens; this pins the invariant that makes that recovery possible.
import assert from "node:assert";

process.env.NEXT_PUBLIC_ADMIN_WALLETS =
  "0xd5720Ed6e70a128C025D0C284874cd1e33B39688,0x57fBC5C7e1A40134eC3cE2fe06EBD26d9C7267A2";

async function main() {
  const n = await import("./networks");
  const core = await import("./adminWalletCore");

  const ADMIN = "0x57fBC5C7e1A40134eC3cE2fe06EBD26d9C7267A2";
  const STRANGER = "0x000000000000000000000000000000000000dEaD";
  const SEPOLIA = 11155111;
  const BASE = 8453;
  const ARBITRUM = 42161;

  assert.ok(n.ADMIN_ONLY_CHAIN_IDS.includes(SEPOLIA), "Sepolia must be admin-only");
  assert.ok(!n.ADMIN_ONLY_CHAIN_IDS.includes(BASE), "Base must never be gated — it is the product");

  // --- who sees what -------------------------------------------------------------------------
  assert.ok(!n.ADMIN_ONLY_CHAIN_IDS.includes(ARBITRUM), "Arbitrum is public, like Base");
  assert.deepStrictEqual(n.visibleChainIds(ADMIN), [BASE, ARBITRUM, SEPOLIA], "an admin sees all three");
  assert.deepStrictEqual(n.visibleChainIds(STRANGER), [BASE, ARBITRUM], "a stranger sees the mainnets");
  assert.deepStrictEqual(n.visibleChainIds(null), [BASE, ARBITRUM], "a disconnected visitor sees the mainnets");
  assert.deepStrictEqual(n.visibleChainIds(undefined), [BASE, ARBITRUM], "no wallet -> the mainnets");

  // Address casing must not decide access: the connected address is not always checksummed the
  // same way as the env list, and a miss here silently demotes a real admin.
  assert.deepStrictEqual(n.visibleChainIds(ADMIN.toLowerCase()), [BASE, ARBITRUM, SEPOLIA], "lowercase admin");
  assert.deepStrictEqual(n.visibleChainIds(ADMIN.toUpperCase().replace("0X", "0x")), [BASE, ARBITRUM, SEPOLIA]);

  assert.strictEqual(n.isChainVisible(SEPOLIA, ADMIN), true);
  assert.strictEqual(n.isChainVisible(SEPOLIA, STRANGER), false);
  assert.strictEqual(n.isChainVisible(BASE, STRANGER), true);

  // --- nobody can be stranded ------------------------------------------------------------------
  // The escape hatch UserDash uses must itself always be visible, to every wallet. If DEFAULT were
  // ever gated, the anti-stranding effect would bounce a non-admin between two hidden chains.
  assert.ok(
    n.visibleChainIds(STRANGER).includes(n.DEFAULT_CHAIN_ID),
    "DEFAULT_CHAIN_ID must be visible to a non-admin, or the stranding recovery has nowhere to go",
  );
  assert.ok(
    n.SUPPORTED_CHAIN_IDS.every((c) => n.visibleChainIds(ADMIN).includes(c)),
    "an admin must see every supported chain",
  );
  // A gated chain that is not supported at all would be dead config.
  assert.ok(
    n.ADMIN_ONLY_CHAIN_IDS.every((c) => n.SUPPORTED_CHAIN_IDS.includes(c)),
    "every gated chain must be a supported chain",
  );

  // --- with no allowlist configured, the gate must not lock EVERYONE out silently --------------
  // A deploy that forgets NEXT_PUBLIC_ADMIN_WALLETS hides Sepolia from admins too. That is the
  // safe direction, but it is worth stating so the failure is recognised rather than debugged.
  assert.strictEqual(core.adminWalletAllowlistSize() > 0, true, "allowlist is configured in this run");

  console.log(
    "adminChainGate.check: OK — Sepolia hidden from non-admins and visible to admins " +
      "(case-insensitively), Base always visible, and DEFAULT_CHAIN_ID is never gated",
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
