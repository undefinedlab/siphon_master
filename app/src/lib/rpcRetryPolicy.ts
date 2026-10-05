/**
 * Should a failed provider read be retried, and how many times?
 *
 * This lived inline in zkHandler's withRetry and was wrong twice, in opposite directions — once
 * too narrow (it claimed to absorb "an empty 0x from a lagging upstream" but matched only
 * `missing revert data`, so the case it was written for threw on the first attempt), then too
 * broad (retrying our own rate limiter, which cannot succeed and only spends more of the same
 * budget). zkHandler is not importable in a test — it pulls circomlibjs and wasm — so the decision
 * lives here as a pure function over the error text, where it can be checked.
 */

export type RetryPlan = { retry: boolean; maxTries: number };

/** Attempts allowed for an empty-0x read. See EMPTY_RETURN_TRIES rationale below. */
export const EMPTY_RETURN_TRIES = 3;

export function rpcRetryPlan(errorText: string, tries: number): RetryPlan {
  const msg = errorText || '';

  // OUR OWN proxy limiter (-32005 "rate_limited" / "rate_limited_heavy"), not an upstream one.
  // /api/rpc already retried the upstream 5x with backoff before it would surface a 429, and this
  // bucket is a 60s sliding window while the whole backoff budget is ~8s — so a retry cannot
  // succeed. It only spends more of the same per-IP allowance and keeps the bucket full, which is
  // how one burst becomes a self-sustaining 429 loop. Fail fast; the next poll gets a clean window.
  if (/rate_limited/i.test(msg)) return { retry: false, maxTries: tries };

  const rateLimited = /429|too many requests|rate.?limit/i.test(msg);

  // A "missing revert data" CALL_EXCEPTION (data=null, reason=null) is a lagging/flaky upstream.
  // A genuine revert carries data/reason and won't match, so we don't loop on real reverts.
  const transientCallException = /missing revert data/i.test(msg);

  // When the upstream answers HTTP 200 with `{"result":"0x"}` the decode fails FIRST and ethers
  // raises BAD_DATA — which is why matching only the line above missed it. Match the empty-0x
  // shape alone: a decode failure against real bytes is an ABI mismatch, deterministic, no retry.
  const emptyReturn = /BAD_DATA/.test(msg) && /value="0x"/.test(msg);

  if (!rateLimited && !transientCallException && !emptyReturn) {
    return { retry: false, maxTries: tries };
  }

  // An empty 0x is never served from cache (rpcCache refuses to store it), so every attempt is a
  // real upstream round trip charged against the per-IP budget. A lagging node recovers on the next
  // read or not at all, so 3 attempts buy the same recovery as 6 at half the spend — and keep a
  // permanently-0x address (a dead contract) from costing six calls on every poll.
  const emptyReturnOnly = emptyReturn && !rateLimited && !transientCallException;
  return {
    retry: true,
    maxTries: emptyReturnOnly ? Math.min(tries, EMPTY_RETURN_TRIES) : tries,
  };
}
