/**
 * Zcash exit E2E (read-only): catalog wiring + live LI.FI Base USDC → ZEC quote
 * + trade-executor /bridgeQuote.
 *
 * Full vault WITHDRAW → /bridgeWithdraw still needs MetaMask + a funded Base USDC note.
 *
 *   npx tsx src/lib/bridge/zcashExit.check.ts
 *   TRADE_EXECUTOR_URL=https://api.siphon.money npx tsx src/lib/bridge/zcashExit.check.ts
 */
import assert from "node:assert";
import {
  BASE_USDC,
  BRIDGE_DESTS,
  FUND_SOURCES,
  HUB_CHAIN_ID,
  ZCASH_LIFI_ID,
  bridgeDest,
  bridgeMinUnits,
  fundSourceForEdge,
  isValidDestAddress,
  minOutFrom,
  payoutDestFor,
  payoutToken,
} from "./hub";
import { listHomeChainOptions, resolveHomeChainOption } from "../chains/homeChains";

/** Well-known transparent P2PKH used in hub.check (valid base58check). */
const ZEC_T1 = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
const REFUND = "0x57fBC5C7e1A40134eC3cE2fe06EBD26d9C7267A2";
/** Zcash floor is 10 USDC (NEAR Intents often fails under ~8). */
const AMOUNT = 10_000_000n;
const LIFI = "https://li.quest/v1";
const EXECUTOR =
  process.env.TRADE_EXECUTOR_URL?.replace(/\/+$/, "") ||
  process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL?.replace(/\/+$/, "") ||
  "https://api.siphon.money";

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];

function ok(name: string, detail: string) {
  steps.push({ name, ok: true, detail });
  console.log(`  ✓ ${name} — ${detail}`);
}
function fail(name: string, detail: string) {
  steps.push({ name, ok: false, detail });
  console.log(`  ✗ ${name} — ${detail}`);
}

type LifiQuoteBody = {
  message?: string;
  tool?: string;
  toolDetails?: { name?: string };
  estimate?: {
    toAmount?: string;
    toAmountMin?: string;
    executionDuration?: number;
    feeCosts?: { amountUSD?: string }[];
  };
  action?: { toToken?: { symbol?: string; decimals?: number } };
};

