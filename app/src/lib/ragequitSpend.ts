/**
 * Post-ragequitBatch local state: never mark a note spent unless the vault
 * says its nullifier is spent. Skipped batch items stay visible + retriable.
 */

export type RagequitSpendItem = {
  noteKey: string;
  nullifierHash: string;
};

export type NullifierVault = {
  nullifiers: (nh: bigint) => Promise<unknown>;
};

/** Keep each recovery transaction comfortably below the block gas limit. */
export const RAGEQUIT_BATCH_CHUNK = 8;

export function chunkRagequitItems<T>(items: T[], size = RAGEQUIT_BATCH_CHUNK): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error("Chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export async function markRagequitNotesFromChain(
  vault: NullifierVault,
  items: RagequitSpendItem[],
  markSpent: (noteKey: string) => void,
): Promise<{ spentKeys: string[]; unspentKeys: string[] }> {
  const spentKeys: string[] = [];
  const unspentKeys: string[] = [];
  for (const item of items) {
    try {
      const spent = Boolean(await vault.nullifiers(BigInt(item.nullifierHash)));
      if (spent) {
        markSpent(item.noteKey);
        spentKeys.push(item.noteKey);
      } else {
        unspentKeys.push(item.noteKey);
      }
    } catch {
      unspentKeys.push(item.noteKey);
    }
  }
  return { spentKeys, unspentKeys };
}
