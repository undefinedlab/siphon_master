/**
 * Wallet-sig auth headers for trade-executor and privileged Next proxies.
 *
 * Reads (executor): long-lived cached signature over `Siphon auth v1:<timestamp>` (localStorage).
 * Writes (executor): short-lived challenge — POST /auth/challenge {chain_id}, then sign
 *   `Siphon auth v2:write:<chainId>:<nonce>` (built here from the chain we mean; see writeChallengeMessage).
 * Privileged Next proxies (OMEGA-01):
 *   - Soft session `Siphon auth v1:session:<path>:<ts>` — one in-memory sign per allowlisted route.
 *   - Hard routes (prove): full `req:METHOD:path:bodySha256:ts` binding.
 *   - Never localStorage.
 *
 * Never send API_TOKEN from the browser. Executor-only routes use server-side tokens.
 */
import { Signer } from 'ethers';
import { getSelectedChainId } from '@/lib/networks';
import { getTradeExecutorBaseUrl } from '@/lib/tradeExecutorClient';

import { signGuarded, type SignaturePurpose } from './walletSignatureGate';

const SIGN_MESSAGE_AUTH_BASE = 'Siphon auth v1';
/**
 * The text a write is signed over. The chain is load-bearing (OVERLORD G-8): each executor only
 * issues nonces for the chains it serves, so a nonce a compromised Arbitrum box fetches from the
 * Base executor can never carry a signature made for 42161. Always built from OUR chain, never
 * from text a server returns.
 */
export function writeChallengeMessage(chainId: number | null, nonce: string): string {
  // null = a pre-G-8 executor's unbound nonce (the Arbitrum box until it is upgraded). Safe to sign:
  // the Base executor never issues unbound nonces and only verifies v2 over a chain binding, so a
  // v1 signature is useless anywhere but the legacy host that issued the nonce.
  return chainId === null ? `Siphon auth v1:write:${nonce}` : `Siphon auth v2:write:${chainId}:${nonce}`;
}
const PRIVILEGED_REQ_PREFIX = 'Siphon auth v1:req';
/** Keep in sync with apiWalletAuth.PRIVILEGED_SESSION_PREFIX */
const PRIVILEGED_SESSION_PREFIX = 'Siphon auth v1:session';
/** Keep in sync with apiWalletAuth.PRIVILEGED_PATH_SCOPE_BODY */
const PRIVILEGED_PATH_SCOPE_BODY = '*';
/** Soft privileged session paths — keep in sync with apiWalletAuth. */
import {
  SESSION_HEADER,
  SESSION_KEY_HEADER,
  awaitPendingSession,
  ensureSession,
  hasSession,
  sessionDelegationStillValid,
  signWithSession,
  signWithSessionSync,
} from './sessionKey';

const PRIVILEGED_SESSION_ALLOWLIST = new Set([
  '/api/builder-agent',
  '/api/asp-set/root',
  '/api/asp-set/path',
  '/api/asp-set/smt-path',
  '/api/asp-set/member',
  '/api/asp-screen',
  '/api/compliance-fee',
]);
/** Path-scope fallback (builder bodies). */
const PRIVILEGED_PATH_SCOPE_ALLOWLIST = new Set(['/api/builder-agent']);
/** Keep in sync with apiWalletAuth.walletAuthMaxAgeSec default (24h). */
const DEFAULT_AUTH_MAX_AGE_SEC = 24 * 60 * 60;
/** Keep in sync with apiWalletAuth.privilegedWalletAuthMaxAgeSec default (5m). */
const DEFAULT_PRIVILEGED_MAX_AGE_SEC = 5 * 60;
/** Refresh slightly before server TTL so clock skew does not cause 401 storms. */
const PRIVILEGED_CACHE_SKEW_SEC = 30;

type PrivilegedCacheEntry = {
  headers: Record<string, string>;
  expiresAtMs: number;
};

/** In-memory only — keyed by wallet|METHOD|path|bodySha256. */
const privilegedAuthCache = new Map<string, PrivilegedCacheEntry>();
/** Single-flight so parallel polls share one signMessage. */
const privilegedAuthInflight = new Map<string, Promise<Record<string, string>>>();

