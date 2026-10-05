import { expect, test } from "bun:test";
import { devnetSplitValues } from "../chains/solanaDevnetStrategy";

test("legs share the order evenly, the last takes the rounding, and the leftover rides last", () => {
  expect(devnetSplitValues(100n, 100n, 3)).toEqual([33n, 33n, 34n]);
  expect(devnetSplitValues(150n, 100n, 4)).toEqual([25n, 25n, 25n, 25n, 50n]);
  const v = devnetSplitValues(1_000_000_007n, 1_000_000_000n, 7);
  expect(v.reduce((a, b) => a + b, 0n)).toBe(1_000_000_007n);
});

test("a leg cannot be empty", () => {
  expect(() => devnetSplitValues(3n, 3n, 4)).toThrow();
});
