// Multi-leg strategy builder (TWAP / RANGE_GRID).
//
// A TWAP/Grid order is executed as N INDEPENDENT shielded legs. This module turns a single
// deposit note into that ladder:
//
//   1. split  — Entrypoint.split slices ONE deposit note into N slice-notes in a single private
//               tx (always 8 commitments on-chain, zero-padded, so the real slice count is
//               hidden). Uses generateSplitProof().
//   2. prove  — one swap proof per slice-note (generateSwapProof), each spending a distinct note
//               with its own nullifier. N slices ⇒ N proofs ⇒ N nullifiers — never reused.
//   3. encrypt— each leg gets its OWN encrypted trigger:
//                 • grid rung  → encrypted price band (encryptPrice) keyed by buy/sell side
//                 • TWAP slice → encrypted FIRE-TIME (encryptPriceCents on the unix-second
//                   target), compared in the FHE engine against the public current time, so the
//                   cadence stays in ciphertext exactly like a price threshold.
//   4. assemble — return legs[] for the /createStrategy payload (the backend persists one
//                 StrategyLeg row per leg and the scheduler fires each independently).
//
// On-chain prerequisite: the deployed Entrypoint/Vault must expose split() + the multi-note
// withdraw/swap verifiers (the upgraded contracts). The split tx is submitted here via the
// caller-provided `submitSplit` so this module stays free of contract-wiring specifics.

import { ethers, Contract } from "ethers";
import {
  generateSplitProof,
  invalidateLeafCache,
  getOnChainLeaves,
  getReadProvider,
  type TokenInfo,
  type SplitProofData,
} from "./zkHandler";
import { computeRangeGridLegs } from "./strategySpec";
import { armingChargeUsdcWei } from "./feeModel";
import { encryptPrice, encryptPriceCents } from "./fhe";
import { getNetwork, NATIVE_TOKEN, getZkWithdrawRecipient } from "./networks";
import { getSigner } from "./nexus";
import { writeNote, markNoteSpent, noteKey } from "./localNoteStore";
import { requireStrategySupport, requireV2StrategyPath } from "./v3/configV3";

// The bundled Entrypoint.json includes Hard ASP split(); keep an explicit fragment for clarity.
// Entrypoint.split(asset, depositor, totalValue, stateRoot, aspRoot, nullifierHash, outCommitments[8], outLabel, pA, pB, pC)
// _depositor + _totalValue back the slice outputs' DepositInfo (revocation/ragequit authority over the
// slices). _depositor = the split note's owner (the connected wallet), NOT the relayer.
const SPLIT_ABI = [
  "function split(address _asset, address _depositor, uint256 _totalValue, uint256 _stateRoot, uint256 _aspRoot, uint256 _nullifierHash, uint256[8] _outCommitments, uint256 _outLabel, uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC)",
];

const V3_FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Resolve the Uniswap v3 pool for tokenIn/tokenOut on `chainId`, trying the requested fee tier
 * first then common ones. Returns the pool address for a leg's SwapBinding (bound into the swap
 * proof and checked by Vault.swap). Throws if no pool exists.
 */
export async function resolveSwapPool(
  chainId: number,
  tokenInAddr: string,
  tokenOutAddr: string,
  fee = 3000,
): Promise<{ pool: string; fee: number }> {
  const net = getNetwork(chainId);
  if (!net.uniswapV3Factory) throw new Error(`No uniswapV3Factory configured for chain ${chainId}`);
  // Pool lookup is read-only — use the app's RPC, not the injected wallet. A wallet provider
  // contended by two extensions can hang an eth_call forever, stalling the arm flow here.
  const factory = new Contract(net.uniswapV3Factory, V3_FACTORY_ABI, getReadProvider(chainId));
  const tIn = tokenInAddr === NATIVE_TOKEN ? net.weth : tokenInAddr;
  const tOut = tokenOutAddr === NATIVE_TOKEN ? net.weth : tokenOutAddr;
  for (const f of [...new Set([fee, 3000, 500, 10000, 100])]) {
    const pool: string = await factory.getPool(tIn, tOut, f);
    if (pool && pool !== ZERO) return { pool, fee: f };
  }
  throw new Error(`No Uniswap v3 pool for ${tIn} → ${tOut} on chain ${chainId}`);
}

