/**
 * v3 multi-leg orchestration — a DROP-IN for the buildTwapLegs/buildGridLegs result at the
 * DetailsModal / Build callsites, mirroring `v4/strategyOrchestrate`.
 *
 * Wiring at the callsite:
 *
 *   const multi = v3StrategiesLive(chainId)
 *     ? await buildV3Multi({ kind, chainId, inToken, outToken, amountStr, sliceCount, ... })
 *     : (isTimeMultiLeg ? await buildTwapLegs(...) : await buildGridLegs(...));
 *
 * Returns the same {legs, splitTxHash, scheduleAnchor, armingFeeWei, armingTxHash} shape, so the
 * /createStrategy payload is unchanged — only the builder differs. The legs carry no `zk_proof`,
 * which is what routes them through the executor's attested path at fire time.
 *
 * Why a separate orchestrator rather than a flag on the v2 one: the two differ at every step. v2
 * deposits through `handler.deposit` into the v1 Entrypoint, tracks notes in `localNoteStore`, and
 * splits with `generateSplitProof`. v3 deposits into the VaultKernel, tracks notes in
 * `noteStoreV3`, and splits with `splitV3`. Sharing the function would have meant a v3 split
 * against a v2 note — the exact mistake `strategyGuard` exists to prevent.
 */
import { ethers } from "ethers";
import type { Signer } from "ethers";

import {
  buildV3StrategyLegs,
  type V3LegBuildResult,
} from "./buildV3StrategyLegs";
import { busEtaText, nextBusAtMs } from "./aspBusV3";
import { mergeNotesV3 } from "./mergeNotesV3";
import { v3ArmStrategyId, v3Config, v3Deployed } from "./configV3";
import { depositV3 } from "./depositV3";
import { loadV3Notes } from "./noteStoreV3";
import { ARM_LOCK_MS, lockNote, noteLockHolder, unlockNote } from "./noteLockV3";
import { noteAssetAddress } from "./noteCryptoV3";
import { fetchStateLeaves } from "./stateLeavesClient";
import { checkAdmitted, waitForSpendablePath } from "./aspClientV3";
import type { SpendNote, SubmitHook } from "./spendActionsV3";
import { selectMergeInputs } from "./selectMergeInputs";

/** True when this chain can actually run a v3 strategy end to end. */
export function v3StrategiesLive(chainId: number): boolean {
  const cfg = v3Config(chainId);
  return v3Deployed(chainId) && !!cfg?.executorUrl && !!cfg?.aspUrl;
}

export interface BuildV3MultiParams {
  chainId: number;
  signer: Signer;
  screenToken: string;
  inToken: { address: string; symbol: string; decimals: number };
  outToken: { address: string; symbol: string; decimals: number };
  amountStr: string;
  sliceCount: number;
  windowHours?: number;
  swap: {
    pool: bigint;
    dstToken: bigint;
    fee: bigint;
    minOutFor: (sliceAmountHuman: string) => bigint;
  };
  encryptLeg: (legIndex: number, sliceAmountHuman: string) => Promise<{
    encrypted_upper_bound?: string;
    encrypted_lower_bound?: string;
    side?: "LIMIT_BUY" | "LIMIT_SELL";
    eval_mode?: "price" | "time";
  }>;
  submit: SubmitHook;
  log?: (m: string) => void;
}

/**
 * Get a v3 note that COVERS `amountWei`, depositing one only if the vault balance cannot.
 *
 * Shared by the multi-leg and single-leg builders so both fund the same way. A spend consumes the
 * WHOLE note, so a note larger than the order has to produce change — both callers do that as part
 * of a split they were already going to run (`splitNoteV3`), which is why this can hand back an
 * oversized note instead of insisting on an exact match.
 *
 * That exact-match rule is what made every order deposit fresh: reuse only fired if the user
 * happened to place the identical amount twice, so a wallet holding 0.010 ETH still deposited again
 * to fund a 0.001 order. Each such deposit costs a transaction AND a wait on the ~5 minute admit
 * bus before the note can be spent. Spending an existing note skips both — change inherits the
 * parent's label, so it is admitted the instant it exists.
 *
 * Smallest-covering, so the big note stays whole for a big order rather than being shaved down.
 *
 * Every note it commits to is locked against ragequit (noteLockV3) and pushed onto `locks`, so the
 * caller's withArmLocks can hand them back if the arm fails.
 */
