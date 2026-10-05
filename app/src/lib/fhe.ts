// In-browser FHE for Siphon — thin typed wrapper over the wasm-bindgen module in
// fhe-wasm/pkg. The wasm is byte-compatible with the Rust FHE engine (tfhe 0.5,
// integer radix, PARAM_MESSAGE_2_CARRY_2_KS_PBS, NUM_BLOCKS=16, bincode 1.3 + hex).
//
// The client key is generated client-side. With TEE autonomous mode it is also sent (via
// trade-executor proxy) to the confidential VM for result-bit decryption only.

import { keccak256 } from "ethers";
import type { Signer } from "ethers";
import { signGuarded } from "./walletSignatureGate";

// Bundler-target wasm-bindgen module lives outside src/. next.config.ts enables
// asyncWebAssembly + topLevelAwait so webpack can resolve the .wasm import.
type FheModule = typeof import("../../fhe-wasm/pkg/siphon_fhe_wasm.js");

export interface FheKeyPair {
  /** Secret key — bincode+hex RadixClientKey. NEVER send to a server. */
  clientKey: string;
  /** Evaluation key — bincode+hex ServerKey. Safe to send to the engine. */
  serverKey: string;
}

let modPromise: Promise<FheModule> | null = null;

/** Lazily load + init the wasm module exactly once. Browser-only. */
async function loadFhe(): Promise<FheModule> {
  if (typeof window === "undefined") {
    throw new Error("FHE wasm is browser-only and cannot run during SSR.");
  }
  if (!modPromise) {
    modPromise = import("../../fhe-wasm/pkg/siphon_fhe_wasm.js").then((mod) => {
      // init() sets the panic hook; the wasm-bindgen start fn runs on import.
      try {
        mod.init();
      } catch {
        /* init is idempotent enough for our purposes */
      }
      return mod;
    });
  }
  return modPromise;
}

/** Warm the wasm so the first real call isn't paying load cost. Optional. */
export async function initFhe(): Promise<void> {
  await loadFhe();
}

/**
 * Derive a (compressed) server key from an existing client key. NOT byte-deterministic —
 * each call uses fresh randomness — but any derived key correctly evaluates ciphertexts
 * from this client key, so it's safe to re-derive and re-upload whenever the backend needs it.
 */
export async function deriveServerKey(clientKeyHex: string): Promise<string> {
  const mod = await loadFhe();
  return mod.derive_server_key(clientKeyHex);
}

// ── Per-wallet client key persistence ────────────────────────────────────────
// Only the small client key (~22KB) is persisted — never the ~23MB server key
// (which exceeds quota and is re-derivable from the client key).
//
// THREE TIERS, cheapest first:
//   sessionStorage  plaintext, tab-scoped        (as before)
//   localStorage    WRAPPED under the note enc-key
//   server          WRAPPED, one row per wallet
//
// The wrapping key is AES-GCM derived from a wallet signature that is already paid on every page
// load by the note stores, so unwrapping costs no new prompt — that is the whole point. Only
// ciphertext reaches disk or the server, and the unwrapping secret is rebuilt from a live wallet
// signature each load, so a stolen disk image or a shared browser yields an unopenable blob. That
// is the property the original sessionStorage-only decision (OMEGA-01) was protecting.
//
// This does NOT defend XSS after unlock. That attacker already reads every note blob (nullifiers,
// secrets) — strictly worse than a strategy-bounds key, which cannot move funds, since spending is
// Groth16-authorised in VaultKernel.spend().

// v2 = plaintext, the pre-wrapping layout. Only ever PURGED now, never read: a v2 entry may have
// been written under the `recipient` bug below (wallet A's key stored under wallet B's id) and
// carries no signerAddress to detect it with. Reading one back would perpetuate exactly the
// poisoning this file now refuses. Cost of purging is one re-derive per open tab at deploy.
const LEGACY_CLIENT_KEY_PREFIX = "siphon.fhe.clientKey.v2.";
// v3 = a self-describing payload; wrapped in localStorage and on the server, plain in sessionStorage.
const CLIENT_KEY_PREFIX = "siphon.fhe.clientKey.v3.";

