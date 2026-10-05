/**
 * Instant balance from the notes we already hold — no network, no ASP, no RPC.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `getV3Balance` needs one eth_call per note (`dropUsedNullifiers`) and one ASP call per label
 * (`statusByLabelV3`). Either can fail, and when it did, `UserDash` replaced the NUMBER with a
 * "verifying on-chain, network busy" message.
 *
 * That conflates two different things: "we cannot verify" and "we do not know the amount". We
 * always know the amount — it is the sum of the notes in localStorage. Hiding it because a third
 * party is unreachable is what makes a user believe their funds are gone, and a balance that fails
 * SILENTLY is the worst failure this product has: every other error is visible, but money that
 * does not appear reads as money that is gone.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * COMPLETENESS — why summing local notes is not missing anything
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A note is {nullifier, secret, commitment}, and those exist in exactly two places: localStorage
 * and the encrypted server backup. No third source can produce a spendable note. `syncV3FromServer`
 * merges the backup into localStorage before this runs, so this sum IS the complete universe.
 *
 * The residual risk therefore runs one way only: a note in here may ALREADY be spent, making the
 * figure too HIGH. It can never be too low. That asymmetry is what makes showing it immediately
 * safe — the correction is downward and rare, not a guess that might understate funds.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SPENT-FLAG CONFLICTS — local vs server
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Resolution is "spent wins", monotonically (SPENT_RANK_V3: false(0) < pending(1) < true(2)),
 * and both directions of disagreement resolve the same way for different reasons:
 *
 *   server spent, local unspent → SPENT. `markV3NoteSpent` writes local FIRST, then the server.
 *                                A server 'true' therefore means some device wrote it locally;
 *                                this device simply never saw it (another device, another tab).
 *   server unspent, local spent → SPENT. Local is only marked AFTER the spend, and the server
 *                                write is the leg that fails (it is the network call). This is
 *                                the ordinary "local succeeded, sync failed" case.
 *
 * `pending` is a third state and is NOT spendable. `strategyNoteReservation` sets it when a note
 * is reserved for a strategy: the enclave holds a proof for that note. Counting it as spendable
 * lets the planner select a note that is about to be consumed → revert with NullifierAlreadyUsed.
 * Those funds belong in the IN-STRATEGY bucket, derived from the strategy list, not from here.
 *
 * A note present locally but ABSENT from the server is still spendable — that is the failed-backup
 * case (`backup:'pending'`). Absence from the server is not evidence of spentness. Union, never
 * intersect.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE BUCKETS, and why each is where it is
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   PRIVATE      notes with spent==='false' on both sides            ← this module
 *   IN STRATEGY  Σ strategy.amount where status ∈ {PENDING, ARMED}   ← getStrategyBalance, below
 *   IN REVIEW    notes whose label the ASP has not admitted          ← needs the ASP
 *
 * IN STRATEGY comes from the strategy LIST, not from note reservations: it needs no commitment-id
 * lookup, it is the same number Activity shows (so the two views cannot disagree), and it survives
 * a device switch — reservations live in localStorage, strategies live on the server.
 *
 * Terminal strategies contribute NOTHING, `PARTIALLY_EXECUTED` included. Unfired TWAP/grid legs
 * hold REAL on-chain slice-notes (the split ran at submit), so those funds are already counted in
 * PRIVATE; adding `strategy.amount` for a terminal strategy would double-count them.
 *
 * IN REVIEW when the ASP is unreachable: the note genuinely IS in review — we do not know its
 * admission state, and "not known yet" is exactly what in-review means. Showing it there is
 * correct, not a degradation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ON-CHAIN VERIFICATION — kept, but demoted to a background refinement
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `dropUsedNullifiers` (one `NullifierSet.isUsed` eth_call per unspent note) is the ONLY mechanism
 * that learns about an enclave fire-time spend: the enclave spends the note on-chain, and neither
 * this browser nor the server backup ever finds out. Without it that note keeps counting, gets
 * selected by the next spend, and reverts with NullifierAlreadyUsed — a wasted proof, gas, and an
 * error the user cannot act on.
 *
 * It is NOT free: a healthy wallet with N genuinely-unspent notes pays N calls on every refresh,
 * because only SPENT notes get marked and skipped thereafter ("once marked, never re-checked").
 * That cost falls on the common case, which is why it must never gate the display.
 *
 * So it stays, but it no longer blocks: this module paints first, and that path corrects downward
 * if it finds something. The balance does not move in the common case, and a move that does happen
 * is a correction rather than a glitch.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * KNOWN RESIDUALS — what this does NOT solve
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * R1  Both stores unreachable when a note is written. Needs the server AND the executor down at
 *     once. Read-back confirmation detects it, so the user can be told to export — not silent.
 * R2  Stale-high across devices, briefly. A failed status write is queued on the device that made
 *     it, so another device may count a reserved note until that queue drains. Closable only by
 *     making the reservation write server-authoritative (executor-side), which is out of scope here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * No ASP call, so it cannot separate admitted from in-review. Callers show this as the total and
 * let the fuller path refine it.
 *
 * NO CONFIDENCE BADGE. An earlier version labelled the figure "not yet confirmed on-chain" until
 * the reconcile finished. That was removed deliberately: local + the encrypted backup ARE the
 * complete set of a user's notes, so the number is trustworthy on arrival, and telling the user it
 * might not be invites doubt about funds that are genuinely theirs. The on-chain check still runs
 * in the background and still corrects the figure — it just does so silently, the way a correction
 * to something already believed should.
 */

