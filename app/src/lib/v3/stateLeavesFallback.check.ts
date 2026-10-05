/**
 * A configured-but-empty indexer must not be worse than no indexer.
 *
 * fetchStateLeaves fell back to the verified chain scan ONLY when indexerUrl was unset. Base's
 * indexer answers but indexes Sepolia only, so /state/leaves returns 503 with totalCount 0 — and
 * setting NEXT_PUBLIC_V3_BASE_INDEXER_URL therefore took every v3 path on Base (arming, withdraw,
 * output-note resolution) from working to "state leaves unavailable". Adding configuration must
 * never be able to do that.
 *
 * Run: bunx tsx src/lib/v3/stateLeavesFallback.check.ts
 */
process.env.NEXT_PUBLIC_V3_BASE_VAULT_KERNEL = "0x94242AE27e0E17000Fb9d28B43118B8A7904c51A";
process.env.NEXT_PUBLIC_V3_BASE_COMPLIANCE_HUB = "0x64E092415E9C017eb742EBaa31bCda94d9BF8078";
process.env.NEXT_PUBLIC_V3_BASE_INDEXER_URL = "https://indexer.invalid/idx";
// deployBlock 0 → leavesFromChain fails closed immediately (no live getLogs walk in this check).
process.env.NEXT_PUBLIC_V3_BASE_DEPLOY_BLOCK = "0";

import assert from "node:assert";

/** BigInt-safe, because a SUCCESSFUL fallback returns leaves as bigints. */
function show(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
}

/** The fallback ran if the scan succeeded, or if its reason was appended to the indexer's. */
function attemptedFallback(res: { available: boolean; reason?: string }): boolean {
  return res.available || /chain-scan fallback:/.test(res.reason ?? "");
}

async function main() {
  const { fetchStateLeaves, invalidateStateLeavesCache } = await import("./stateLeavesClient");

  /** Every way the indexer can let us down. Each must reach the chain scan, not stop at the indexer. */
  const INDEXER_FAILURES: Array<[string, Response]> = [
    ["503 not indexed", new Response(JSON.stringify({ available: false, totalCount: 0 }), { status: 503 })],
    ["500 server error", new Response("boom", { status: 500 })],
    ["200 malformed json", new Response("not json", { status: 200 })],
    ["200 missing leaves[]", new Response(JSON.stringify({ ok: true }), { status: 200 })],
  ];

  for (const [label, response] of INDEXER_FAILURES) {
    invalidateStateLeavesCache(8453);
    globalThis.fetch = (async () => response.clone()) as typeof fetch;
    const res = await fetchStateLeaves(8453);
    // Either outcome proves the fallback ran: with RPC reachable the scan SUCCEEDS, and without it
    // the reason carries the "chain-scan fallback:" prefix. What must never happen is returning the
    // bare indexer reason, which is the pre-fix behaviour this check exists to prevent — so the
    // check states the requirement without depending on whether CI has network.
    assert.ok(attemptedFallback(res), `${label}: fallback not attempted — got ${show(res)}`);
  }

  // A network-level failure (not an HTTP status) must fall back too.
  invalidateStateLeavesCache(8453);
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const unreachable = await fetchStateLeaves(8453);
  assert.ok(attemptedFallback(unreachable), `unreachable indexer should fall back — got ${show(unreachable)}`);

  // An unsupported chain must still fail fast rather than scan nothing forever.
  const bogus = await fetchStateLeaves(999999);
  assert.ok(!bogus.available, "unsupported chain must not report available");
  assert.ok(!/chain-scan fallback:/.test(bogus.reason ?? ""), "unsupported chain should not attempt a scan");

  console.log(
    `stateLeavesFallback.check: OK — ${INDEXER_FAILURES.length} indexer failure modes plus an ` +
      `unreachable indexer all reach the verified chain scan, and an unsupported chain still fails fast`,
  );
}

main();
