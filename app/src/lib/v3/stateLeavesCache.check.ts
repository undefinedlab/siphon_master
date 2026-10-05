/**
 * Withdraw retries must not re-hit the indexer when the on-chain tip is unchanged, and concurrent
 * callers must share one in-flight fetch (the pattern that 429'd free-tier RPCs on double-click).
 *
 * Run: bunx tsx src/lib/v3/stateLeavesCache.check.ts
 */
process.env.NEXT_PUBLIC_V3_BASE_VAULT_KERNEL = "0x94242AE27e0E17000Fb9d28B43118B8A7904c51A";
process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB = "0x64E092415E9C017eb742EBaa31bCda94d9BF8078";
process.env.NEXT_PUBLIC_V3_BASE_INDEXER_URL = "https://indexer.test/idx";
process.env.NEXT_PUBLIC_V3_BASE_DEPLOY_BLOCK = "0";

import assert from "node:assert";

async function main() {
  const {
    fetchStateLeaves,
    invalidateStateLeavesCache,
    setStateLeavesTestHooks,
  } = await import("./stateLeavesClient");

  invalidateStateLeavesCache();

  const tipRoot = 12345n;
  const leaf = 99n;
  let indexerHits = 0;
  let rootReads = 0;

  setStateLeavesTestHooks({
    readOnChainStateRoot: async () => {
      rootReads += 1;
      return tipRoot;
    },
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/state/leaves")) {
      indexerHits += 1;
      // Slow first response so concurrent callers pile onto one in-flight promise.
      await new Promise((r) => setTimeout(r, 40));
      return new Response(
        JSON.stringify({
          leaves: [{ leafIndex: 0, commitment: leaf.toString() }],
          tipRoot: tipRoot.toString(),
          totalCount: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const first = await fetchStateLeaves(8453);
    assert.ok(first.available, `first fetch should succeed — ${first.reason}`);
    assert.strictEqual(indexerHits, 1, "first fetch hits indexer once");
    assert.ok(rootReads >= 1, "freshness check reads on-chain root");

    const rootsAfterFirst = rootReads;
    const second = await fetchStateLeaves(8453);
    assert.ok(second.available, "cached fetch should succeed");
    assert.strictEqual(indexerHits, 1, "second fetch must reuse cache (no second indexer hit)");
    assert.ok(rootReads > rootsAfterFirst, "cache hit still verifies against live stateRoot");

    invalidateStateLeavesCache(8453);
    indexerHits = 0;
    const [a, b, c] = await Promise.all([
      fetchStateLeaves(8453),
      fetchStateLeaves(8453),
      fetchStateLeaves(8453),
    ]);
    assert.ok(a.available && b.available && c.available);
    assert.strictEqual(indexerHits, 1, "concurrent callers must share one in-flight fetch");

    console.log(
      "stateLeavesCache.check: OK — unchanged tip reuses snapshot; concurrent callers share one fetch",
    );
  } finally {
    setStateLeavesTestHooks({ readOnChainStateRoot: null });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
