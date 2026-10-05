/**
 * Quick self-check: npx tsx src/builder_agent/pipelineHops.check.ts
 */
import {
  clampParsedToSupportedFlow,
  isMultiPhaseFlowPrompt,
} from "./flowCapabilities";
import {
  inferPipelineHopsFromPrompt,
  isSolanaVenuePipelinePrompt,
} from "./pipelineHops";
import { createDefaultParsed } from "./parsedDefaults";
import { createFlowFromParsed } from "./createNodes";

const PROMPT =
  "deposit 1 usdc, yield it for jlUSDC, swap that one for sol, stake sol for liquid and swap that for usdc, bridge to eth sepolia, swap for eth.";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(isSolanaVenuePipelinePrompt(PROMPT), "should detect Solana venue pipeline");
assert(!isMultiPhaseFlowPrompt(PROMPT), "should NOT treat venue pipeline as DCA multi-phase");

const hops = inferPipelineHopsFromPrompt(PROMPT, "1");
assert(hops && hops.length >= 4, `expected ≥4 hops, got ${hops?.length}`);
assert(hops![0].venue === "jupiter" && hops![0].assetOut === "jlUSDC", "hop0 earn");
assert(hops!.some((h) => h.venue === "jito"), "includes jito stake");
assert(hops!.some((h) => h.assetOut === "USDC" && h.kind === "swap"), "unwinds to USDC");

const parsed = createDefaultParsed(PROMPT, {
  amount: "1",
  coin: "USDC",
  pipelineHops: hops,
  depositChain: "Solana Devnet",
});
const { parsed: clamped, capabilityMessage } = clampParsedToSupportedFlow(parsed, PROMPT);
assert(!capabilityMessage, "must not clamp with phase-1 message");
assert(clamped.pipelineHops && clamped.pipelineHops.length >= 4, "keeps pipeline hops");

const { nodes } = createFlowFromParsed(clamped);
const lendCount = nodes.filter((n) => n.data.type === "lend").length;
const swapCount = nodes.filter((n) => n.data.type === "swap").length;
assert(lendCount >= 2, `expected ≥2 lend nodes, got ${lendCount}`);
assert(swapCount >= 2, `expected ≥2 swap nodes, got ${swapCount}`);
assert(!nodes.some((n) => n.data.type === "strategy"), "pipeline has no Strategy block");

console.log("pipelineHops.check OK", {
  hops: hops!.map((h) => `${h.kind}:${h.assetIn}→${h.assetOut}`),
  nodes: nodes.map((n) => String(n.data.label || n.data.type)),
});
