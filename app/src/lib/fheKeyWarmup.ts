// Wallet-connect FHE key warmup.
//
// Pre-generates the per-wallet FHE keypair the moment a wallet connects, so the first
// order doesn't pay keygen (~3-5s), server-key derivation (heavy wasm) or the ~20MB
// server-key upload at submit time.
//
// Storage split:
//   - client key (~22KB hex, SECRET)      → sessionStorage (via fhe.ts; migrated off localStorage)
//   - server key (~23MB hex, eval key)    → IndexedDB — it exceeds the ~5MB localStorage
//     quota, and is re-derivable, so IndexedDB is a cache, not the source of truth.
//
// The cached server key is bound to a fingerprint of the client key that derived it.
// A fingerprint mismatch (new device / regenerated client key) forces a re-derive and
// re-upload — this preserves the stale-key-mismatch protection that made
// ensureServerKeyUploaded always re-upload before.

import { getOrCreateClientKey, getStoredClientKey, deriveServerKey, encryptPriceCents, wrappedClientKeyForUpload } from "@/lib/fhe";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import { getSigner } from "@/lib/nexus";
import {
  getWalletWriteAuthHeaders,
  getWalletAuthHeaders,
  getCachedWalletAuthHeaders,
} from "@/lib/walletAuthHeaders";

export interface FheKeyState {
  stage: "idle" | "generating" | "deriving" | "uploading" | "ready" | "error";
  /** Wallet the state refers to (lowercase), or null before the first warmup. */
  userId: string | null;
  clientKeyReady: boolean;
  serverKeyReady: boolean;
  /** Server key confirmed on file with the trade-executor. */
  uploaded: boolean;
  /** Byte size of the cached server key, once known. */
  serverKeyBytes: number | null;
  error?: string;
}

export const FHE_KEYS_EVENT = "siphon:fheKeys";

let state: FheKeyState = {
  stage: "idle",
  userId: null,
  clientKeyReady: false,
  serverKeyReady: false,
  uploaded: false,
  serverKeyBytes: null,
};

export function getFheKeyState(): FheKeyState {
  return state;
}

function setState(patch: Partial<FheKeyState>): void {
  state = { ...state, ...patch };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<FheKeyState>(FHE_KEYS_EVENT, { detail: state }));
  }
}

// ── Client-key fingerprint ───────────────────────────────────────────────────
// Binds a cached/uploaded server key to the exact client key that derived it.