/**
 * Broadcast Entrypoint.split(asset, stateRoot, nullifierHash, outCommitments[8], pA, pB, pC),
 * then persist the real slice notes to the local encrypted note store so the per-leg swap proofs
 * can spend them by note key. Returns the tx hash + the slice note keys (split insert order).
 *
 * Requires the upgraded Entrypoint with split() (the multi-note contracts). On the legacy
 * single-note deployment this call reverts — multi-leg orders need the redeploy.
 */
export async function submitSplitOnChain(
  chainId: number,
  token: TokenInfo,
  split: SplitProofData,
): Promise<{ txHash: string; sliceNoteKeys: string[] }> {
  requireV2StrategyPath(chainId);
  const signer = getSigner();
  if (!signer) throw new Error("Wallet not connected.");
  const net = getNetwork(chainId);
  const asset = token.symbol === "ETH" ? NATIVE_TOKEN : token.address;

  const entrypoint = new Contract(net.entrypoint, SPLIT_ABI, signer);
  // Explicit gasLimit — split() inserts 8 commitments, each a depth-32 Poseidon Merkle insert whose
  // levels are external PoseidonT3 calls. Under the 63/64 gas-forwarding rule a too-low estimate
  // starves the inner calls and the insert reverts (status 0, gasUsed < limit) — the SAME failure
  // the deposit path fixed with an explicit 1.5M for ONE insert (see collectArmingFee). 8 inserts
  // ⇒ ~8M; 12M gives headroom (unused gas refunds). Also skips MetaMask's rate-limited estimate.
  const depositor = await signer.getAddress();
  const tx = await entrypoint.split(
    asset,
    depositor,
    split.totalValue,
    split.stateRoot,
    split.aspRoot,
    split.nullifierHash,
    split.outCommitments,
    split.outLabel,
    split.pA,
    split.pB,
    split.pC,
    { gasLimit: 12_000_000n },
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`split tx failed: ${tx.hash}`);
  }

  // The 8 slice commitments are now on-chain leaves — bust the cached leaf scan so the per-leg
  // swap proofs can prove membership (otherwise getLeafSet returns the pre-split set and the
  // slice notes look "not on-chain").
  try { invalidateLeafCache(asset); } catch { /* best-effort */ }

  // Persist the real slice notes (encrypted) under the CANONICAL note key
  // `siphon-note-{chainId}-{SYMBOL}-{commitment}`. This MUST be noteKey() — generateZKData scans
  // notes by that exact prefix (scanNotes) and, for a per-leg spend, filters `key !== _noteKey`.
  // A hand-rolled `${chainId}-${symbol}-${commitment}` (no prefix) never matches the scanned key,
  // so every note is skipped → "Insufficient balance. Have 0.0" on leg 0 (TWAP/grid only; single
  // orders pass no _noteKey and were unaffected).
  // Skip the protocol arming-fee slice (no nullifier/secret on this device) so sliceNoteKeys holds
  // only the USER slices the legs map to.
  const sliceNoteKeys: string[] = [];
  for (const slice of split.slices) {
    if (!slice.nullifier) continue;
    // MUST be noteKey() (canonical `siphon-note-…` prefix) — a raw `${chainId}-…` string never
    // matches scanNotes and strands every leg ("Have 0.0"). See the comment block above.
    const key = noteKey(chainId, token.symbol, slice.commitment);
    const amountHuman = ethers.formatUnits(slice.amountWei, token.decimals);
    await writeNote(
      key,
      {
        nullifier:     slice.nullifier,
        secret:        slice.secret,
        commitment:    slice.commitment,
        precommitment: slice.precommitment,
        nullifierHash: '',
        label:         slice.label,
        amount:        amountHuman,
        spent:         false,
      },
      signer,
    );

    // Back the slice note to Supabase too (writeNote is localStorage-only). These are REAL
    // on-chain leaves; without the backup they're unspendable after a storage clear / device
    // switch — same gap as the strategy change note. Mirrors the deposit/withdraw backup.
    try {
      const { backupNoteWithConfirmation } = await import('./commitmentStore');
      const { currentVaultId } = await import('./vaultRegistry');
      const sliceVaultId = (await currentVaultId(chainId, token.symbol)) ?? undefined;
      await backupNoteWithConfirmation(
        signer,
        {
          nullifier:     slice.nullifier,
          secret:        slice.secret,
          commitment:    slice.commitment,
          amount:        amountHuman,
          chainId,
          nullifierHash: '',
          precommitment: slice.precommitment,
          label:         slice.label,
          vaultId:       sliceVaultId,
        },
        token.symbol,
        'change',
      );
    } catch (e) {
      console.warn('[split] slice note Supabase backup failed:', slice.commitment, e);
    }

    sliceNoteKeys.push(key);
  }
  // The split input note is consumed.
  if (split.spentNoteKey) markNoteSpent(split.spentNoteKey);

  return { txHash: tx.hash, sliceNoteKeys };
}