// Fixed message the wallet signs to derive the FHE key seed. MUST stay constant forever — changing
// it changes every user's derived key. EOAs sign ECDSA deterministically (RFC-6979), so the same
// wallet always yields the same signature → same seed → BYTE-IDENTICAL ClientKey on every device.
const KEY_SEED_MESSAGE =
  "Siphon Protocol\n\nSign to derive your private FHE encryption key.\n\n" +
  "This signature deterministically recreates the SAME key on every device and never leaves your " +
  "browser. Only sign this on the official Siphon app.";

/**
 * What we store, at every tier.
 *
 * `v: 1` held `k` as the raw hex string; `v: 2` holds base64 of the hex-DECODED bytes, which
 * halves it (58.6 KiB → 29.3 KiB for a 44,952-char key). We emit 2 and read both, so a blob
 * written by an early build still opens.
 */
interface StoredKeyPayload {
  v: 1 | 2;
  k: string;
  /** The wallet whose signature produced this key. See the ownership check below. */
  signerAddress: string;
  /** True only on the deriveKeySeed path — a random key must never leave the tab. */
  derived: boolean;
  /** fingerprintClientKey(clientKeyHex) — sha256(hex)[:16]. */
  fp: string;
}

function clientKeyStorageKey(userId: string): string {
  return CLIENT_KEY_PREFIX + userId.toLowerCase();
}

// ── encoding helpers ─────────────────────────────────────────────────────────
// Chunked on purpose. String.fromCharCode(...bytes) is fine for 22 KB under JSC, but V8's
// argument limit is lower (~125k) and this ships to Chrome, so spread the risk away entirely.
const B64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(out);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** Payload → client-key hex, accepting both encodings. */
function payloadToHex(p: StoredKeyPayload): string {
  return p.v === 1 ? p.k : bytesToHex(base64ToBytes(p.k));
}

async function makePayload(
  clientKeyHex: string,
  signerAddress: string,
  derived: boolean,
): Promise<StoredKeyPayload> {
  const { fingerprintClientKey } = await import("./fheKeyWarmup");
  return {
    v: 2,
    k: bytesToBase64(hexToBytes(clientKeyHex)),
    signerAddress: signerAddress.toLowerCase(),
    derived,
    fp: await fingerprintClientKey(clientKeyHex),
  };
}

/**
 * Every gate a restored payload must clear before we trust it. Fail CLOSED throughout — an
 * unverifiable key is precisely the case to reject, so a missing `fp` is a rejection and not a
 * skipped check.
 *
 * `requireDerived` is false only for the sessionStorage tier, where a random no-signer key is
 * still allowed to live for the life of the tab, exactly as it did before.
 */
async function payloadIsTrustworthy(
  p: StoredKeyPayload | null,
  expectedSigner: string,
  requireDerived: boolean,
): Promise<boolean> {
  if (!p || typeof p.k !== "string" || !p.k) return false;
  if (p.v !== 1 && p.v !== 2) return false;
  // Ownership. The fingerprint proves self-consistency, NOT ownership: wallet A's key is a
  // perfectly well-formed key under wallet B's id, and arming with it while the decryptor holds
  // B's sealed key decrypts encrypted-FALSE to garbage, read as TRUE — a false trigger.
  if (!p.signerAddress || p.signerAddress.toLowerCase() !== expectedSigner.toLowerCase()) {
    return false;
  }
  if (requireDerived && p.derived !== true) return false;
  if (!p.fp) return false;
  try {
    const { fingerprintClientKey } = await import("./fheKeyWarmup");
    return (await fingerprintClientKey(payloadToHex(p))) === p.fp;
  } catch {
    return false;
  }
}

// ── tier 1: sessionStorage (plaintext, tab-scoped) ───────────────────────────

/** Delete the pre-wrapping plaintext entries. Never migrated — see the v2 note above. */
function purgeLegacyPlaintextKey(userId: string): void {
  if (typeof window === "undefined") return;
  const legacy = LEGACY_CLIENT_KEY_PREFIX + userId.toLowerCase();
  try { window.localStorage.removeItem(legacy); } catch { /* private mode */ }
  try { window.sessionStorage.removeItem(legacy); } catch { /* private mode */ }
}

