/**
 * Phantom (ed25519) auth for the Devnet vault: one day-long session signature per wallet per tab
 * proves the wallet to both the trade executor (X-Solana-* headers) and the privileged same-origin
 * proxies (apiWalletAuth.verifySolanaDevnetSession; session-allowlisted routes only).
 */
import { getPhantom } from "@/lib/chains/solanaWallet";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Same-origin fetch with the Phantom Devnet session (no popup once the tab has signed it). */
export async function fetchWithSolanaAuth(pathWithQuery: string, init: RequestInit = {}): Promise<Response> {
  return fetch(pathWithQuery, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
      ...(await getSolanaExecutorHeaders()),
    },
  });
}

/** Keep in sync with the executor's wallet_auth.SOLANA_SESSION_PREFIX / SOLANA_SESSION_MAX_SEC. */
const EXECUTOR_SESSION_PREFIX = "Siphon devnet session v1";
const EXECUTOR_SESSION_SEC = 24 * 60 * 60;
const SESSION_STORE = "siphon-sol-exec-session:";
const executorSessions = new Map<string, { headers: Record<string, string>; expires: number }>();
const executorInflight = new Map<string, Promise<Record<string, string>>>();

export function solanaExecutorSessionMessage(wallet: string, expires: number): string {
  return `${EXECUTOR_SESSION_PREFIX}\nwallet:${wallet}\nexpires:${expires}`;
}

/**
 * Headers proving a Phantom wallet to the trade executor's Devnet routes (createStrategy, key
 * upload, strategy list/result, execute, abort) and to the ASP proxies. One signMessage per wallet per day, kept for the
 * tab: the executor checks the ed25519 signature over the wallet and expiry on every request.
 */
export async function getSolanaExecutorHeaders(): Promise<Record<string, string>> {
  const phantom = getPhantom();
  const wallet = phantom?.publicKey?.toString();
  if (!phantom?.signMessage || !wallet) throw new Error("Connect Phantom to use the Devnet vault.");
  const now = Math.floor(Date.now() / 1000);
  let hit = executorSessions.get(wallet);
  if (!hit) {
    try {
      const raw = sessionStorage.getItem(SESSION_STORE + wallet);
      if (raw) hit = JSON.parse(raw);
    } catch { /* private window / blocked storage: sign again */ }
  }
  if (hit && hit.expires - 300 > now) return { ...hit.headers };
  const pending = executorInflight.get(wallet);
  if (pending) return pending;

  const promise = (async () => {
    const expires = now + EXECUTOR_SESSION_SEC;
    const message = new TextEncoder().encode(solanaExecutorSessionMessage(wallet, expires));
    const { signature } = await phantom.signMessage!(message, "utf8");
    const entry = {
      expires,
      headers: {
        "X-Solana-Address": wallet,
        "X-Solana-Session": toBase64(signature),
        "X-Solana-Expires": String(expires),
      },
    };
    executorSessions.set(wallet, entry);
    try {
      sessionStorage.setItem(SESSION_STORE + wallet, JSON.stringify(entry));
    } catch { /* memory only */ }
    return { ...entry.headers };
  })().finally(() => executorInflight.delete(wallet));
  executorInflight.set(wallet, promise);
  return promise;
}
