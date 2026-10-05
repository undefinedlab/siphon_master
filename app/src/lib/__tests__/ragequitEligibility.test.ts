// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { isRevokedByLeaf, ragequitBlockedReason } from "../v3/ragequitEligibility";

/**
 * A 0.01 USDC deposit was ragequit one minute after landing and failed with
 * "asp path: label ... not member" — the shared witness assembler demanding an ASP inclusion path
 * that ragequit.circom never reads. Removing that gate exposes the real constraint underneath:
 * §5.2.1 forbids ragequit for a clean, not-yet-admitted label once the ASP is non-empty.
 */

describe("ragequitBlockedReason", () => {
  test("a revoked label may exit", () => {
    expect(ragequitBlockedReason(1, "7590037809282334063115716201269092906393636833769827450590653969740658264882")).toBeNull();
  });

  test("a clean pending label is blocked, and the message says to wait", () => {
    const reason = ragequitBlockedReason(1, "0");
    expect(reason).toBeTruthy();
    expect(reason).toContain("admits");
  });

  test("the bootstrap branch is left to the circuit's own empty-ASP check", () => {
    expect(ragequitBlockedReason(0, "0")).toBeNull();
  });
});

describe("isRevokedByLeaf", () => {
  test("leaf 0 is the SMT's non-membership slot", () => {
    expect(isRevokedByLeaf("0")).toBe(false);
  });

  test("any other leaf is a real revocation", () => {
    expect(isRevokedByLeaf("759003780928233406311571620126909290639363683376982745059065396974")).toBe(true);
  });

  test("a missing leaf reads as not revoked rather than throwing", () => {
    // The ASP omits claimedLeaf on some responses; defaulting to revoked would hand out an exit.
    expect(isRevokedByLeaf(undefined as unknown as string)).toBe(false);
  });
});
