/**
 * One place that knows what a note row's `amount` actually means.
 *
 * The `amount` column in the shared commitments backup carries TWO different units:
 *
 *   - v2 writers store a HUMAN DECIMAL ("0.001"), and every v2 reader assumes that —
 *     localNoteStore.syncFromServer does parseUnits(amount, decimals) to rebuild the leaf.
 *   - v3's saveV3Note stores WEI ("1000000000000000"), because that is what the circuit binds
 *     and what noteStoreV3 reads back.
 *
 * Both halves are self-consistent, so nothing broke until the two met in one table. Then:
 *
 *   - v2's sync read a v3 row and did parseUnits("1000000000000000", 18), producing a value 1e18
 *     too large. reconstructLeaf then disagreed with the stored commitment and the note was
 *     discarded as "recovered leaf ≠ commitment — skipping corrupt row". The row was fine; the
 *     unit was wrong, and a real note went invisible.
 *   - the dashboard's in-review overlay did parseFloat on the same string and rendered
 *     "1000000000000000.000000 ETH" for a 0.001 ETH note.
 *
 * The discriminator is deterministic, not a magnitude guess: `vault_id` is a plaintext column on
 * the row, and v3 writes `v3-<kernel>` into it. A decimal point is also conclusive — no wei value
 * has one.
 *
 * New v3 backups write the human decimal (see saveV3Note), matching the majority convention. This
 * helper still reads both, because rows written before that change are already stored.
 */
import { ethers } from "ethers";

/** True when this row's `amount` is denominated in wei rather than whole tokens. */
export function amountIsWei(row: {
  amount?: unknown;
  vault_id?: string | null;
  vaultId?: string | null;
  /** Set by the v3 sync: this row belongs to the v3 store, so its amount is wei even untagged. */
  isV3?: boolean;
}): boolean {
  const raw = String(row.amount ?? "").trim();
  if (raw === "") return false;
  // A decimal point is conclusive: wei is an integer.
  if (raw.includes(".")) return false;
  const vaultId = String(row.vault_id ?? row.vaultId ?? "");
  if (vaultId.startsWith("v3-")) return true;
  // An UNTAGGED row is WEI when the caller says the chain is v3.
  //
  // The prefix test alone read vault_id NULL as "v2, therefore a human decimal" and ran
  // parseUnits over an already-wei amount — a real 0.01 USDC note (10000, 6dp) came back as
  // 10000000000, and that inflated note then flowed through a withdrawal into an equally
  // inflated change note, because the planner enforces conservation and cannot know the input
  // was wrong. Rows arrive untagged whenever a v3 note reaches the table through the v2
  // postCommitment path.
  //
  // NOT decided by magnitude: 5000000 is a legitimate 5 USDC AND a legitimate wei amount, so no
  // threshold can separate them. Only the caller knows which store the row belongs to, so
  // `isV3` is passed explicitly by the v3 sync and defaults to false — every v2 caller keeps
  // exactly its old behaviour.
  if (row.isV3 === true) return true;
  return false;
}

/**
 * Resolve a row's amount to wei. Returns null when it cannot be parsed, so callers fail closed
 * instead of rebuilding a leaf from a silently wrong value.
 */
export function noteAmountToWei(
  row: { amount?: unknown; vault_id?: string | null; vaultId?: string | null; isV3?: boolean },
  decimals: number,
): bigint | null {
  const raw = String(row.amount ?? "").trim();
  if (raw === "") return null;
  try {
    return amountIsWei(row) ? BigInt(raw) : ethers.parseUnits(raw, decimals);
  } catch {
    return null;
  }
}

/** Resolve a row's amount to a human-readable number, for display and balance totals. */
export function noteAmountToHuman(
  row: { amount?: unknown; vault_id?: string | null; vaultId?: string | null; isV3?: boolean },
  decimals: number,
): number {
  const wei = noteAmountToWei(row, decimals);
  if (wei === null) return 0;
  const n = Number(ethers.formatUnits(wei, decimals));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve a LOCALSTORAGE note row to a human-readable number.
 *
 * Local rows are unambiguous on their own: v3 (noteStoreV3) writes `value` in wei and no `amount`;
 * v2 writes `amount` as a human decimal. Kept here so the two shapes are decoded in one place.
 */
export function localNoteAmountToHuman(
  row: { amount?: unknown; value?: unknown },
  decimals: number,
): number {
  if (row.value !== undefined && row.value !== null && String(row.value) !== "") {
    try {
      const n = Number(ethers.formatUnits(BigInt(String(row.value)), decimals));
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  const n = parseFloat(String(row.amount ?? "0"));
  return Number.isFinite(n) ? n : 0;
}
