/**
 * Shared auth primitives for the note DB (Supabase).
 *
 * Single tag — keccak256(walletSig)[0:20 bytes] — used for both commitments
 * and precommitments tables. Tag is wallet-bound and pseudonymous in the DB.
 *
 * Auth token v2 = HMAC-SHA256(key=tagWalletSig, msg="siphon-auth-v2:"+tag) — not
 * forgeable from a DB tag leak alone. Server pins sha256(token) via /auth/tag-bind.
 * Legacy v1 is never emitted by this client (NOTE-02).
 *
 * Popup count (target):
 *   First ever visit : 1 note popup (enc-key → tag derived from same sig). Tag-bind is awaited
 *     before /commitments (read auth, write fallback only if executor still requires it).
 *   New tab          : 1 (enc-key memory miss; tag/authToken restored from sessionStorage)
 *   Same tab reload  : 1 (enc-key is memory-only — OMEGA-02)
 *
 * Encryption key: AES-GCM, derived from wallet sig, held in memory only (never sessionStorage).
 */
import { Signer } from 'ethers';
import { keccak256, toUtf8Bytes } from 'ethers';
import { showAppToast } from './appToast';
import { clearSignatureDeclines, isSignatureDeclined, signGuarded } from './walletSignatureGate';

const ENC_KEY_DECLINED_MESSAGE =
  'Signature declined — your private balance stays hidden. Reconnect your wallet to unlock it.';

const SIGN_TAG     = 'Siphon tag v1';
const SIGN_ENC_KEY = 'Siphon-Encryption-Key-v1';
const HMAC_AUTH_MSG_V2 = 'siphon-auth-v2';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? '';
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

// ── In-memory caches ──────────────────────────────────────────────────────────
const _tagCache       = new Map<string, string>();      // wallet → tag
const _authTokenCache = new Map<string, string>();      // wallet → authToken
const _tagSigCache    = new Map<string, string>();      // wallet → tag signing sig
const _encKeyCache    = new Map<string, CryptoKey>();
/** In-memory raw SHA-256 bytes for HMAC (nullifier registry). Never written to storage (OMEGA-02). */
const _encKeyRawCache = new Map<string, ArrayBuffer>();
/** Enc-key wallet signature — used to derive tag without a second popup. Memory only. */
const _encSigCache    = new Map<string, string>();
// `${executorBase}|${tag}` — the pin lives on ONE executor, and each chain can have its own.
const _boundTags      = new Set<string>();

async function _executorBase(): Promise<string> {
  const { getTradeExecutorBaseUrl } = await import('./tradeExecutorClient');
  return getTradeExecutorBaseUrl();
}

/**
 * The X-Auth-Token to present to `base`. It is a static bearer that authorizes every note-backup
 * route (read, mark-spent, prune), so the raw token must only ever reach the executor that pinned
 * it first — the global one. A per-chain executor gets sha256("siphon-tag-token-v1|origin|token"):
 * it pins that instead, and a copy captured there is useless against any other executor.
 */
export async function _tokenForExecutor(authToken: string, base: string): Promise<string> {
  const { isPerChainExecutor } = await import('./tradeExecutorClient');
  if (!isPerChainExecutor(base)) return authToken;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`siphon-tag-token-v1|${base}|${authToken}`),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const _encKeyInflight = new Map<string, Promise<CryptoKey>>();
const _tagInflight    = new Map<string, Promise<void>>();

/**
 * Decline memory lives in walletSignatureGate — this was only one of five signing paths with the
 * same "cache the success, forget the rejection" bug, so the policy belongs in one place.
 */

// sessionStorage: survives HMR/page-reload within same tab (tag + authToken — not enc-key)
const _ssKey = (kind: string, wallet: string) => `siphon-auth-${kind}-${wallet}`;
function _ssGet(kind: string, wallet: string): string | null {
  try { return sessionStorage.getItem(_ssKey(kind, wallet)); } catch { return null; }
}
function _ssSet(kind: string, wallet: string, value: string): void {
  try { sessionStorage.setItem(_ssKey(kind, wallet), value); } catch { /* quota */ }
}

/**
 * Durable per-origin tag record — localStorage, so it survives closing the tab.
 *
 * The tag identifies which rows belong to this wallet, so it must be STABLE FOREVER: a wallet that
 * derives a second tag owns nothing under it and reads as an empty balance. Every store here was
 * previously either memory (gone on reload) or sessionStorage (gone on tab close), and the only
 * durable copy lived in Supabase `wallet_keys` behind NEXT_PUBLIC_COMMITMENTS_VIA_SUPABASE. With
 * that flag off there was NO persistence at all, so each new tab re-derived a tag from scratch —
 * which is why local builds produced a different tag than the deployment for the same wallet.
 *
 * Holding the tag locally is not a secret leak: `tag` is already sent in cleartext as X-Tag on
 * every request, and `authToken` is the HMAC the executor pins via /auth/tag-bind. `tagSig` is a
 * wallet signature over a fixed public message. None of it is note-secret material — those stay
 * encrypted under the enc-key, which is memory-only and deliberately NOT stored here.
 */
