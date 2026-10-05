// Runnable self-check for the Limit Order condition_tree fix (no test framework in this repo).
//   npx tsx src/lib/graphRunPlan.check.ts
// Regression guard for the "≥3000 fired at ~1800" bug: a Limit Order's user target lives in the
// node's condition_tree, not priceGoal. buildGraphRunPlan must send the tree (with the real bound)
// and zero the flat bounds — NOT flatten to a stale priceGoal default.
import assert from "node:assert";
import type { Node, Edge } from "@xyflow/react";
import { buildGraphRunPlan } from "./graphRunPlan";
import { buildLimitOrderConditionTreeJson } from "./limitOrderTree";

const nodes = [
  { id: "d", position: { x: 0, y: 0 }, data: { type: "deposit", coin: "ETH", amount: "0.001" } },
  {
    id: "s", position: { x: 0, y: 0 },
    data: {
      type: "strategy", strategy: "Limit Order", side: "sell",
      // User typed 3000 into the AND/OR tree; priceGoal is the STALE default that caused the bug.
      priceGoal: "1500",
      conditionTree: buildLimitOrderConditionTreeJson({ priceGoal: 3000, side: "sell", asset: "ETH" }),
    },
  },
  { id: "w", position: { x: 0, y: 0 }, data: { type: "swap", coin: "ETH", toCoin: "USDC" } },
] as unknown as Node[];

const res = buildGraphRunPlan(nodes, [] as Edge[], {});
assert(res.ok, `plan failed: ${res.ok ? "" : res.error}`);
const p = res.plan.payload;

// The tree — carrying the real 3000 — must be sent, and the flat bounds zeroed.
assert(p.condition_tree != null, "condition_tree missing — the tree (user's 3000) was dropped");
assert.strictEqual(p.upper_bound, 0, "upper_bound must be 0 when a condition_tree is present");
assert.strictEqual(p.lower_bound, 0, "lower_bound must be 0 when a condition_tree is present");
const leaf = (p.condition_tree as { conditions: { bound: number; condition: string }[] }).conditions[0];
assert.strictEqual(leaf.bound, 3000, `expected bound 3000, got ${leaf.bound} (stale priceGoal leaked)`);
assert.strictEqual(leaf.condition, "GTE", `sell must be GTE, got ${leaf.condition}`);

console.log("OK — Limit Order sends condition_tree with the real target (bound=3000, GTE), bounds zeroed");

// ── DCA / TWAP loop → finite N legs (the pre-split model has no open-ended path). ──
const loopNodes = (perBuy: string, mode: "until_funds" | "count", count?: string) => [
  { id: "d", position: { x: 0, y: 0 }, data: { type: "deposit", coin: "ETH", amount: "0.01" } },
  { id: "loop", type: "repeatGroup", position: { x: 0, y: 0 },
    data: { type: "repeatGroup", repeatMode: mode, repeatCount: count ?? "", intervalSeconds: "86400" } },
  { id: "s", parentId: "loop", position: { x: 0, y: 0 },
    data: { type: "swap", coin: "ETH", toCoin: "USDC", amount: perBuy } },
] as unknown as Node[];

// until_funds: N = floor(deposit / per-buy) = floor(0.01 / 0.004) = 2, strategy_type DCA.
const dca = buildGraphRunPlan(loopNodes("0.004", "until_funds"), [] as Edge[], {});
assert(dca.ok, `until_funds plan failed: ${dca.ok ? "" : dca.error}`);
assert.strictEqual(dca.plan.payload.strategy_type, "DCA", "until_funds loop must be DCA");
assert.strictEqual(dca.plan.payload.slices, 2, `expected 2 derived buys, got ${dca.plan.payload.slices}`);

// per-buy ≥ deposit → cannot make ≥2 buys → clear error (not a silent single-strategy 400).
const tooBig = buildGraphRunPlan(loopNodes("0.01", "until_funds"), [] as Edge[], {});
assert(!tooBig.ok, "per-buy == deposit must be rejected (only 1 buy)");

// count mode → finite TWAP with the explicit count.
const twap = buildGraphRunPlan(loopNodes("0.004", "count", "5"), [] as Edge[], {});
assert(twap.ok, `count plan failed: ${twap.ok ? "" : twap.error}`);
assert.strictEqual(twap.plan.payload.strategy_type, "TWAP", "count loop must be TWAP");
assert.strictEqual(twap.plan.payload.slices, 5, `expected 5 buys, got ${twap.plan.payload.slices}`);

console.log("OK — DCA until_funds derives N=2 from per-buy, rejects per-buy≥deposit, count→TWAP(5)");