export interface BuiltLeg {
  leg_index: number;
  amount: number;                 // human units (asset_in)
  side?: "LIMIT_BUY" | "LIMIT_SELL";
  eval_mode: "price" | "time";
  // NOTE: no plaintext target_price. The rung price exists ONLY inside encrypted_upper/lower_bound —
  // sending it in cleartext made the FHE band decorative against anyone with executor-DB access.
  encrypted_upper_bound?: string; // sell-rung price band
  encrypted_lower_bound?: string; // buy-rung price band  OR  TWAP encrypted fire-time
  // Each leg re-deposits its swap output into the asset_out vault as a private note; this is that
  // note's precommitment (the executor mints Poseidon(actualOut, precommitment) on deposit).
  output_precommitment: string;
  // Swap proof for swapAndDeposit (recipient = dst vault), or legacy withdraw proof.
  /** OPTIONAL since v3: an enclave-armed leg has no browser-built proof — the enclave proves at
   *  fire time. Its ABSENCE is exactly what routes the leg through the executor's attested path
   *  (executor_runner._execute_attested_leg), so this must stay optional, not a zero value. */
  zk_proof?: {
    pA: [string, string];
    pB: [[string, string], [string, string]];
    pC: [string, string];
    stateRoot: string;
    aspRoot: string;
    changeLabel: string;
    newLabel: string;
    nullifierHashes: string[];    // one slice note spent per leg
    changeCommitment: string;
    newCommitment: string;        // == changeCommitment (backend reads either)
    amount: string;               // amountIn / withdrawn value (slice amount, wei)
    venue?: string;
    amountIn?: string;
    recipient?: string;
    pool?: string;
    dstToken?: string;
    fee?: number;
    minAmountOut?: string;
    nullifier?: string;
  };
}

export interface MultiLegResult {
  legs: BuiltLeg[];
  splitTxHash: string;
  scheduleAnchor: number;         // unix seconds the TWAP fire-times were computed against
  armingFeeWei: string;           // fixed fee in USDC base units (250000 = $0.25)
  armingTxHash: string;            // confirmed USDC.transfer verified by the backend
}

/**
 * Collect one fixed $0.25 arming fee directly in USDC. This is intentionally outside the vault:
 * no approval, precommitment, note pool, Merkle insertion, oracle quote, or CVM round trip.
 */