const _lsKey = (kind: string, wallet: string) => `siphon-tagrec-${kind}-${wallet}`;
function _lsGet(kind: string, wallet: string): string | null {
  try { return localStorage.getItem(_lsKey(kind, wallet)); } catch { return null; }
}
function _lsSet(kind: string, wallet: string, value: string): void {
  try { localStorage.setItem(_lsKey(kind, wallet), value); } catch { /* quota / private mode */ }
}

function _persistTagSession(wallet: string, blob: { tag: string; authToken: string; tagSig?: string }): void {
  _ssSet('tag', wallet, blob.tag);
  _ssSet('authToken', wallet, blob.authToken);
  if (blob.tagSig) _ssSet('tagSig', wallet, blob.tagSig);
  // Durable mirror — this is what stops a new tab from deriving a second tag.
  _lsSet('tag', wallet, blob.tag);
  _lsSet('authToken', wallet, blob.authToken);
  if (blob.tagSig) _lsSet('tagSig', wallet, blob.tagSig);
}

/** Restore from the durable record. Same shape as _restoreTagSession, one storage tier down. */
function _restoreTagLocal(wallet: string): boolean {
  const tag = _lsGet('tag', wallet);
  const authToken = _lsGet('authToken', wallet);
  if (!tag || !authToken) return false;
  _tagCache.set(wallet, tag);
  _authTokenCache.set(wallet, authToken);
  const tagSig = _lsGet('tagSig', wallet);
  if (tagSig) _tagSigCache.set(wallet, tagSig);
  // Re-arm sessionStorage so the rest of this tab takes the fast path.
  _persistTagSession(wallet, { tag, authToken, tagSig: tagSig ?? undefined });
  return true;
}

function _restoreTagSession(wallet: string): boolean {
  const tag = _ssGet('tag', wallet);
  const authToken = _ssGet('authToken', wallet);
  if (!tag || !authToken) return false;
  _tagCache.set(wallet, tag);
  _authTokenCache.set(wallet, authToken);
  const tagSig = _ssGet('tagSig', wallet);
  if (tagSig) _tagSigCache.set(wallet, tagSig);
  return true;
}

// ── HMAC auth token ───────────────────────────────────────────────────────────

/** Wallet-bound token — tagSig is the MetaMask signature used to derive the tag. */
async function _deriveAuthTokenV2(tag: string, tagSig: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(tagSig),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${HMAC_AUTH_MSG_V2}:${tag}`),
  );
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── wallet_keys Supabase blob ─────────────────────────────────────────────────

type WalletBlob = { tag: string; authToken: string; tagSig?: string; authVersion?: number };

async function _fetchWalletBlob(key: CryptoKey, wallet: string): Promise<WalletBlob | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  // OMEGA-03: anon-key REST only when explicitly opted in (same flag as commitments).
  if ((process.env.NEXT_PUBLIC_COMMITMENTS_VIA_SUPABASE || '').trim() !== '1') return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/wallet_keys?wallet_address=eq.${encodeURIComponent(wallet)}&select=enc_blob,iv`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) return null;
    const rows: { enc_blob: string; iv: string }[] = await res.json();
    if (!rows.length) return null;
    const blob = await decryptBlob<WalletBlob>(key, rows[0].enc_blob, rows[0].iv);
    if (!blob.tag || !blob.authToken) return null;
    return blob;
  } catch {
    return null;
  }
}

async function _writeWalletBlob(key: CryptoKey, wallet: string, blob: WalletBlob): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  if ((process.env.NEXT_PUBLIC_COMMITMENTS_VIA_SUPABASE || '').trim() !== '1') return;
  try {
    const { enc_blob, iv } = await encryptBlob(key, blob);
    await fetch(`${SUPABASE_URL}/rest/v1/wallet_keys`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ wallet_address: wallet, enc_blob, iv }),
    });
  } catch { /* best-effort */ }
}

function _applyBlob(wallet: string, blob: WalletBlob): void {
  _tagCache.set(wallet, blob.tag);
  _authTokenCache.set(wallet, blob.authToken);
  if (blob.tagSig) _tagSigCache.set(wallet, blob.tagSig);
  _persistTagSession(wallet, blob);
}

