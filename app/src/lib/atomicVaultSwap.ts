/**
 * Arm a same-chain private swap that settles via Entrypoint.swapAndDeposit:
 * generateSwapProof with recipient = dst vault, plus an output note precommitment.
 *
 * Spec: siphon-contracts/docs/SWAP_AND_DEPOSIT.md
 */
import { Contract, ethers } from 'ethers';
import entrypointArtifact from './abi/Entrypoint.json';
import {
  generateSwapProof,
  getReadProvider,
  armTrace,
  type SwapProofData,
  type TokenInfo,
} from './zkHandler';
import { getNetwork, getZkWithdrawRecipient } from './networks';
import { getSigner } from './nexus';
import { resolveSwapPool } from './multiLegBuilder';
import { createVaultOutputNote } from './outputNoteResolver';

const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Minimal ABI fragment for feature / policy probes. */
const ENTRYPOINT_PROBE_ABI = [
  'function supportsSwapAndDeposit() view returns (bool)',
  'function getVault(address asset) view returns (address)',
  'function swapAndDepositPermissionless() view returns (bool)',
  'function swapAndDepositRelayers(address) view returns (bool)',
  'function swapAndDepositFeeBps() view returns (uint16)',
  'function isRegisteredVault(address) view returns (bool)',
];

export type ArmedVaultSwap = {
  swapProof: SwapProofData;
  outputPrecommitment: string;
  /** Wire shape for strategy zkp_data / leg zk_proof */
  zkpData: Record<string, unknown>;
  feeBps: number;
};

/** Exported so the v3 strategy path prices minAmountOut with the SAME logic as v2 rather than a
 *  second implementation. It is the only slippage bound on a vault-output leg (the executor's
 *  preflight path is unreachable for that shape), so two implementations means two bounds. */
export function estimateMinOutWei(
  amountInHuman: string,
  inToken: TokenInfo,
  outToken: TokenInfo,
  ethUsdPrice: number,
  slippageBps: number,
  feeBps: number,
): { minOut: bigint; error?: string } {
  const amountIn = parseFloat(amountInHuman);
  if (!Number.isFinite(amountIn) || amountIn <= 0) {
    return { minOut: 1n, error: 'Invalid swap amount.' };
  }
  const aIn = inToken.symbol.toUpperCase();
  const aOut = outToken.symbol.toUpperCase();
  const needsEthUsd =
    (aIn === 'ETH' && aOut === 'USDC') || (aIn === 'USDC' && aOut === 'ETH');
  if (needsEthUsd && !(ethUsdPrice > 0)) {
    return { minOut: 0n, error: 'Live ETH/USD price required to arm vault swap (refusing silent fallback).' };
  }
  let outHuman: number;
  if (aIn === aOut) {
    outHuman = amountIn;
  } else if (aIn === 'ETH' && aOut === 'USDC') {
    outHuman = amountIn * ethUsdPrice;
  } else if (aIn === 'USDC' && aOut === 'ETH') {
    outHuman = amountIn / ethUsdPrice;
  } else {
    return {
      minOut: 0n,
      error: `No minOut estimator for ${aIn}→${aOut}; refusing 1:1 fallback.`,
    };
  }
  // Slippage first (desired net), then inflate to GROSS Uniswap floor so post-fee credit ≈ net.
  const slipped = outHuman * (1 - Math.min(Math.max(slippageBps, 1), 5000) / 10_000);
  const fee = Math.min(Math.max(feeBps, 0), 100);
  const gross = fee > 0 ? slipped * (10_000 / (10_000 - fee)) : slipped;
  const wei = ethers.parseUnits(
    gross.toFixed(Math.min(outToken.decimals, 8)),
    outToken.decimals,
  );
  return { minOut: wei > 0n ? wei : 1n };
}

