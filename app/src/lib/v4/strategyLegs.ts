/**
 * v4 strategy legs — TWAP / RANGE_GRID executed through the Siphon v4 shielded hook.
 *
 * A multi-leg order becomes N INDEPENDENT shielded legs, each a 9-signal SWAP proof bound to the
 * EXECUTOR (recipient == executor, so the hook's msg.sender==recipient guard lets the executor
 * relay it; no third party can front-run). Per leg:
 *
 *   1. deposit  — shield one slice of the input token into the v4 vault as its own note.
 *   2. prove    — build a swap proof spending that whole slice-note through the pool, bound to the
 *                 executor, with a fresh OUTPUT precommitment (the re-shielded proceeds).
 *   3. encrypt  — the leg's own FHE trigger (grid price band or TWAP fire-time), same as v3.
 *
 * When the executor fires a leg it submits vault.shieldedSwap: the hook verifies the proof inside
 * the pool swap, burns the nullifier, and re-shields the output in afterSwap — atomic, no custody
 * window. The output note's amount is unknown until it fires, so its secrets are stashed as a
 * pending output (see noteStore) and reconciled from the ShieldedSwap event afterwards.
 *
 * ponytail: N separate deposits (one per leg), NOT a single split — the v4 vault has no split()
 *   circuit yet, so leg count is visible on-chain and gas is N deposits. Port split() to the v4
 *   vault to hide count / cut gas when it matters.
 * ponytail: minAmountOut defaults to 0 — set a real slippage bound per slice (oracle-derived, like
 *   the v3 preflight) before using this with value at risk.
 */
import { ethers, type Signer } from "ethers";
import { depositNativeV4, depositTokenV4, isCurrentV4Note, listNotes, prepareV4Swap, type V4SwapProof } from "./siphonV4";
import { type V4Pool } from "./config";
import { markSpent, addPendingOutput } from "./noteStore";
import { encryptPrice, encryptPriceCents } from "../fhe";
import { getZkWithdrawRecipient } from "../networks";
import { computeRangeGridLegs } from "../strategySpec";

export interface V4BuiltLeg {
  leg_index: number;
  amount: number;                 // human units (input token)
  side?: "LIMIT_BUY" | "LIMIT_SELL";
  eval_mode: "price" | "time";
  encrypted_upper_bound?: string; // sell-rung price band
  encrypted_lower_bound?: string; // buy-rung price band OR TWAP encrypted fire-time
  output_precommitment: string;   // re-shielded output note's precommitment
  zk_proof: V4SwapProof;          // executor-ready, venue:'v4'
}

const STABLES = new Set(["USDC", "USDT", "DAI"]);

/** The input token's metadata for a swap direction on a pool. */
function inTokenOf(pool: V4Pool, zeroForOne: boolean) {
  return zeroForOne ? pool.token0 : pool.token1;
}

/** Deposit one slice via the one-tx depositor (WETH input = native ETH wrap+deposit, no approve;
 *  ERC20 = approve-depositor + atomic depositToken), then build an executor-bound swap proof
 *  spending it. Retries proof-gen a few times so a read-provider lagging the fresh deposit leaf
 *  doesn't spuriously fail the leg. */
async function buildOneLeg(
  signer: Signer,
  executor: string,
  pool: V4Pool,
  zeroForOne: boolean,
  sliceAmountWei: bigint,
  minAmountOutWei: bigint,
): Promise<{ proof: V4SwapProof; outputPrecommitment: string }> {
  const inTok = inTokenOf(pool, zeroForOne);
  // A previous build may have deposited successfully and then failed while reading/proving. Reuse
  // that still-unspent exact-value note so retrying PAY & RUN cannot deposit the same funds again.
  const reusable = listNotes(inTok.address).find(
    (note) => isCurrentV4Note(note) && BigInt(note.value) === sliceAmountWei,
  );
  const note = reusable ?? (inTok.symbol.toUpperCase() === "WETH"
    ? (await depositNativeV4(signer, sliceAmountWei)).note                 // native ETH → wrap+deposit, one tx
    : (await depositTokenV4(signer, inTok.address, sliceAmountWei)).note); // ERC20 → approve helper + atomic deposit

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const prep = await prepareV4Swap(signer, {
        inputNote: note,
        amountIn: sliceAmountWei, // spend the whole slice; change == 0
        minAmountOut: minAmountOutWei,
        zeroForOne,
        recipient: executor,
        pool,
      });
      // The slice-note is consumed by this leg; keep it out of the instant-swap spendable set. Stash
      // the output secrets so the proceeds can be reconciled + withdrawn once the leg fires.
      markSpent(note.commitment);
      addPendingOutput(prep.outputSecrets);
      return { proof: prep.proof, outputPrecommitment: prep.proof.outputPrecommitment };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof Error) || !e.message.includes("not found in the input token's tree")) throw e;
      await new Promise((r) => setTimeout(r, 1500)); // fresh leaf not visible yet — retry
    }
  }
  throw new Error(`v4 leg proof failed after deposit (leaf never visible): ${lastErr}`);
}

