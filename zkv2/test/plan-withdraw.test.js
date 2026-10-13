"use strict";

const { planWithdraw, MAX_INPUTS } = require("../sdk/planWithdraw.js");

const ASSET = "4096"; // uint160(0x1000) fixture token
const OTHER = "8192";

function note(value, id, assetId = ASSET) {
  return {
    commitment: `c${id}`,
    value: BigInt(value),
    label: `L${id}`,
    assetId,
    nullifier: `n${id}`,
    secret: `s${id}`,
  };
}

describe("planWithdraw — Policy 1 (single note)", () => {
  test("exact single note → N=1, zero change", () => {
    const p = planWithdraw([note(10, "a"), note(5, "b")], 10, ASSET);
    expect(p.inputCount).toBe(1);
    expect(p.selected[0].commitment).toBe("ca");
    expect(p.boundaryIndex).toBe(0);
    expect(p.primaryValue).toBe(10n);
    expect(p.secondaryValue).toBe(0n);
  });

  test("smallest single note >= target → fractional change carved from it", () => {
    // target 7; notes 5,8,20 → smallest single >= 7 is 8; change = 1
    const p = planWithdraw([note(5, "a"), note(20, "c"), note(8, "b")], 7, ASSET);
    expect(p.inputCount).toBe(1);
    expect(p.selected[0].commitment).toBe("cb"); // the 8-note
    expect(p.primaryValue).toBe(7n);
    expect(p.secondaryValue).toBe(1n);
    expect(p.secondaryValue).toBeLessThanOrEqual(p.selected[0].value);
  });

  test("exact preferred over a larger single fit", () => {
    const p = planWithdraw([note(8, "big"), note(7, "exact")], 7, ASSET);
    expect(p.selected[0].commitment).toBe("cexact");
    expect(p.secondaryValue).toBe(0n);
  });
});

describe("planWithdraw — Policy 2 (greedy multi-note)", () => {
  test("[10,5,3] target 12 → select 10+5, boundary=5, change=3", () => {
    const p = planWithdraw([note(10, "a"), note(5, "b"), note(3, "c")], 12, ASSET);
    expect(p.inputCount).toBe(2);
    // descending: 10 then 5; sum 15 >= 12
    expect(p.selected.map((n) => n.commitment)).toEqual(["ca", "cb"]);
    expect(p.boundaryIndex).toBe(1); // last = smallest selected = the 5-note
    expect(p.primaryValue).toBe(12n);
    expect(p.secondaryValue).toBe(3n); // < boundary value 5
    expect(p.secondaryValue).toBeLessThan(p.selected[p.boundaryIndex].value);
  });

  test("change is always strictly less than the boundary (smallest selected) value", () => {
    // target 22; notes 10,9,8 → 10+9=19<22, +8=27; boundary=8; change=5 (<8)
    const p = planWithdraw([note(8, "c"), note(10, "a"), note(9, "b")], 22, ASSET);
    expect(p.selected.map((n) => n.commitment)).toEqual(["ca", "cb", "cc"]);
    expect(p.boundaryIndex).toBe(2);
    expect(p.secondaryValue).toBe(5n);
    expect(p.secondaryValue).toBeLessThan(p.selected[2].value);
  });

  test("multi-note that sums exactly → zero change", () => {
    const p = planWithdraw([note(10, "a"), note(5, "b"), note(3, "c")], 15, ASSET);
    expect(p.selected.map((n) => n.commitment)).toEqual(["ca", "cb"]);
    expect(p.secondaryValue).toBe(0n);
    expect(p.primaryValue).toBe(15n);
  });
});

describe("planWithdraw — D1 per-asset scoping", () => {
  test("other-asset notes are never selected", () => {
    const p = planWithdraw(
      [note(100, "wrong", OTHER), note(10, "a"), note(5, "b")],
      12,
      ASSET,
    );
    expect(p.selected.every((n) => n.assetId === ASSET)).toBe(true);
    expect(p.selected.map((n) => n.commitment)).toEqual(["ca", "cb"]);
  });

  test("insufficient in-asset funds despite other-asset balance → throws", () => {
    expect(() =>
      planWithdraw([note(1000, "wrong", OTHER), note(5, "a")], 12, ASSET),
    ).toThrow(/insufficient funds/);
  });

  test("no notes for asset → throws", () => {
    expect(() => planWithdraw([note(10, "x", OTHER)], 5, ASSET)).toThrow(/no spendable notes/);
  });
});

describe("planWithdraw — guards", () => {
  test("non-positive target throws", () => {
    expect(() => planWithdraw([note(10, "a")], 0, ASSET)).toThrow(/positive/);
  });

  test("missing assetId throws", () => {
    expect(() => planWithdraw([note(10, "a")], 5)).toThrow(/assetId required/);
  });

  test("zero-value notes ignored", () => {
    const p = planWithdraw([note(0, "z"), note(10, "a")], 10, ASSET);
    expect(p.selected.map((n) => n.commitment)).toEqual(["ca"]);
  });

  test("needing more than MAX_INPUTS notes throws", () => {
    // seven 1-value notes, target 7 → needs 7 inputs > MAX_INPUTS(6)
    const notes = Array.from({ length: 7 }, (_, i) => note(1, `n${i}`));
    expect(() => planWithdraw(notes, 7, ASSET)).toThrow(/MAX_INPUTS/);
    expect(MAX_INPUTS).toBe(6);
  });

  test("exactly MAX_INPUTS notes is allowed", () => {
    const notes = Array.from({ length: 6 }, (_, i) => note(1, `n${i}`));
    const p = planWithdraw(notes, 6, ASSET);
    expect(p.inputCount).toBe(6);
    expect(p.secondaryValue).toBe(0n);
  });

  test("string and number values accepted", () => {
    const mixed = [
      { commitment: "cs", value: "10", label: "L", assetId: ASSET, nullifier: "n", secret: "s" },
      { commitment: "cn", value: 5, label: "L2", assetId: ASSET, nullifier: "n2", secret: "s2" },
    ];
    const p = planWithdraw(mixed, 10, ASSET);
    expect(p.selected[0].commitment).toBe("cs");
    expect(p.secondaryValue).toBe(0n);
  });
});