export async function collectArmingFee(
  chainId: number,
  /** Execution window the order is asking for, in hours — it is priced into this one transfer. */
  windowHours = 0,
): Promise<{ armingCollectedWei: bigint; armingTxHash: string }> {
  // Every arming path funnels through here (DetailsModal, Builder/Build, quickSwapRun,
  // buildTwapLegs, v4/strategyOrchestrate) — the one place that catches them all before money moves.
  requireStrategySupport(chainId);
  const charge = armingChargeUsdcWei(windowHours);
  const signer = getSigner();
  if (!signer) throw new Error("Wallet not connected for arming-fee collection.");
  const net = getNetwork(chainId);
  const executor = getZkWithdrawRecipient(chainId);
  const usdc = new Contract(
    net.usdc,
    [
      "function transfer(address to, uint256 value) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ],
    signer,
  );
  // Pre-flight: the arming fee is a plain WALLET USDC transfer (NOT from the shielded vault), so a
  // wallet with its USDC already shielded fails the transfer at estimateGas with a raw
  // "ERC20: transfer amount exceeds balance". Check the balance first and throw a clear message.
  // Wording avoids friendlyTxError's "insufficient balance"/"have 0.0" patterns so it isn't
  // genericised, and keeps the shortfall in the first ~140 chars (that helper truncates the rest).
  const from = await signer.getAddress();
  const bal: bigint = await usdc.balanceOf(from);
  if (bal < charge) {
    const need = ethers.formatUnits(charge, 6);
    const has = ethers.formatUnits(bal, 6);
    throw new Error(
      `Arming fee needs ${need} USDC in your wallet, but your ${net.name} wallet holds only ${has} USDC ` +
      `(the fee is charged from your wallet, not your shielded vault). Top up USDC and try again.`,
    );
  }
  const tx = await usdc.transfer(executor, charge);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Arming-fee USDC transfer failed.");
  return { armingCollectedWei: charge, armingTxHash: tx.hash };
}

/** A single-slice swap (or withdraw) proof → the leg's zk_proof wire shape. */
function proofToLegProof(tx: Record<string, unknown>): NonNullable<BuiltLeg["zk_proof"]> {
  const nullifiers = (tx.nullifierHashes as string[]) ||
    (tx.nullifier ? [String(tx.nullifier)] : []);
  return {
    pA: tx.pA as NonNullable<BuiltLeg["zk_proof"]>["pA"],
    pB: tx.pB as NonNullable<BuiltLeg["zk_proof"]>["pB"],
    pC: tx.pC as NonNullable<BuiltLeg["zk_proof"]>["pC"],
    stateRoot: String(tx.stateRoot),
    aspRoot: String(tx.aspRoot),
    changeLabel: String(tx.changeLabel || tx.newLabel),
    // execute_evm_leg_swap encodes newLabel into the on-chain proof tuple and fatals without it.
    newLabel: String(tx.newLabel || tx.changeLabel),
    nullifierHashes: nullifiers,
    changeCommitment: String(tx.changeCommitment || tx.newCommitment),
    newCommitment: String(tx.newCommitment || tx.changeCommitment),
    amount: String(tx.amountIn || tx.amount || ""),
    // Entrypoint.withdraw._changeValue / IVault.ZKProof.changeValue — private circuit input the
    // executor cannot derive. Omit rather than stringify undefined, so a leg built by an older
    // path fails closed with the executor's re-arm message instead of encoding "undefined".
    ...(tx.changeValue !== undefined && tx.changeValue !== null
      ? { changeValue: String(tx.changeValue) }
      : {}),
    ...(tx.pool
      ? {
          venue: "swap_and_deposit",
          amountIn: String(tx.amountIn),
          recipient: String(tx.recipient),
          pool: String(tx.pool),
          dstToken: String(tx.dstToken),
          fee: Number(tx.fee),
          minAmountOut: String(tx.minAmountOut),
          nullifier: String(tx.nullifier || nullifiers[0]),
        }
      : {}),
  } as NonNullable<BuiltLeg["zk_proof"]>;
}

/**
 * Split the deposit, then build one swapAndDeposit proof per slice. Each leg's proof is bound to
 * the destination vault as recipient: Entrypoint.swapAndDeposit swaps asset_in→asset_out and
 * credits the output vault note (output_precommitment) in one tx — no executor custody.
 * Shared by TWAP + Grid; the caller supplies the per-leg encrypted bound via
 * `encryptLeg(legIndex, sliceAmountHuman)`.
 *
 * `submitSplit` must broadcast Entrypoint.split(splitProof), resolve once the slice commitments
 * are on-chain leaves, and persist the slice notes to the local note store keyed
 * `${chainId}-${symbol}-${commitment}` so generateSwapProof can spend them by note key.
 */
/**
 * Fallback when a caller supplies nothing. Matches the value legs were hardcoded to before the
 * user's setting was threaded through, so an un-updated caller behaves exactly as it did.
 * Note this is TIGHTER than the executor's own DEFAULT_MAX_SLIPPAGE_BPS (300) — deliberately, since
 * the leg's minAmountOut is fixed at arm time and cannot be re-quoted at fire time.
 */
const DEFAULT_LEG_SLIPPAGE_BPS = 100;

/** Clamp to the executor's accepted range (evm_executor.MAX_ALLOWED_SLIPPAGE_BPS, and >0 because a
 *  zero bound can never fill on a fee-bearing AMM). Keeps a bad UI value from arming a dead leg. */
export function clampSlippageBps(bps: number | null | undefined): number {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEG_SLIPPAGE_BPS;
  return Math.min(Math.max(Math.round(n), 1), 5000);
}

async function buildLegsFromSplit(
  chainId: number,
  inToken: TokenInfo,
  outToken: TokenInfo,
  sliceCount: number,
  encryptLeg: (legIndex: number, sliceAmountHuman: string) => Promise<Pick<BuiltLeg, "encrypted_upper_bound" | "encrypted_lower_bound" | "side" | "eval_mode">>,
  submitSplit: (split: SplitProofData) => Promise<{ txHash: string; sliceNoteKeys: string[] }>,
  splitNoteKey?: string,       // split THIS note (the freshly-deposited amount), not the largest note
  // Per-leg slippage cap. This is the ONLY place it takes effect for a same-chain vault-output
  // strategy: those legs settle via Entrypoint.swapAndDeposit, whose minAmountOut is baked into the
  // proof HERE at arm time. The executor's own max_slippage_bps path (preflight_same_chain_swap) is
  // unreachable for that shape, so a hardcoded value here silently overrode the user's choice.
  maxSlippageBps: number = DEFAULT_LEG_SLIPPAGE_BPS,
  // Execution window the order asks for, in hours. Priced into the single arming transfer, so it
  // must be the SAME number the caller sends as execution_window_sec or the executor will read a
  // different tier than the user paid for.
  windowHours: number = 0,
): Promise<MultiLegResult> {
  const scheduleAnchor = Math.floor(Date.now() / 1000);
  const executor = getZkWithdrawRecipient(chainId); // proofs withdraw to the executor wallet
  const signer = getSigner() ?? undefined;

  const { armingCollectedWei, armingTxHash } = await collectArmingFee(chainId, windowHours);

  // 1. Split one deposit note into N slice notes (private, on-chain). splitNoteKey pins the split to
  // the note the caller just deposited for this order (its value == the user-requested amount), so
  // each slice is amount/N — NOT a divide of whatever the largest pre-existing note happens to be.
  const split = await generateSplitProof(chainId, inToken, sliceCount, splitNoteKey);
  if ("error" in split) throw new Error(`split proof failed: ${split.error}`);
  const { txHash: splitTxHash, sliceNoteKeys } = await submitSplit(split);
  if (sliceNoteKeys.length < sliceCount) {
    throw new Error(`split produced ${sliceNoteKeys.length} slice notes, need ${sliceCount}`);
  }
  const userSlices = split.slices;

  // 2+3+4. Per slice: atomic swap proof (slice → dst vault) + output vault note + encrypted trigger.
  const { fetchCoinPrices } = await import("../components/navs/Discover/price_utils");
  const ethUsd = Number((await fetchCoinPrices()).ETH ?? 0) || 0;
  const legs: BuiltLeg[] = [];
  for (let i = 0; i < sliceCount; i++) {
    const sliceNoteKey = sliceNoteKeys[i];
    const slice = userSlices[i];
    const sliceAmountHuman = ethers.formatUnits(slice.amountWei, inToken.decimals);

    const { armSameChainVaultSwap } = await import("./atomicVaultSwap");
    const armed = await armSameChainVaultSwap({
      chainId,
      inToken,
      outToken,
      amountHuman: sliceAmountHuman,
      noteKey: sliceNoteKey,
      ethUsdPrice: ethUsd,
      maxSlippageBps,
    });
    if ("error" in armed) throw new Error(`leg ${i} swap proof failed: ${armed.error}`);

    // Persist swap change remainder (usually 0 for exact slice spends) so it isn't stranded.
    const chg = armed.swapProof.change;
    const chgWei = BigInt(chg.amountWei || "0");
    if (chgWei > 0n && signer) {
      const chgKey = noteKey(chainId, inToken.symbol, chg.commitment);
      await writeNote(chgKey, {
        nullifier: chg.nullifier,
        secret: chg.secret,
        commitment: chg.commitment,
        precommitment: chg.precommitment,
        nullifierHash: "",
        amount: ethers.formatUnits(chgWei, inToken.decimals),
        spent: false,
      }, signer);
    }

    const bound = await encryptLeg(i, sliceAmountHuman);
    legs.push({
      leg_index: i,
      amount: parseFloat(sliceAmountHuman),
      ...bound,
      output_precommitment: armed.outputPrecommitment,
      zk_proof: proofToLegProof(armed.zkpData),
    });
  }

  return {
    legs, splitTxHash, scheduleAnchor,
    armingFeeWei: armingCollectedWei.toString(),
    armingTxHash,
  };
}

/**
 * TWAP: N equal slices, each firing at anchor + k*interval (encrypted fire-time, FHE-gated).
 * `clientKeyHex` is the user's FHE client key (used to encrypt each fire-time).
 */
// The split circuit has a FIXED 8 output slots (zero-padded); see SPLIT_N in zkHandler. A TWAP/grid
// count outside 2..8 can never produce a valid split, so reject it BEFORE any funds move.
const SPLIT_MAX_SLICES = 8;

/**
 * Fund a TWAP/Grid split and return the canonical note key of ONE note holding EXACTLY `amountStr`,
 * so generateSplitProof splits that note (each slice = amount/N) — NOT whatever the largest
 * pre-existing note happens to be (the "0.002 into 3 became 0.000111" bug). Reuses an existing
 * unspent exact-amount vault note if one exists (idempotent on retry, uses vault funds); otherwise
 * deposits the amount fresh from the wallet. BOTH multi-leg callers (Discover RUN modal + Builder
 * canvas) MUST route through here so neither silently ignores the amount.
 *
 * Order of safety:
 *  - Validate the slice count (2..8) BEFORE depositing — an invalid config never moves funds.
 *  - deposit() deposits on the app's SELECTED chain (currentChainId()); callers must already be on
 *    `chainId` (DetailsModal via selectChainAndSwitchWallet; Build.tsx CHAIN_ID === getSelectedChainId()).
 *  - After the deposit, wait (bounded) until the fresh leaf is visible to the split's leaf scan. The
 *    split reads through a read-provider that can lag the wallet node by a block, which would otherwise
 *    surface as a spurious "No spendable note found to split". If it never appears we still return the
 *    key and let the split error clearly — the deposit is a normal, recoverable vault note, never stranded.
 */
export async function depositForSplit(
  chainId: number,
  token: TokenInfo,
  amountStr: string,
  sliceCount: number,
  log?: (m: string) => void,
): Promise<string> {
  requireV2StrategyPath(chainId);
  if (!Number.isInteger(sliceCount) || sliceCount < 2 || sliceCount > SPLIT_MAX_SLICES) {
    throw new Error(`slice/grid count must be a whole number 2..${SPLIT_MAX_SLICES}`);
  }
  const tokenAddress = token.symbol === "ETH" ? NATIVE_TOKEN : token.address;

  // Reuse an existing UNSPENT, on-chain note of EXACTLY this amount before depositing fresh — so a
  // retry (or a vault already holding the amount) doesn't pile a NEW wallet deposit into the vault on
  // every order. Exact-amount match keeps each slice = amount/N (the reused note IS the amount); a
  // larger note is never reused because generateSplitProof splits the WHOLE note.
  const signer = getSigner();
  if (signer) {
    try {
      const amountWei = ethers.parseUnits(amountStr, token.decimals);
      const onChain = new Set((await getOnChainLeaves(tokenAddress, chainId)).map((l) => l.toString()));
      const { scanNotes, readNote } = await import("./localNoteStore");
      for (const meta of scanNotes(chainId, token.symbol)) {
        if (meta.spent === "true") continue;
        if (!onChain.has(BigInt(meta.commitment).toString())) continue;
        if (ethers.parseUnits(meta.amount, token.decimals) !== amountWei) continue;
        if (!(await readNote(meta.key, signer))) continue; // must be spendable (secret present)
        log?.(`Reusing an existing ${amountStr} ${token.symbol} vault note — no new deposit`);
        return meta.key;
      }
    } catch { /* fall through to a fresh deposit */ }
  }

  log?.(`Depositing ${amountStr} ${token.symbol} to split into ${sliceCount}…`);
  const { deposit } = await import("./handler");
  const dep = await deposit(token.symbol, amountStr);
  if (!dep.success || !dep.noteKey) throw new Error(dep.error || "deposit for split failed");

  // Wait for the fresh leaf to be visible to generateSplitProof's leaf scan (read-provider lag).
  const { parseNoteKey } = await import("./localNoteStore");
  const commitment = parseNoteKey(dep.noteKey)?.commitment;
  if (commitment) {
    const target = BigInt(commitment);
    for (let i = 0; i < 8; i++) {
      invalidateLeafCache(tokenAddress);
      const leaves = await getOnChainLeaves(tokenAddress, chainId);
      if (leaves.some((l) => l === target)) { log?.("Deposit confirmed — splitting that note…"); return dep.noteKey; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    log?.("Deposit made; leaf not yet visible — attempting split (retry if it errors)…");
  }
  return dep.noteKey;
}

/** TWAP trigger encryption, factored out so the v3 orchestrator can reuse it verbatim.
 *
 *  Shared rather than reimplemented on purpose: the fire-time is encoded RELATIVE to the schedule
 *  anchor (k*intervalSec), because the scheduler compares against elapsed-since-anchor and an
 *  absolute unix time (~1.7e9) exceeds the FHE integer width. A v3 copy that drifted from this
 *  would encrypt bounds the engine cannot compare, and the only symptom is a leg that never fires.
 */
export function twapEncryptLeg(intervalSec: number, clientKeyHex: string) {
  return async (i: number) => ({
    eval_mode: "time" as const,
    encrypted_lower_bound: await encryptPriceCents(BigInt(i * intervalSec), clientKeyHex),
  });
}

/** Grid trigger encryption, factored out for the v3 orchestrator. Same rung/side derivation as
 *  buildGridLegs — a single direction, funded by its own asset_in slice. */
export function gridEncryptLeg(low: number, high: number, levels: number, inSymbol: string, clientKeyHex: string) {
  const STABLES = new Set(["USDC", "USDT", "DAI"]);
  const gridSide = STABLES.has(inSymbol.toUpperCase()) ? ("LIMIT_BUY" as const) : ("LIMIT_SELL" as const);
  const rungs = computeRangeGridLegs(low, high, levels, gridSide);
  return async (i: number) => {
    const rung = rungs[i];
    const encBound = await encryptPrice(rung.price, clientKeyHex);
    return rung.legType === "LIMIT_BUY"
      ? { eval_mode: "price" as const, side: "LIMIT_BUY" as const, encrypted_lower_bound: encBound }
      : { eval_mode: "price" as const, side: "LIMIT_SELL" as const, encrypted_upper_bound: encBound };
  };
}

export async function buildTwapLegs(opts: {
  chainId: number;
  inToken: TokenInfo;
  outToken: TokenInfo;
  sliceCount: number;
  intervalSec: number;
  clientKeyHex: string;
  submitSplit: (split: SplitProofData) => Promise<{ txHash: string; sliceNoteKeys: string[] }>;
  splitNoteKey?: string;   // the freshly-deposited note to split (its value == the requested amount)
  maxSlippageBps?: number; // per-leg cap; baked into each leg's minAmountOut at arm time
  windowHours?: number;    // execution window in hours; priced into the arming transfer
}): Promise<MultiLegResult> {
  const { chainId, inToken, outToken, sliceCount, intervalSec, clientKeyHex, submitSplit, splitNoteKey } = opts;
  const anchor = Math.floor(Date.now() / 1000);
  const encryptLeg = twapEncryptLeg(intervalSec, clientKeyHex);
  const res = await buildLegsFromSplit(
    chainId, inToken, outToken, sliceCount, encryptLeg, submitSplit, splitNoteKey,
    clampSlippageBps(opts.maxSlippageBps), opts.windowHours ?? 0,
  );
  return { ...res, scheduleAnchor: anchor };
}

/**
 * Grid: N rungs across [low, high]; even rungs buy (fire on price ≤ rung), odd rungs sell
 * (fire on price ≥ rung). Each rung gets an encrypted price band keyed by its side.
 */
export async function buildGridLegs(opts: {
  chainId: number;
  inToken: TokenInfo;
  outToken: TokenInfo;
  low: number;
  high: number;
  levels: number;
  clientKeyHex: string;
  submitSplit: (split: SplitProofData) => Promise<{ txHash: string; sliceNoteKeys: string[] }>;
  splitNoteKey?: string;   // the freshly-deposited note to split (its value == the requested amount)
  maxSlippageBps?: number; // per-leg cap; baked into each rung's minAmountOut at arm time
  windowHours?: number;    // execution window in hours; priced into the arming transfer
}): Promise<MultiLegResult> {
  const { chainId, inToken, outToken, low, high, levels, clientKeyHex, submitSplit, splitNoteKey } = opts;
  // Coherent single direction (see computeRangeGridLegs): paying with a stablecoin buys the base
  // asset (fire when price <= rung, LIMIT_BUY); paying with the base asset sells it (fire when price
  // >= rung, LIMIT_SELL). Every rung is the same side, so none swaps backwards and each is funded by
  // its own asset_in slice. (True bidirectional grid would need dual-asset funding — separate feature.)
  const encryptLeg = gridEncryptLeg(low, high, levels, inToken.symbol, clientKeyHex);
  return buildLegsFromSplit(
    chainId, inToken, outToken, levels, encryptLeg, submitSplit, splitNoteKey,
    clampSlippageBps(opts.maxSlippageBps), opts.windowHours ?? 0,
  );
}