export async function fingerprintClientKey(clientKeyHex: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientKeyHex));
    return Array.from(new Uint8Array(digest).slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Non-secure-context fallback (dev over http): cheap rolling hash.
  let h = 0n;
  for (let i = 0; i < clientKeyHex.length; i++) {
    h = (h * 131n + BigInt(clientKeyHex.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

// ── IndexedDB cache for the server key ───────────────────────────────────────

const DB_NAME = "siphon-fhe";
const STORE = "serverKeys";

interface ServerKeyRow {
  userId: string;        // lowercase wallet
  clientKeyFp: string;   // fingerprint of the client key this server key was derived from
  serverKey: string;     // bincode+hex ServerKey
  ts: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "userId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetServerKey(userId: string): Promise<ServerKeyRow | null> {
  try {
    const db = await openDb();
    return await new Promise<ServerKeyRow | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(userId.toLowerCase());
      req.onsuccess = () => resolve((req.result as ServerKeyRow) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // IndexedDB unavailable (private mode etc.) — cache miss, we re-derive
  }
}

async function idbPutServerKey(row: ServerKeyRow): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("[FHE] server-key cache write failed (will re-derive next time):", e);
  }
}

// In-memory copy so repeat submits in one session never touch IndexedDB.
const memServerKeys = new Map<string, { clientKeyFp: string; serverKey: string }>();

/**
 * Server key for this wallet: memory → IndexedDB → derive (and persist).
 * Always matched to the CURRENT client key via fingerprint.
 */
export async function getOrCreateServerKey(userId: string, clientKey: string): Promise<string> {
  const uid = userId.toLowerCase();
  const fp = await fingerprintClientKey(clientKey);

  const mem = memServerKeys.get(uid);
  if (mem && mem.clientKeyFp === fp) return mem.serverKey;

  const cached = await idbGetServerKey(uid);
  if (cached && cached.clientKeyFp === fp) {
    memServerKeys.set(uid, { clientKeyFp: fp, serverKey: cached.serverKey });
    setState({ serverKeyReady: true, serverKeyBytes: Math.floor(cached.serverKey.length / 2) });
    return cached.serverKey;
  }

  setState({ stage: "deriving" });
  const serverKey = await deriveServerKey(clientKey);
  memServerKeys.set(uid, { clientKeyFp: fp, serverKey });
  void idbPutServerKey({ userId: uid, clientKeyFp: fp, serverKey, ts: Date.now() });
  setState({ serverKeyReady: true, serverKeyBytes: Math.floor(serverKey.length / 2) });
  return serverKey;
}

/** Cached server key for display/copy (no derive). Null if not warmed yet. */
export async function getCachedServerKey(userId: string): Promise<string | null> {
  const uid = userId.toLowerCase();
  const mem = memServerKeys.get(uid);
  if (mem) return mem.serverKey;
  const clientKey = getStoredClientKey(userId);
  const row = await idbGetServerKey(uid);
  if (!row) return null;
  // Only hand out a server key that provably matches the CURRENT client key. If no client key is
  // stored yet (e.g. right after the v2 cutover, before the deterministic key is re-derived), we
  // can't validate the cached row — return null rather than a stale (possibly v1-era) server key.
  if (!clientKey || row.clientKeyFp !== (await fingerprintClientKey(clientKey))) return null;
  return row.serverKey;
}

// ── Upload to the trade-executor ─────────────────────────────────────────────

/** Write-challenge headers for key upload — never send API_TOKEN from the browser. */
async function keyWriteAuthHeaders(userId: string): Promise<Record<string, string>> {
  // Solana Devnet: Phantom session (executor SOLANA_DEVNET_ARM_OPEN=1 + signature). First: an
  // EVM signer, if one is also connected, cannot speak for a Phantom id.
  if (userId && !userId.startsWith("0x")) {
    const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
    return { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) };
  }
  const signer = getSigner();
  if (signer) return getWalletWriteAuthHeaders(signer);
  throw new Error("Wallet required to upload FHE keys — connect and retry");
}

/**
 * Read headers (X-Signature/X-Timestamp) for GET routes behind @verify_wallet_sig.
 * The write-challenge set (X-Write-Signature/X-Write-Nonce) does NOT satisfy that decorator, so
 * sending keyAuthHeaders() to a GET returns 401 — the executor's _check_wallet_sig only reads the
 * X-Signature/X-Timestamp pair. Reuses the cached read signature, so no extra wallet popup.
 */
async function keyReadAuthHeaders(userId: string): Promise<Record<string, string>> {
  if (userId && !userId.startsWith("0x")) {
    const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
    return { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) };
  }
  const signer = getSigner();
  if (signer) return getWalletAuthHeaders(signer);
  return { "Content-Type": "application/json", ...getCachedWalletAuthHeaders(userId) };
}

export type EnsureServerKeyOpts = {
  /**
   * When the executor already has this server-key fingerprint, still POST a tiny canary.
   * Needed before arming strategies; skip on connect warmup to avoid a write-challenge popup.
   */
  refreshCanary?: boolean;
};

/**
 * Ensure the trade-executor has the server key matching THIS client key.
 *
 * Fast path: if we already uploaded this exact client key's server key (fingerprint
 * recorded in localStorage) AND the executor confirms it still has one on file
 * (/hasServerKey), skip the ~20MB upload entirely. A regenerated client key changes
 * the fingerprint → re-upload (same protection as the old always-upload behavior);
 * an executor DB reset makes /hasServerKey return false → re-upload.
 *
 * Write-challenge is acquired only when a mutating POST is required (not on the GET check).
 */
export async function ensureServerKeyUploaded(
  userId: string,
  clientKey: string,
  onUpload?: () => void,
  force = false,
  opts: EnsureServerKeyOpts = {},
): Promise<void> {
  const base = getTradeExecutorBaseUrl();
  const refreshCanary = opts.refreshCanary === true;

  // Derive (or reuse the cached) server key for THIS client key and fingerprint it. The executor
  // returns the fingerprint of the key it currently holds; skip the ~24MB re-upload ONLY when the
  // executor's stored key is byte-identical to ours. The old presence-only check let a
  // stale/other-device server key survive, so the engine evaluated fresh bounds with an old key →
  // garbage → decrypt mismatch (fail-closed / false trigger). Server truth, not localStorage.
  // `force` (used by the pre-arm re-sync) skips the check and re-uploads unconditionally.
  const serverKey = await getOrCreateServerKey(userId, clientKey);
  // Canary = encrypt(0) under THIS client key. It's tiny (~few KB) and MUST be refreshed on arm
  // (refreshCanary) so the scheduler's decrypt-time gate always has a same-generation known-answer.
  const canary = refreshCanary || force ? await encryptPriceCents(0n, clientKey) : null;
  if (!force) {
    const skFp = await fingerprintClientKey(serverKey);
    try {
      const res = await fetch(`${base}/hasServerKey/${userId}`, {
        headers: await keyReadAuthHeaders(userId),
      });
      if (res.ok) {
        const j = await res.json();
        if (j?.has_key === true && j?.fingerprint === skFp) {
          if (refreshCanary && canary) {
            // Server key already current — skip the big upload, POST only the small canary.
            // The wrapped ClientKey rides along: this is the request the browser actually makes
            // most of the time (the ~24MB server_key is fast-skipped whenever the fingerprint
            // matches), so a blob sent only with a FULL upload would almost never land.
            const auth = await keyWriteAuthHeaders(userId);
            const wrapped = await wrappedClientKeyForUpload(userId);
            await fetch(`${base}/uploadServerKey`, {
              method: "POST",
              headers: auth,
              body: JSON.stringify({ user_id: userId, canary, ...(wrapped ?? {}) }),
            }).catch(() => { /* best-effort; a missing canary just keeps the strategy dormant, never fires */ });
          }
          setState({ uploaded: true });
          return;
        }
      }
    } catch {
      /* can't confirm — fall through and upload */
    }
  }

  onUpload?.();
  setState({ stage: "uploading" });
  const auth = await keyWriteAuthHeaders(userId);
  const canaryBody = canary ?? (await encryptPriceCents(0n, clientKey));
  // gzip the ~24MB body in-browser (native CompressionStream, ~27MB → ~7MB on the wire).
  // Older Safari lacks CompressionStream → plain JSON, executor accepts both.
  // Same wrapped ClientKey on the full path, so a first-ever upload publishes it too.
  const wrapped = await wrappedClientKeyForUpload(userId);
  const json = JSON.stringify({
    user_id: userId, server_key: serverKey, canary: canaryBody, ...(wrapped ?? {}),
  });
  let body: BodyInit = json;
  let encHeader: Record<string, string> = {};
  if (typeof CompressionStream !== "undefined") {
    const gz = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    body = await new Response(gz).arrayBuffer();
    encHeader = { "Content-Encoding": "gzip" };
  }
  const res = await fetch(`${base}/uploadServerKey`, {
    method: "POST",
    headers: { ...auth, ...encHeader },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      (text.trim() || `Server key upload failed (HTTP ${res.status})`) +
        ` — executor: ${base}`,
    );
  }
  setState({ uploaded: true });
}

/**
 * Pre-arm key-consistency check. Proves the decryptor's STORED ClientKey decrypts the engine's
 * output correctly BEFORE a strategy is armed: sends the current server key + a canary ciphertext
 * (encrypt 0), the executor evaluates 0<=100 (known answer TRUE) and decrypts with the stored key.
 * Returns true only when the round-trip yields the known answer — i.e. the bound-encryption key,
 * engine server key and decryptor client key are provably one generation. Returns false on any
 * mismatch/garbage so the caller can re-sync and never arm on skewed keys.
 */
export async function verifyKeyConsistency(userId: string, clientKey: string): Promise<boolean> {
  const base = getTradeExecutorBaseUrl();
  const canary = await encryptPriceCents(0n, clientKey);
  const auth = await keyWriteAuthHeaders(userId);
  try {
    // NOTE: no server_key here — the endpoint deliberately checks the STORED key and always
    // ignored the inline one. Sending it anyway shipped ~49MB of dead weight per arm and made
    // this step take minutes on a slow uplink.
    const res = await fetch(`${base}/selfCheckKeys`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ user_id: userId, encrypted_canary: canary }),
    });
    if (!res.ok) return false;
    return (await res.json())?.consistent === true;
  } catch {
    return false;
  }
}

