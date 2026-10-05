// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { screeningTotals, spendableBalances, type ScreeningRow } from "../v3/screeningTotals";

/**
 * A user deposited 2 + 1 + 0.5 USDC, saw 3.5 as private balance, ordered 3.5, and was told the
 * wallet was short — because arming skips notes the ASP has not admitted while the headline
 * counted them. These pin the split, and pin the two ways getting it wrong is worse than the bug:
 * an unreachable ASP must not zero the balance, and nothing may ever render negative.
 */

const rows: ScreeningRow[] = [
  { token: "USDC", amount: "1.0", phase: "checking" },
  { token: "USDC", amount: "0.5", phase: "checking" },
  { token: "ETH", amount: "0.002", phase: "flagged" },
];

describe("screeningTotals", () => {
  test("sums pending and flagged per token, keeping them apart", () => {
    const t = screeningTotals(rows);
    expect(t.checking.USDC).toBeCloseTo(1.5, 10);
    expect(t.flagged.ETH).toBeCloseTo(0.002, 10);
    expect(t.checking.ETH).toBeUndefined();
    expect(t.flagged.USDC).toBeUndefined();
  });

  test("ignores unparseable, zero and negative amounts", () => {
    const t = screeningTotals([
      { token: "USDC", amount: "nonsense", phase: "checking" },
      { token: "USDC", amount: "0", phase: "checking" },
      { token: "USDC", amount: "-5", phase: "checking" },
    ]);
    expect(t.checking.USDC).toBeUndefined();
  });

  test("no rows means no totals", () => {
    expect(screeningTotals([])).toEqual({ checking: {}, grace: {}, flagged: {} });
  });

  /**
   * The reported bug: after a swap, a 3 USDC deposit rendered as "0.01 USDC" private with
   * "2.98 in review". The 2.98 was the change note — ASP-ADMITTED and spendable — but still inside
   * its five-minute ragequit window, so it was phase `checking` and got subtracted from the
   * headline. An admitted note must never reduce the spendable figure.
   */
  test("an admitted note in its ragequit window is grace, not pending", () => {
    const t = screeningTotals([
      { token: "USDC", amount: "2.98", phase: "checking", admitted: true },
      { token: "USDC", amount: "0.25", phase: "checking", admitted: false },
    ]);
    expect(t.grace.USDC).toBeCloseTo(2.98, 10);
    expect(t.checking.USDC).toBeCloseTo(0.25, 10);
    // Only the genuinely unadmitted 0.25 comes off a 2.99 reconcile.
    expect(spendableBalances({ USDC: 2.99 }, t.checking).USDC).toBeCloseTo(2.74, 10);
  });

  test("a row with no admitted flag stays conservative and counts as pending", () => {
    const t = screeningTotals([{ token: "USDC", amount: "1.0", phase: "checking" }]);
    expect(t.checking.USDC).toBeCloseTo(1.0, 10);
    expect(t.grace.USDC).toBeUndefined();
  });

  test("a revoked note is flagged even when admitted was once true", () => {
    const t = screeningTotals([{ token: "USDC", amount: "1.0", phase: "flagged", admitted: true }]);
    expect(t.flagged.USDC).toBeCloseTo(1.0, 10);
    expect(t.grace.USDC).toBeUndefined();
    expect(t.checking.USDC).toBeUndefined();
  });
});

describe("spendableBalances", () => {
  test("the reported case: 3.5 reconciled with 1.5 pending is 2.0 spendable", () => {
    expect(spendableBalances({ USDC: 3.5 }, { USDC: 1.5 }).USDC).toBeCloseTo(2.0, 10);
  });

  test("an unreachable ASP leaves the headline untouched, never zeroed", () => {
    // Empty pending is "we don't know", not "everything is pending".
    expect(spendableBalances({ USDC: 3.5, ETH: 0.01 }, {})).toEqual({ USDC: 3.5, ETH: 0.01 });
  });

  test("never renders negative when pending exceeds the reconciled total", () => {
    // A reconcile lagging a spend can legitimately produce this; a negative balance must not ship.
    expect(spendableBalances({ USDC: 1 }, { USDC: 4 }).USDC).toBe(0);
  });

  test("subtracts per token and does not leak across tokens", () => {
    const out = spendableBalances({ USDC: 3.5, ETH: 0.01 }, { USDC: 1.5 });
    expect(out.USDC).toBeCloseTo(2.0, 10);
    expect(out.ETH).toBeCloseTo(0.01, 10);
  });

  test("a token that is entirely pending reads as zero, not as missing", () => {
    expect(spendableBalances({ USDC: 2 }, { USDC: 2 }).USDC).toBe(0);
  });
});
