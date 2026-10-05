/**
 * Wait for a just-sent approve to become visible to reads.
 *
 * `approveTx.wait(1)` resolves as soon as ONE backend hands back a receipt. Base's RPC is load
 * balanced, so the next eth_call can land on a node that has not seen that block — and the deposit
 * flow's `deposit.staticCall` then simulates against allowance 0 and throws the asset adapter's
 * genuine `ERC20: transfer amount exceeds allowance`. No transaction is ever sent; the deposit just
 * dies at the prediction step.
 *
 * rpcRetryPlan cannot absorb this, and should not be widened to: that revert carries both data and
 * reason, so by error text alone it is indistinguishable from a real one, and retrying real reverts
 * is the "too broad" mistake that module's header already records. So wait on the precondition
 * itself rather than on the symptom.
 *
 * Lives in its own module because depositV3 pulls circomlibjs/wasm through noteCryptoV3 and is not
 * importable from a test — the same reason rpcRetryPolicy was split out of zkHandler.
 */

export type AwaitAllowanceOptions = {
  /** Reads after the first count as retries: 10 tries at 600ms covers ~5.4s of lag. */
  tries?: number;
  delayMs?: number;
  /** Injectable so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `readAllowance` until it reports at least `needed`.
 *
 * Returns true once it does, false if the budget runs out. False is NOT an error: the caller should
 * carry on and let the real call fail on its own, because a stalled read is not proof that the
 * allowance is missing — that keeps this from turning a slow RPC into a refused deposit.
 */
export async function awaitAllowanceVisible(
  readAllowance: () => Promise<bigint>,
  needed: bigint,
  opts: AwaitAllowanceOptions = {},
): Promise<boolean> {
  const tries = Math.max(1, opts.tries ?? 10);
  const delayMs = opts.delayMs ?? 600;
  const sleep = opts.sleep ?? defaultSleep;

  for (let i = 0; i < tries; i++) {
    let seen: bigint;
    try {
      seen = await readAllowance();
    } catch {
      // A throwing read is the lagging-node case this exists for, so keep waiting rather than
      // treating it as a verdict on the allowance.
      seen = 0n;
    }
    if (seen >= needed) return true;
    if (i < tries - 1) await sleep(delayMs);
  }
  return false;
}
