// Runnable self-check: solving a gross from an exact-receive target must not overshoot.
//   npx tsx src/lib/withdrawFee.check.ts
//
// The overshoot this pins was one minor unit — 0.000001 USDC — and it hid for as long as nobody
// tried to withdraw their whole balance. Max fills balance-minus-fee, the solver turned that back
// into balance+1, and the withdrawal was refused for a unit that cannot exist. Small, invisible,
// and it makes "withdraw everything" impossible on every vault, since feeBps=0 is the live config.
import assert from "node:assert";
// v3 chains must resolve as deployed BEFORE withdrawFee/configV3 is imported — configV3 snapshots
// process.env at module load. These are the real Base addresses; only their non-zero-ness matters.
process.env.NEXT_PUBLIC_V3_BASE_VAULT_KERNEL ||= "0x94242AE27e0E17000Fb9d28B43118B8A7904c51A";
process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB ||= "0x3a9Bc8000000000000000000000000000000dEaD";

/** What the contract charges for a gross of w: floor(w*feeBps/10000) + g. */
const feeFor = (w: bigint, g: bigint, feeBps: bigint) => (w * feeBps) / 10000n + g;

async function main() {
  // Imported here, not at top level: tsx emits CJS, and the env above must be set first anyway.
  const { grossForExactReceive, getFeeInfo, solveWithdrawForExactReceive } = await import("./withdrawFee");

  // --- the live Base config: feeBps=0, flat 0.03 USDC gas ------------------------------------
  const G = 30_000n; // 0.03 USDC in 6dp
  const BALANCE = 524_238n; // 0.524238 USDC

  // Max fills balance - fee; solving that back MUST land exactly on the balance, not past it.
  const maxReceive = BALANCE - G;
  const gross = grossForExactReceive(maxReceive, G, 0n);
  assert.strictEqual(gross, BALANCE, `whole-balance withdraw must solve to the balance, got ${gross}`);
  assert.ok(gross <= BALANCE, "solving the max must never exceed the balance");
  assert.strictEqual(gross - feeFor(gross, G, 0n), maxReceive, "recipient must get exactly the target");

  // --- the recipient is never short, across a sweep of targets and fee configs ----------------
  // Rounding up is the safe direction; the bug was rounding up when it was already exact.
  //
  // Only feeBps=0 is solved EXACTLY, and that is not a weaker claim than it sounds: the contract
  // FLOORS the margin, so with feeBps>0 the true minimal gross can sit a unit below what the
  // real-valued inverse ceils to. That slack is harmless (it lands in the change note) and costs a
  // unit of precision, not a unit of the user's money. The whole-balance case — the one that made
  // withdrawing everything impossible — only exists at feeBps=0, which is the live config, and
  // that case must be exact.
  for (const feeBps of [0n, 1n, 20n, 100n, 500n]) {
    for (const target of [1n, 7n, 999n, 24_238n, 494_238n, 1_000_000n, 123_456_789n]) {
      const w = grossForExactReceive(target, G, feeBps);
      const overpay = w - feeFor(w, G, feeBps) - target;
      assert.ok(overpay >= 0n, `feeBps=${feeBps} target=${target}: recipient short by ${-overpay}`);
      if (feeBps === 0n) {
        assert.strictEqual(overpay, 0n, `feeBps=0 target=${target}: must be exact, over by ${overpay}`);
      } else {
        assert.ok(overpay <= 2n, `feeBps=${feeBps} target=${target}: over by ${overpay}, expected <= 2`);
      }
    }
  }

  // --- a v3 chain has no fee module, and must not be quoted the v2 vault's ---------------------
  // VaultKernel._payout sends primaryValue in full. Reading the retired v2 vault still ANSWERS
  // (it is deployed and does have a fee config), which is what made this so quiet: a real number,
  // from the wrong protocol. The first Base withdrawal quoted 0.494238 and paid 0.524238.
  const v3Fee = await getFeeInfo("USDC", 8453);
  assert.strictEqual(v3Fee.enabled, false, "a v3 chain must report no fee module");
  assert.strictEqual(v3Fee.feeBps, 0);
  assert.strictEqual(v3Fee.gasMode, 0);
  assert.strictEqual(v3Fee.minWithdrawWei, 0n);

  // ...so exact-receive on v3 is the identity: no fee reserved, and Max can spend the whole balance.
  const v3Quote = await solveWithdrawForExactReceive("USDC", BALANCE, 1, 8453);
  assert.strictEqual(v3Quote.withdrawnValueWei, BALANCE, "v3 must not gross up the amount");
  assert.strictEqual(v3Quote.recipientReceivesWei, BALANCE, "v3 recipient gets the full amount");
  assert.strictEqual(v3Quote.feeWei, 0n, "v3 must quote a zero fee");

  // --- the specific regression, stated plainly ------------------------------------------------
  // The old formula was `num / den + 1n`. With an exact division that is always one too many.
  const oldWay = ((maxReceive + G) * 10000n) / 10000n + 1n;
  assert.strictEqual(oldWay, BALANCE + 1n, "the old formula overshot by exactly one unit");
  assert.notStrictEqual(gross, oldWay, "the fix must differ from the old formula here");

  console.log(
    `withdrawFee.check: OK — 0.494238 solves to 0.524238 (not 0.524239), exact at feeBps=0, ` +
      `across 5 fee configs x 7 targets the recipient is never short, ` +
      `and a v3 chain quotes no fee at all`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
