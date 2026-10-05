// Runnable self-check: the builder's arm gate reads the v5 indexer when the v1 /vault-index is gone.
//   npx tsx src/lib/graphArmV5.check.ts
//
// /vault-index (v1 Ponder) has 503'd on every chain since the 2026-10 move, so with
// GRAPH_ARM_FAIL_CLOSED the builder refused to build any strategy ("BLOCK: no anonymity-set
// data"). The v2 indexer at NEXT_PUBLIC_V3_*_INDEXER_URL serves the kernel's leaf set.
import assert from "node:assert";

process.env.GRAPH_ARM_FAIL_CLOSED = "1";
process.env.TRADE_EXECUTOR_URL = "https://executor.test";
process.env.NEXT_PUBLIC_V3_BASE_INDEXER_URL = "https://idx.test/idx";

async function main() {
  const { assessStrategyArming } = await import("@siphon/sdk-ts/graph");
  let v5Up = true;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.startsWith("https://executor.test/vault-index")) return new Response("{}", { status: 503 });
    if (u.startsWith("https://idx.test/idx/state/leaves") && v5Up) {
      return new Response(JSON.stringify({ available: true, totalCount: 62 }), { status: 200 });
    }
    return new Response("{}", { status: 503 });
  }) as typeof fetch;

  const ok = await assessStrategyArming({ chainId: 8453, fromAsset: "ETH", toAsset: "USDC" });
  assert.strictEqual(ok.shouldBlock, false, `v5 indexer up must not block: ${ok.reasons.join(" | ")}`);
  assert.strictEqual(ok.anonymity?.source, "v5_indexer");
  assert.strictEqual(ok.anonymity?.leafCount, 62);

  v5Up = false;
  const down = await assessStrategyArming({ chainId: 8453, fromAsset: "ETH", toAsset: "USDC" });
  assert.strictEqual(down.shouldBlock, true, "with no data at all the gate still fails closed");
  console.log("graphArmV5.check: OK — v5 indexer feeds the arm gate; no data still fails closed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