import { v3Config } from "./configV3";

export interface LocalBalance {
  /** Minor units per uppercased symbol, e.g. { ETH: 24238000000000n }. */
  bySymbol: Record<string, bigint>;
  /** Notes counted. Zero means "no notes", which is a real answer, not a failure. */
  noteCount: number;
  /** Notes present but unreadable (corrupt row / wrong enc-key) — surfaced, never silently dropped. */
  unreadable: number;
}

/**
 * Spendable-for-display totals from localStorage alone.
 *
 * Excludes `spent: 'true'` AND `spent: 'pending'`. Pending is a strategy reservation: the enclave
 * holds a proof for that note, so counting it as spendable would let the planner select a note that
 * is about to be consumed — a revert with NullifierAlreadyUsed. Those funds belong in the
 * IN-STRATEGY bucket, which the caller derives from the strategy list, not from here.
 *
 * Excludes notes tagged with a retired `vaultId` for the same reason `loadV3Notes` does: their leaf
 * lives in a previous kernel's tree, so they can never be spent here and showing them as spendable
 * would overstate what the user can actually withdraw.
 */
export function getLocalBalance(chainId: number, owner?: string | null): LocalBalance {
  const out: LocalBalance = { bySymbol: {}, noteCount: 0, unreadable: 0 };
  if (typeof localStorage === "undefined") return out;

  const cfg = v3Config(chainId);
  const activeVaultId = cfg?.vaultKernel ? `v3-${cfg.vaultKernel}` : null;
  const prefix = `siphon-v3note-${chainId}-`;

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const raw = localStorage.getItem(k);
    if (!raw) continue;

    try {
      const row = JSON.parse(raw);
      // spent-wins: 'true' and 'pending' are both not-spendable.
      if (row.spent === "true" || row.spent === "pending") continue;
      // A row with no vaultId predates the tag; treat it as foreign rather than assume it is ours.
      if (activeVaultId && row.vaultId !== activeVaultId) continue;
      // Another wallet's note on this browser (rows carry their owner in plaintext). Counting it
      // showed account B the balance account A left here, and the empty reconcile for B could
      // not clear it — an empty result after a non-empty paint reads as an ASP blip.
      if (owner && row.owner && String(row.owner).toLowerCase() !== owner.toLowerCase()) continue;

      // `value` is a PLAINTEXT column on the row (saveV3Note writes it alongside enc_blob), so a
      // balance needs no decryption at all. An earlier version called deriveEncKey() here, which
      // is a WALLET SIGNATURE — it blocks on a MetaMask prompt, so the "instant" balance sat on
      // "Checking for notes…" until the user signed. The blob holds only secrets; nothing a
      // balance needs is inside it.
      const value = BigInt(row.value ?? "0");
      if (value <= 0n) continue;

      // The symbol lives in the key: siphon-v3note-<chain>-<SYMBOL>-<commitment>.
      const rest = k.slice(prefix.length);
      const dash = rest.indexOf("-");
      if (dash <= 0) continue;
      const symbol = rest.slice(0, dash).toUpperCase();

      out.bySymbol[symbol] = (out.bySymbol[symbol] ?? 0n) + value;
      out.noteCount++;
    } catch {
      out.unreadable++;
    }
  }

  return out;
}

/** Strategy statuses whose funds are committed and NOT withdrawable. */
const ACTIVE_STRATEGY_STATUSES = new Set(["PENDING", "ARMED"]);

/**
 * Funds committed to live strategies, from the strategy list.
 *
 * Derived from the strategy records rather than from note reservations, because that is the same
 * number Activity shows (the two views cannot disagree), it needs no commitment-id lookup, and it
 * survives a device switch — reservations live in localStorage, strategies live on the server.
 *
 * TERMINAL STRATEGIES CONTRIBUTE NOTHING, `PARTIALLY_EXECUTED` INCLUDED. Unfired TWAP/grid legs
 * hold REAL on-chain slice-notes (trade-executor/app.py: "the split ran on-chain at submit"), so
 * those funds are already counted in the local balance above. Adding `strategy.amount` for a
 * terminal strategy would double-count them.
 */
export function getStrategyBalance(
  strategies: ReadonlyArray<{ status: string; amount: number; asset_in: string }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of strategies) {
    if (!ACTIVE_STRATEGY_STATUSES.has((s.status || "").toUpperCase())) continue;
    const sym = (s.asset_in || "").toUpperCase();
    if (!sym) continue;
    out[sym] = (out[sym] ?? 0) + (Number(s.amount) || 0);
  }
  return out;
}
