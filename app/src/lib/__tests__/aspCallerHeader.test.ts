// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { callerHeader } from "../aspServerUrl";

/**
 * The ASP rate-limits per client, but every browser read reaches it through this one server, so
 * its bucket was global: 60 req/min shared by the whole userbase. This header restores per-wallet
 * bucketing. Anything that could collapse users back into one bucket is the regression to catch.
 */
describe("callerHeader", () => {
  test("a wallet becomes a lowercase caller header", () => {
    expect(callerHeader("0xAbCdef0123456789abcdef0123456789ABcdEF01")).toEqual({
      "X-Siphon-Caller": "0xabcdef0123456789abcdef0123456789abcdef01",
    });
  });

  test("the `optional` sentinel is NOT a bucket", () => {
    // gatePrivilegedProxy returns this for unauthenticated reads. Bucketing on it would put every
    // anonymous caller in one bucket — exactly the global cap this change removes.
    expect(callerHeader("optional")).toEqual({});
  });

  test("undefined, empty and malformed values send no header (ASP falls back to IP)", () => {
    expect(callerHeader(undefined)).toEqual({});
    expect(callerHeader("")).toEqual({});
    expect(callerHeader("0x123")).toEqual({});
    expect(callerHeader("not-an-address")).toEqual({});
  });

  test("a non-hex 42-char string is rejected", () => {
    expect(callerHeader("0xZZcdef0123456789abcdef0123456789abcdef01")).toEqual({});
  });
});