/**
 * How long to wait on a wallet signature before giving up. Generous — a hardware wallet or a user
 * reading the message is normal — but bounded.
 */
const SIGN_TIMEOUT_MS = 120_000;

/**
 * `signer.signMessage` with a deadline.
 *
 * An unbounded signMessage is the difference between a button that fails and a button that is
 * stuck. MetaMask does not reject when its prompt is dismissed, ignored, or queued behind another
 * pending request — the promise simply never settles. Every caller here sits inside a
 * `try/finally` that only clears its busy flag once the promise resolves, so the UI shows
 * "Running…" forever with no error, no toast, and nothing in the console. That is exactly how the
 * Level 1 TOS + KYT button presented.
 *
 * Rejecting instead surfaces the real cause, which the user can act on: the prompt is sitting in
 * the extension waiting to be opened. A late signature is harmless — the caller has already
 * failed and the value is discarded.
 */
async function signWithDeadline(signer: Signer, message: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signer.signMessage(message),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Your wallet did not respond to the signature request. Open your wallet " +
                  "extension — the prompt may be waiting there — and try again.",
              ),
            ),
          SIGN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SessionCacheEntry = { headers: Record<string, string>; expiresAtMs: number };
const privilegedSessionCache = new Map<string, SessionCacheEntry>();
const privilegedSessionInflight = new Map<string, Promise<Record<string, string>>>();

const authStorageKey = (wallet: string) => `siphon-note-auth-${wallet.toLowerCase()}`;

function authMaxAgeSec(): number {
  const n = Number(process.env.NEXT_PUBLIC_WALLET_AUTH_MAX_AGE_SEC || '');
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_AUTH_MAX_AGE_SEC;
}

function readCachedAuthHeaders(wallet: string): Record<string, string> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(authStorageKey(wallet));
    if (!raw) return null;
    const stored: { timestamp: string; signature: string; delegation?: string } = JSON.parse(raw);
    if (!stored?.timestamp || !stored.signature) return null;
    const ts = Number(stored.timestamp);
    const age = Math.floor(Date.now() / 1000) - ts;
    if (!Number.isFinite(ts) || age < -120 || age > authMaxAgeSec()) {
      localStorage.removeItem(authStorageKey(wallet));
      return null;
    }
    // A session-signed entry is only usable together with the delegation that proves the session
    // key acts for this wallet. Cached without it, the server recovers an address it has never
    // heard of and 401s — so the two are stored and returned as a unit, or not at all.
    if (stored.delegation && !sessionDelegationStillValid(stored.delegation, wallet)) {
      localStorage.removeItem(authStorageKey(wallet));
      return null;
    }
    return {
      'X-Wallet-Address': wallet.toLowerCase(),
      'X-Signature': stored.signature,
      'X-Timestamp': stored.timestamp,
      'Content-Type': 'application/json',
      ...(stored.delegation ? { [SESSION_HEADER]: stored.delegation } : {}),
    };
  } catch {
    return null;
  }
}

function privilegedClientMaxAgeSec(): number {
  const n = Number(process.env.NEXT_PUBLIC_PRIVILEGED_WALLET_AUTH_MAX_AGE_SEC || '');
  const ttl =
    Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PRIVILEGED_MAX_AGE_SEC;
  return Math.max(30, ttl - PRIVILEGED_CACHE_SKEW_SEC);
}

function privilegedCacheKey(
  wallet: string,
  method: string,
  path: string,
  bodySha256: string,
): string {
  return `${wallet.toLowerCase()}|${method}|${path}|${bodySha256}`;
}

function pathnameOnly(pathWithQuery: string): string {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  return path.split('?')[0] || path;
}

function pathAllowsSession(pathWithQuery: string): boolean {
  return PRIVILEGED_SESSION_ALLOWLIST.has(pathnameOnly(pathWithQuery));
}

function pathAllowsScope(pathWithQuery: string): boolean {
  return PRIVILEGED_PATH_SCOPE_ALLOWLIST.has(pathnameOnly(pathWithQuery));
}

