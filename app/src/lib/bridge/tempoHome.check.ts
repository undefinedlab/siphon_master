/**
 * Tempo bridged-home E2E (read-only): catalog wiring + live LI.FI fund/withdraw quotes
 * + optional trade-executor /bridgeQuote.
 *
 *   npx tsx src/lib/bridge/tempoHome.check.ts
 *   TRADE_EXECUTOR_URL=https://api.siphon.money npx tsx src/lib/bridge/tempoHome.check.ts
 */
import assert from "node:assert";
import {
  BASE_USDC,
  BRIDGE_DESTS,
  FUND_SOURCES,
  HUB_CHAIN_ID,
  bridgeDest,
  fundSourceForEdge,
  minOutFrom,
  payoutDestFor,
  payoutToken,
} from "./hub";
import { listHomeChainOptions, resolveHomeChainOption } from "../chains/homeChains";
import { chainLogoIdForHomeChainId } from "../chains/chainLogos";

const TEMPO = 4217;
const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";
const USER = "0x57fBC5C7e1A40134eC3cE2fe06EBD26d9C7267A2";
const AMOUNT = 5_000_000n; // 5 USDC
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

async function lifiQuote(params: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${LIFI}/quote?${qs}`, { signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    tool?: string;
    estimate?: { toAmount?: string; toAmountMin?: string; executionDuration?: number };
  };
  if (!res.ok) throw new Error(body.message || `LI.FI HTTP ${res.status}`);
  return body;
}

async function main() {
  console.log("\n══ Tempo bridged-home E2E (catalog + live quotes) ══\n");
  console.log(`Executor probe: ${EXECUTOR}\n`);

  // ── 1. Catalog / edge wiring (mainnet Tempo is LI.FI-only; connect home is Moderato testnet) ──
  console.log("1. CATALOG");
  assert.ok(!listHomeChainOptions().some((o) => o.id === "tempo"), "no mainnet Tempo connect card");
  const home = resolveHomeChainOption("tempo-moderato");
  assert.ok(home, "tempo-moderato home missing");
  assert.equal(home.tag, "Testnet");
  assert.equal(home.numericId, 42431);
  assert.equal(chainLogoIdForHomeChainId("tempo-moderato"), "tempo");
  ok("testnet home", `Tempo Moderato ${home.numericId}`);
  assert.equal(fundSourceForEdge(TEMPO), TEMPO);
  ok("mainnet edge", `LI.FI fund/receive still on ${TEMPO}`);

  const dest = bridgeDest(TEMPO);
  assert.ok(dest);
  assert.equal(dest.label, "Tempo");
  assert.equal(dest.kind, "evm");
  assert.equal(dest.toToken.toLowerCase(), TEMPO_USDC.toLowerCase());
  ok("BRIDGE_DESTS", `${dest.label} → ${dest.toToken}`);

  const src = FUND_SOURCES.find((s) => s.id === TEMPO);
  assert.ok(src);
  assert.equal(src.usdc.toLowerCase(), TEMPO_USDC.toLowerCase());
  assert.equal(src.gasToken.toLowerCase(), TEMPO_USDC.toLowerCase()); // no native coin
  assert.equal(fundSourceForEdge(TEMPO), TEMPO);
  ok("FUND_SOURCES", `fund from Tempo USDC.e, gasToken=USDC.e`);

  assert.equal(payoutDestFor(HUB_CHAIN_ID, "Tempo")?.id, TEMPO);
  assert.equal(payoutToken(dest, "USDC"), dest.toToken);
  assert.equal(payoutToken(dest, "ETH"), null); // Tempo has no native ETH delivery
  ok("payoutDestFor", `Withdraw to Tempo → chain ${TEMPO}`);

  assert.ok(BRIDGE_DESTS.some((d) => d.id === TEMPO));
  ok("catalog consistency", "home ↔ fund ↔ dest ↔ builder payout aligned");

  // ── 2. Live LI.FI: fund Tempo → Base ──
  console.log("\n2. LI.FI FUND (Tempo → Base USDC)");
  try {
    const q = await lifiQuote({
      fromChain: TEMPO,
      toChain: HUB_CHAIN_ID,
      fromToken: TEMPO_USDC,
      toToken: BASE_USDC,
      fromAmount: AMOUNT.toString(),
      fromAddress: USER,
      toAddress: USER,
    });
    const out = BigInt(q.estimate?.toAmount || "0");
    assert.ok(out > 0n, "empty toAmount");
    ok(
      "fund quote",
      `${q.tool} · 5 USDC → ${(Number(out) / 1e6).toFixed(4)} Base USDC` +
        (q.estimate?.executionDuration != null ? ` · ~${q.estimate.executionDuration}s` : ""),
    );
  } catch (e) {
    fail("fund quote", e instanceof Error ? e.message : String(e));
  }

  // ── 3. Live LI.FI: withdraw Base → Tempo (what the executor bridges) ──
  console.log("\n3. LI.FI WITHDRAW (Base USDC → Tempo)");
  let toAmountMin = "0";
  try {
    const q = await lifiQuote({
      fromChain: HUB_CHAIN_ID,
      toChain: TEMPO,
      fromToken: BASE_USDC,
      toToken: TEMPO_USDC,
      fromAmount: AMOUNT.toString(),
      fromAddress: USER,
      toAddress: USER,
    });
    toAmountMin = q.estimate?.toAmountMin || q.estimate?.toAmount || "0";
    const out = BigInt(q.estimate?.toAmount || "0");
    assert.ok(out > 0n, "empty toAmount");
    ok(
      "withdraw quote",
      `${q.tool} · 5 USDC → ${(Number(out) / 1e6).toFixed(4)} Tempo` +
        ` · minOut client bound ${minOutFrom(toAmountMin)}`,
    );
  } catch (e) {
    fail("withdraw quote", e instanceof Error ? e.message : String(e));
  }

  // ── 4. Trade executor /bridgeQuote (payee for vault withdraw proof) ──
  console.log("\n4. EXECUTOR /bridgeQuote");
  try {
    const res = await fetch(`${EXECUTOR}/bridgeQuote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        chain_id: HUB_CHAIN_ID,
        bridge: {
          to_chain_id: TEMPO,
          to_address: USER,
          to_token: TEMPO_USDC,
          amount: AMOUNT.toString(),
          min_out: "1",
          refund_address: USER,
        },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      payee?: string;
      tool?: string;
      toAmount?: string;
      toAmountMin?: string;
    };
    if (!res.ok || !body.payee) {
      fail("bridgeQuote", body.error || `HTTP ${res.status}`);
    } else {
      ok(
        "bridgeQuote",
        `payee ${body.payee.slice(0, 10)}… · ${body.tool}` +
          (body.toAmount ? ` · out ${(Number(body.toAmount) / 1e6).toFixed(4)}` : ""),
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
  console.log("Wallet-signed fund / vault deposit / bridgeWithdraw still need MetaMask.");
  console.log("════════════════════════════════════════\n");
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