/** Fail closed if Entrypoint lacks swapAndDeposit or executor cannot submit. */
export async function assertAtomicSettleReady(
  chainId: number,
): Promise<{ ok: true; feeBps: number } | { error: string }> {
  const net = getNetwork(chainId);
  // Read-only probes go through the app's OWN RPC, never the injected wallet. An injected provider
  // with two extensions competing for window.ethereum (Brave Wallet + MetaMask) can accept an
  // eth_call and never settle — no timeout, no error, no network traffic — which stalls the arm
  // flow forever before it ever reaches /api/prove. MetaMask also rate-limits read calls.
  const entrypoint = new Contract(net.entrypoint, ENTRYPOINT_PROBE_ABI, getReadProvider(chainId));
  try {
    const supported: boolean = await entrypoint.supportsSwapAndDeposit();
    if (!supported) {
      return { error: `Entrypoint on chain ${chainId} reports supportsSwapAndDeposit=false.` };
    }
  } catch {
    return {
      error:
        `Entrypoint ${net.entrypoint} on ${net.name} does not expose supportsSwapAndDeposit — ` +
        `redeploy contracts with swapAndDeposit before arming atomic vault swaps.`,
    };
  }

  let feeBps = 0;
  try {
    feeBps = Number(await entrypoint.swapAndDepositFeeBps());
  } catch {
    feeBps = 0;
  }

  try {
    const permissionless: boolean = await entrypoint.swapAndDepositPermissionless();
    if (!permissionless) {
      const executor = getZkWithdrawRecipient(chainId);
      const allowed: boolean = await entrypoint.swapAndDepositRelayers(executor);
      if (!allowed) {
        return {
          error:
            `Executor ${executor} is not an allowlisted swapAndDeposit relayer on ${net.name}. ` +
            `Owner must call setSwapAndDepositRelayer before strategies can settle.`,
        };
      }
    }
  } catch (e) {
    return {
      error: `Could not verify swapAndDeposit relayer policy: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { ok: true, feeBps };
}

/** @deprecated use assertAtomicSettleReady */
export async function assertEntrypointSupportsSwapAndDeposit(
  chainId: number,
): Promise<{ ok: true } | { error: string }> {
  const r = await assertAtomicSettleReady(chainId);
  if ('error' in r) return r;
  return { ok: true };
}

/** Build swap proof bound to dst vault + fresh output note secrets for swapAndDeposit. */
export async function armSameChainVaultSwap(opts: {
  chainId: number;
  inToken: TokenInfo;
  outToken: TokenInfo;
  amountHuman: string;
  ethUsdPrice?: number;
  maxSlippageBps?: number;
  noteKey?: string;
}): Promise<ArmedVaultSwap | { error: string }> {
  const {
    chainId,
    inToken,
    outToken,
    amountHuman,
    ethUsdPrice = 0,
    maxSlippageBps = 100,
    noteKey,
  } = opts;

  let _at = armTrace("arm:start");
  const ready = await assertAtomicSettleReady(chainId);
  _at = armTrace("arm:assertAtomicSettleReady", _at);
  if ('error' in ready) return ready;
  const { feeBps } = ready;

  const net = getNetwork(chainId);
  const signer = getSigner();
  if (!signer) return { error: 'Wallet not connected.' };

  const entrypoint = new Contract(
    net.entrypoint,
    (entrypointArtifact as { abi?: ethers.InterfaceAbi }).abi ?? ENTRYPOINT_PROBE_ABI,
    // Read-only (getVault) — app RPC, not the wallet provider. See assertAtomicSettleReady.
    getReadProvider(chainId),
  );
  const dstAsset = outToken.symbol.toUpperCase() === 'ETH' ? NATIVE_TOKEN : outToken.address;
  const dstVault: string = await entrypoint.getVault(dstAsset);
  _at = armTrace("arm:getVault", _at);
  if (!dstVault || dstVault === ethers.ZeroAddress) {
    return { error: `No vault for ${outToken.symbol} on chain ${chainId}` };
  }

  const srcForPool =
    inToken.symbol.toUpperCase() === 'ETH' ? net.weth : inToken.address;
  const dstForPool =
    outToken.symbol.toUpperCase() === 'ETH' ? net.weth : outToken.address;
  const { pool, fee } = await resolveSwapPool(chainId, srcForPool, dstForPool);
  _at = armTrace("arm:resolveSwapPool", _at);

  const { minOut: minAmountOut, error: minOutErr } = estimateMinOutWei(
    amountHuman,
    inToken,
    outToken,
    ethUsdPrice,
    maxSlippageBps,
    feeBps,
  );
  if (minOutErr) return { error: minOutErr };

  const dstTokenForProof =
    outToken.symbol.toUpperCase() === 'ETH' ? net.weth : outToken.address;

  let swapProof = await generateSwapProof(
    chainId,
    inToken,
    amountHuman,
    dstVault,
    { pool, dstToken: dstTokenForProof, fee, minAmountOut },
    noteKey,
  );
  _at = armTrace(`arm:generateSwapProof(${'error' in swapProof ? 'ERROR' : 'ok'})`, _at);
  if ('error' in swapProof && !noteKey && /No single|No spendable|largest deposit/i.test(swapProof.error)) {
    const { mergeCrossLabelIfNeeded } = await import('./noteConsolidator');
    for (let round = 0; round < 4; round++) {
      const mr = await mergeCrossLabelIfNeeded(chainId, inToken);
      if ('error' in mr) return { error: mr.error };
      if (!mr.merged) break;
      const retry = await generateSwapProof(
        chainId,
        inToken,
        amountHuman,
        dstVault,
        { pool, dstToken: dstTokenForProof, fee, minAmountOut },
        mr.key,
      );
      if (!('error' in retry)) {
        swapProof = retry;
        break;
      }
      if (!/No single|No spendable|largest deposit/i.test(retry.error)) {
        return { error: retry.error };
      }
    }
  }
  if ('error' in swapProof) return { error: swapProof.error };

  const outNote = await createVaultOutputNote(chainId, outToken, signer);
  _at = armTrace("arm:createVaultOutputNote", _at);
  const zkpData = {
    venue: 'swap_and_deposit',
    pA: swapProof.pA,
    pB: swapProof.pB,
    pC: swapProof.pC,
    stateRoot: swapProof.stateRoot,
    aspRoot: swapProof.aspRoot,
    nullifierHashes: [swapProof.nullifier],
    nullifier: swapProof.nullifier,
    changeCommitment: swapProof.newCommitment,
    newCommitment: swapProof.newCommitment,
    newLabel: swapProof.newLabel,
    changeLabel: swapProof.newLabel,
    amountIn: swapProof.amountIn,
    amount: swapProof.amountIn,
    recipient: swapProof.recipient,
    pool: swapProof.pool,
    dstToken: swapProof.dstToken,
    fee: swapProof.fee,
    minAmountOut: swapProof.minAmountOut,
    // IVault.ZKProof.changeValue — relayer-supplied, not bound in the swap public signals.
    // Only the plain amount: the rest of `swapProof.change` is note secrets (nullifier/secret/
    // precommitment) and must never reach the server.
    changeValue: swapProof.change.amountWei,
  };

  return {
    swapProof,
    outputPrecommitment: outNote.precommitment,
    zkpData,
    feeBps,
  };
}
