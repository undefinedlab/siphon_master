/**
 * E2E (logic) — prompt → canvas Bridge flow → cursor deposit → prepare → finalize.
 *
 * Does NOT call live Li.Fi / on-chain vault spend (execute path not wired yet).
 *
 * Run: bunx tsx src/lib/v3/vaultBridgeE2E.check.ts
 */
import assert from "node:assert/strict";
import { parsePrompt } from "@/builder_agent/parsePrompt";
import { createFlowFromParsed, getDesiredFlowSegments } from "@/builder_agent/createNodes";
import {
  clearNoteCursor,
  loadNoteCursor,
  peekActiveNoteCursor,
  recordDepositOnCursor,
} from "./noteCursorSession";
import { lineageSummary } from "./noteCursor";
import {
  finalizeVaultBridgeOnCursor,
  prepareVaultBridgeLeg,
  validateVaultBridgeBlock,
} from "./vaultBridgeLeg";

const mem = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => {
    mem.set(k, String(v));
  },
  removeItem: (k) => {
    mem.delete(k);
  },
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

const PROMPT = "Deposit 100 USDC on Arbitrum, bridge to Base, then limit buy ETH";

// ── 1) Prompt parse ──────────────────────────────────────────────────────────
const parsed = parsePrompt(PROMPT);
assert.equal(parsed.includeBridge, true, "prompt must set includeBridge");
assert.equal(parsed.depositChain, "Arbitrum");
assert.equal(parsed.bridgeToChain, "Base");
assert.equal(parsed.coin, "USDC");
assert.equal(parsed.amount, "100");

const segments = getDesiredFlowSegments(parsed);
assert.deepEqual(
  segments,
  ["deposit", "bridge", "strategy", "swap"],
  `unexpected segments: ${JSON.stringify(segments)}`,
);

// ── 2) Canvas materialization ────────────────────────────────────────────────
const { nodes, edges } = createFlowFromParsed(parsed);
assert.ok(nodes.length >= 4, `expected ≥4 nodes, got ${nodes.length}`);
assert.equal(edges.length, nodes.length - 1);

const deposit = nodes.find((n) => n.data.type === "deposit");
const bridge = nodes.find((n) => n.data.type === "bridge");
const strategy = nodes.find((n) => n.data.type === "strategy");
const swap = nodes.find((n) => n.data.type === "swap");

assert.ok(deposit, "missing deposit node");
assert.ok(bridge, "missing bridge node");
assert.ok(strategy, "missing strategy node");
assert.ok(swap, "missing swap node");

assert.equal(deposit!.data.chain, "Arbitrum");
assert.equal(deposit!.data.coin, "USDC");
assert.equal(deposit!.data.amount, "100");
assert.equal(bridge!.data.chain, "Arbitrum");
assert.equal(bridge!.data.toChain, "Base");
assert.equal(String(bridge!.data.label), "Bridge → Base");

// Topology: deposit → bridge → strategy → swap
const bySource = new Map(edges.map((e) => [e.source, e.target]));
assert.equal(bySource.get(deposit!.id), bridge!.id);
assert.equal(bySource.get(bridge!.id), strategy!.id);
assert.equal(bySource.get(strategy!.id), swap!.id);

// ── 3) Run preflight (no cursor yet) ─────────────────────────────────────────
const preflight = validateVaultBridgeBlock({
  fromChain: bridge!.data.chain as string,
  toChain: bridge!.data.toChain as string,
});
assert.equal(preflight.ok, true);
if (preflight.ok) {
  assert.equal(preflight.fromChainId, 42161);
  assert.equal(preflight.toChainId, 8453);
}

clearNoteCursor();
assert.equal(
  prepareVaultBridgeLeg({
    fromChain: "Arbitrum",
    toChain: "Base",
  }).ok,
  false,
  "prepare must fail before deposit",
);

// ── 4) Deposit opens cursor (simulates depositV3 / recordDepositOnCursor) ────
const afterDep = recordDepositOnCursor({
  chainId: 42161,
  symbol: "USDC",
  commitment: "0xe2e_arb_note",
  value: 100_000_000n, // 100 USDC
  txHash: "0xdep_e2e",
});
assert.ok(afterDep?.active);
assert.equal(peekActiveNoteCursor()?.chainId, 42161);

const ready = prepareVaultBridgeLeg({
  fromChain: bridge!.data.chain as string,
  toChain: bridge!.data.toChain as string,
});
assert.equal(ready.ok, true, ready.ok ? "" : ready.error);
if (ready.ok) {
  assert.match(ready.message, /Arbitrum → Base/);
  assert.equal(ready.activeNoteKey, afterDep!.active!.noteKey);
}

// ── 5) Li.Fi lands + dest vault deposit → finalize cursor ────────────────────
const afterBridge = finalizeVaultBridgeOnCursor({
  toChainId: 8453,
  symbol: "USDC",
  commitment: "0xe2e_base_note",
  value: 99_500_000n,
  txHash: "0xbridge_e2e",
});
assert.ok(afterBridge?.active);
assert.equal(afterBridge!.active!.chainId, 8453);
assert.equal(afterBridge!.active!.commitment, "0xe2e_base_note");
assert.equal(afterBridge!.lineage.length, 2);
assert.equal(afterBridge!.lineage[0].kind, "deposit");
assert.equal(afterBridge!.lineage[1].kind, "bridge");
assert.equal(afterBridge!.lineage[1].bridgeToChainId, 8453);

const persisted = loadNoteCursor();
assert.equal(persisted?.active?.chainId, 8453);
assert.match(lineageSummary(persisted!), /deposit@42161/);
assert.match(lineageSummary(persisted!), /bridge 42161→8453/);
assert.match(lineageSummary(persisted!), /active USDC@8453/);

// ── 6) Fail closed: cannot bridge again to same vault / wrong source ─────────
assert.equal(
  prepareVaultBridgeLeg({ fromChain: "Arbitrum", toChain: "Base" }).ok,
  false,
  "cursor is on Base now — Arb→Base prepare must fail",
);

const toArb = prepareVaultBridgeLeg({ fromChain: "Base", toChain: "Arbitrum" });
assert.equal(toArb.ok, true, toArb.ok ? "" : toArb.error);

assert.equal(
  prepareVaultBridgeLeg({ fromChain: "Base", toChain: "Solana" }).ok,
  false,
  "Solana not in v1 Base↔Arb channel",
);

console.log(
  "vaultBridgeE2E.check: OK —",
  lineageSummary(persisted!),
  `| nodes=${nodes.map((n) => n.data.type).join("→")}`,
);
