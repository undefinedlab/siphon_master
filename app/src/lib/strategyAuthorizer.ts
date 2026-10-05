// Browser-side execution authorization for client-side-FHE strategies.
//
// The scheduler "arms" a strategy each cycle: it computes the *encrypted* trigger bit on the
// FHE engine and stores it, but it cannot decrypt (it has no client key). So execution must be
// authorized by the browser: poll the encrypted result, decrypt it locally with the user's
// client key, and when it says "triggered" call /executeStrategy to run the on-chain trade.

import { decryptResult, getStoredClientKey, restoreInFlight } from "@/lib/fhe";

import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import { getSigner } from "@/lib/nexus";
import { getWalletAuthHeaders, getWalletWriteAuthHeaders, getCachedWalletAuthHeaders } from "@/lib/walletAuthHeaders";

function baseUrl(): string {
  return getTradeExecutorBaseUrl();
}

/** Write-challenge headers — never send API_TOKEN from the browser. */
async function writeAuthHeaders(userId: string): Promise<Record<string, string>> {
  // Solana Devnet: Phantom session (executor SOLANA_DEVNET_ARM_OPEN=1 + signature). First: an
  // EVM signer, if one is also connected, cannot speak for a Phantom id.
  if (userId && !userId.startsWith("0x")) {
    const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
    return { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) };
  }
  const signer = getSigner();
  if (signer) return getWalletWriteAuthHeaders(signer);
  return { "Content-Type": "application/json", ...getCachedWalletAuthHeaders(userId) };
}

export interface StrategyResult {
  status: string; // PENDING | ARMED | EXECUTED | ...
  encrypted_result: string | null;
  result_updated_at: string | null;
}

export async function fetchStrategyResult(
  strategyId: string,
  userId?: string,
): Promise<StrategyResult> {
  const signer = getSigner();
  const headers =
    userId && !userId.startsWith("0x")
      ? await (await import("@/lib/solanaWalletAuth")).getSolanaExecutorHeaders()
      : signer
        ? await getWalletAuthHeaders(signer)
        : getCachedWalletAuthHeaders(userId ?? "");
  const res = await fetch(`${baseUrl()}/strategy/${encodeURIComponent(strategyId)}/result`, {
    headers,
  });
  if (!res.ok) throw new Error(`result fetch failed: HTTP ${res.status}`);
  return res.json();
}

export interface ExecuteResponse {
  status: string;
  tx_hash?: string;
  error?: string;
  code?: string;
  [key: string]: unknown;
}

export async function authorizeExecution(
  strategyId: string,
  userId: string,
  /** refresh_only: attach a fresh Devnet proof to a resting order without firing it. */
  extra?: { zkp_data?: unknown; refresh_only?: boolean; leg_index?: number },
): Promise<ExecuteResponse> {
  const res = await fetch(`${baseUrl()}/executeStrategy`, {
    method: "POST",
    headers: await writeAuthHeaders(userId),
    body: JSON.stringify({
      strategy_id: strategyId,
      user_id: userId,
      ...(extra?.zkp_data ? { zkp_data: extra.zkp_data } : {}),
      ...(extra?.refresh_only ? { refresh_only: true } : {}),
      ...(extra?.leg_index !== undefined ? { leg_index: extra.leg_index } : {}),
    }),
  });
  const json = (await res.json()) as ExecuteResponse;
  if (!res.ok) return { status: "error", error: json?.error || `HTTP ${res.status}` };
  return json;
}

export interface AuthorizeCallbacks {
  /** No encrypted result yet (waiting for the scheduler's first evaluation). */
  onWaiting?: (msg: string) => void;
  /** Decrypted result = not triggered this cycle; will keep polling. */
  onNotTriggered?: (msg: string) => void;
  /** Decrypted result = triggered; about to authorize execution. */
  onTriggered?: () => void;
  /** Execution finished on-chain. */
  onExecuted?: (txHash?: string) => void;
  /** Terminal error (execution failed / no client key / timeout). */
  onError?: (msg: string) => void;
}

export interface AuthorizeResult {
  executed: boolean;
  txHash?: string;
  error?: string;
  timedOut?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a single strategy until it's executed, errors, or times out. When the encrypted result
 * decrypts to "triggered", authorize execution via /executeStrategy. Self-terminating.
 *
 * The client key for `userId` must be present in this browser (it submitted the strategy).
 */
export async function pollAndAuthorize(
  strategyId: string,
  userId: string,
  cb: AuthorizeCallbacks = {},
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<AuthorizeResult> {
  const intervalMs = opts.intervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 180_000; // 3 min — covers a couple scheduler cycles

  // A restore may be in flight (localStorage or server tier). getStoredClientKey is synchronous
  // and returns null during that window, so waiting here is the difference between telling the
  // user their key is missing and it simply not having landed yet.
  let clientKey = getStoredClientKey(userId);
  if (!clientKey) {
    await restoreInFlight(userId);
    clientKey = getStoredClientKey(userId);
  }
  if (!clientKey) {
    const msg = "No FHE client key on this device for your wallet — can't decrypt the result here.";
    cb.onError?.(msg);
    return { executed: false, error: msg };
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let res: StrategyResult;
    try {
      res = await fetchStrategyResult(strategyId, userId);
    } catch (e) {
      cb.onWaiting?.(`result not available yet (${(e as Error).message})`);
      await sleep(intervalMs);
      continue;
    }

    if (res.status === "EXECUTED") {
      cb.onExecuted?.();
      return { executed: true };
    }

    if (res.encrypted_result) {
      let triggered = false;
      try {
        triggered = await decryptResult(res.encrypted_result, clientKey);
      } catch (e) {
        cb.onError?.(`decrypt failed: ${(e as Error).message}`);
        return { executed: false, error: "decrypt failed" };
      }

      if (triggered) {
        cb.onTriggered?.();
        const exec = await authorizeExecution(strategyId, userId);
        if (exec.error || exec.status === "error") {
          cb.onError?.(exec.error || "execution failed");
          return { executed: false, error: exec.error || "execution failed" };
        }
        cb.onExecuted?.(exec.tx_hash);
        return { executed: true, txHash: exec.tx_hash };
      }
      cb.onNotTriggered?.("price condition not met yet — still watching");
    } else {
      cb.onWaiting?.("awaiting first encrypted evaluation from the scheduler");
    }

    await sleep(intervalMs);
  }

  cb.onError?.("timed out waiting for the strategy to trigger");
  return { executed: false, timedOut: true };
}