async function acquireV3Note(
  p: Pick<BuildV3MultiParams, "chainId" | "signer" | "inToken" | "amountStr" | "log" | "screenToken" | "submit">,
  purpose: string,
  locks: string[],
): Promise<SpendNote> {
  const amountWei = ethers.parseUnits(p.amountStr, p.inToken.decimals);
  const symbol = p.inToken.symbol.toUpperCase();
  const cfg = v3Config(p.chainId);

  // Logged because loadV3Notes reconciles every note against the on-chain nullifier set, which is
  // an eth_call per note through the wallet's provider. It is the last silent stretch before the
  // first real progress line, so a slow provider used to read as a hung modal.
  p.log?.(`Reading your ${symbol} vault notes…`);
  const loaded = await loadV3Notes(p.chainId, p.signer, symbol);
  // A note mid-ragequit is leaving the vault, and one another arm holds is already promised — an
  // exact-size limit order keeps its note unspent until it fires.
  const all = loaded.filter((n) => !noteLockHolder(n.commitment));
  if (all.length < loaded.length) {
    p.log?.(`Skipping ${loaded.length - all.length} ${symbol} note(s) held by a ragequit or another strategy…`);
  }
  const lock = (c: string) => {
    lockNote(c, "arm", ARM_LOCK_MS);
    locks.push(c);
  };
  const covering = all
    .filter((n) => n.value >= amountWei)
    .sort((a, b) => (a.value === b.value ? 0 : a.value < b.value ? -1 : 1));

  // Admission is asked once per note and reused by both the single-note loop and the merge
  // fallback: /set/member is IP rate limited, and asking twice per note turned a 3-note wallet
  // into six lookups on every arm.
  const admittedCache = new Map<string, boolean>();
  const isAdmitted = async (n: SpendNote): Promise<boolean> => {
    if (!cfg?.aspUrl) return true;
    const hit = admittedCache.get(n.commitment);
    if (hit !== undefined) return hit;
    const admitted = await checkAdmitted(cfg.aspUrl, p.screenToken, n.label, p.chainId);
    // `null` means the ASP is unreachable. Treat as usable rather than forcing a needless deposit;
    // the spend fails loudly if it really is not admitted.
    const ok = admitted !== false;
    admittedCache.set(n.commitment, ok);
    return ok;
  };

  for (const n of covering) {
    // Covering the amount is not enough — the note must be ADMITTED. A spend proves an
    // `admittedPath`, so an unadmitted note gets a bare 404 from /set/path deep inside the split,
    // AFTER the arming fee is charged. Notes predating a working ASP watcher sit in the store
    // looking perfectly spendable, which is exactly how this bit.
    if (!(await isAdmitted(n))) {
      p.log?.(`Skipping a ${symbol} note that the compliance set has not admitted…`);
      continue;
    }
    p.log?.(
      n.value === amountWei
        ? `Using an existing ${p.amountStr} ${symbol} vault note — no new deposit`
        : `Funding from your ${ethers.formatUnits(n.value, p.inToken.decimals)} ${symbol} vault ` +
          `balance — no new deposit`,
    );
    lock(n.commitment);
    return gateOnSpendablePath(p, n);
  }

  // No SINGLE note covers the order — but the vault balance still might, spread across several.
  // Before this, that case fell straight through to a fresh deposit: a wallet holding 2 + 1 + 0.5
  // USDC was told "not enough balance" on a 3.5 order, because the deposit it silently tried to
  // make needed 3.5 more from the wallet. The balance on screen and the balance you could trade
  // disagreed, and the money was not spendable by any amount the user could name above 2.0.
  //
  // MERGE consolidates 2..6 notes into one (merge2..merge6 + SpendMergeVerifier2..6 are deployed),
  // and the output inherits the boundary label, so it is admitted immediately — no second wait on
  // the admit bus. Largest-first so the fewest possible notes are consumed: fewer inputs is a
  // smaller circuit, a cheaper proof, and it leaves the small notes intact for small orders.
  // Admission is resolved before selecting rather than during: selection is then a pure function
  // that can be tested. The extra cost is bounded and small — loadV3Notes already spends an
  // eth_call per note, and isAdmitted memoises, so the single-note loop above has usually paid for
  // most of these already.
  const admittedNotes: SpendNote[] = [];
  for (const n of all) {
    if (n.value <= 0n) continue;
    if (await isAdmitted(n)) admittedNotes.push(n);
  }
  const picked = selectMergeInputs(admittedNotes, amountWei);
  if (picked) {
    const pickedSum = picked.reduce((acc, n) => acc + n.value, 0n);
    p.log?.(
      `Combining ${picked.length} ${symbol} notes into one ` +
        `(${ethers.formatUnits(pickedSum, p.inToken.decimals)} ${symbol}) — no new deposit…`,
    );
    picked.forEach((n) => lock(n.commitment));
    const merged = await mergeNotesV3({
      chainId: p.chainId,
      signer: p.signer,
      screenToken: p.screenToken,
      notes: picked,
      symbol,
      submit: p.submit,
    });
    lock(merged.note.commitment);
    return gateOnSpendablePath(p, merged.note);
  }

  // The admitted notes fall short — but if notes still waiting for the ASP bus make up the
  // difference, the money is not missing, it is minutes away. Depositing again from the wallet
  // here double-funds the order, and that deposit would have to wait for the same bus anyway.
  // This runs before any split or arming fee, so stopping costs the user nothing.
  let inReview = 0n;
  for (const n of all) if (n.value > 0n && !(await isAdmitted(n))) inReview += n.value;
  const admittedTotal = admittedNotes.reduce((acc, n) => acc + n.value, 0n);
  if (inReview > 0n && admittedTotal + inReview >= amountWei) {
    throw new Error(
      `${ethers.formatUnits(inReview, p.inToken.decimals)} ${symbol} of your vault balance is still in ` +
        `compliance review — ${busEtaText(await nextBusAtMs(p.chainId))}. Arm this once it is admitted; ` +
        `nothing was charged.`,
    );
  }

  p.log?.(`Depositing ${p.amountStr} ${symbol} ${purpose}…`);
  const dep = await depositV3({
    chainId: p.chainId,
    token: p.inToken.address,
    amount: amountWei,
    signer: p.signer,
  });

  // Wait for the leaf to be visible before spending it — the arming path derives its state path
  // from the leaf set, and a path built against a tree that does not yet contain the note can
  // never prove. Failing here costs a retry; failing at fire time costs the arming fee.
  const target = BigInt(dep.noteCommitment);
  let seen = false;
  for (let i = 0; i < 8 && !seen; i++) {
    const leaves = await fetchStateLeaves(p.chainId);
    seen = !!leaves.data?.leaves.some((l) => l === target);
    if (!seen) await new Promise((r) => setTimeout(r, 1500));
  }
  p.log?.(seen
    ? "Deposit confirmed."
    : "Deposit made; leaf not yet visible — continuing (retry if it errors)…");

  const note = (await loadV3Notes(p.chainId, p.signer, symbol)).find(
    (n) => n.commitment === String(dep.noteCommitment),
  );
  if (!note) throw new Error("acquireV3Note: deposited note not found in the v3 note store");

  lock(note.commitment);
  return gateOnSpendablePath(p, note);
}

