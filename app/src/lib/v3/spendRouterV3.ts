/**
 * v3 spend router (Phase 5 Façade).
 *
 * High-level orchestration for v3 WITHDRAW, MERGE, and RAGEQUIT:
 * 1. Loads all v3 notes for the chain and selects them by assetId (never by storage symbol).
 * 2. Runs circuit planners (planWithdraw) / selection.
 * 3. Proves, verifies, and submits via executorSubmitV3.
 * 4. ORDERING GUARANTEE: Marks input notes spent ONLY AFTER executor returns tx_hash.
 * 5. Saves change / merged notes with inherited boundary labels and exact circuit commitments.
 * 6. Fails closed via requireV3(chainId).
 */

import { Signer } from "ethers";
import { requireV3 } from "./configV3";
import { noteAssetIdFor, assetIdFromToken, hashCommitment, hashPrecommitment, randomUserSalt } from "./noteCryptoV3";
import { loadV3Notes, markV3NoteSpent, parseV3NoteKey, saveV3Note } from "./noteStoreV3";
import { parseTooManyNotes, planWithdraw } from "./planWithdrawV3";
import { mergeNotesV3 } from "./mergeNotesV3";
import { selectConsolidationInputs } from "./selectMergeInputs";
import { checkAdmitted } from "./aspClientV3";
import { withdrawV3 } from "./withdrawV3";
import { mergeV3, ragequitV3, type SpendNote } from "./spendActionsV3";
import { createExecutorSubmitV3 } from "./executorSubmitV3";
import { recordSwapOnCursor, recordWithdrawOnCursor } from "./noteCursorSession";
import { lockNote, RAGEQUIT_LOCK_MS, unlockNote } from "./noteLockV3";
import type { BridgeOrderRequest } from "../bridge/hub";

export interface WithdrawViaV3Params {
  chainId: number;
  token: string;
  symbol: string;
  amount: bigint;
  recipient: string;
  signer: Signer;
  screenToken: string;
  /**
   * Withdraw to another chain: `recipient` must then be the /bridgeQuote payee (the executor),
   * and the final withdraw goes to /bridgeWithdraw with this order. `amount` is overwritten with
   * the withdraw amount so the two cannot drift.
   */
  bridge?: BridgeOrderRequest;
}

export interface MergeViaV3Params {
  chainId: number;
  token: string;
  symbol: string;
  signer: Signer;
  screenToken: string;
}

export interface RagequitViaV3Params {
  chainId: number;
  note: SpendNote;
  recipient: string;
  signer: Signer;
  screenToken: string;
}

export interface SpendRouterResult {
  txHash: string;
  /** Set when the withdraw went through /bridgeWithdraw — poll GET /bridgeOrders/<id>. */
  bridgeOrderId?: string;
}

/**
 * Fold notes together until the withdrawal fits the circuit's input cap.
 *
 * A balance built up from many small deposits could not be withdrawn at all: the planner needs one
 * input per note and the widest circuit is withdraw6, so 3.81 USDC spread over seven notes died on
 * "target needs 7 notes but MAX_INPUTS is 6 — merge notes first" with nothing in the UI to merge
 * with. Arming already consolidates for exactly this reason; withdraw now uses the same primitive.
 *
 * Each pass folds the FEWEST notes that fix it (see selectConsolidationInputs) — seven notes against
 * a cap of six costs one merge2, not a merge6, which is the difference between a 45 MB proving key
 * and a 144 MB one downloaded and proved in the browser. One pass removes at most 5 notes, hence
 * the loop; the bound is low on purpose, since every pass is a proof and an on-chain transaction
 * and a wallet needing more than three has a dust problem that quietly spending its gas is the
 * wrong answer to.
 *
 * Only ASP-admitted notes are eligible. Merging is a private spend like any other and proves
 * inclusion in the current admitted root, so folding in a note still waiting for the bus would
 * fail the merge instead of the withdrawal — the same error, one step earlier and less explicable.
 */
async function consolidateForWithdraw(p: {
  chainId: number;
  notes: SpendNote[];
  target: bigint;
  assetId: string;
  symbol: string;
  signer: Signer;
  screenToken: string;
  submit: ReturnType<typeof createExecutorSubmitV3>;
}): Promise<SpendNote[]> {
  const MAX_PASSES = 3;
  let notes = p.notes;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let needed: number;
    try {
      planWithdraw(notes, p.target, p.assetId);
      return notes; // the plan fits — nothing to consolidate
    } catch (e) {
      // Any other planner error (insufficient funds, no notes) is the caller's to report as-is.
      const tooMany = parseTooManyNotes(e instanceof Error ? e.message : String(e));
      if (!tooMany) return notes;
      needed = tooMany.needed;
    }

    const admitted: SpendNote[] = [];
    for (const n of notes) {
      if ((await checkAdmitted(undefined, p.screenToken, String(n.label), p.chainId)) === true) admitted.push(n);
    }

    const fold = selectConsolidationInputs(admitted, needed);
    // Nothing foldable means the notes that CAN be spent are already as few as they get; let the
    // planner throw its own message rather than inventing a worse one here.
    if (!fold) return notes;

    const { note: merged } = await mergeNotesV3({
      chainId: p.chainId,
      signer: p.signer,
      screenToken: p.screenToken,
      notes: fold,
      symbol: p.symbol,
      submit: p.submit,
    });

    const folded = new Set(fold.map((n) => n.commitment));
    notes = [...notes.filter((n) => !folded.has(n.commitment)), merged];
  }

  return notes;
}

