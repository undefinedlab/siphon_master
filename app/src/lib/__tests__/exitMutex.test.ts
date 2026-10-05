// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { ragequit, recoverAllRejected } from "../handler";

/**
 * Every exit control was pressed at once — the balance card's Ragequit, the Activity Log's
 * Ragequit all, and Recover all — and all three started. They live in two components with two
 * independent busy flags, and `ragequitLocked` did not include `ragequitAllBusy`, so pressing one
 * left the others enabled.
 *
 * The nullifier set means a double spend was never possible; the cost was wasted proofs and a
 * NullifierAlreadyUsed after the fact. The lock sits at the shared entry point rather than in a
 * component, because a component's flag cannot see the other component.
 */

describe("one exit at a time", () => {
  test("a second ragequit started during the first is refused, not run", async () => {
    const [first, second] = await Promise.all([
      ragequit("USDC", "note-a"),
      ragequit("USDC", "note-b"),
    ]);
    expect(second.error).toContain("Another exit is already running");
    // The first is allowed through — it fails only because these tests have no wallet.
    expect(first.error).not.toContain("Another exit is already running");
  });

  test("Recover all cannot run alongside a ragequit", async () => {
    const [, recover] = await Promise.all([
      ragequit("USDC", "note-a"),
      recoverAllRejected({ flaggedOnly: true }),
    ]);
    expect(recover.error).toContain("Another exit is already running");
  });

  test("the lock is released when the exit finishes, including on failure", async () => {
    await ragequit("USDC", "note-a");
    const after = await ragequit("USDC", "note-b");
    expect(after.error).not.toContain("Another exit is already running");
  });
});
