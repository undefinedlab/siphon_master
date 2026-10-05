/**
 * v4 multi-leg orchestration — a DROP-IN for the v3 buildTwapLegs/buildGridLegs result at the
 * DetailsModal / Build callsites. Returns the same {legs, splitTxHash, scheduleAnchor, armingFeeWei,
 * armingTxHash} shape so the /createStrategy payload is unchanged; only the builder differs.
 *
 * Wiring at the callsite:
 *
 *   const route = v4RouteFor(chainId, inToken, outToken);   // null → no v4 pool → keep v3
 *   const multi = route
 *     ? await buildV4Multi({ kind, chainId, inToken, outToken, amountStr, sliceCount, ... })
 *     : (isTimeMultiLeg ? await buildTwapLegs(...) : await buildGridLegs(...));
 *
 * `v4RouteFor` maps native ETH → WETH (the v4 pool is WETH/USDC) and returns null for any pair
 * without a registered pool, so pairs we haven't deployed a pool for transparently stay on v3.
 */
import { ethers } from "ethers";
import { getSigner } from "../nexus";
import { getNetwork, NATIVE_TOKEN } from "../networks";
import { collectArmingFee } from "../multiLegBuilder";
import { poolForPair, type V4Pool } from "./config";
import { buildV4TwapLegs, buildV4GridLegs, buildV4SwapLeg, type V4BuiltLeg } from "./strategyLegs";
import type { V4SwapProof } from "./siphonV4";

export interface V4MultiResult {
  legs: V4BuiltLeg[];
  splitTxHash: string;      // no split in v4 (N deposits); placeholder kept for callsite parity
  scheduleAnchor: number;
  armingFeeWei: string;
  armingTxHash: string;
}

type TokenRef = { address: string; symbol?: string };

/** Map a UI token to the ERC20 address the v4 pool uses (native ETH → the network's WETH). */
function resolveV4Address(chainId: number, tok: TokenRef): string {
  if (tok.address === NATIVE_TOKEN || tok.symbol?.toUpperCase() === "ETH") return getNetwork(chainId).weth;
  return tok.address;
}

/** Resolve the v4 pool + direction for a UI pair, or null (→ caller keeps the v3 path). Sync, so
 *  the callsite can decide v4-vs-v3 before awaiting the builder. */
export function v4RouteFor(chainId: number, inTok: TokenRef, outTok: TokenRef): { pool: V4Pool; zeroForOne: boolean } | null {
  return poolForPair(chainId, resolveV4Address(chainId, inTok), resolveV4Address(chainId, outTok));
}

/**
 * Build the v4 proof for a SINGLE strategy (limit order / single Pay & Run): deposit the full amount
 * fresh into the v4 vault and return an executor-bound swap proof + its output precommitment. Returns
 * null if the pair has no v4 pool (caller keeps the v3 generateZKData path). The caller submits this
 * as the strategy's `zk_proof` with output_mode='vault' + output_precommitment; the strategy's own
 * encrypted price trigger is unchanged.
 */
export async function buildV4Single(opts: {
  chainId: number;
  inToken: TokenRef;
  outToken: TokenRef;
  amountStr: string;
  minAmountOutWei?: bigint;
}): Promise<{ zk_proof: V4SwapProof; output_precommitment: string } | null> {
  const route = v4RouteFor(opts.chainId, opts.inToken, opts.outToken);
  if (!route) return null;
  const signer = getSigner();
  if (!signer) throw new Error("Wallet not connected.");

  const inDecimals = (route.zeroForOne ? route.pool.token0 : route.pool.token1).decimals;
  const amountWei = ethers.parseUnits(opts.amountStr, inDecimals);
  if (amountWei === 0n) throw new Error("amount rounds to zero");

  const { proof, outputPrecommitment } = await buildV4SwapLeg({
    chainId: opts.chainId, signer, pool: route.pool, zeroForOne: route.zeroForOne,
    amountWei, minAmountOutWei: opts.minAmountOutWei,
  });
  return { zk_proof: proof, output_precommitment: outputPrecommitment };
}

export async function buildV4Multi(opts: {
  kind: "time" | "grid";
  chainId: number;
  inToken: TokenRef;
  outToken: TokenRef;
  amountStr: string;
  sliceCount: number;
  clientKeyHex: string;
  intervalSec?: number;    // time
  low?: number;            // grid
  high?: number;           // grid
  minAmountOutWei?: bigint;
}): Promise<V4MultiResult> {
  const signer = getSigner();
  if (!signer) throw new Error("Wallet not connected.");

  const route = v4RouteFor(opts.chainId, opts.inToken, opts.outToken);
  if (!route) throw new Error(`no v4 pool for ${opts.inToken.symbol ?? opts.inToken.address} → ${opts.outToken.symbol ?? opts.outToken.address}`);
  const { pool, zeroForOne } = route;

  const scheduleAnchor = Math.floor(Date.now() / 1000);
  // Arming fee kept identical to v3 (plain USDC transfer to the executor) so the backend's arming
  // verification is satisfied the same way regardless of swap venue.
  const { armingCollectedWei, armingTxHash } = await collectArmingFee(opts.chainId);

  // Slice amount in the input token's on-chain decimals (the pool's inToken).
  const inDecimals = (zeroForOne ? pool.token0 : pool.token1).decimals;
  const totalWei = ethers.parseUnits(opts.amountStr, inDecimals);
  const sliceAmountWei = totalWei / BigInt(opts.sliceCount);
  if (sliceAmountWei === 0n) throw new Error("per-slice amount rounds to zero");

  const legs =
    opts.kind === "time"
      ? await buildV4TwapLegs({
          chainId: opts.chainId, signer, pool, zeroForOne, sliceAmountWei,
          sliceCount: opts.sliceCount, intervalSec: opts.intervalSec ?? 60,
          clientKeyHex: opts.clientKeyHex, minAmountOutWei: opts.minAmountOutWei,
        })
      : await buildV4GridLegs({
          chainId: opts.chainId, signer, pool, zeroForOne, sliceAmountWei,
          low: opts.low ?? 0, high: opts.high ?? 0, levels: opts.sliceCount,
          clientKeyHex: opts.clientKeyHex, minAmountOutWei: opts.minAmountOutWei,
        });

  return {
    legs,
    splitTxHash: "v4:no-split",
    scheduleAnchor,
    armingFeeWei: armingCollectedWei.toString(),
    armingTxHash,
  };
}