export function clearPrivilegedSessionCache(wallet?: string | null): void {
  if (!wallet) {
    privilegedSessionCache.clear();
    privilegedSessionInflight.clear();
    return;
  }
  const w = wallet.toLowerCase();
  privilegedSessionCache.delete(w);
  privilegedSessionInflight.delete(w);
}

/** Drop in-memory privileged request-bound sigs (wallet disconnect / auth invalid). */
export function clearPrivilegedWalletAuthCache(wallet?: string | null): void {
  clearPrivilegedSessionCache(wallet);
  if (!wallet) {
    privilegedAuthCache.clear();
    privilegedAuthInflight.clear();
    return;
  }
  const prefix = `${wallet.toLowerCase()}|`;
  for (const k of [...privilegedAuthCache.keys()]) {
    if (k.startsWith(prefix)) privilegedAuthCache.delete(k);
  }
  for (const k of [...privilegedAuthInflight.keys()]) {
    if (k.startsWith(prefix)) privilegedAuthInflight.delete(k);
  }
}

/** Drop cached Siphon auth v1 sig (e.g. after server returns wallet_auth_expired). */
export function clearWalletAuthCache(wallet: string | null | undefined): void {
  clearPrivilegedWalletAuthCache(wallet);
  if (typeof window === 'undefined' || !wallet) return;
  try {
    localStorage.removeItem(authStorageKey(wallet));
  } catch {
    /* ignore */
  }
}

/** Test helper — wipe privileged memory cache. */
export function _resetPrivilegedAuthCacheForTests(): void {
  privilegedAuthCache.clear();
  privilegedAuthInflight.clear();
  privilegedSessionCache.clear();
  privilegedSessionInflight.clear();
}

function persistAuthHeaders(
  wallet: string,
  timestamp: string,
  signature: string,
  delegation?: string,
): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      authStorageKey(wallet),
      JSON.stringify(delegation ? { timestamp, signature, delegation } : { timestamp, signature }),
    );
  } catch {
    /* quota */
  }
}

/**
 * Cache-only variant for read/poll call sites that have the wallet address but no Signer.
 */
export function getCachedWalletAuthHeaders(wallet: string | null | undefined): Record<string, string> {
  if (!wallet) return {};
  // A live session key signs a fresh read message in microseconds, no prompt. The cache below can
  // hold a signature for 24h while the executor rejects any older than READ_SIG_MAX_AGE_SECONDS
  // (300s) — so preferring the session is what stops these background reads 401ing after 5 minutes.
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const fresh = typeof window === 'undefined' ? null : signWithSessionSync(wallet, `${SIGN_MESSAGE_AUTH_BASE}:${timestamp}`);
  if (fresh) {
    persistAuthHeaders(wallet, timestamp, fresh.signature, fresh.delegation);
    return {
      'X-Wallet-Address': wallet.toLowerCase(),
      'X-Signature': fresh.signature,
      'X-Timestamp': timestamp,
      'Content-Type': 'application/json',
      [SESSION_HEADER]: fresh.delegation,
    };
  }
  return readCachedAuthHeaders(wallet) ?? {};
}

/** SHA-256 over raw bytes, lowercase hex. Exported so the gateway intent path shares one copy. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256HexUtf8(body: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(body));
}

function pathWithQueryFromInput(input: RequestInfo | URL): string {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const base =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';
  const u = new URL(raw, base);
  return `${u.pathname}${u.search}`;
}

/**
 * One soft privileged session sign — bound to a single allowlisted route (OVERLORD F-6).
 * Never unlocks /api/prove. Memory only.
 */
