// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { selectConsolidationInputs, selectMergeInputs, MERGE_MAX_INPUTS } from "../v3/selectMergeInputs";

/**
 * The reported case: 2 + 1 + 0.5 USDC in the vault, a 3.5 order refused with "not enough balance"
 * because no single note covered it and the flow tried to deposit 3.5 more from a wallet holding
 * 1.03. These pin that the subset is found, that it stays inside the circuit's 6-input ceiling,
 * and that it never claims to fund an order it cannot.
 */

const usdc = (n: string) => ({ value: BigInt(Math.round(parseFloat(n) * 1e6)) });

describe("selectMergeInputs", () => {
  test("the reported case: 2 + 1 + 0.5 funds a 3.5 order", () => {
    const picked = selectMergeInputs([usdc("2"), usdc("1"), usdc("0.5")], usdc("3.5").value);
    expect(picked).not.toBeNull();
    expect(picked!.length).toBe(3);
    expect(picked!.reduce((a, n) => a + n.value, 0n)).toBe(usdc("3.5").value);
  });

  test("largest-first takes the fewest notes, leaving small ones intact", () => {
    // 5 covers a 4 order alone once combined with nothing else; the 0.1s must stay untouched.
    const picked = selectMergeInputs(
      [usdc("0.1"), usdc("3"), usdc("0.1"), usdc("2"), usdc("0.1")],
      usdc("4").value,
    );
    expect(picked!.map((n) => n.value)).toEqual([usdc("3").value, usdc("2").value]);
  });

  test("returns null when a single note already covers it — that is the caller's cheaper path", () => {
    // 5 alone covers 3, so the greedy walk stops at one note and this is not a merge.
    expect(selectMergeInputs([usdc("5"), usdc("1")], usdc("3").value)).toBeNull();
  });

  test("returns null when the total is genuinely short", () => {
    expect(selectMergeInputs([usdc("1"), usdc("0.5")], usdc("3.5").value)).toBeNull();
  });

  test("never exceeds the circuit's 6-input ceiling", () => {
    const eight = Array.from({ length: 8 }, () => usdc("1"));
    const picked = selectMergeInputs(eight, usdc("6").value);
    expect(picked!.length).toBe(MERGE_MAX_INPUTS);
  });

  test("null when the balance is sufficient but spread across more notes than the circuit takes", () => {
    // 8 x 1 = 8 covers 7, but only 6 can be spent in one proof. Honest null, so the caller
    // deposits rather than building a merge the circuit cannot prove.
    const eight = Array.from({ length: 8 }, () => usdc("1"));
    expect(selectMergeInputs(eight, usdc("7").value)).toBeNull();
  });

  test("ignores zero-value notes rather than wasting an input slot on them", () => {
    const picked = selectMergeInputs(
      [usdc("2"), { value: 0n }, usdc("1.5") ],
      usdc("3.5").value,
    );
    expect(picked!.length).toBe(2);
    expect(picked!.every((n) => n.value > 0n)).toBe(true);
  });

  test("a zero or negative target is never a merge", () => {
    expect(selectMergeInputs([usdc("2"), usdc("2")], 0n)).toBeNull();
    expect(selectMergeInputs([usdc("2"), usdc("2")], -1n)).toBeNull();
  });

  test("exact-sum selection is accepted, not treated as short", () => {
    const picked = selectMergeInputs([usdc("2"), usdc("1")], usdc("3").value);
    expect(picked!.reduce((a, n) => a + n.value, 0n)).toBe(usdc("3").value);
  });

  test("does not mutate the caller's array", () => {
    const notes = [usdc("1"), usdc("3"), usdc("2")];
    const before = notes.map((n) => n.value);
    selectMergeInputs(notes, usdc("4").value);
    expect(notes.map((n) => n.value)).toEqual(before);
  });
});

describe("selectConsolidationInputs", () => {
  const notes = (...v: number[]) => v.map((n) => ({ value: BigInt(n) }));

  test("seven notes against a cap of six costs ONE merge2, not a merge6", () => {
    // The reported wallet: 3.81 USDC over seven notes. merge2's proving key is 45 MB; merge6's is
    // 144 MB, downloaded and proved in the browser — the wrong pick looks like a hang.
    const picked = selectConsolidationInputs(notes(200, 100, 50, 10, 10, 10, 1), 7);
    expect(picked).not.toBeNull();
    expect(picked!.map((n) => Number(n.value))).toEqual([10, 1]);
  });

  test("folds the SMALLEST of the selection, leaving big notes whole", () => {
    const picked = selectConsolidationInputs(notes(500, 200, 100, 50, 20, 10, 5, 1), 8);
    expect(picked!.map((n) => Number(n.value))).toEqual([10, 5, 1]);
  });

  test("never asks for a circuit that does not exist", () => {
    // Needing 20 inputs would want a merge15; cap at merge6 and let the loop take another pass.
    const picked = selectConsolidationInputs(
      notes(...Array.from({ length: 20 }, (_, i) => 20 - i)),
      20,
    );
    expect(picked!.length).toBe(MERGE_MAX_INPUTS);
  });

  test("a plan that already fits is not worth a proof", () => {
    expect(selectConsolidationInputs(notes(200, 100, 50, 10, 10, 10), 6)).toBeNull();
  });

  test("a single note cannot be merged with itself", () => {
    expect(selectConsolidationInputs(notes(5), 7)).toBeNull();
  });

  test("zero-value notes are not worth a proof", () => {
    expect(selectConsolidationInputs(notes(5, 0, 0), 7)).toBeNull();
  });
});