// ── Tag + auth token resolution ───────────────────────────────────────────────

async function _ensureTagOnce(signer: Signer, wallet: string): Promise<void> {
  if (_tagCache.has(wallet) && _authTokenCache.has(wallet)) {
    await _bindTagVerifier(signer, _tagCache.get(wallet)!, _authTokenCache.get(wallet)!);
    return;
  }

  // sessionStorage fast path — same tab reload / HMR: restore tag without Siphon tag v1 popup
  if (_restoreTagSession(wallet)) {
    await _bindTagVerifier(signer, _tagCache.get(wallet)!, _authTokenCache.get(wallet)!);
    return;
  }

  // Durable local record — a NEW TAB, or any reload after the tab was closed. Checked before the
  // Supabase lookup and before any signing, because a wallet that already has a tag must reuse it:
  // deriving a second one orphans every note filed under the first. This is the tier that was
  // missing, and its absence is why a tag got regenerated on every cold start.
  if (_restoreTagLocal(wallet)) {
    await _bindTagVerifier(signer, _tagCache.get(wallet)!, _authTokenCache.get(wallet)!);
    return;
  }

  // Supabase lookup — requires enc-key (1 popup on new tab)
  const key = await deriveEncKey(signer);
  const blob = await _fetchWalletBlob(key, wallet);
  if (blob) {
    // Never keep forgeable v1 tokens (HMAC of tag alone). Upgrade or re-bind to v2 (NOTE-02).
    if (blob.tagSig && (blob.authVersion ?? 1) < 2) {
      const v2 = await _deriveAuthTokenV2(blob.tag, blob.tagSig);
      const upgraded: WalletBlob = { ...blob, authToken: v2, authVersion: 2 };
      _applyBlob(wallet, upgraded);
      _writeWalletBlob(key, wallet, upgraded).catch(() => {});
      await _bindTagVerifier(signer, upgraded.tag, upgraded.authToken);
      return;
    }
    if ((blob.authVersion ?? 1) < 2 || !blob.tagSig) {
      // Legacy blob without tagSig — re-derive so we never emit a v1 token.
      //
      // MUST sign SIGN_ENC_KEY, not SIGN_TAG. The tag is keccak(signature): signing a different
      // message yields a different tag, and every note this wallet owns is filed under the
      // enc-key-derived one. Verified against live data — the enc-key signature reproduces this
      // wallet's real tag, while SIGN_TAG produced an orphan owning zero rows.
      const sig = _encSigCache.get(wallet) ?? await signer.signMessage(SIGN_ENC_KEY);
      _encSigCache.set(wallet, sig);
      const tag = keccak256(toUtf8Bytes(sig)).slice(2, 42);
      const authToken = await _deriveAuthTokenV2(tag, sig);
      const newBlob: WalletBlob = { tag, authToken, tagSig: sig, authVersion: 2 };
      _applyBlob(wallet, newBlob);
      _writeWalletBlob(key, wallet, newBlob).catch(() => {});
      await _bindTagVerifier(signer, tag, authToken);
      return;
    }
    _applyBlob(wallet, blob);
    await _bindTagVerifier(signer, blob.tag, blob.authToken);
    return;
  }

  // First ever setup for this wallet — derive the tag ONCE, from the enc-key signature.
  //
  // The tag is keccak(signature), so WHICH message gets signed decides the tag. Falling back to
  // SIGN_TAG when _encSigCache was cold silently produced a DIFFERENT tag for the same wallet:
  // _deriveEncKeyOnce only populates that cache on its fresh-sign path, so a key recovered from
  // memory or sessionStorage left it empty even though the enc-key was available. The wallet then
  // got a tag derived from 'Siphon tag v1' instead of 'Siphon-Encryption-Key-v1' — an orphan tag
  // that owns no rows, so every note query returned empty and the balance read zero, silently.
  //
  // personal_sign over a fixed message is deterministic, so re-signing SIGN_ENC_KEY always
  // reproduces the same signature, and therefore the same tag, whichever path warmed the key.
  let encSig = _encSigCache.get(wallet);
  if (!encSig) {
    encSig = await signer.signMessage(SIGN_ENC_KEY);
    _encSigCache.set(wallet, encSig);
  }
  const tag       = keccak256(toUtf8Bytes(encSig)).slice(2, 42);
  const authToken = await _deriveAuthTokenV2(tag, encSig);

  const newBlob: WalletBlob = { tag, authToken, tagSig: encSig, authVersion: 2 };
  _applyBlob(wallet, newBlob);
  _writeWalletBlob(key, wallet, newBlob).catch(() => { /* best-effort */ });
  await _bindTagVerifier(signer, tag, authToken);
}

