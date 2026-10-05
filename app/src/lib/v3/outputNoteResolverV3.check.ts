// Runnable self-check for the v3 strategy output-note commitment — no test framework in this repo.
//   npx tsx src/lib/v3/outputNoteResolverV3.check.ts
//
// Worth pinning because both failure directions lose money silently:
//   - a WRONG commitment never matches a leaf, so the stash is never promoted and the proceeds
//     stay on-chain and invisible forever — the exact bug this resolver was written to fix;
//   - a commitment that matches but whose (value, label, assetId) disagree with the leaf produces
//     a note that shows a balance and then fails every spend at the circuit's Merkle assert.
//
// The rule under test is `deriveSwapPublics`: the leg's dest note is
//     commitment = commitment_with_pre(minAmountOut, inLabel, dstToken, outputPrecommitment)
// with destLabel == inLabel (association inheritance) and the amount pinned to minAmountOut,
// because VaultKernel mints the user note at exactly minOut and accrues any surplus to the
// protocol. Anything that reads amount off the fill instead of off minOut is wrong.
import assert from "node:assert";

import { deriveSwapPublics } from "./actionPublicsV3";
import { hashCommitmentWithPre, hashPrecommitment } from "./noteCryptoV3";

async function main() {
  const inLabel = 7788990011223344556677n;
  const dstToken = 0x1c7d4b196cb0c7b01d743fbc6116a902379c7238n; // Sepolia USDC as a uint160 assetId
  const minAmountOut = 2486642n; // 2.486642 USDC — the amount the live Sepolia fill actually minted
  const destNullifier = 111222333444555n;
  const destSecret = 666777888999000n;
  const outputPrecommitment = await hashPrecommitment(destNullifier, destSecret);

  const publics = await deriveSwapPublics({
    // Fixed, non-zero: this check reproduces a specific historical fill, so nothing may vary run
    // to run. Production samples a fresh salt per spend (randomLabelSalt).
    labelCommitSalt: 1n,
    input: {
      inValue: 1_000_000_000_000_000n,
      inNullifier: 424242n,
      inSecret: 434343n,
      inLabel,
      inAssetId: 0xfff9976782d46cc05630d1f6ebab18b2324d6b14n, // WETH
    },
    primaryValue: 1_000_000_000_000_000n,
    secondaryValue: 0n, // exact slice spend: no change note
    pool: 0x6ce0896eae6d4bd668fde41bb784548fb8f59b50n,
    dstToken,
    fee: 3000n,
    minAmountOut,
    outputPrecommitment,
    outNullifier: 0n,
    outSecret: 0n,
    roots: { stateRoot: 1n, admittedRoot: 2n, revokedRoot: 3n },
  });

  assert.strictEqual(publics.length, 25, "a spend has 25 public limbs");

  // Limb 22 is the dest commitment. armLegV3 reads it from exactly here rather than re-hashing,
  // so that the stashed note can never drift from what the circuit constrains.
  const fromLimb = BigInt(publics[22]);
  const expected = await hashCommitmentWithPre(minAmountOut, inLabel, dstToken, outputPrecommitment);
  assert.strictEqual(fromLimb, expected, "limb 22 must be commitment_with_pre(minOut, inLabel, dstToken, pre)");

  // The label is INHERITED, not fresh. A fresh label would still produce a valid-looking
  // commitment and would simply never appear in the tree.
  const wrongLabel = await hashCommitmentWithPre(minAmountOut, inLabel + 1n, dstToken, outputPrecommitment);
  assert.notStrictEqual(wrongLabel, expected, "a different label must not collide");

  // The amount is minOut, NOT what the pool returned. On the live Sepolia fill the pool paid
  // 17.551446 USDC and the user note was minted at 2.486642; hashing the fill amount would build a
  // commitment that is not in the tree.
  const measuredByPool = 17_551_446n;
  const wrongAmount = await hashCommitmentWithPre(measuredByPool, inLabel, dstToken, outputPrecommitment);
  assert.notStrictEqual(wrongAmount, expected, "the fill amount must not be mistaken for minOut");

  // assetId is the OUTPUT token; using the input's is the classic copy-paste slip.
  const wrongAsset = await hashCommitmentWithPre(
    minAmountOut,
    inLabel,
    0xfff9976782d46cc05630d1f6ebab18b2324d6b14n,
    outputPrecommitment,
  );
  assert.notStrictEqual(wrongAsset, expected, "the output note binds the OUTPUT asset");

  console.log("outputNoteResolverV3.check: OK — limb 22 is the leaf the kernel will insert");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
