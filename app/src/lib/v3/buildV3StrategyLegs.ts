/**
 * Build the legs of a v3 TWAP/Grid strategy: split one note into slices, then arm each slice.
 *
 * The v3 twin of `multiLegBuilder.buildLegsFromSplit`. It is a separate function rather than a
 * branch inside that one because the two differ at every step, not just at the end: v2 splits via
 * `generateSplitProof` into v2 note keys and arms each slice by building a Groth16 proof in the
 * browser; v3 splits via `splitV3` into v3 notes and arms each slice by SEALING its secrets to the
 * enclave, which proves at fire time. Branching inside the v2 function would have meant arming v3
 * legs against v2 notes — well-typed and completely wrong.
 *
 * The resulting legs deliberately carry NO `zk_proof`. That absence is what the executor uses to
 * route them through the attested path (`executor_runner._execute_attested_leg`): every other leg
 * shape requires a proof and fails immediately without one, so it is an unambiguous discriminator
 * and needs no schema change.
 */
import { ethers } from "ethers";
import type { Signer } from "ethers";

import { armV3StrategyLeg } from "./armStrategyLegV3";
import { requireV3, requireStrategySupport, v3ArmStrategyId } from "./configV3";
import { collectArmingFee } from "../multiLegBuilder";
import { splitV3, type SubmitHook } from "./spendActionsV3";
import type { SpendNote } from "./spendActionsV3";
import { hashCommitmentWithPre, hashPrecommitment, randomUserSalt } from "./noteCryptoV3";
import { markV3NoteSpent, saveV3Note } from "./noteStoreV3";

/** SPLIT is fixed-width: 8 slots, inactive ones zeroed. */
const SPLIT_OUTPUTS = 8;

/** Same shape v4/strategyOrchestrate returns, so this is a drop-in at the DetailsModal / Build
 *  callsites and the /createStrategy payload is unchanged — only the builder differs. */
export interface V3LegBuildResult {
  legs: Array<{
    leg_index: number;
    amount: number;
    output_precommitment: string;
    // No zk_proof — see the header.
    encrypted_upper_bound?: string;
    encrypted_lower_bound?: string;
    side?: "LIMIT_BUY" | "LIMIT_SELL";
    eval_mode: "price" | "time";
  }>;
  splitTxHash: string;
  scheduleAnchor: number;
  /** The id the enclave keys these legs by — goes on the payload as `arm_strategy_id`. */
  armStrategyId: string;
  /** ASP association label of the note these legs spend — the payload's `note_label`.
   *  createStrategy REQUIRES it (ASP_REQUIRE_NOTE_LABEL) and then drops it; it is never stored.
   *  The v2 path satisfied the check incidentally, because strategySubmit lifts the label out of
   *  a leg's `zk_proof` — and a v3 leg has no proof at all. */
  noteLabel: string;
  armingFeeWei: string;
  armingTxHash: string;
}

export interface BuildV3LegsParams {
  chainId: number;
  signer: Signer;
  screenToken: string;
  /** Progress for the UI. Each step here either asks the wallet to sign or runs for tens of
   *  seconds, so a caller that announces only the last one leaves the user staring at a stalled
   *  modal while a wallet popup waits behind it. */
  log?: (message: string) => void;
  /** The note to carve up. Its value is divided evenly across `sliceCount`. */
  note: SpendNote;
  /** How much of `note` this strategy spends. Defaults to the whole note; anything left over comes
   *  back as a change slice in the SAME split, so funding a strategy from a larger vault note costs
   *  no extra transaction and no second admission wait. */
  spendValue?: bigint;
  sliceCount: number;
  inSymbol: string;
  outSymbol: string;
  inDecimals: number;
  /** Execution window in hours. MUST equal the execution_window_sec the caller sends, or the
   *  executor reads a different fee tier than the user paid for (same trap as the v2 builder). */
  windowHours?: number;
  /** Per-leg encrypted trigger, exactly as the v2 builder supplies it. */
  encryptLeg: (legIndex: number, sliceAmountHuman: string) => Promise<{
    encrypted_upper_bound?: string;
    encrypted_lower_bound?: string;
    side?: "LIMIT_BUY" | "LIMIT_SELL";
    eval_mode?: "price" | "time";
  }>;
  swap: {
    pool: bigint;
    dstToken: bigint;
    fee: bigint;
    /** Prices one slice's minAmountOut. Supplied by the caller so the v3 path reuses v2's
     *  `estimateMinOutWei` verbatim — a second pricing implementation would be a second, silently
     *  different slippage bound on the only place this shape enforces one. */
    minOutFor: (sliceAmountHuman: string) => bigint;
  };
  submit: SubmitHook;
}