/**
 * Build ONE executor-bound v4 swap leg (deposit + proof) for a SINGLE strategy (limit order /
 * single Pay & Run) — no encrypted trigger attached (the strategy carries its own price trigger in
 * its bounds/condition_tree). Wraps native ETH → WETH if the input is WETH. Same shielded-hook
 * semantics as a TWAP leg: recipient == executor, output re-shielded, no custody window.
 */
export async function buildV4SwapLeg(opts: {
  chainId: number;
  signer: Signer;
  pool: V4Pool;
  zeroForOne: boolean;
  amountWei: bigint;
  minAmountOutWei?: bigint;
}): Promise<{ proof: V4SwapProof; outputPrecommitment: string }> {
  const executor = getZkWithdrawRecipient(opts.chainId);
  return buildOneLeg(opts.signer, executor, opts.pool, opts.zeroForOne, opts.amountWei, opts.minAmountOutWei ?? 0n);
}

async function buildV4Legs(
  chainId: number,
  signer: Signer,
  pool: V4Pool,
  zeroForOne: boolean,
  sliceAmountWei: bigint,
  sliceCount: number,
  minAmountOutWei: bigint,
  encryptLeg: (i: number) => Promise<Pick<V4BuiltLeg, "encrypted_upper_bound" | "encrypted_lower_bound" | "side" | "eval_mode">>,
): Promise<V4BuiltLeg[]> {
  const executor = getZkWithdrawRecipient(chainId);
  const inTok = inTokenOf(pool, zeroForOne);
  const amountHuman = parseFloat(ethers.formatUnits(sliceAmountWei, inTok.decimals));

  const legs: V4BuiltLeg[] = [];
  for (let i = 0; i < sliceCount; i++) {
    const { proof, outputPrecommitment } = await buildOneLeg(signer, executor, pool, zeroForOne, sliceAmountWei, minAmountOutWei);
    const bound = await encryptLeg(i);
    legs.push({
      leg_index: i,
      amount: amountHuman,
      ...bound,
      output_precommitment: outputPrecommitment,
      zk_proof: proof,
    });
  }
  return legs;
}

export async function buildV4TwapLegs(opts: {
  chainId: number;
  signer: Signer;
  pool: V4Pool;
  zeroForOne: boolean;
  sliceAmountWei: bigint;
  sliceCount: number;
  intervalSec: number;
  clientKeyHex: string;
  minAmountOutWei?: bigint;
}): Promise<V4BuiltLeg[]> {
  const encryptLeg = async (i: number) => ({
    // Fire-time RELATIVE to the schedule anchor (k*interval), kept small for the FHE integer width.
    eval_mode: "time" as const,
    encrypted_lower_bound: await encryptPriceCents(BigInt(i * opts.intervalSec), opts.clientKeyHex),
  });
  return buildV4Legs(
    opts.chainId, opts.signer, opts.pool, opts.zeroForOne, opts.sliceAmountWei,
    opts.sliceCount, opts.minAmountOutWei ?? 0n, encryptLeg,
  );
}

export async function buildV4GridLegs(opts: {
  chainId: number;
  signer: Signer;
  pool: V4Pool;
  zeroForOne: boolean;
  sliceAmountWei: bigint;
  low: number;
  high: number;
  levels: number;
  clientKeyHex: string;
  minAmountOutWei?: bigint;
}): Promise<V4BuiltLeg[]> {
  // Same coherent single-direction grid as v3 (see computeRangeGridLegs): paying a stablecoin buys
  // the base (LIMIT_BUY, fire on price <= rung); paying the base sells it (LIMIT_SELL, fire >= rung).
  const gridSide = STABLES.has(inTokenOf(opts.pool, opts.zeroForOne).symbol.toUpperCase())
    ? ("LIMIT_BUY" as const)
    : ("LIMIT_SELL" as const);
  const rungs = computeRangeGridLegs(opts.low, opts.high, opts.levels, gridSide);
  const encryptLeg = async (i: number) => {
    const rung = rungs[i];
    const encBound = await encryptPrice(rung.price, opts.clientKeyHex);
    return rung.legType === "LIMIT_BUY"
      ? { eval_mode: "price" as const, side: "LIMIT_BUY" as const, encrypted_lower_bound: encBound }
      : { eval_mode: "price" as const, side: "LIMIT_SELL" as const, encrypted_upper_bound: encBound };
  };
  return buildV4Legs(
    opts.chainId, opts.signer, opts.pool, opts.zeroForOne, opts.sliceAmountWei,
    opts.levels, opts.minAmountOutWei ?? 0n, encryptLeg,
  );
}
