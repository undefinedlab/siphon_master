/**
 * Split a wallet's vault balance into spendable / in-review / flagged, from real ASP membership.
 *
 * The headline "private balance" is a claim that the money can be spent right now. The on-chain
 * reconcile cannot make that claim on its own: it counts every leaf the wallet owns, admitted or
 * not. Meanwhile the arming path (`acquireV3Note`) skips notes the ASP has not admitted. So a
 * just-mined deposit showed up instantly in the headline and was then refused for funding — the
 * number on screen and the number you could trade disagreed for the whole ~5 minute admit bus.
 *
 * The previous In Review figure came from an age heuristic that scanned the `siphon-note-` key
 * prefix. v3 notes are keyed `siphon-v3note-`, so it matched none of them and the row never
 * rendered on Base at all. This takes per-note admitted/revoked status instead.
 *
 * Pure and separate from the component so the arithmetic can be tested; UserDash pulls the rows
 * from listDepositScreening, which routes to listDepositScreeningV3.
 */

export type ScreeningRow = {
  token: string;
  /** Human decimal string, as listDepositScreening emits it. */
  amount: string;
  phase: "checking" | "flagged";
  /** ASP has admitted this note — see DepositScreening.admitted. */
  admitted?: boolean;
};

export type ScreeningTotals = {
  /** Deposited but not yet admitted by the ASP — NOT spendable. */
  checking: Record<string, number>;
  /** Admitted and spendable, but still inside the five-minute public-ragequit window.
   *
   * Split out of `checking` because the two were being subtracted from the headline together. A
   * swap mints a change note, the change note starts a fresh grace window, and the whole change
   * amount vanished from the spendable figure for five minutes: a 3 USDC deposit that had spent
   * 0.01 rendered as "0.01 USDC" with "2.98 in review", which reads as losing the deposit. These
   * notes are admitted; the window only means the public exit is still OFFERED. Never subtract
   * this from the spendable balance — only surface the ragequit affordance for it. */
  grace: Record<string, number>;
  /** Revoked — not spendable, recoverable only by ragequit. */
  flagged: Record<string, number>;
};

export function screeningTotals(rows: readonly ScreeningRow[]): ScreeningTotals {
  const checking: Record<string, number> = {};
  const grace: Record<string, number> = {};
  const flagged: Record<string, number> = {};
  for (const r of rows) {
    const amt = parseFloat(r.amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    // `admitted` is optional so an older row (or a caller that never learned to set it) keeps the
    // previous conservative behaviour: unknown counts as not-admitted.
    const bucket = r.phase === "flagged" ? flagged : r.admitted ? grace : checking;
    bucket[r.token] = (bucket[r.token] ?? 0) + amt;
  }
  return { checking, grace, flagged };
}

/**
 * Spendable balance per token: the reconciled total minus what is not yet admitted.
 *
 * `pending` empty means the ASP could not be reached. That must leave the headline UNCHANGED —
 * subtracting on no evidence would flash the balance to zero during an ASP blip, which is a far
 * worse lie than the one being fixed. Clamped at zero so a reconcile that lags a spend can never
 * render a negative balance.
 */
export function spendableBalances(
  reconciled: Record<string, number>,
  pending: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [symbol, amount] of Object.entries(reconciled)) {
    out[symbol] = Math.max(0, amount - (pending[symbol] ?? 0));
  }
  return out;
}
