// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { clampSlippageBps } from "../multiLegBuilder";

/**
 * TWAP/grid legs settle through Entrypoint.swapAndDeposit, whose minAmountOut is baked into the
 * proof at ARM time. That makes this the only place the user's slippage setting can take effect —
 * the executor's max_slippage_bps path (preflight_same_chain_swap) is unreachable for a same-chain
 * vault-output strategy. It used to be hardcoded to 100, so the Builder's control did nothing.
 */
describe("per-leg slippage clamp", () => {
  test("passes a normal setting straight through", () => {
    expect(clampSlippageBps(250)).toBe(250);
    expect(clampSlippageBps(1)).toBe(1);
    expect(clampSlippageBps(5000)).toBe(5000);
  });

  test("falls back to the previous hardcoded value when unset", () => {
    // An un-updated caller must behave exactly as it did before this was threaded through.
    for (const v of [undefined, null, NaN]) expect(clampSlippageBps(v)).toBe(100);
  });

  test("a zero or negative bound never reaches the proof", () => {
    // evm_executor rejects <=0 outright: on a fee-bearing AMM even a perfectly priced pool charges
    // its LP fee, so a 0 bound reverts AFTER the nullifier is spent. Arming one is unrecoverable.
    for (const v of [0, -1, -5000]) expect(clampSlippageBps(v)).toBe(100);
  });

  test("clamps to the executor's accepted ceiling", () => {
    // MAX_ALLOWED_SLIPPAGE_BPS = 5000. Anything above would be rejected server-side at fire time,
    // after arming has already been paid for.
    expect(clampSlippageBps(9999)).toBe(5000);
    expect(clampSlippageBps(1_000_000)).toBe(5000);
  });

  test("rounds fractional input rather than passing a non-integer on the wire", () => {
    expect(clampSlippageBps(150.6)).toBe(151);
  });
});