/**
 * Split one note into `values`, persist every resulting note, and hand them back.
 *
 * Shared by the multi-leg builder (its slices, plus a change slice when the strategy spends less
 * than the note holds) and the single-leg builder (just `[amount, change]`). One function because
 * the saving is the part that must not be got wrong twice: a slice that is minted on-chain and not
 * written to the note store is money the user owns and the UI cannot see.
 *
 * `values` must sum to the note exactly — the circuit constrains Σ slices == input value, so a
 * dropped wei fails to prove rather than quietly vanishing. Checked here so the error names the
 * amounts instead of surfacing as an opaque constraint failure a minute into proving.
 */
export async function splitNoteV3(p: {
  chainId: number;
  signer: Signer;
  screenToken: string;
  note: SpendNote;
  values: bigint[];
  /** Uppercased symbol of the asset being split. Slices stay in the input asset. */
  symbol: string;
  submit: SubmitHook;
}): Promise<{ notes: SpendNote[]; txHash: string }> {
  if (p.values.length < 1 || p.values.length > SPLIT_OUTPUTS) {
    throw new Error(`splitNoteV3: need 1..${SPLIT_OUTPUTS} outputs, got ${p.values.length}`);
  }
  const sum = p.values.reduce((a, b) => a + b, 0n);
  if (sum !== p.note.value) {
    throw new Error(`splitNoteV3: outputs sum to ${sum} but the note holds ${p.note.value}`);
  }

  // Fresh secrets per active slice; inactive slots MUST be all-zero (actionPublicsV3.SplitParams).
  const active = p.values.map((value) => ({
    value,
    nullifier: randomUserSalt(),
    secret: randomUserSalt(),
  }));
  const slices = [
    ...active,
    ...Array.from({ length: SPLIT_OUTPUTS - active.length }, () => ({
      value: 0n,
      nullifier: 0n,
      secret: 0n,
    })),
  ];

  const split = await splitV3({
    chainId: p.chainId,
    note: p.note,
    slices,
    screenToken: p.screenToken,
    submit: p.submit,
  });
  if (!split.ok) throw new Error("splitNoteV3: split failed");

  // Retire the parent immediately. `loadV3Notes` does eventually notice — it checks each note
  // against the on-chain nullifier set — but that only helps once the split is mined AND read back.
  // Now that strategies fund from the vault balance this is the common path, not a rare one, so
  // two strategies armed back to back would otherwise both pick the same parent and the second
  // would fail with NullifierAlreadyUsed after paying its arming fee.
  await markV3NoteSpent(p.chainId, p.note.commitment, p.signer);

  const notes: SpendNote[] = [];
  for (let i = 0; i < active.length; i++) {
    const s = active[i];
    const pre = await hashPrecommitment(s.nullifier, s.secret);
    const commitment =
      split.splitCommitments?.[i] ??
      String(
        await hashCommitmentWithPre(s.value, BigInt(p.note.label), BigInt(p.note.assetId), pre),
      );
    await saveV3Note(
      p.chainId,
      {
        nullifier: s.nullifier.toString(),
        secret: s.secret.toString(),
        // Slices inherit the spent note's label (deriveSplitPublics binds outLabel = inLabel), so
        // they are admitted the moment they exist — no second trip through the ~5 min admit bus.
        label: p.note.label,
        assetId: p.note.assetId,
        symbol: p.symbol.toUpperCase(),
        commitment: String(commitment),
        value: s.value,
        precommitment: pre.toString(),
        origin: "change",
        spent: "false",
      },
      p.signer,
      // Slice notes are carved from an existing note and stay in the same asset, so they are a
      // 'change' commitment; CommitmentSource has no 'split' member.
      "change",
    );
    notes.push({
      commitment: String(commitment),
      value: s.value,
      label: p.note.label,
      assetId: p.note.assetId,
      nullifier: s.nullifier.toString(),
      secret: s.secret.toString(),
    });
  }

  return { notes, txHash: split.txHash ?? "" };
}


