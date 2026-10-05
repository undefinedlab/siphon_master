// Runnable self-check: the indexer-free chain scan rebuilds the REAL state tree.
//   npx tsx src/lib/v3/stateLeavesFromChain.check.ts
//
// Hits live Sepolia. Skips (exit 0) when the RPC is unreachable — this must not fail CI on a
// network blip, only on a logic regression.
//
// The scan used to read VaultKernel.Deposited, which only covers leaves created by a deposit. A
// split inserts up to 8 and a swap inserts its output note, so the rebuilt tree diverged from the
// on-chain root the moment anything but a deposit ran — and the code failed closed, which is what
// made the indexer mandatory. At the time of writing the live pool held 21 leaves and the old scan
// found 5.
//
// NoteTree.CommitmentInserted is emitted for every leaf whatever created it, and carries the
// leafIndex the tree used. This asserts the end state that matters: leaves are contiguous from 0,
// and Poseidon-rebuilding them reproduces VaultKernel.stateRoot() exactly. If that holds, paths
// derived from this scan are the same paths the circuit will accept, and the indexer is a cache
// rather than a dependency.
import assert from "node:assert";

import { ethers } from "ethers";

import { computeStateRoot } from "./stateTreeV3";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const KERNEL = "0x50Db1b65fe56de4015912FD3E1AdC1bccFB08151";
const DEPLOY_BLOCK = 11579907;
const SPAN = 9_000;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);

  let latest: number;
  try {
    latest = await provider.getBlockNumber();
  } catch {
    console.log("stateLeavesFromChain.check: SKIPPED — Sepolia RPC unreachable");
    return;
  }

  const kernel = new ethers.Contract(
    KERNEL,
    ["function notes() view returns (address)", "function stateRoot() view returns (uint256)"],
    provider,
  );
  const noteTree = new ethers.Contract(
    await kernel.notes(),
    ["event CommitmentInserted(uint256 indexed leafIndex, uint256 commitment, uint256 newRoot)"],
    provider,
  );

  const events: ethers.Log[] = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += SPAN) {
    const to = Math.min(from + SPAN - 1, latest);
    events.push(...(await noteTree.queryFilter(noteTree.filters.CommitmentInserted(), from, to)));
  }

  const ordered = events
    .map((e) => {
      const a = (e as ethers.EventLog).args;
      return { index: Number(a.leafIndex), leaf: BigInt(a.commitment) };
    })
    .sort((a, b) => a.index - b.index);

  assert.ok(ordered.length > 0, "no CommitmentInserted events — wrong NoteTree or deploy block");

  // A gap means a missed log. A tree built over a gap yields sibling paths that prove nothing, so
  // the scan must detect it rather than hand back a plausible-looking wrong tree.
  ordered.forEach((x, i) =>
    assert.strictEqual(x.index, i, `leaf index gap at ${i} (saw ${x.index})`),
  );

  const rebuilt = await computeStateRoot(ordered.map((x) => x.leaf));
  const onChain = BigInt((await kernel.stateRoot()).toString());
  assert.strictEqual(
    rebuilt.toString(),
    onChain.toString(),
    "rebuilt root != on-chain stateRoot — the scan is incomplete",
  );

  console.log(
    `stateLeavesFromChain.check: OK — ${ordered.length} leaves rebuild the on-chain root ` +
      `(no indexer)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