// ── Warmup orchestration ─────────────────────────────────────────────────────

const inflight = new Map<string, Promise<void>>();
const warmedOk = new Set<string>();

/** Clear warmup cache and retry executor upload (e.g. after changing NEXT_PUBLIC_TRADE_EXECUTOR_URL). */
export function retryFheKeyUpload(userId: string): Promise<void> {
  const uid = userId.toLowerCase();
  warmedOk.delete(uid);
  inflight.delete(uid);
  setState({ stage: "idle", error: undefined, uploaded: false });
  return warmFheKeys(uid, { upload: true });
}

/**
 * Full warmup for a wallet: client key (generate + persist on first connect),
 * server key (derive + IndexedDB cache). Executor upload is deferred to arm/submit
 * so connect does not pay a write-challenge popup.
 */
export function warmFheKeys(
  userId: string,
  opts?: { upload?: boolean },
): Promise<void> {
  const uid = userId.toLowerCase();
  if (warmedOk.has(uid)) return Promise.resolve();
  const running = inflight.get(uid);
  if (running) return running;

  const wantUpload = opts?.upload === true;

  const p = (async () => {
    if (state.userId !== uid) {
      // Different wallet — don't carry over the previous wallet's readiness flags.
      state = { stage: "idle", userId: uid, clientKeyReady: false, serverKeyReady: false, uploaded: false, serverKeyBytes: null };
    }
    setState({ userId: uid, error: undefined });
    const t0 = Date.now();
    const hadKey = !!getStoredClientKey(userId);
    if (!hadKey) {
      console.log("🔐 [FHE] New wallet — pre-generating FHE keypair now so orders are instant…");
      setState({ stage: "generating" });
    }
    const clientKey = await getOrCreateClientKey(userId);
    setState({ clientKeyReady: true });

    await getOrCreateServerKey(userId, clientKey);
    if (wantUpload) {
      await ensureServerKeyUploaded(userId, clientKey);
    }

    setState({ stage: "ready" });
    warmedOk.add(uid);
    console.log(
      `🔐 [FHE] Keys warmed for ${uid} in ${Date.now() - t0}ms` +
        (wantUpload ? " (uploaded)." : " (local only; upload on arm)."),
    );
  })()
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[FHE] key warmup failed (orders will fall back to on-demand keygen):", msg);
      setState({ stage: "error", error: msg });
      throw e;
    })
    .finally(() => inflight.delete(uid));

  inflight.set(uid, p);
  return p;
}