export async function ensurePrivilegedSession(
  signer: Signer,
  pathWithQuery: string,
): Promise<Record<string, string>> {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  const pathname = path.split('?')[0] || path;
  const wallet = (await signer.getAddress()).toLowerCase();
  const cacheKey = `${wallet}|${pathname}`;
  const now = Date.now();
  const hit = privilegedSessionCache.get(cacheKey);
  if (hit && hit.expiresAtMs > now) return { ...hit.headers };

  const inflight = privilegedSessionInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async (): Promise<Record<string, string>> => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `${PRIVILEGED_SESSION_PREFIX}:${pathname}:${timestamp}`;
    const { signature, extraHeaders } = await signAuthMessage(
      signer,
      wallet,
      'session',
      message,
    );
    const headers: Record<string, string> = {
      'X-Wallet-Address': wallet,
      'X-Signature': signature,
      'X-Timestamp': timestamp,
      'X-Auth-Mode': 'session',
      'X-Body-Sha256': 'session',
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    privilegedSessionCache.set(cacheKey, {
      headers,
      expiresAtMs: Date.now() + privilegedClientMaxAgeSec() * 1000,
    });
    return { ...headers };
  })().finally(() => {
    privilegedSessionInflight.delete(cacheKey);
  });

  privilegedSessionInflight.set(cacheKey, promise);
  return promise;
}

/**
 * Privileged auth — signs method + path + body hash (OMEGA-01).
 * Soft allowlisted routes prefer a privileged *session* (one sign → asp-set + builder + …).
 * Never persisted to localStorage / sessionStorage. Never covers /api/prove.
 */
export async function getPrivilegedWalletAuthHeaders(
  signer: Signer,
  method: string,
  pathWithQuery: string,
  body: string = '',
  opts?: { pathScope?: boolean; preferSession?: boolean },
): Promise<Record<string, string>> {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  const preferSession = opts?.preferSession !== false && pathAllowsSession(path);
  if (preferSession) {
    return ensurePrivilegedSession(signer, path);
  }

  const wallet = (await signer.getAddress()).toLowerCase();
  const m = method.trim().toUpperCase();
  const useScope = opts?.pathScope === true || (opts?.pathScope !== false && pathAllowsScope(path));
  const bodySha256 = useScope ? PRIVILEGED_PATH_SCOPE_BODY : await sha256HexUtf8(body);
  const cacheKey = privilegedCacheKey(wallet, m, path, bodySha256);

  const now = Date.now();
  const hit = privilegedAuthCache.get(cacheKey);
  if (hit && hit.expiresAtMs > now) {
    return { ...hit.headers };
  }

  const inflight = privilegedAuthInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async (): Promise<Record<string, string>> => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `${PRIVILEGED_REQ_PREFIX}:${m}:${path}:${bodySha256}:${timestamp}`;
    const { signature, extraHeaders } = await signAuthMessage(
      signer,
      wallet,
      'request',
      message,
    );
    const headers: Record<string, string> = {
      'X-Wallet-Address': wallet,
      'X-Signature': signature,
      'X-Timestamp': timestamp,
      'X-Body-Sha256': bodySha256,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    privilegedAuthCache.set(cacheKey, {
      headers,
      expiresAtMs: Date.now() + privilegedClientMaxAgeSec() * 1000,
    });
    return { ...headers };
  })().finally(() => {
    privilegedAuthInflight.delete(cacheKey);
  });

  privilegedAuthInflight.set(cacheKey, promise);
  return promise;
}

/**
 * Browser fetch to a same-origin privileged proxy with request-bound Siphon auth.
 * Retries once on wallet_auth_expired (re-sign same method/path/body or path-scope).
 */