/**
 * Run an arm holding its note locks. A failed arm releases them so a ragequit works straight away;
 * a successful one keeps them until they expire, covering the deposit's ragequit window.
 */
async function withArmLocks<T>(run: (locks: string[]) => Promise<T>): Promise<T> {
  const locks: string[] = [];
  try {
    return await run(locks);
  } catch (e) {
    for (const c of locks) unlockNote(c, "arm");
    throw e;
  }
}

/**
 * Refuse to hand back a note whose admitted path cannot be fetched yet.
 *
 * This is the last gate before the caller charges the arming fee, and it covers BOTH ways a note
 * arrives — a fresh deposit waiting on the admit bus, and a reused note caught in the ~1 minute
 * window where the bus is admitted but its root is not yet published on-chain. Both surfaced as
 * hard errors from deep inside the split, after the money had already moved.
 */
async function gateOnSpendablePath(
  p: Pick<BuildV3MultiParams, "chainId" | "screenToken" | "log">,
  note: SpendNote,
): Promise<SpendNote> {
  const cfg = v3Config(p.chainId);
  if (!cfg?.aspUrl) return note;

  p.log?.("Checking the compliance set can prove this note…");
  const res = await waitForSpendablePath(cfg.aspUrl, p.screenToken, note.label, {
    chainId: p.chainId,
    onWait: (s) => p.log?.(`Waiting on the compliance set — ${s}s elapsed…`),
  });
  if (res.ok) return note;

  const why =
    res.reason === "not_member"
      ? "it has not been admitted to the compliance set yet — admission runs on a ~5 minute batch"
      : res.reason === "publish_pending"
        ? "the compliance set is mid-publish — this clears within a minute or two"
        : "the compliance service could not be reached";
  throw new Error(`This note cannot be spent yet: ${why}. Try again shortly — no arming fee was charged.`);
}

