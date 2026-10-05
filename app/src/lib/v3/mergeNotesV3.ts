/**
 * Note consolidation — shared by strategy arming and by withdraw.
 *
 * Lived in buildV3StrategyLegs while arming was its only caller. Withdraw needs the same thing for
 * the same reason (the circuits cap inputs at 6), and importing it from the strategy builder would
 * have dragged armV3StrategyLeg and the arming-fee collector into the withdraw path.
 */

import type { Signer } from "ethers";
import { mergeV3, type SpendNote, type SubmitHook } from "./spendActionsV3";
import { hashCommitmentWithPre, hashPrecommitment, randomUserSalt } from "./noteCryptoV3";
import { markV3NoteSpent, saveV3Note } from "./noteStoreV3";
import { MERGE_MAX_INPUTS } from "./selectMergeInputs";
import { waitForStateLeaf } from "./stateLeavesClient";

/**
 * Consolidate 2..6 notes into one, persisting the output and retiring the inputs.
 *
 * mergeV3 proves and submits but stores nothing, so — exactly like splitNoteV3 — the local note
 * store has to be brought in line here or the merged funds are invisible to the next read while
 * the inputs still look spendable.
 *
 * The output inherits the BOUNDARY note's label (deriveMergePublics binds outLabel = inLabel of
 * the max-value input), so it is admitted the moment it exists — merging never costs a second trip
 * through the ~5 minute admit bus. The circuit requires the boundary to be the largest input, so
 * that is chosen here rather than trusted from the caller.
 */
export async function mergeNotesV3(p: {
  chainId: number;
  signer: Signer;
  screenToken: string;
  notes: SpendNote[];
  /** Uppercased symbol. Merging never changes asset. */
  symbol: string;
  submit: SubmitHook;
}): Promise<{ note: SpendNote; txHash: string }> {
  if (p.notes.length < 2 || p.notes.length > MERGE_MAX_INPUTS) {
    throw new Error(`mergeNotesV3: need 2..${MERGE_MAX_INPUTS} notes, got ${p.notes.length}`);
  }
  const assetId = p.notes[0].assetId;
  if (p.notes.some((n) => n.assetId !== assetId)) {
    throw new Error("mergeNotesV3: every note must be the same asset");
  }

  // Boundary = max value. Ties resolve to the first, which the circuit accepts: its rule is that no
  // input EXCEEDS the boundary, not that the boundary is unique.
  let boundaryIndex = 0;
  for (let i = 1; i < p.notes.length; i++) {
    if (p.notes[i].value > p.notes[boundaryIndex].value) boundaryIndex = i;
  }
  const boundary = p.notes[boundaryIndex];
  const sum = p.notes.reduce((acc, n) => acc + n.value, 0n);

  const outNullifier = randomUserSalt();
  const outSecret = randomUserSalt();

  const res = await mergeV3({
    chainId: p.chainId,
    notes: p.notes,
    boundaryIndex,
    outNullifier,
    outSecret,
    screenToken: p.screenToken,
    submit: p.submit,
  });
  if (!res.ok) throw new Error("mergeNotesV3: merge failed");

  // Retire the inputs before anything else can pick them up. Same reasoning as splitNoteV3: two
  // strategies armed back to back would otherwise both select the same notes and the second would
  // fail with NullifierAlreadyUsed after its arming fee had already been charged.
  for (const n of p.notes) await markV3NoteSpent(p.chainId, n.commitment, p.signer);

  const pre = await hashPrecommitment(outNullifier, outSecret);
  // publicSignals[7] is outCommitment (actionPublicsV3: limbs[7]); prefer the value the chain
  // actually verified over recomputing it.
  const commitment =
    res.publicSignals?.[7] ??
    String(await hashCommitmentWithPre(sum, BigInt(boundary.label), BigInt(assetId), pre));

  await saveV3Note(
    p.chainId,
    {
      nullifier: outNullifier.toString(),
      secret: outSecret.toString(),
      label: boundary.label,
      assetId,
      symbol: p.symbol.toUpperCase(),
      commitment: String(commitment),
      value: sum,
      precommitment: pre.toString(),
      origin: "change",
      spent: "false",
    },
    p.signer,
    // Same asset, carved from notes already in the vault — a 'change' commitment, matching how
    // splitNoteV3 classifies its slices. CommitmentSource has no 'merge' member.
    "change",
  );

  // The relayer waits for the MERGE receipt, but the browser's read RPC and the indexer can lag
  // that block. Any immediate consumer (withdraw and strategy arming both do this) needs the new
  // leaf before it can reconstruct a Merkle path. Wait here, after the secrets are durably saved,
  // so a transient indexing delay cannot turn a successful consolidation into a stale-leaf error.
  await waitForStateLeaf(p.chainId, String(commitment));

  return {
    note: {
      commitment: String(commitment),
      value: sum,
      label: boundary.label,
      assetId,
      nullifier: outNullifier.toString(),
      secret: outSecret.toString(),
    },
    txHash: res.txHash ?? "",
  };
}