export async function withdrawViaV3(p: WithdrawViaV3Params): Promise<SpendRouterResult> {
  requireV3(p.chainId); // Fail closed

  const assetId = noteAssetIdFor(p.chainId, p.token).toString();
  // Load ALL notes for the chain and select by assetId, never by the storage symbol.
  //
  // The symbol is only a localStorage key. A note minted from native ETH binds WETH, and WETH is
  // not a displayed token, so such notes were filed under a symbol the caller never asks for —
  // they are on-chain and spendable, yet a symbol-filtered load returns nothing. assetId is the
  // authoritative asset identity (it is what the circuits and the kernel bind), so filter on that.
  let notes = (await loadV3Notes(p.chainId, p.signer)).filter(
    (n) => String(n.assetId) === assetId,
  );
  if (notes.length === 0) {
    throw new Error(`withdrawViaV3: no spendable notes found for ${p.symbol}`);
  }

  const outNullifier = randomUserSalt();
  const outSecret = randomUserSalt();
  const submitHook = createExecutorSubmitV3(p.signer);

  notes = await consolidateForWithdraw({
    chainId: p.chainId,
    notes,
    target: p.amount,
    assetId,
    symbol: p.symbol,
    signer: p.signer,
    screenToken: p.screenToken,
    submit: submitHook,
  });

  // Merges above stay on /relaySpend; only the final withdraw carries the bridge order.
  let bridgeOrderId: string | undefined;
  const finalSubmit = p.bridge
    ? createExecutorSubmitV3(p.signer, {
        path: "/bridgeWithdraw",
        extraBody: { bridge: { ...p.bridge, amount: p.amount.toString() } },
        onResponse: (json) => { bridgeOrderId = json.order_id ? String(json.order_id) : undefined; },
      })
    : submitHook;

  const result = await withdrawV3({
    chainId: p.chainId,
    notes,
    target: p.amount,
    assetId,
    recipient: p.recipient,
    outNullifier,
    outSecret,
    screenToken: p.screenToken,
    submit: finalSubmit,
  });

  if (!result.txHash) {
    throw new Error("withdrawViaV3: submission returned no transaction hash");
  }

  const plan = result.plan;

  // 1) Mark inputs spent ONLY after submission succeeded
  for (const note of plan.selected) {
    await markV3NoteSpent(p.chainId, note.commitment, p.signer);
  }

  // 2) Save change note if secondaryValue > 0
  if (plan.secondaryValue > 0n) {
    const boundaryNote = plan.selected[plan.boundaryIndex];
    const changeLabel = boundaryNote.label;

    // Use exact commitment recomputed from circuit public signals (publicInputs[7]) or derived
    const circuitChangeCommitment = result.publicSignals[7];
    const changeCommitment =
      circuitChangeCommitment && circuitChangeCommitment !== "0"
        ? circuitChangeCommitment
        : (
            await hashCommitment(
              plan.secondaryValue,
              BigInt(changeLabel),
              BigInt(assetId),
              outNullifier,
              outSecret,
            )
          ).toString();

    const changePrecommitment = await hashPrecommitment(outNullifier, outSecret);

    await saveV3Note(
      p.chainId,
      {
        nullifier: outNullifier.toString(),
        secret: outSecret.toString(),
        label: changeLabel,
        assetId,
        symbol: p.symbol,
        commitment: changeCommitment,
        value: plan.secondaryValue,
        precommitment: changePrecommitment.toString(),
        spent: "false",
      },
      p.signer,
      "change",
    );

    // Partial withdraw: cursor follows the change note that remains in the vault.
    recordSwapOnCursor({
      chainId: p.chainId,
      symbol: p.symbol,
      commitment: changeCommitment,
      value: plan.secondaryValue,
      txHash: result.txHash,
    });
  } else {
    // Full withdraw of the run's notes — cursor ends.
    recordWithdrawOnCursor({ txHash: result.txHash });
  }

  return { txHash: result.txHash, bridgeOrderId };
}