export async function buildV3Multi(p: BuildV3MultiParams): Promise<V3LegBuildResult> {
  const cfg = v3Config(p.chainId);
  if (!cfg) throw new Error(`buildV3Multi: v3 is not configured for chain ${p.chainId}`);

  return withArmLocks(async (locks) => {
    const symbol = p.inToken.symbol.toUpperCase();
    const note = await acquireV3Note(p, `to split into ${p.sliceCount}`, locks);

    // No progress line here: buildV3StrategyLegs announces each step as it reaches it. Announcing
    // "splitting" up front described the LAST step of three and hid the wallet confirmation.
    return buildV3StrategyLegs({
      chainId: p.chainId,
      signer: p.signer,
      screenToken: p.screenToken,
      log: p.log,
      note,
      // The note may hold more than the order: the leftover comes back as a change slice in the same
      // split, so funding from the vault balance costs no extra transaction.
      spendValue: ethers.parseUnits(p.amountStr, p.inToken.decimals),
      sliceCount: p.sliceCount,
      inSymbol: symbol,
      outSymbol: p.outToken.symbol,
      inDecimals: p.inToken.decimals,
      windowHours: p.windowHours,
      swap: p.swap,
      encryptLeg: p.encryptLeg,
      submit: p.submit,
    });
  });
}

/**
 * Resolve the pool + pricing a v3 strategy leg needs, reusing the v2 helpers.
 *
 * `resolveSwapPool` and `estimateMinOutWei` are shared with the v2 builder deliberately: minAmountOut
 * is the ONLY slippage bound on a vault-output leg (the executor's preflight path is unreachable for
 * that shape), so a second implementation here would be a second, silently different bound.
 */
export async function v3SwapParams(
  chainId: number,
  inToken: { address: string; symbol: string; decimals: number },
  outToken: { address: string; symbol: string; decimals: number },
  slippageBps: number,
): Promise<BuildV3MultiParams["swap"]> {
  const { resolveSwapPool } = await import("../multiLegBuilder");
  const { estimateMinOutWei } = await import("../atomicVaultSwap");
  const { fetchCoinPrices } = await import("../../components/navs/Discover/price_utils");

  const { pool, fee } = await resolveSwapPool(chainId, inToken.address, outToken.address);
  // ETH/USDC pairs price through the live ETH quote; estimateMinOutWei errors without it rather
  // than silently pricing at zero, which would set minAmountOut to dust and accept any fill.
  const ethUsd = Number((await fetchCoinPrices()).ETH ?? 0) || 0;

  return {
    pool: BigInt(pool),
    // Through noteAssetAddress, NOT the raw address. For native ETH `outToken.address` is the
    // 0xEeee… sentinel, which is not a token: the kernel checks the swap's destination against
    // its allowlist (`_requireAllowedAsset(pi[18])`) and allows WETH but never the sentinel, so
    // every USDC->ETH order proved correctly and then reverted on-chain with TokenNotAllowed()
    // after the user had paid the arming fee.
    //
    // resolveSwapPool two lines above already maps the sentinel to WETH to find the pool — this
    // was the same mapping missing at the other end of the same object.
    //
    // It also fixes a latent stranding bug: this value becomes the OUTPUT note's assetId, and a
    // note whose asset is the sentinel can never be spent, because withdrawal casts the assetId
    // back to a token address and that one holds no balance. See depositV3: "the note must name
    // a real ERC-20 or it would be unspendable".
    dstToken: BigInt(noteAssetAddress(chainId, outToken.address)),
    fee: BigInt(fee),
    minOutFor: (sliceAmountHuman: string) => {
      const { minOut, error } = estimateMinOutWei(
        sliceAmountHuman,
        inToken as never,
        outToken as never,
        ethUsd,
        slippageBps,
        0, // fill fee is applied on-chain by the kernel, not folded into the client's bound
      );
      if (error) throw new Error(`v3SwapParams: cannot price minAmountOut — ${error}`);
      return minOut;
    },
  };
}

/** What a single-leg (Limit Order) v3 arming returns to the callsite. */
export interface V3SingleBuildResult {
  /** Goes on the strategy row so the executor can check the proceeds will be resolvable. */
  outputPrecommitment: string;
  /** ASP association label of the spent note — the payload's `note_label`, which createStrategy
   *  requires and then drops (it is never stored on Strategy). */
  noteLabel: string;
  /** The id the enclave keys this leg by — goes on the payload as `arm_strategy_id`. */
  armStrategyId: string;
  /** The anchor baked into `armStrategyId`. The payload MUST carry this exact value, not a
   *  freshly taken `Date.now()`: the two differ by however long the arm took. */
  scheduleAnchor: number;
}