export async function buildV3StrategyLegs(p: BuildV3LegsParams): Promise<V3LegBuildResult> {
  requireStrategySupport(p.chainId);
  const cfg = requireV3(p.chainId);

  const spendValue = p.spendValue ?? p.note.value;
  const change = p.note.value - spendValue;
  if (spendValue <= 0n || change < 0n) {
    throw new Error(`buildV3StrategyLegs: cannot spend ${spendValue} of a ${p.note.value} note`);
  }
  // The change slice occupies one of the 8 output slots, so a strategy funded from a larger note
  // can carry one fewer leg. Caught here rather than as a slice-array overflow inside the prover.
  const maxSlices = SPLIT_OUTPUTS - (change > 0n ? 1 : 0);
  if (p.sliceCount < 1 || p.sliceCount > maxSlices) {
    throw new Error(`buildV3StrategyLegs: sliceCount must be 1..${maxSlices}, got ${p.sliceCount}`);
  }

  // Even slices, with the remainder pushed onto the FIRST slice so the slices sum to exactly
  // `spendValue` and the whole split sums to exactly the note.
  const per = spendValue / BigInt(p.sliceCount);
  const remainder = spendValue - per * BigInt(p.sliceCount);
  const sliceValues = Array.from({ length: p.sliceCount }, (_, i) =>
    i === 0 ? per + remainder : per,
  );

  const scheduleAnchor = Math.floor(Date.now() / 1000);
  const armStrategyId = v3ArmStrategyId(cfg.vaultKernel, scheduleAnchor);

  // Charged once for the whole strategy, before anything is split or armed — same order as v2, so
  // a user who abandons partway has paid for nothing that exists. It is a real USDC transfer, so
  // it needs a wallet confirmation: say so, or the modal reads as hung.
  p.log?.("Confirm the arming fee in your wallet…");
  const { armingCollectedWei, armingTxHash } = await collectArmingFee(p.chainId, p.windowHours ?? 0);

  p.log?.(
    change > 0n
      ? `Proving the split into ${p.sliceCount} slices plus change — this takes a moment…`
      : `Proving the split into ${p.sliceCount} slices — this takes a moment…`,
  );
  // Change rides in the SAME split as the slices, so funding from a larger vault note costs no
  // extra transaction. splitNoteV3 persists every output before returning — if arming dies halfway
  // the slices and the change are still real, spendable notes rather than invisible funds.
  const split = await splitNoteV3({
    chainId: p.chainId,
    signer: p.signer,
    screenToken: p.screenToken,
    note: p.note,
    values: change > 0n ? [...sliceValues, change] : sliceValues,
    symbol: p.inSymbol,
    submit: p.submit,
  });

  p.log?.(`Split settled — sealing ${p.sliceCount} legs to the enclave…`);
  // The trailing change note, when there is one, is deliberately NOT armed: it is the user's
  // leftover balance and stays spendable.
  const sliceNotes = split.notes.slice(0, p.sliceCount);

  const legs: V3LegBuildResult["legs"] = [];

  for (let i = 0; i < p.sliceCount; i++) {
    const note = sliceNotes[i];
    // Baked in at ARM time and the only slippage bound on this shape, so it uses the v2 pricer.
    const minAmountOut = p.swap.minOutFor(ethers.formatUnits(note.value, p.inDecimals));

    const armed = await armV3StrategyLeg({
      chainId: p.chainId,
      strategyId: armStrategyId,
      legIndex: i,
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
      outSymbol: p.outSymbol,
      screenToken: p.screenToken,
      swap: {
        amountIn: note.value,
        change: 0n, // exact slice spend
        pool: p.swap.pool,
        dstToken: p.swap.dstToken,
        fee: p.swap.fee,
        minAmountOut,
      },
    });

    const sliceAmountHuman = ethers.formatUnits(note.value, p.inDecimals);
    const bound = await p.encryptLeg(i, sliceAmountHuman);
    legs.push({
      leg_index: i,
      amount: parseFloat(sliceAmountHuman),
      output_precommitment: armed.output_precommitment,
      ...bound,
      // encryptLeg always supplies it; restated so the emitted leg satisfies BuiltLeg, where
      // eval_mode is required (the scheduler branches on it).
      eval_mode: bound.eval_mode ?? "price",
    });
  }

  return {
    legs,
    splitTxHash: split.txHash,
    scheduleAnchor,
    armStrategyId,
    // Every slice inherits the spent note's label (deriveSplitPublics binds outLabel = inLabel),
    // so one label describes the whole strategy.
    noteLabel: p.note.label,
    armingFeeWei: armingCollectedWei.toString(),
    armingTxHash,
  };
}