/**
 * Pin tag→token on the trade-executor. Must complete before /commitments or we get 401
 * (TAG_AUTH_V2_ONLY). Prefer read auth; fall back to write challenge only if executor still
 * requires it (older deploys).
 */
async function _bindTagVerifier(
  signer: Signer,
  tag: string,
  authToken: string,
  executorBase?: string,
): Promise<boolean> {
  const base = executorBase ?? (await _executorBase());
  const boundKey = `${base}|${tag}`;
  if (_boundTags.has(boundKey)) return true;
  try {
    const { getWalletAuthHeaders, getWalletWriteAuthHeaders } = await import('./walletAuthHeaders');
    const headersBase = {
      'X-Tag': tag,
      'X-Auth-Token': await _tokenForExecutor(authToken, base),
    };
    const read = await getWalletAuthHeaders(signer);
    let res = await fetch(`${base}/auth/tag-bind`, {
      method: 'POST',
      headers: { ...read, ...headersBase },
      body: '{}',
    });
    // Older executors still gate tag-bind with write-challenge.
    if (res.status === 401) {
      const write = await getWalletWriteAuthHeaders(signer);
      res = await fetch(`${base}/auth/tag-bind`, {
        method: 'POST',
        headers: { ...write, ...headersBase },
        body: '{}',
      });
    }
    if (res.ok) {
      _boundTags.add(boundKey);
      try { localStorage.setItem(`siphon-tag-bound-${tag}`, '1'); } catch { /* ignore */ }
      return true;
    }
    console.warn('[noteAuth] tag-bind failed:', res.status, await res.text().catch(() => ''));
    // Stale local "bound" flag — force retry next time.
    try { localStorage.removeItem(`siphon-tag-bound-${tag}`); } catch { /* ignore */ }
    return false;
  } catch (e) {
    console.warn('[noteAuth] tag-bind error:', e);
    return false;
  }
}

/** Clear local bind memo so the next ensureTag re-pins (e.g. after commitments 401). */
export function invalidateTagBind(tag: string): void {
  for (const k of _boundTags) if (k.endsWith(`|${tag}`)) _boundTags.delete(k);
  try { localStorage.removeItem(`siphon-tag-bound-${tag}`); } catch { /* ignore */ }
}

async function _ensureTag(signer: Signer, wallet: string): Promise<void> {
  if (_tagCache.has(wallet) && _authTokenCache.has(wallet)) return;
  const inflight = _tagInflight.get(wallet);
  if (inflight) return inflight;
  const promise = _ensureTagOnce(signer, wallet).finally(() => _tagInflight.delete(wallet));
  _tagInflight.set(wallet, promise);
  return promise;
}

export async function deriveTag(signer: Signer): Promise<string> {
  const wallet = (await signer.getAddress()).toLowerCase();
  await _ensureTag(signer, wallet);
  return _tagCache.get(wallet)!;
}

/** @deprecated use deriveTag — kept for callers not yet migrated */
export async function deriveCommTag(signer: Signer): Promise<string> {
  return deriveTag(signer);
}

/** @deprecated use deriveTag — kept for callers not yet migrated */
export async function derivePrecommTag(signer: Signer): Promise<string> {
  return deriveTag(signer);
}

/**
 * `executorBase` is the host the caller is about to fetch. Pass the SAME value you fetch with: the
 * token is scoped to it (F-1), so resolving the host twice across a chain switch would present one
 * executor's token to another — at best a 401, at worst the global token on a per-chain host.
 */
export async function noteAuthHeaders(
  signer: Signer,
  tag: string,
  executorBase?: string,
): Promise<Record<string, string>> {
  const base = executorBase ?? (await _executorBase());
  const wallet = (await signer.getAddress()).toLowerCase();
  await _ensureTag(signer, wallet);
  const authToken = _authTokenCache.get(wallet);
  if (!authToken) {
    throw new Error("Note auth token unavailable — reconnect wallet and retry");
  }
  // Ensure pin completed (covers cache-hit path that skipped a failed earlier bind).
  if (!_boundTags.has(`${base}|${tag}`)) {
    await _bindTagVerifier(signer, tag, authToken, base);
  }
  return {
    'X-Tag':            tag,
    'X-Wallet-Address': wallet,
    'X-Auth-Token':     await _tokenForExecutor(authToken, base),
    'Content-Type':     'application/json',
  };
}

// ── Enc-key derivation ────────────────────────────────────────────────────────

