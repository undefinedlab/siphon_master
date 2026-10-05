// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { memberTtlMs } from "../v3/aspClientV3";

/**
 * /set/member answers one label per request and is rate limited at both the proxy (30/60s) and the
 * ASP. Screening asks about every note, so an 8-note wallet tripped it, every 429 became `null`,
 * and the screening list emptied — hiding In Review and its ragequit button on exactly the wallets
 * that had pending notes.
 *
 * The cache leans on an asymmetry: pending flips soon (the ~5 min admit bus), admitted only flips
 * on a rare revoke. Getting that backwards either hammers the limiter again or freezes a note in
 * "In Review" long after it was admitted, so pin it.
 */

const PENDING = 20_000;
const ADMITTED = 300_000;

describe("memberTtlMs", () => {
  test("an admitted, unrevoked label is cached long — it only changes on a rare revoke", () => {
    expect(memberTtlMs({ admitted: true, revoked: false }, PENDING, ADMITTED)).toBe(ADMITTED);
  });

  test("a pending label is re-asked often — the admit bus flips it within minutes", () => {
    expect(memberTtlMs({ admitted: false, revoked: false }, PENDING, ADMITTED)).toBe(PENDING);
  });

  test("a revoked label uses the short TTL even though it is admitted", () => {
    // Revocation is the state a user acts on via ragequit; it must not sit behind a 5 minute cache.
    expect(memberTtlMs({ admitted: true, revoked: true }, PENDING, ADMITTED)).toBe(PENDING);
  });

  test("revoked-and-not-admitted is also short", () => {
    expect(memberTtlMs({ admitted: false, revoked: true }, PENDING, ADMITTED)).toBe(PENDING);
  });

  test("the long TTL is strictly longer, or the cache saves nothing", () => {
    const admitted = memberTtlMs({ admitted: true, revoked: false });
    const pending = memberTtlMs({ admitted: false, revoked: false });
    expect(admitted).toBeGreaterThan(pending);
  });
});