export async function mergeViaV3(p: MergeViaV3Params): Promise<SpendRouterResult> {
  requireV3(p.chainId);

  const assetId = noteAssetIdFor(p.chainId, p.token).toString();
  // Load ALL notes for the chain and select by assetId, never by the storage symbol.
  //
  // The symbol is only a localStorage key. A note minted from native ETH binds WETH, and WETH is
  // not a displayed token, so such notes were filed under a symbol the caller never asks for —
  // they are on-chain and spendable, yet a symbol-filtered load returns nothing. assetId is the
  // authoritative asset identity (it is what the circuits and the kernel bind), so filter on that.
  const notes = (await loadV3Notes(p.chainId, p.signer)).filter(
    (n) => String(n.assetId) === assetId,
  );
  if (notes.length < 2) {
    throw new Error(`mergeViaV3: need at least 2 notes to merge ${p.symbol}, found ${notes.length}`);
  }

  // Sort descending by value; max-value note is boundary (boundaryIndex = 0)
  const sorted = [...notes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = sorted.slice(0, 6); // Max 6 inputs
  const boundaryIndex = 0;
  const boundaryNote = selected[boundaryIndex];

  const outNullifier = randomUserSalt();
  const outSecret = randomUserSalt();
  const totalValue = selected.reduce((acc, n) => acc + n.value, 0n);

  const mergedLabel = boundaryNote.label;
  const mergedCommitment = await hashCommitment(
    totalValue,
    BigInt(mergedLabel),
    BigInt(assetId),
    outNullifier,
    outSecret,
  );
  const mergedPrecommitment = await hashPrecommitment(outNullifier, outSecret);

  const submitHook = createExecutorSubmitV3(p.signer);

  const result = await mergeV3({
    chainId: p.chainId,
    notes: selected,
    boundaryIndex,
    outNullifier,
    outSecret,
    screenToken: p.screenToken,
    submit: submitHook,
  });

  if (!result.txHash) {
    throw new Error("mergeViaV3: submission returned no transaction hash");
  }

  // Mark inputs spent ONLY after transaction confirmed/submitted
  for (const note of selected) {
    await markV3NoteSpent(p.chainId, note.commitment, p.signer);
  }

  // Save consolidated merged note
  await saveV3Note(
    p.chainId,
    {
      nullifier: outNullifier.toString(),
      secret: outSecret.toString(),
      label: mergedLabel,
      assetId,
      symbol: p.symbol,
      commitment: mergedCommitment.toString(),
      value: totalValue,
      precommitment: mergedPrecommitment.toString(),
      spent: "false",
    },
    p.signer,
    "merge",
  );

  return { txHash: result.txHash };
}

export async function ragequitViaV3(p: RagequitViaV3Params): Promise<SpendRouterResult> {
  requireV3(p.chainId);

  const submitHook = createExecutorSubmitV3(p.signer);

  const result = await ragequitV3({
    chainId: p.chainId,
    note: p.note,
    recipient: p.recipient,
    screenToken: p.screenToken,
    submit: submitHook,
  });

  if (!result.txHash) {
    throw new Error("ragequitViaV3: submission returned no transaction hash");
  }

  // Mark note spent ONLY after submission succeeded
  await markV3NoteSpent(p.chainId, p.note.commitment, p.signer);

  return { txHash: result.txHash };
}

/**
 * Ragequit the note identified by a localStorage note key.
 *
 * The screening UI (and recover-all) only carry a note key — v1's ragequit(token, noteKey) took
 * the same shape — while ragequitViaV3 needs the decrypted note. Resolve one to the other here so
 * handler.ts can dispatch on chain version without knowing the v3 note model.
 */
export async function ragequitByNoteKeyV3(p: {
  noteKey: string;
  recipient: string;
  signer: Signer;
  screenToken?: string;
}): Promise<SpendRouterResult & { value: bigint; symbol: string }> {
  const parsed = parseV3NoteKey(p.noteKey);
  if (!parsed) throw new Error(`ragequitByNoteKeyV3: not a v3 note key: ${p.noteKey}`);

  // Before the exit ticket, which revokes the label: an arm consuming this note meanwhile would
  // leave its strategy under a revoked label. Throws while an arm holds the note.
  lockNote(parsed.commitment, "ragequit", RAGEQUIT_LOCK_MS);
  try {
    // loadV3Notes drops locally-spent notes and other generations, so a miss here means the note is
    // already spent or belongs to a retired kernel — both worth saying plainly rather than failing
    // deep inside the prover.
    const notes = await loadV3Notes(parsed.chainId, p.signer, parsed.symbol);
    const note = notes.find((n) => n.commitment === parsed.commitment);
    if (!note) {
      throw new Error("This note is no longer spendable — it may already have been recovered.");
    }

    // A clean pending label cannot satisfy ragequit's revoked branch directly. The existing ASP
    // exit-ticket route verifies this exact deposit, publishes the label into the revoked SMT, and
    // waits for the selected chain's ComplianceHub to catch up. Already-revoked notes are a no-op;
    // admitted notes fail here with the private-withdraw guidance before we spend time proving.
    const { ensureRagequitExitTicket } = await import("./exitTicketV3");
    await ensureRagequitExitTicket({
      chainId: parsed.chainId,
      noteKey: p.noteKey,
      note,
      signer: p.signer,
    });

    const res = await ragequitViaV3({
      chainId: parsed.chainId,
      note,
      recipient: p.recipient,
      signer: p.signer,
      screenToken: p.screenToken ?? "",
    });

    // Return the recovered amount so the caller can log a complete activity row rather than one
    // with a blank amount.
    return { ...res, value: note.value, symbol: parsed.symbol };
  } finally {
    unlockNote(parsed.commitment, "ragequit");
  }
}