export async function fetchWithWalletAuth(
  signer: Signer,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const body =
    typeof init.body === 'string'
      ? init.body
      : init.body == null
        ? ''
        : typeof init.body === 'object' &&
            typeof (init.body as { toString?: () => string }).toString === 'function' &&
            !(init.body instanceof Blob) &&
            !(typeof FormData !== 'undefined' && init.body instanceof FormData) &&
            !(typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) &&
            !(init.body instanceof ArrayBuffer)
          ? String(init.body)
          : '';
  if (init.body != null && typeof init.body !== 'string' && body === '') {
    throw new Error(
      'fetchWithWalletAuth requires a string body for privileged POST/PUT/PATCH (request-bound auth)',
    );
  }
  const path = pathWithQueryFromInput(input);
  const useSession = pathAllowsSession(path);
  const useScope = !useSession && pathAllowsScope(path);

  const post = async (auth: Record<string, string>) => {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(auth)) {
      if (k.toLowerCase() === 'content-type' && headers.has('content-type')) continue;
      headers.set(k, v);
    }
    if (!headers.has('content-type') && init.body != null) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(input, { ...init, headers });
  };

  let auth = await getPrivilegedWalletAuthHeaders(signer, method, path, body, {
    pathScope: useScope,
    preferSession: useSession,
  });
  let res = await post(auth);
  if (res.status === 401) {
    const errBody = (await res.clone().json().catch(() => ({}))) as { error?: string };
    if (errBody.error === 'wallet_auth_expired' || errBody.error === 'wallet_auth_invalid') {
      const wallet = (await signer.getAddress()).toLowerCase();
      if (useSession) {
        clearPrivilegedSessionCache(wallet);
      } else {
        const bodySha256 = useScope ? PRIVILEGED_PATH_SCOPE_BODY : await sha256HexUtf8(body);
        privilegedAuthCache.delete(privilegedCacheKey(wallet, method, path, bodySha256));
      }
      auth = await getPrivilegedWalletAuthHeaders(signer, method, path, body, {
        pathScope: useScope,
        preferSession: useSession,
      });
      res = await post(auth);
    }
  }
  return res;
}

/** Long-lived ownership proof — for GET /strategies, GET /notes, GET /receipts, etc. */

/**
 * Sign `message` with the session key when one exists, else with the wallet.
 *
 * This is the ONLY place session keys enter the signing path. Every caller below routes through
 * it, so there is one place to reason about and one place to disable it.
 *
 * `ensureSession` is deliberately NOT called here: minting a session is itself a wallet prompt,
 * and triggering it from deep inside a request would replace one popup with a different one at an
 * unpredictable moment. Sessions are established explicitly (see primeSessionKey) and this helper
 * only *uses* what already exists. No session -> the existing wallet path runs untouched.
 */
async function signAuthMessage(
  signer: Signer,
  wallet: string,
  label: SignaturePurpose,
  message: string,
): Promise<{ signature: string; extraHeaders: Record<string, string> }> {
  // If a delegation is mid-flight, wait for it rather than racing it to storage and prompting.
  await awaitPendingSession(wallet);
  if (hasSession(wallet)) {
    const viaSession = await signWithSession(wallet, message);
    if (viaSession) {
      return { signature: viaSession.signature, extraHeaders: viaSession.headers };
    }
  }
  // signGuarded banks a decline so a rejected prompt is not reopened next tick; signWithDeadline
  // bounds a prompt that never settles. Both still apply on the wallet path.
  const signature = await signGuarded(wallet, label, () => signWithDeadline(signer, message));
  return { signature, extraHeaders: {} };
}

/**
 * True when a live session key exists for this wallet — WITHOUT minting one.
 *
 * For callers that want the session-key path but must not cause a wallet prompt if there is no
 * session yet: `getWalletAuthHeaders` falls back to a wallet signature, which is correct for a
 * user-initiated read and wrong for a background warm-up.
 */
export async function hasSessionKey(signer: Signer): Promise<boolean> {
  const wallet = (await signer.getAddress()).toLowerCase();
  await awaitPendingSession(wallet);
  return hasSession(wallet);
}

/**
 * Establish a session key (one wallet popup) — call at connect time, not mid-request.
 * Safe to call repeatedly: it no-ops when a live session exists, and a decline is not an error.
 */
export async function primeSessionKey(signer: Signer, chainId: number): Promise<boolean> {
  return (await ensureSession(signer, chainId)) !== null;
}