function readSessionPayload(userId: string): StoredKeyPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(clientKeyStorageKey(userId));
    if (!raw) return null;
    return JSON.parse(raw) as StoredKeyPayload;
  } catch {
    return null;
  }
}

function writeSessionPayload(userId: string, payload: StoredKeyPayload): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(clientKeyStorageKey(userId), JSON.stringify(payload));
  } catch {
    /* quota / private mode — in-memory only this page */
  }
}

/**
 * Return the persisted client key for this user, or null.
 *
 * SYNCHRONOUS on purpose: nine call sites, several in React effects and polling hot paths.
 * It therefore cannot await the async restore, and returns null during that window — callers
 * that would show the user "no key on this device" must await restoreInFlight() first.
 *
 * The ownership check here is a plain string compare (sync); the fingerprint is verified on the
 * async tiers, which are the ones that can hand back a foreign blob.
 */
export function getStoredClientKey(userId: string): string | null {
  if (typeof window === "undefined") return null;
  purgeLegacyPlaintextKey(userId);
  const p = readSessionPayload(userId);
  if (!p || typeof p.k !== "string" || !p.k) return null;
  if (p.v !== 1 && p.v !== 2) return null;
  // Applies to the sessionStorage tier TOO: restore writes through to here, and a mis-keyed blob
  // trusted once would be trusted for the rest of the tab's life.
  if (!p.signerAddress || p.signerAddress.toLowerCase() !== userId.toLowerCase()) return null;
  try {
    return payloadToHex(p);
  } catch {
    return null;
  }
}

// ── tier 2: localStorage, wrapped under the note enc-key ─────────────────────

interface WrappedBlob { enc_blob: string; iv: string }

async function wrapPayload(signer: Signer, payload: StoredKeyPayload): Promise<WrappedBlob> {
  const { deriveEncKey, encryptBlob } = await import("./noteAuth");
  const key = await deriveEncKey(signer);
  return encryptBlob(key, payload as unknown as object);
}

async function unwrapPayload(signer: Signer, blob: WrappedBlob): Promise<StoredKeyPayload | null> {
  try {
    const { deriveEncKey, decryptBlob } = await import("./noteAuth");
    const key = await deriveEncKey(signer);
    return await decryptBlob<StoredKeyPayload>(key, blob.enc_blob, blob.iv);
  } catch {
    // enc-key declined, no signer, corrupt blob — a restore never prompts to save a prompt, and
    // never propagates. Fall through to the next tier.
    return null;
  }
}

async function readLocalPayload(userId: string, signer: Signer): Promise<StoredKeyPayload | null> {
  if (typeof window === "undefined") return null;
  let blob: WrappedBlob | null = null;
  try {
    const raw = window.localStorage.getItem(clientKeyStorageKey(userId));
    blob = raw ? (JSON.parse(raw) as WrappedBlob) : null;
  } catch {
    return null;
  }
  if (!blob?.enc_blob || !blob?.iv) return null;
  return unwrapPayload(signer, blob);
}

async function writeLocalPayload(
  userId: string,
  signer: Signer,
  payload: StoredKeyPayload,
): Promise<void> {
  if (typeof window === "undefined") return;
  if (payload.derived !== true) return; // a random key never reaches disk
  try {
    const blob = await wrapPayload(signer, payload);
    window.localStorage.setItem(clientKeyStorageKey(userId), JSON.stringify(blob));
  } catch {
    /* quota / enc-key declined — the session tier still has it */
  }
}

// ── tier 3: server row ───────────────────────────────────────────────────────

