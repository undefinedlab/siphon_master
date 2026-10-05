// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { applyScreening } from "../../components/navs/UserDash/ActivityLog";

/**
 * The reported bug: five Base deposits showed as pending in the Activity Log while the ASP had
 * admitted every one of that wallet's labels. applyScreening keyed off `phase` alone, but a
 * `checking` row means either "not admitted yet" OR "admitted, ragequit window still open" —
 * DepositScreening.admitted is the field that separates them.
 */

const row = (over = {}) => ({
  id: "r1",
  kind: "deposit",
  title: "Deposit 0.5 USDC",
  subtitle: "Vault deposit",
  status: "confirmed",
  statusClass: "executed",
  timestamp: new Date(0).toISOString(),
  txHash: null,
  relatedTxHash: null,
  isActive: false,
  ...over,
});

const screen = (over = {}) => ({
  noteKey: "siphon-v3note-8453-USDC-c1",
  token: "USDC",
  amount: "0.5",
  phase: "checking" as const,
  admitted: true,
  isOriginal: true,
  depositor: "0xdead",
  ...over,
});

describe("applyScreening", () => {
  test("an ADMITTED note keeps its confirmed status — it is not waiting on the ASP", () => {
    const out = applyScreening(row() as never, screen() as never);
    expect(out.status).toBe("confirmed");
    expect(out.statusClass).toBe("executed");
    expect(out.subtitle).toBe("Vault deposit");
  });

  test("an ADMITTED note still carries its note metadata", () => {
    const out = applyScreening(row() as never, screen() as never);
    expect(out.noteKey).toBe("siphon-v3note-8453-USDC-c1");
    expect(out.isOriginal).toBe(true);
  });

  test("a genuinely un-admitted note still reads as in checking", () => {
    const out = applyScreening(row() as never, screen({ admitted: false }) as never);
    expect(out.status).toBe("in checking");
    expect(out.statusClass).toBe("checking");
    expect(out.isActive).toBe(true);
  });

  test("an absent `admitted` field is treated as not admitted, never as admitted", () => {
    // Fail-closed: an older row without the field must not silently read as admitted.
    const out = applyScreening(row() as never, screen({ admitted: undefined }) as never);
    expect(out.statusClass).toBe("checking");
  });

  test("a FLAGGED note is unaffected by the admitted shortcut", () => {
    const out = applyScreening(
      row() as never,
      screen({ phase: "flagged", admitted: true }) as never,
    );
    expect(out.statusClass).toBe("flagged");
    expect(out.subtitle).toBe("Screening failed");
  });

  // Real deposit rows are SAVED as "in checking" (UserDash records them at submit) — the cases
  // above start from "confirmed", which is how the stale clock + ragequit row slipped through.
  const stored = (ageMs: number) =>
    row({ status: "in checking", statusClass: "checking", isActive: true, timestamp: new Date(1_000_000 - ageMs).toISOString() });

  test("a stored 'in checking' deposit settles once its window passes with no screening row", () => {
    const out = applyScreening(stored(6 * 60_000) as never, undefined, 1_000_000);
    expect(out.statusClass).toBe("executed");
    expect(out.isActive).toBe(false);
  });

  test("inside the window with no screening row it stays as stored (ASP may still answer)", () => {
    const out = applyScreening(stored(60_000) as never, undefined, 1_000_000);
    expect(out.statusClass).toBe("checking");
  });

  test("an ADMITTED note overrides a stored 'in checking' — no clock on a spendable deposit", () => {
    const out = applyScreening(stored(60_000) as never, screen() as never, 1_000_000);
    expect(out.statusClass).toBe("executed");
    expect(out.status).toBe("confirmed");
  });

  test("a waiting note shows a live bus countdown and its open exit window", () => {
    const now = 1_000_000;
    const out = applyScreening(
      stored(60_000) as never,
      screen({ admitted: false, busEtaMs: now + 125_000, graceDeadlineMs: now + 240_000 }) as never,
      now,
    );
    expect(out.subtitle).toBe("Not spendable yet — next compliance bus in 2:05 · public ragequit open 4:00 more");
    expect(out.ragequitOpen).toBe(true);
  });

  test("past the exit window a still-waiting note stays in review but loses the ragequit button", () => {
    const now = 1_000_000;
    const out = applyScreening(
      stored(6 * 60_000) as never,
      screen({ admitted: false, busEtaMs: now - 1_000, graceDeadlineMs: now - 60_000 }) as never,
      now,
    );
    expect(out.statusClass).toBe("checking");
    expect(out.subtitle).toMatch(/boarding the compliance bus now/);
    expect(out.ragequitOpen).toBe(false);
  });
});