/** Deliberately does NOT collect the arming fee, unlike buildV3Multi: the single-leg callsite
 *  charges it after the arm is certain to be submitted, so a failed arm costs the user nothing.
 *  Charging here as well would bill twice. */

/**
 * Arm a SINGLE-leg v3 strategy (Limit Order): acquire the note, seal it to the enclave as leg 0.
 *
 * The v3 counterpart of `atomicVaultSwap.armSameChainVaultSwap`. That function builds a finished
 * Groth16 proof against the v1 Entrypoint's tree — on a v3 chain its root is one the kernel has
 * never seen, so the spend could only fail with UnknownStateRoot after paying gas.
 *
 * Deliberately does NOT go through buildV3StrategyLegs with sliceCount=1: that would submit a
 * SPLIT transaction to carve one note into one note, costing the user a proof and gas for nothing,
 * and adding a failure mode between the deposit and the arm.
 *
 * Leg index 0 is not arbitrary — the enclave keys armed legs by (strategyId, legIndex), and the
 * executor proves a single strategy as leg 0 (executor_runner.run_execution).
 */
export async function buildV3Single(
  p: Omit<BuildV3MultiParams, "sliceCount" | "encryptLeg" | "swap"> & {
    windowHours?: number;
    /** Payout order: arm a WITHDRAW of the order note to this address (the executor's bridge
     *  payee, from /bridgeQuote) instead of a swap. The executor bridges it when it fires. */
    payee?: string;
    /** Required unless `payee` is set. */
    swap?: BuildV3MultiParams["swap"];
  },
): Promise<V3SingleBuildResult> {
  const cfg = v3Config(p.chainId);
  if (!cfg) throw new Error(`buildV3Single: v3 is not configured for chain ${p.chainId}`);
  if (!p.payee && !p.swap) throw new Error("buildV3Single: a swap order needs swap params");

  const { armV3StrategyLeg } = await import("./armStrategyLegV3");

  return withArmLocks(async (locks) => {
    const amountWei = ethers.parseUnits(p.amountStr, p.inToken.decimals);
    const acquired = await acquireV3Note(p, "to arm this order", locks);

    // Carve the order out of a larger vault note. This is the one case where a single-leg strategy
    // pays for a split, and it is still the cheaper path: the alternative is a fresh deposit, which
    // costs a transaction too AND blocks on the ~5 minute admit bus before it can be armed.
    //
    // NOT done by passing `change` to the swap: that change note is minted at FIRE time, so the
    // user's leftover would sit locked inside an unfired limit order — possibly forever. Splitting
    // now hands it back immediately as a spendable note under the already-admitted parent label.
    let note = acquired;
    if (acquired.value > amountWei) {
      const { splitNoteV3 } = await import("./buildV3StrategyLegs");
      p.log?.("Carving this order out of your vault balance — this takes a moment…");
      const split = await splitNoteV3({
        chainId: p.chainId,
        signer: p.signer,
        screenToken: p.screenToken,
        note: acquired,
        values: [amountWei, acquired.value - amountWei],
        symbol: p.inToken.symbol,
        submit: p.submit,
      });
      note = split.notes[0];
    }

    const scheduleAnchor = Math.floor(Date.now() / 1000);
    const armStrategyId = v3ArmStrategyId(cfg.vaultKernel, scheduleAnchor);

    p.log?.("Sealing the order to the enclave…");
    const armed = await armV3StrategyLeg({
      chainId: p.chainId,
      strategyId: armStrategyId,
      legIndex: 0,
      signer: p.signer,
      note: {
        nullifier: note.nullifier,
        secret: note.secret,
        label: note.label,
        assetId: note.assetId,
        commitment: note.commitment,
        value: note.value.toString(),
        spent: "false",
      },
      outSymbol: p.outToken.symbol,
      screenToken: p.screenToken,
      payee: p.payee,
      swap: p.payee || !p.swap
        ? { amountIn: note.value, change: 0n, pool: 0n, dstToken: 0n, fee: 0n, minAmountOut: 0n }
        : {
            amountIn: note.value,
            // Always 0: `note` is exactly the order size, either as acquired or after the split
            // above. Any leftover was already handed back as its own note rather than minted here.
            change: 0n,
            pool: p.swap.pool,
            dstToken: p.swap.dstToken,
            fee: p.swap.fee,
            minAmountOut: p.swap.minOutFor(ethers.formatUnits(note.value, p.inToken.decimals)),
          },
    });

    return {
      outputPrecommitment: armed.output_precommitment,
      noteLabel: note.label,
      armStrategyId,
      scheduleAnchor,
    };
  });
}
