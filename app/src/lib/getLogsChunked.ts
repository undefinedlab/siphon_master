import { ethers } from "ethers";

// Keep every eth_getLogs call comfortably below common hosted-RPC limits. Some wallet RPCs cap
// requests at 50k blocks (MetaMask currently reports this as -32603), while free tiers can be much
// smaller. The scanner shrinks this further if a provider rejects the initial window.
const DEFAULT_GETLOGS_CHUNK = 9_000;

function configuredChunkSize(): number {
  const configured = Number.parseInt(process.env.NEXT_PUBLIC_GETLOGS_CHUNK || "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_GETLOGS_CHUNK;
}

function errorText(err: unknown): string {
  try {
    return `${JSON.stringify(err ?? "")} ${err instanceof Error ? err.message : String(err ?? "")}`;
  } catch {
    return err instanceof Error ? err.message : String(err ?? "");
  }
}

/** Retry a provider call with exponential backoff when the RPC rate-limits. */
async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  let delay = 300;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = errorText(err);
      const retryable = /429|too many requests|rate.?limit|missing revert data/i.test(msg);
      if (attempt >= tries - 1 || !retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 4_000);
    }
  }
}

/** Pull a provider-suggested inclusive block span out of an RPC error, if present. */
function suggestedRangeFromError(err: unknown): number | null {
  const match = errorText(err).match(/\[0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+)\]/);
  if (!match) return null;
  const span = Number.parseInt(match[2], 16) - Number.parseInt(match[1], 16) + 1;
  return span > 0 ? span : null;
}

/** Only range/response-size failures are made better by retrying with a smaller block window. */
function isRangeLimitError(err: unknown): boolean {
  return /block range|maximum block|ranges? over \d[\d,]* blocks|limited to.{0,40}range|query returned more than|too many (?:logs|results)|response size|log response size/i.test(
    errorText(err),
  );
}

/**
 * Scan an inclusive block range without asking an RPC for an unbounded `0..latest` log query.
 * If a provider rejects the initial window, retry with progressively smaller windows.
 */
export async function getLogsChunked(
  provider: Pick<ethers.Provider, "getLogs">,
  filter: { address: string; topics: (string | null)[] },
  fromBlock: number,
  toBlock: number,
  initialChunk = configuredChunkSize(),
): Promise<ethers.Log[]> {
  if (toBlock < fromBlock) return [];

  const out: ethers.Log[] = [];
  let chunk = Math.max(1, Math.trunc(initialChunk));
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const logs = await withRetry(() =>
        provider.getLogs({ ...filter, fromBlock: start, toBlock: end }),
      );
      out.push(...logs);
      start = end + 1;
    } catch (err) {
      // Authentication, CORS, HTTP transport, and upstream availability errors do not improve with
      // smaller ranges. Throw immediately so one failure cannot turn into a console/RPC storm.
      if (!isRangeLimitError(err)) throw err;

      const suggested = suggestedRangeFromError(err);
      if (suggested && suggested < chunk) {
        chunk = suggested;
        continue;
      }
      if (chunk > 1) {
        chunk = Math.max(1, Math.floor(chunk / 2));
        continue;
      }
      throw err;
    }
  }
  return out;
}
