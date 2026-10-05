// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { canRagequitRow } from "../../components/navs/UserDash/ActivityLog";

/**
 * Pending deposits obtain a deposit-bound ASP exit ticket before using the existing revoked
 * ragequit branch. Both pending and already-flagged originals therefore expose the control.
 */

const row = (over: Record<string, unknown> = {}) => ({
  kind: "deposit",
  noteKey: "siphon-v3note-8453-USDC-123",
  isOriginal: true,
  statusClass: "flagged",
  ...over,
});

describe("canRagequitRow", () => {
  test("a flagged deposit can exit", () => {
    expect(canRagequitRow(row())).toBe(true);
  });

  test("an in-review deposit can obtain an exit ticket and exit", () => {
    expect(canRagequitRow(row({ statusClass: "checking" }))).toBe(true);
  });

  test("an admitted deposit cannot — private withdraw only", () => {
    expect(canRagequitRow(row({ statusClass: "admitted" }))).toBe(false);
  });

  test("a checking deposit past its exit window is not offered (the server would refuse)", () => {
    expect(canRagequitRow(row({ statusClass: "checking", ragequitOpen: false }))).toBe(false);
  });

  test("an already-ragequit row is not offered again", () => {
    expect(canRagequitRow(row({ statusClass: "ragequit" }))).toBe(false);
  });

  test("a withdraw row is never a ragequit", () => {
    expect(canRagequitRow(row({ kind: "withdraw" }))).toBe(false);
  });

  test("no note key means nothing to prove with", () => {
    expect(canRagequitRow(row({ noteKey: null }))).toBe(false);
  });

  test("a change note is not the original deposit", () => {
    expect(canRagequitRow(row({ isOriginal: false }))).toBe(false);
  });
});
