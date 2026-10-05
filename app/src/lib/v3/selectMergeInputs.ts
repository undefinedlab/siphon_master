/**
 * Which notes to consolidate so a strategy can be funded from the vault balance.
 *
 * `acquireV3Note` used to look only for a SINGLE note worth at least the order. A wallet holding
 * 2 + 1 + 0.5 USDC therefore could not place a 3.5 order: no one note covered it, so the flow fell
 * through to a fresh deposit and refused with "not enough balance" against a wallet that had
 * already put all of it in the vault. Anything above the largest single note was untradeable.
 *
 * MERGE takes 2..6 inputs (merge2..merge6), so the fix is to pick a subset. Largest-first is
 * deliberate on three counts: it reaches the target with the fewest inputs, fewer inputs means a
 * smaller circuit and a cheaper proof, and it leaves the small notes whole for small orders
 * instead of shredding the balance into dust.
 *
 * Pure, and separate from the orchestrator so the selection can be tested without a chain: it
 * decides which of a user's funds get consumed.
 */

/** Most notes MERGE can consume in one proof — merge2..merge6 are the only circuits that exist. */
export const MERGE_MAX_INPUTS = 6;

export type MergeCandidate = { value: bigint };

/**
 * Largest-first subset whose values sum to at least `target`, or null if no such subset of at most
 * `maxInputs` notes exists.
 *
 * Null means "merging cannot fund this" — the caller falls back to a deposit. That is the honest
 * answer even when the total balance IS sufficient but sits in more than `maxInputs` notes: the
 * circuit genuinely cannot spend them in one proof.
 */
export function selectMergeInputs<T extends MergeCandidate>(
  notes: readonly T[],
  target: bigint,
  maxInputs: number = MERGE_MAX_INPUTS,
): T[] | null {
  if (target <= 0n || maxInputs < 2) return null;

  const sorted = [...notes]
    .filter((n) => n.value > 0n)
    .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));

  const picked: T[] = [];
  let sum = 0n;
  for (const n of sorted) {
    if (sum >= target || picked.length >= maxInputs) break;
    picked.push(n);
    sum += n.value;
  }

  // Fewer than 2 is not a merge — a single covering note is the caller's earlier, cheaper path.
  if (picked.length < 2 || sum < target) return null;
  return picked;
}

/**
 * The notes to fold together when a withdrawal needs more inputs than the circuit accepts.
 *
 * Fold the FEWEST notes that fix it, not the most. The planner's greedy selection is the `needed`
 * largest notes, and merging any k of them into one drops the count by k-1 — so needing 7 against a
 * cap of 6 is fixed by a single merge2, not a merge6. That is not a micro-optimisation: the proving
 * keys are 45 MB for merge2 against 144 MB for merge6, downloaded in the browser and proved there,
 * so picking the widest circuit turns a slow withdrawal into one that looks hung.
 *
 * Within the selection, take the SMALLEST — folding 0.1 + 0.01 leaves the large notes whole for
 * later withdrawals, where folding the two largest would strand their value in a single lump.
 */
export function selectConsolidationInputs<T extends MergeCandidate>(
  notes: readonly T[],
  needed: number,
  maxInputs: number = MERGE_MAX_INPUTS,
): T[] | null {
  if (maxInputs < 2 || needed <= maxInputs) return null;

  const sorted = [...notes]
    .filter((n) => n.value > 0n)
    .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
  if (sorted.length < 2) return null;

  // k notes become 1, so k-1 disappear. Cap at the circuit's width — a wallet needing more than one
  // pass gets another one rather than a circuit that does not exist.
  const fold = Math.min(maxInputs, needed - maxInputs + 1, sorted.length);
  if (fold < 2) return null;

  // The planner would have taken the `needed` largest; fold the tail of exactly that set.
  return sorted.slice(0, Math.min(needed, sorted.length)).slice(-fold);
}