/** LI.FI/NEAR occasionally returns "no route" then succeeds on retry within seconds. */
async function lifiQuote(params: Record<string, string | number>, attempts = 3): Promise<LifiQuoteBody> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  let last = "LI.FI quote failed";
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${LIFI}/quote?${qs}`, { signal: AbortSignal.timeout(45_000) });
    const body = (await res.json().catch(() => ({}))) as LifiQuoteBody;
    if (res.ok) return body;
    last = body.message || `LI.FI HTTP ${res.status}`;
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(last);
}

async function main() {
  console.log("\n══ Zcash exit E2E (catalog + live Base USDC → ZEC) ══\n");
  console.log(`Executor probe: ${EXECUTOR}`);
  console.log(`Dest: ${ZEC_T1} · amount ${Number(AMOUNT) / 1e6} USDC\n`);

  // ── 1. Catalog ──
  console.log("1. CATALOG");
  const dest = bridgeDest(ZCASH_LIFI_ID);
  assert.ok(dest, "Zcash missing from BRIDGE_DESTS");
  assert.equal(dest.label, "Zcash");
  assert.equal(dest.kind, "zcash");
  assert.equal(dest.toToken, "ZEC");
  assert.equal(dest.minUsdc, 10);
  assert.equal(bridgeMinUnits(dest), AMOUNT);
  ok("BRIDGE_DESTS", `${dest.label} → ${dest.toToken}, min ${dest.minUsdc} USDC, eta ${dest.eta}`);

  assert.ok(!FUND_SOURCES.some((s) => s.id === ZCASH_LIFI_ID), "Zcash must not fund");
  assert.equal(fundSourceForEdge(ZCASH_LIFI_ID), 42161);
  ok("no fund-from", "Zcash excluded from FUND_SOURCES; edge falls back to Arbitrum");

  assert.ok(!listHomeChainOptions().some((o) => /zcash/i.test(o.id) || /zcash/i.test(o.label)));
  assert.ok(!resolveHomeChainOption("zcash"));
  ok("not a home", "Zcash is receive-only, not in home picker");

  assert.equal(payoutDestFor(HUB_CHAIN_ID, "Zcash")?.id, ZCASH_LIFI_ID);
  assert.equal(payoutToken(dest, "USDC"), "ZEC");
  assert.equal(payoutToken(dest, "ETH"), "ZEC"); // dest forces ZEC regardless of assetOut
  ok("builder payout", `Withdraw to Zcash → chain ${ZCASH_LIFI_ID}, token ZEC`);

  assert.ok(isValidDestAddress("zcash", ZEC_T1));
  assert.ok(isValidDestAddress("zcash", "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd"));
  assert.ok(!isValidDestAddress("zcash", "zs1" + "q".repeat(75)));
  ok("address rules", "t1/t3 ok, sapling-only rejected");

  assert.ok(BRIDGE_DESTS.some((d) => d.id === ZCASH_LIFI_ID));
  ok("catalog consistency", "dest ↔ payout ↔ address validation aligned");

  // ── 2. Live LI.FI: Base USDC → ZEC (what the executor bridges) ──
  console.log("\n2. LI.FI WITHDRAW (Base USDC → Zcash ZEC)");
  let toAmountMin = "0";
  let decimals = 8;
  try {
    const q = await lifiQuote({
      fromChain: HUB_CHAIN_ID,
      toChain: ZCASH_LIFI_ID,
      fromToken: BASE_USDC,
      toToken: "ZEC",
      fromAmount: AMOUNT.toString(),
      fromAddress: REFUND,
      toAddress: ZEC_T1,
    });
    toAmountMin = q.estimate?.toAmountMin || q.estimate?.toAmount || "0";
    const out = BigInt(q.estimate?.toAmount || "0");
    assert.ok(out > 0n, "empty toAmount");
    decimals = q.action?.toToken?.decimals ?? 8;
    const tool = q.toolDetails?.name || q.tool || "?";
    const fees = (q.estimate?.feeCosts || []).reduce((s, f) => s + Number(f.amountUSD || 0), 0);
    ok(
      "withdraw quote",
      `${tool} · 10 USDC → ${(Number(out) / 10 ** decimals).toFixed(6)} ZEC` +
        ` · minOut client ${minOutFrom(toAmountMin)}` +
        (q.estimate?.executionDuration != null ? ` · ~${q.estimate.executionDuration}s` : "") +
        (fees ? ` · fees ~$${fees.toFixed(2)}` : ""),
    );
  } catch (e) {
    fail("withdraw quote", e instanceof Error ? e.message : String(e));
  }

  // ── 3. Sub-minimum should fail (documents the 10 USDC floor vs LI.FI liquidity) ──
  console.log("\n3. LI.FI SUB-MIN (5 USDC — expect no route / error)");
  try {
    await lifiQuote({
      fromChain: HUB_CHAIN_ID,
      toChain: ZCASH_LIFI_ID,
      fromToken: BASE_USDC,
      toToken: "ZEC",
      fromAmount: "5000000",
      fromAddress: REFUND,
      toAddress: ZEC_T1,
    });
    fail("sub-min quote", "unexpectedly got a route for 5 USDC (floor may have dropped)");
  } catch (e) {
    ok("sub-min quote", `no route as expected: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 4. Trade executor /bridgeQuote ──
  console.log("\n4. EXECUTOR /bridgeQuote");
  try {
    const res = await fetch(`${EXECUTOR}/bridgeQuote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        chain_id: HUB_CHAIN_ID,
        bridge: {
          to_chain_id: ZCASH_LIFI_ID,
          to_address: ZEC_T1,
          to_token: "ZEC",
          amount: AMOUNT.toString(),
          min_out: "1",
          refund_address: REFUND,
        },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      payee?: string;
      tool?: string;
      toAmount?: string;
      toAmountMin?: string;
      toToken?: { symbol?: string; decimals?: number };
      durationSec?: number;
    };
    if (!res.ok || !body.payee) {
      fail("bridgeQuote", body.error || `HTTP ${res.status}`);
    } else {
      const dec = body.toToken?.decimals ?? decimals;
      const out = body.toAmount ? Number(body.toAmount) / 10 ** dec : NaN;
      ok(
        "bridgeQuote",
        `payee ${body.payee.slice(0, 10)}… · ${body.tool}` +
          (Number.isFinite(out) ? ` · ~${out.toFixed(6)} ${body.toToken?.symbol || "ZEC"}` : "") +
          (body.durationSec != null ? ` · ~${body.durationSec}s` : ""),
      );
    }
  } catch (e) {
    fail("bridgeQuote", e instanceof Error ? e.message : String(e));
  }

  // ── Summary ──
  const passed = steps.filter((s) => s.ok).length;
  const failed = steps.filter((s) => !s.ok).length;
  console.log("\n════════════════════════════════════════");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log("Not covered: MetaMask WITHDRAW proof → POST /bridgeWithdraw → LI.FI settle.");
  console.log("════════════════════════════════════════\n");
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