async function readServerPayload(userId: string, signer: Signer): Promise<StoredKeyPayload | null> {
  try {
    const { getTradeExecutorBaseUrl } = await import("./tradeExecutorClient");
    const { getWalletAuthHeaders } = await import("./walletAuthHeaders");
    // READ headers: already cached from this page load, so no new prompt.
    const res = await fetch(
      `${getTradeExecutorBaseUrl()}/fheKeyBlob/${encodeURIComponent(userId)}`,
      { headers: await getWalletAuthHeaders(signer) },
    );
    if (!res.ok) return null; // 404 (no row yet) / 403 / 500 — fall through to derive
    const body = await res.json();
    if (!body?.enc_client_key || !body?.client_key_iv) return null;
    return unwrapPayload(signer, { enc_blob: body.enc_client_key, iv: body.client_key_iv });
  } catch {
    return null;
  }
}

/**
 * The wrapped ClientKey, shaped for /uploadServerKey's body.
 *
 * Deliberately NOT its own endpoint. getWalletWriteAuthHeaders signs a fresh nonce on every call
 * — there is no cache and no session-key path — so a dedicated PUT would put a wallet popup on
 * the very flow this work exists to quieten. Riding the upload's existing write challenge costs
 * nothing: the enc-key was already paid for by the note stores this page load.
 *
 * Best-effort by construction. Returns null (never throws) when there is no signer, no derived
 * key yet, or the enc-key is unavailable — the caller just posts without these fields, and the
 * user pays one extra prompt on their next new device.
 */
export async function wrappedClientKeyForUpload(userId: string): Promise<{
  enc_client_key: string;
  client_key_iv: string;
  client_key_fp: string;
  client_key_v: number;
} | null> {
  try {
    const uid = userId.toLowerCase();
    const payload = readSessionPayload(uid);
    // A random no-signer key is not reproducible on another device, so publishing it would hand
    // a second device a key it can never re-derive.
    if (!payload || payload.derived !== true) return null;
    const { getSigner } = await import("./nexus");
    const signer = getSigner();
    if (!signer) return null;
    const addr = (await signer.getAddress()).toLowerCase();
    if (addr !== uid || payload.signerAddress?.toLowerCase() !== addr) return null;
    const blob = await wrapPayload(signer, payload);
    return {
      enc_client_key: blob.enc_blob,
      client_key_iv: blob.iv,
      client_key_fp: payload.fp,
      client_key_v: payload.v,
    };
  } catch {
    return null;
  }
}

/**
 * Publish the wrapped ClientKey to the executor so another device can restore it without a
 * signature. Idempotent, fire-and-forget, at most one attempt per wallet per page load.
 *
 * WHY THIS IS NOT ONLY ON THE DERIVE PATH. The obvious place is right after deriveKeySeed — but
 * getOrCreateClientKey RETURNS EARLY on a session/local/server hit, so a user who already holds the
 * key on disk never reaches the derive branch again. Their blob would stay unpublished forever, and
 * the 404 they get on their next device is exactly the bug this fixes. Every existing user is in
 * that state, so publishing only on derive would fix nobody who already has a key.
 *
 * It therefore also runs on a LOCAL-tier hit, which is the migration path: the key is already on
 * this device, so publishing costs no prompt and backfills the server row that was never written.
 *
 * Publishing needs the enc-key (to wrap) and a session key (to authenticate). Neither is forced
 * here: if either is unavailable this returns quietly, because a background backup must never
 * open a wallet prompt of its own.
 */
const publishInflight = new Set<string>();

