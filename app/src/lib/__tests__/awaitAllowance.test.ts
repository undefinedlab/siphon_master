// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { awaitAllowanceVisible } from "../v3/awaitAllowance";

/**
 * A 2 USDC deposit on Base died at `deposit.staticCall` with the adapter's genuine
 * "ERC20: transfer amount exceeds allowance" — no transaction was ever sent. The approve had
 * confirmed; `wait(1)` just returned before the node serving the next eth_call had the block.
 *
 * These pin the three things that matter: it keeps waiting while the read is stale, it stops the
 * moment the read catches up, and a read that never catches up does NOT become a refused deposit.
 */

const noSleep = async () => {};

describe("awaitAllowanceVisible", () => {
  test("returns immediately when the allowance is already visible", async () => {
    let reads = 0;
    const ok = await awaitAllowanceVisible(
      async () => {
        reads++;
        return 2_000_000n;
      },
      2_000_000n,
      { sleep: noSleep },
    );
    expect(ok).toBe(true);
    expect(reads).toBe(1); // no needless round trips on the happy path
  });

  test("keeps polling across a stale read and succeeds once the node catches up", async () => {
    const seen = [0n, 0n, 2_000_000n];
    let reads = 0;
    const ok = await awaitAllowanceVisible(
      async () => seen[reads++] ?? 2_000_000n,
      2_000_000n,
      { sleep: noSleep },
    );
    expect(ok).toBe(true);
    expect(reads).toBe(3);
  });

  test("an allowance below the amount is not accepted as visible", async () => {
    const ok = await awaitAllowanceVisible(async () => 1_999_999n, 2_000_000n, {
      tries: 3,
      sleep: noSleep,
    });
    expect(ok).toBe(false);
  });

  test("gives up after the budget and reports false rather than throwing", async () => {
    let reads = 0;
    const ok = await awaitAllowanceVisible(
      async () => {
        reads++;
        return 0n;
      },
      2_000_000n,
      { tries: 4, sleep: noSleep },
    );
    // False lets the caller proceed and fail for real: a stalled read is not proof the
    // allowance is missing, and must never turn a slow RPC into a refused deposit.
    expect(ok).toBe(false);
    expect(reads).toBe(4);
  });

  test("a throwing read is treated as lag, not as a verdict", async () => {
    let reads = 0;
    const ok = await awaitAllowanceVisible(
      async () => {
        reads++;
        if (reads < 3) throw new Error("missing revert data");
        return 2_000_000n;
      },
      2_000_000n,
      { sleep: noSleep },
    );
    expect(ok).toBe(true);
    expect(reads).toBe(3);
  });

  test("sleeps between attempts but never after the last one", async () => {
    const slept: number[] = [];
    await awaitAllowanceVisible(async () => 0n, 1n, {
      tries: 3,
      delayMs: 600,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([600, 600]); // 3 reads, 2 gaps
  });
});
