export type SpendCandidate<T> = {
  amountWei: bigint;
  value: T;
};

/**
 * Find the smallest on-chain-unspent candidate without probing every larger note.
 * Candidates are checked in ascending value order, so the first unspent note is
 * the same note a full scan would choose while keeping RPC work bounded.
 */
export async function selectSmallestUnspent<T>(
  candidates: SpendCandidate<T>[],
  isSpent: (candidate: T) => Promise<boolean>,
  onSpent?: (candidate: T) => void,
): Promise<T | null> {
  const ordered = candidates
    .map((candidate, index) => ({ ...candidate, index }))
    .sort((a, b) => (a.amountWei < b.amountWei ? -1 : a.amountWei > b.amountWei ? 1 : a.index - b.index));

  for (const candidate of ordered) {
    if (await isSpent(candidate.value)) {
      onSpent?.(candidate.value);
      continue;
    }
    return candidate.value;
  }
  return null;
}