async function publishWrappedClientKey(uid: string, signer: Signer): Promise<void> {
  if (publishInflight.has(uid)) return;
  publishInflight.add(uid);
  try {
    const { getWalletWriteAuthHeaders, hasSessionKey } = await import("./walletAuthHeaders");

    // Wait for the session key rather than racing it: getWalletWriteAuthHeaders THROWS when no
    // session exists, and this often runs before the bootstrap's delegation has landed. Bounded
    // and event-free by design — a long poll here is cheap, and giving up merely defers the
    // publish to the next page load rather than losing anything.
    for (let i = 0; i < 30; i++) {
      if (await hasSessionKey(signer)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!(await hasSessionKey(signer))) {
      console.warn("[FHE] key publish deferred: no session key yet");
      return;
    }

    // Wrapped LAST, so a declined enc-key costs nothing until we know the rest can proceed.
    const wrapped = await wrappedClientKeyForUpload(uid);
    if (!wrapped) {
      console.warn("[FHE] key publish skipped: could not wrap the client key");
      return;
    }

    const { getTradeExecutorBaseUrl } = await import("./tradeExecutorClient");
    const res = await fetch(`${getTradeExecutorBaseUrl()}/uploadServerKey`, {
      method: "POST",
      headers: await getWalletWriteAuthHeaders(signer),
      body: JSON.stringify({ user_id: uid, ...wrapped }),
    });
    console.log(
      res.ok
        ? "[FHE] wrapped client key published — future devices restore without a signature"
        : `[FHE] key publish failed: ${res.status}`,
    );
  } catch (e) {
    // Logged, not swallowed. A silent skip leaves GET /fheKeyBlob 404ing forever and the seed
    // prompt returning on every fresh device, with nothing in the console to say why.
    console.warn("[FHE] key publish failed:", e);
  } finally {
    publishInflight.delete(uid);
  }
}

/**
 * keccak256(signature) → 32-byte hex seed. EVM signatures arrive 0x-prefixed; the Phantom adapter
 * returns bare hex of the 64-byte ed25519 signature, which keccak256 would reject.
 */
export function seedFromSignature(sig: string): string {
  return keccak256(sig.startsWith("0x") ? sig : `0x${sig}`);
}

/** keccak256(wallet signature of the fixed message) → 32-byte hex seed for deterministic keygen. */
async function deriveKeySeed(signer: Signer): Promise<string> {
  // Gated: the FHE warmup retries on a timer, so a declined seed used to re-prompt for ever.
  const wallet = (await signer.getAddress()).toLowerCase();
  const sig = await signGuarded(wallet, 'fhe-key', () => signer.signMessage(KEY_SEED_MESSAGE));
  return seedFromSignature(sig);
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;

/**
 * The signer that owns `userId`'s key: the EVM wallet for a 0x id, Phantom for a Solana one.
 *
 * Solana ids used to go to the EVM signer too, which either threw "refusing to store" (Phantom
 * exposes an EVM account as well) or, with no EVM signer, fell back to a random tab-only key that
 * no other device or tab could reproduce. ed25519 signatures are deterministic, so Phantom's
 * signMessage gives the same seed — the same key — everywhere, exactly like the EVM path. The
 * adapter is the note store's, so the wrapping enc-key is the one it already derived this load.
 */
async function signerForKeyOwner(userId: string): Promise<Signer | null> {
  if (EVM_ADDRESS.test(userId)) {
    const { getSigner } = await import("./nexus");
    return getSigner();
  }
  const { getPhantom } = await import("./chains/solanaWallet");
  const phantom = getPhantom();
  const pubkey = phantom?.publicKey?.toString();
  if (!phantom?.signMessage || !pubkey) return null;
  const { phantomEncSigner } = await import("./chains/solanaNoteStore");
  return phantomEncSigner(pubkey);
}

// ── the one entry point ──────────────────────────────────────────────────────

/** Keyed on the lowercased address, so two callers cannot race two unwrap+fetch round-trips. */
const clientKeyInflight = new Map<string, Promise<string>>();

/**
 * Resolves while a restore is running, so a caller can tell "not on this device" apart from
 * "arriving in a moment". Background pollers should NOT await this — they pick it up next tick.
 */
export function restoreInFlight(userId: string): Promise<void> | null {
  const p = clientKeyInflight.get(userId.toLowerCase());
  return p ? p.then(() => undefined, () => undefined) : null;
}

/**
 * Get the user's client key, restoring it rather than re-deriving wherever possible.
 *
 *   sessionStorage -> localStorage (unwrap) -> server (unwrap) -> derive (one signature)
 *
 * Every restore step is best-effort: a throw anywhere falls through to the next tier and
 * ultimately to derive. A restore never opens a prompt in order to save a prompt.
 *
 * THROWS when `userId` is not the connected signer. The key's entropy IS the signer's private
 * key, so storing it under someone else's id writes wallet A's key material into wallet B's
 * namespace — and persistence would make that permanent. Nothing that works today breaks:
 * `_wallet_authorizes` already 403s a recipient≠signer strategy at uploadServerKey, so such a
 * strategy cannot complete; this turns a confusing 403 into a clear early failure.
 */
export async function getOrCreateClientKey(
  userId: string,
  onGenerate?: () => void,
): Promise<string> {
  const uid = userId.toLowerCase();
  const cached = getStoredClientKey(uid);
  if (cached) return cached;

  const running = clientKeyInflight.get(uid);
  if (running) return running;

  const task = (async (): Promise<string> => {
    const signer = await signerForKeyOwner(userId);
    const isSolana = !EVM_ADDRESS.test(userId);

    if (!signer) {
      // No connected signer — a random key so the app still functions. Session-only, exactly as
      // before: it is not reproducible on another device, so it must never reach disk or a server.
      onGenerate?.();
      console.warn("[FHE] no signer for deterministic key derivation — using a random key");
      const { clientKey } = await generateKeys();
      writeSessionPayload(uid, await makePayload(clientKey, uid, false));
      return clientKey;
    }

    const signerAddress = (await signer.getAddress()).toLowerCase();
    if (signerAddress !== uid) {
      throw new Error(
        `getOrCreateClientKey: refusing to store wallet ${signerAddress}'s key under ${uid}. ` +
          `The FHE key is derived from the connected signer, so it must be requested for that ` +
          `same address.`,
      );
    }

    // The server tier and the publish authenticate with EVM session headers, so a Solana key
    // lives in the local (wrapped) tier only; a new device re-derives it with one Phantom prompt.
    const tiers = isSolana
      ? ([["local", readLocalPayload]] as const)
      : ([["local", readLocalPayload], ["server", readServerPayload]] as const);
    for (const [tier, read] of tiers) {
      const p = await read(uid, signer);
      if (await payloadIsTrustworthy(p, signerAddress, true)) {
        const hex = payloadToHex(p as StoredKeyPayload);
        writeSessionPayload(uid, p as StoredKeyPayload);
        // A server restore is cached to disk (wrapped) so the next tab is a local hit and never
        // needs the network. Free: wrapping reuses the enc-key this page load already paid for.
        if (tier === "server") {
          await writeLocalPayload(uid, signer, p as StoredKeyPayload);
        } else {
          // LOCAL hit — the server may never have received this key. Users who derived before the
          // publish existed hold the key on disk and hit this branch on every load, so without a
          // backfill here they would never publish and would be prompted again on their next
          // device. Idempotent and prompt-free; the executor upserts.
          if (!isSolana) void publishWrappedClientKey(uid, signer);
        }
        return hex;
      }
    }

    onGenerate?.();
    const seed = await deriveKeySeed(signer);
    const clientKey = await generateKeysFromSeed(seed);
    const payload = await makePayload(clientKey, signerAddress, true);
    writeSessionPayload(uid, payload);
    await writeLocalPayload(uid, signer, payload);

    // PUBLISH THE WRAPPED KEY NOW — do not wait for an /uploadServerKey that may never come.
    //
    // This used to defer, because publishing meant a second wallet signature straight after the
    // seed one. That is no longer true: getWalletWriteAuthHeaders signs with the SESSION KEY, so
    // the write costs no prompt. Meanwhile the deferral had a real cost — the upload only happens
    // when a strategy is ARMED, so a user who deposits and withdraws without ever arming never
    // publishes, GET /fheKeyBlob 404s on their next device, and the ladder falls through to derive
    // and prompts again. That is the intermittent "sign to derive your private FHE key" popup:
    // present exactly when this row is missing.
    //
    // The executor accepts a blob-only POST (app.py: `server_key, canary or enc_client_key`), so
    // this sends a few hundred bytes, not the ~24MB server key.
    //
    // Best-effort and non-blocking: the key is already usable from the two local tiers, so a
    // failure here costs one prompt on the NEXT device and nothing on this one.
    if (!isSolana) void publishWrappedClientKey(uid, signer);

    return clientKey;
  })()
    .finally(() => {
      clientKeyInflight.delete(uid);
      // Sync readers (getStoredClientKey) now succeed — tell the UI so it stops rendering
      // "key not generated yet" at a user whose key just landed.
      if (typeof window !== "undefined") {
        void import("./fheKeyWarmup")
          .then(({ FHE_KEYS_EVENT }) =>
            window.dispatchEvent(new CustomEvent(FHE_KEYS_EVENT)))
          .catch(() => {});
      }
    });

  clientKeyInflight.set(uid, task);
  return task;
}

/**
 * Generate a fresh FHE keypair. Heavy: server-key generation is single-threaded
 * in wasm and can take a few seconds. Returns { clientKey, serverKey } as hex.
 */
export async function generateKeys(): Promise<FheKeyPair> {
  const mod = await loadFhe();
  const pair = mod.generate_keys() as FheKeyPair;
  return pair;
}

/**
 * DETERMINISTIC client key from a hex seed: the same seed always yields a byte-identical clientKey.
 * The seed is keccak256(wallet signature) — see deriveKeySeed. Returns only the client key; the
 * server key is re-derived on demand (deriveServerKey) since any server key from this client key
 * validly evaluates its ciphertexts.
 */
export async function generateKeysFromSeed(seedHex: string): Promise<string> {
  const mod = await loadFhe();
  return mod.generate_keys_from_seed(seedHex) as string;
}

/**
 * Encrypt a price (in whole currency units, e.g. dollars) under the given client
 * key. Mirrors the server: priceCents = round(price * 100), encrypted as u64.
 * Returns the ciphertext as bincode+hex.
 */
export async function encryptPrice(
  price: number,
  clientKeyHex: string,
): Promise<string> {
  const mod = await loadFhe();
  const cents = BigInt(Math.round(price * 100));
  return mod.encrypt_price(cents, clientKeyHex);
}

/**
 * Encrypt an already-in-cents value (use when the caller did its own scaling).
 */
export async function encryptPriceCents(
  cents: bigint,
  clientKeyHex: string,
): Promise<string> {
  const mod = await loadFhe();
  return mod.encrypt_price(cents, clientKeyHex);
}

/**
 * Decrypt an engine-produced result ciphertext. The engine encodes the trigger
 * as 1/0; this returns the boolean (true = condition met).
 */
export async function decryptResult(
  ciphertextHex: string,
  clientKeyHex: string,
): Promise<boolean> {
  const mod = await loadFhe();
  return mod.decrypt_result(ciphertextHex, clientKeyHex);
}

/**
 * Recursively encrypt a price condition tree in place: each LEAF's plaintext
 * `bound` (dollars) is replaced with `encrypted_bound` (hex), matching the
 * server's encrypt_tree. Returns a new tree; the input is not mutated.
 */
export async function encryptConditionTree(
  tree: unknown,
  clientKeyHex: string,
): Promise<unknown> {
  const clone = structuredClone(tree);
  await encryptTreeInPlace(clone, clientKeyHex);
  return clone;
}

async function encryptTreeInPlace(
  node: unknown,
  clientKeyHex: string,
): Promise<void> {
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  if (obj.op === "LEAF") {
    // bound arrives as a raw string from the decimal-friendly builder inputs ("1900"). Coerce to a
    // number so it's ALWAYS encrypted: a non-number bound silently skipped this branch, leaving the
    // plaintext bound in the tree — it then leaked to the server (stored on EC2) and made the FHE
    // engine 400 (it expects encrypted_bound, not a plaintext bound). FUND/PRIVACY-critical.
    // Number("") is 0 (not NaN), so guard empties explicitly — an empty bound must skip, not encrypt 0.
    const raw = obj.bound;
    const bound = typeof raw === "string" ? Number(raw.trim() || NaN) : raw;
    if (typeof bound === "number" && Number.isFinite(bound)) {
      obj.encrypted_bound = await encryptPrice(bound, clientKeyHex);
      delete obj.bound;
    }
    return;
  }

  const conditions = obj.conditions;
  if (Array.isArray(conditions)) {
    for (const child of conditions) {
      await encryptTreeInPlace(child, clientKeyHex);
    }
  }
}