async function _deriveEncKeyOnce(signer: Signer, wallet: string): Promise<CryptoKey> {
  const mem = _encKeyCache.get(wallet);
  if (mem) return mem;
  const ssHex = _ssGet('enc-key', wallet);
  if (ssHex) {
    // OMEGA-02: migrate away from persisted key material — import once, then wipe SS.
    const raw = new Uint8Array(ssHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const rawBuf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const key = await crypto.subtle.importKey('raw', rawBuf, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    _encKeyCache.set(wallet, key);
    _encKeyRawCache.set(wallet, rawBuf);
    try { sessionStorage.removeItem(_ssKey('enc-key', wallet)); } catch { /* ignore */ }
    return key;
  }
  const sig  = await signer.signMessage(SIGN_ENC_KEY);
  _encSigCache.set(wallet, sig);
  const raw  = new TextEncoder().encode(sig);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  // extractable:false — never re-export via WebCrypto (OMEGA-02).
  const key  = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  _encKeyCache.set(wallet, key);
  _encKeyRawCache.set(wallet, hash);
  return key;
}

/** Kept as named exports because callers (and the walletManager adopt hook) speak in these terms. */
export const isEncKeyDeclined = isSignatureDeclined;
export const clearEncKeyDecline = clearSignatureDeclines;

export async function deriveEncKey(signer: Signer): Promise<CryptoKey> {
  const wallet = (await signer.getAddress()).toLowerCase();
  const mem = _encKeyCache.get(wallet);
  if (mem) return mem;
  const inflight = _encKeyInflight.get(wallet);
  if (inflight) return inflight;
  const promise = signGuarded(
    wallet,
    'enc-key',
    () => _deriveEncKeyOnce(signer, wallet),
    // Rejecting leaves the private balance empty and the note sync dead. Without this the app
    // just looks broken, and the only feedback was the popup we now correctly suppress.
    () => showAppToast(ENC_KEY_DECLINED_MESSAGE, 'error'),
  ).finally(() => _encKeyInflight.delete(wallet));
  _encKeyInflight.set(wallet, promise);
  return promise;
}

/**
 * Raw enc-key material for in-process HMAC only (nullifier registry).
 * Lives in memory alongside the non-extractable AES CryptoKey — never sessionStorage.
 */
export async function deriveEncKeyRaw(signer: Signer): Promise<ArrayBuffer> {
  const wallet = (await signer.getAddress()).toLowerCase();
  await deriveEncKey(signer);
  const raw = _encKeyRawCache.get(wallet);
  if (!raw) throw new Error("enc key raw material unavailable");
  return raw;
}

export function isEncKeyCached(wallet: string): boolean {
  return _encKeyCache.has(wallet.toLowerCase());
}

// ── Encryption-key drift canary ───────────────────────────────────────────────
const KEYCHECK_PREFIX = 'siphon-keycheck-';
const CANARY_TEXT = 'siphon-canary-v1';

export async function encKeyDrifted(signer: Signer): Promise<boolean> {
  if (typeof localStorage === 'undefined') return false;
  let wallet: string;
  let key: CryptoKey;
  try {
    wallet = (await signer.getAddress()).toLowerCase();
    key = await deriveEncKey(signer);
  } catch {
    return false;
  }
  const ckKey = `${KEYCHECK_PREFIX}${wallet}`;
  let parsed: { enc_blob: string; iv: string } | null = null;
  const stored = localStorage.getItem(ckKey);
  if (stored) { try { parsed = JSON.parse(stored); } catch { parsed = null; } }
  if (!parsed) {
    try {
      const enc = await encryptBlob(key, { c: CANARY_TEXT });
      localStorage.setItem(ckKey, JSON.stringify(enc));
    } catch { /* quota */ }
    return false;
  }
  try {
    const dec = await decryptBlob<{ c: string }>(key, parsed.enc_blob, parsed.iv);
    return dec.c !== CANARY_TEXT;
  } catch {
    return true;
  }
}

// ── AES-GCM helpers ───────────────────────────────────────────────────────────

export async function encryptBlob(key: CryptoKey, payload: object): Promise<{ enc_blob: string; iv: string }> {
  const iv      = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const ct      = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    enc_blob: btoa(String.fromCharCode(...new Uint8Array(ct))),
    iv:       btoa(String.fromCharCode(...iv)),
  };
}

export async function decryptBlob<T = Record<string, unknown>>(
  key: CryptoKey,
  enc_blob: string,
  iv: string,
): Promise<T> {
  const ivBytes = Uint8Array.from(atob(iv),       c => c.charCodeAt(0));
  const ctBytes = Uint8Array.from(atob(enc_blob), c => c.charCodeAt(0));
  const pt      = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