export async function getWalletAuthHeaders(signer: Signer): Promise<Record<string, string>> {
  const wallet = (await signer.getAddress()).toLowerCase();
  // Wait for a delegation that is still being signed, so the branch below sees the finished
  // session rather than racing it and taking the cache path by a few milliseconds.
  await awaitPendingSession(wallet);

  // ESTABLISH THE SESSION KEY FIRST — it is the prerequisite, not a parallel task.
  //
  // awaitPendingSession only waits for a delegation ALREADY in flight. With none yet, this used to
  // fall straight through and sign 'Siphon auth v1:<ts>' with the wallet, while some other caller
  // independently kicked off the session-key delegation — MetaMask then stacked both ("1 of 2"),
  // showing the read-auth prompt BEFORE the session-key one that is supposed to authorise it. The
  // order was whichever caller happened to reach the signer first, so it varied run to run.
  //
  // Priming here makes the sequence deterministic for every entry point at once, instead of each
  // of the dozen call sites having to remember to prime first. Once the session exists, the
  // signing below is done BY the session key in memory — no second popup at all.
  //
  // Declines are not errors: ensureSession returns null, walletSignatureGate banks the refusal so
  // it is not re-prompted, and we fall through to wallet-signed auth exactly as before.
  if (!hasSession(wallet)) {
    try {
      const net = await signer.provider?.getNetwork();
      if (net) await ensureSession(signer, Number(net.chainId));
    } catch {
      /* no provider, declined, or offline — fall through to wallet-signed auth */
    }
  }
  // The cache exists to avoid a wallet popup. A session key has no popup to avoid — it signs in
  // microseconds from memory — and reusing a cached signature is what actually breaks it: this
  // cache holds an entry for NEXT_PUBLIC_WALLET_AUTH_MAX_AGE_SEC (24h by default) while the
  // executor rejects any read signature older than READ_SIG_MAX_AGE_SECONDS (300s by default).
  // Past those five minutes every cached hit is a guaranteed 401 that no amount of retrying
  // fixes, which is exactly the "401 in the browser, 200 from a script" symptom. Signing fresh
  // also keeps the entry warm for the synchronous readers, which cannot sign at all.
  if (!hasSession(wallet)) {
    const cached = readCachedAuthHeaders(wallet);
    if (cached) return cached;
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Both wrappers, and in this order. signGuarded is the outer one: it banks a decline so a
  // rejected prompt is not re-opened on the next tick (the 260-popups-in-3h bug), and that must
  // apply to the deadline's failure too. signWithDeadline is the inner one: it bounds a prompt
  // that never settles at all, which is a different failure from being declined — MetaMask simply
  // does not reject when its window is dismissed or queued behind another request.
  const { signature, extraHeaders } = await signAuthMessage(
    signer,
    wallet,
    'read-auth',
    `${SIGN_MESSAGE_AUTH_BASE}:${timestamp}`,
  );
  // Cache both wallet- and session-signed headers. The synchronous readers
  // (getCachedWalletAuthHeaders, used by decryptorClient/strategyApi/strategySubmit and four more)
  // cannot sign — they only read this cache — so refusing to store session-signed entries left
  // them with either a stale wallet signature or nothing at all. The delegation is stored
  // alongside and validated on read, so an entry cannot outlive the session it depends on.
  persistAuthHeaders(wallet, timestamp, signature, extraHeaders[SESSION_HEADER]);
  return {
    'X-Wallet-Address': wallet,
    'X-Signature': signature,
    'X-Timestamp': timestamp,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
}

const AUTH_CHALLENGE_TIMEOUT_MS = 15_000;

export async function fetchWriteChallenge(
  chainId: number,
): Promise<{ nonce: string; expires_at: number; boundChainId: number | null }> {
  // The same chain picks the host AND is bound into the signature, so they cannot disagree.
  const base = getTradeExecutorBaseUrl(chainId).replace(/\/$/, '');
  const res = await fetch(`${base}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain_id: chainId }),
    signal: AbortSignal.timeout(AUTH_CHALLENGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`auth challenge failed (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { nonce?: string; expires_at?: number; chain_id?: number };
  if (!data.nonce || !/^[0-9a-f]{16,128}$/.test(data.nonce)) throw new Error('auth challenge missing nonce');
  if (data.chain_id !== undefined && data.chain_id !== chainId) {
    // Bound to another chain: signing would produce a signature valid somewhere we did not mean.
    throw new Error(`auth challenge is not bound to chain ${chainId}`);
  }
  return { nonce: data.nonce, expires_at: data.expires_at ?? 0, boundChainId: data.chain_id ?? null };
}

/**
 * Short-lived write auth for mutating routes (createStrategy, abort, uploadServerKey, receipt mint, …).
 * Also primes the long-lived read cache when missing so subsequent GETs work without another popup
 * when ENFORCE_WRITE_CHALLENGE is off during rollout — still one sign for the write itself.
 */
/**
 * Write-auth headers, signed by the SESSION KEY.
 *
 * Previously this always called `signWithDeadline` — the wallet itself — on the reasoning that "a
 * write is something the user just clicked, so it is fresh consent". That is true of a withdrawal;
 * it is false of the writes that actually dominate this path. `TeeClientKeySync` polls every 3s
 * from page load and `fheKeyWarmup` uploads a server key, neither of which the user clicked, so a
 * plain page load opened a queue of MetaMask prompts for auth the session key already exists to
 * carry.
 *
 * The session key is now REQUIRED, not preferred: there is no wallet-signing fallback. A user who
 * declines it cannot authenticate, which is the honest contract — one prompt per session buys every
 * subsequent request, and declining it means declining auth. The executor accepts the delegated
 * signer via `delegated_signer_authorizes` (wallet_auth.py), the same rule the read path uses.
 *
 * The single-use challenge nonce is unchanged, so replay protection is exactly as before: the
 * delegation decides WHO may sign, the nonce still decides how many times.
 *
 * @throws when no valid session exists — callers doing background work should treat this as
 *         "retry later" (the bootstrap mints one shortly), not as a hard failure.
 */
/**
 * Thrown when a write needs the session key and there is not one.
 *
 * Typed, because the two reasons need opposite handling and a plain Error conflates them:
 * `pending` means the bootstrap has not minted a session YET (retry — it is seconds away), while
 * `declined`/`expired` means retrying just spins. TeeClientKeySync polls every 3s for 120s, so
 * getting this wrong logs 40 warnings for a user who simply said no.
 */
export class SessionKeyRequiredError extends Error {
  readonly reason: 'pending' | 'declined' | 'expired';
  constructor(reason: 'pending' | 'declined' | 'expired', message: string) {
    super(message);
    this.name = 'SessionKeyRequiredError';
    this.reason = reason;
  }
}

export function isSessionKeyRequired(err: unknown): err is SessionKeyRequiredError {
  return err instanceof SessionKeyRequiredError;
}

export async function getWalletWriteAuthHeaders(
  signer: Signer,
  chainId: number = getSelectedChainId(),
): Promise<Record<string, string>> {
  const wallet = (await signer.getAddress()).toLowerCase();
  // A session may be mid-signing (bootstrap polls on a 2s tick, this can be called on a 3s tick).
  // Waiting avoids failing a request that is a few milliseconds early.
  await awaitPendingSession(wallet);
  if (!hasSession(wallet)) {
    // Always 'pending': sessionKey.ts does not record a decline (ensureSession returns null and
    // forgets), so this layer genuinely cannot tell "refused" from "not minted yet". Callers must
    // bound their own retries rather than relying on a reason we cannot supply honestly.
    throw new SessionKeyRequiredError(
      'pending',
      'Session key not ready — approve the Siphon session signature to authorise requests',
    );
  }
  const { nonce, boundChainId } = await fetchWriteChallenge(chainId);
  const signed = await signWithSession(wallet, writeChallengeMessage(boundChainId, nonce));
  if (!signed) {
    // Expired between hasSession and here. Do NOT fall back to a wallet prompt — that is the
    // popup this function exists to remove; the next attempt gets a fresh session.
    throw new SessionKeyRequiredError('expired', 'Session key expired — reload to start a new session');
  }
  return {
    'X-Wallet-Address': wallet,
    'X-Write-Signature': signed.signature,
    'X-Write-Nonce': nonce,
    'Content-Type': 'application/json',
    ...signed.headers,
  };
}
