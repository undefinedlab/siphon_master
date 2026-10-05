/**
 * Session-key delegation — one wallet popup per session instead of one per request.
 *
 * WHAT THIS SOLVES
 * Auth signatures fire constantly: `Siphon auth v1` per read, `Siphon auth v1:req` per distinct
 * request body, `Siphon API v1` on every gateway call. Caching cannot fix it — the gateway SETNXes
 * on (wallet, timestamp, signature, nonce) and returns 409 on reuse, deliberately. So the wallet is
 * asked to sign again and again, and the user sees 4-5 MetaMask prompts on a cold load.
 *
 * Instead: generate a throwaway keypair in the browser, have the wallet sign ONE delegation
 * authorizing it, then let the session key produce the per-request signatures.
 *
 * WHY THE DELEGATION TRAVELS WITH EVERY REQUEST
 * The Next app has no server-side store — routes run in Amplify SSR Lambdas with no shared state
 * (see the note in graphHttpGuard.ts about per-worker rate limiting). There is nowhere to persist
 * `sessionAddr -> wallet`. So the client sends the delegation itself in a header and the server
 * verifies the chain cryptographically:
 *
 *     wallet  --signs-->  delegation(sessionAddr, expiry)  --signs-->  per-request message
 *
 * Two `verifyMessage` calls, no lookup, no state. Stateless verification is what makes this
 * deployable on the current infrastructure rather than a prerequisite Redis rollout.
 *
 * WHAT A SESSION KEY CANNOT DO — the security argument
 *   - It NEVER signs key-derivation messages. `Siphon-Encryption-Key-v1`, `Siphon tag v1` and the
 *     FHE seed must be reproducible from the WALLET alone on any device, or a user who clears their
 *     browser cannot recover their notes. Those stay on the wallet, always. See noteAuth.ts / fhe.ts.
 *   - It CANNOT move funds. Spending is authorized by a Groth16 proof in VaultKernel.spend(), never
 *     by any signature in this file. A stolen session key reads note lists and burns API credits.
 *   - It expires (24h hard cap) and is scoped to one origin and one wallet.
 *
 * STORAGE
 * sessionStorage, not localStorage: the key dies with the tab, which bounds exposure without
 * meaningfully hurting UX (a new tab re-prompts once). The private key is necessarily readable by
 * JS — an HttpOnly cookie would not be, but cookies do not work for the SDK/MCP clients this
 * protocol is being packaged for, and today's 24h `Siphon auth v1` signature already sits in
 * localStorage, so this is a net improvement rather than a regression.
 */

import { Wallet, verifyMessage } from "ethers";
import type { Signer } from "ethers";

export const SESSION_DELEGATION_PREFIX = "Siphon session key v1";
/** Hard cap. Not configurable upward — a long-lived delegated key is the thing to avoid. */
export const SESSION_MAX_AGE_SEC = 24 * 60 * 60;
/** Re-delegate slightly early so a request in flight cannot straddle the expiry. */
const RENEW_SKEW_SEC = 120;

export const SESSION_HEADER = "X-Session-Delegation";
export const SESSION_KEY_HEADER = "X-Session-Key";

const ssKey = (wallet: string) => `siphon:sesskey:${wallet.toLowerCase()}`;

export type SessionDelegation = {
  /** Session address (derived from the ephemeral key). */
  sessionAddress: string;
  /** Wallet that authorized it, lowercased. */
  wallet: string;
  chainId: number;
  domain: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  /** Wallet's signature over buildDelegationMessage(...). */
  signature: string;
};

type StoredSession = SessionDelegation & { privateKey: string };

/**
 * The text the user actually reads in MetaMask.
 *
 * It says plainly what is NOT granted. A user who cannot tell an auth delegation from a spend
 * approval is one bad prompt away from signing something they should not, and blind-clicking is a
 * learned behaviour we would be teaching. Domain and chain are inside the signed bytes so a
 * signature phished on another origin cannot be replayed here — the current `Siphon auth v1:<ts>`
 * has no domain binding at all, so this is strictly stronger than what it replaces.
 */
export function buildDelegationMessage(d: Omit<SessionDelegation, "signature">): string {
  return [
    SESSION_DELEGATION_PREFIX,
    "",
    "I authorize the session key below to authenticate API requests on my behalf.",
    "",
    "This does NOT authorize spending, withdrawing, or moving any funds.",
    "Moving funds requires a zero-knowledge proof, which this key cannot produce.",
    "",
    `Session key: ${d.sessionAddress}`,
    `Wallet:      ${d.wallet}`,
    `Domain:      ${d.domain}`,
    `Chain:       ${d.chainId}`,
    `Issued:      ${new Date(d.issuedAt * 1000).toISOString()}`,
    `Expires:     ${new Date(d.expiresAt * 1000).toISOString()}`,
    `Nonce:       ${d.nonce}`,
  ].join("\n");
}

function readStored(wallet: string): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(ssKey(wallet));
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    // Treat a nearly-expired session as absent so we re-delegate before a request fails.
    if (!s?.privateKey || s.expiresAt - RENEW_SKEW_SEC <= Math.floor(Date.now() / 1000)) {
      sessionStorage.removeItem(ssKey(wallet));
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function writeStored(s: StoredSession): void {
  try {
    sessionStorage.setItem(ssKey(s.wallet), JSON.stringify(s));
  } catch {
    /* private mode / quota — fall back to signing with the wallet each time */
  }
}

export function clearSession(wallet?: string | null): void {
  try {
    if (wallet) {
      sessionStorage.removeItem(ssKey(wallet));
      return;
    }
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith("siphon:sesskey:")) sessionStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/** True when a usable session exists — lets callers avoid an await on the hot path. */
export function hasSession(wallet: string | null | undefined): boolean {
  return !!wallet && readStored(wallet) !== null;
}

/** Single-flight: parallel callers must not each trigger their own MetaMask prompt. */
const inflight = new Map<string, Promise<StoredSession | null>>();

/**
 * Await an in-progress delegation, if one is running.
 *
 * Priming happens on the `walletConnected` event, but components mount and start authenticating on
 * their own schedule — TeeClientKeySync calls getWalletAuthHeaders directly on mount. Both fire off
 * the same connect, so without this the auth call reads sessionStorage a few milliseconds before
 * the delegation lands, finds nothing, and prompts the wallet anyway. The user then sees the very
 * popup they just signed a session key to avoid.
 *
 * Resolves immediately when nothing is pending, so this costs nothing on the steady-state path.
 */
export async function awaitPendingSession(wallet: string | null | undefined): Promise<void> {
  if (!wallet) return;
  const pending = inflight.get(wallet.toLowerCase());
  if (pending) {
    try {
      await pending;
    } catch {
      /* a declined or failed delegation just means we fall back to wallet signing */
    }
  }
}

/**
 * Return a live session for `signer`, creating one (ONE wallet popup) if needed.
 *
 * Returns null if the user rejects. Callers MUST treat null as "fall back to wallet signing"
 * rather than as an error: declining a session is a legitimate choice, and every path this
 * replaces still works without one.
 */
export async function ensureSession(
  signer: Signer,
  chainId: number,
): Promise<StoredSession | null> {
  const wallet = (await signer.getAddress()).toLowerCase();

  const existing = readStored(wallet);
  if (existing) return existing;

  const pending = inflight.get(wallet);
  if (pending) return pending;

  const promise = (async (): Promise<StoredSession | null> => {
    const ephemeral = Wallet.createRandom();
    const now = Math.floor(Date.now() / 1000);
    const unsigned: Omit<SessionDelegation, "signature"> = {
      sessionAddress: ephemeral.address,
      wallet,
      chainId,
      domain: typeof window !== "undefined" ? window.location.host : "",
      issuedAt: now,
      expiresAt: now + SESSION_MAX_AGE_SEC,
      nonce: crypto.randomUUID(),
    };

    try {
      const signature = await signer.signMessage(buildDelegationMessage(unsigned));
      const stored: StoredSession = { ...unsigned, signature, privateKey: ephemeral.privateKey };
      writeStored(stored);
      return stored;
    } catch {
      // User rejected, or the wallet is locked. Not an error — the caller signs directly.
      return null;
    }
  })().finally(() => {
    inflight.delete(wallet);
  });

  inflight.set(wallet, promise);
  return promise;
}

/**
 * Sign `message` with the session key and return the headers proving the delegation chain.
 * Returns null when there is no session, so callers fall back to the wallet.
 */
export async function signWithSession(
  wallet: string,
  message: string,
): Promise<{ signature: string; headers: Record<string, string> } | null> {
  const s = readStored(wallet);
  if (!s) return null;

  const signature = await new Wallet(s.privateKey).signMessage(message);
  const { privateKey: _pk, ...delegation } = s;
  return {
    signature,
    headers: {
      [SESSION_HEADER]: JSON.stringify(delegation),
      [SESSION_KEY_HEADER]: s.sessionAddress,
    },
  };
}

/**
 * Synchronous twin of signWithSession, for the readers that cannot await (getCachedWalletAuthHeaders).
 * Returns null when there is no live session.
 */
export function signWithSessionSync(
  wallet: string,
  message: string,
): { signature: string; delegation: string } | null {
  const s = readStored(wallet);
  if (!s) return null;
  const { privateKey, ...delegation } = s;
  return { signature: new Wallet(privateKey).signMessageSync(message), delegation: JSON.stringify(delegation) };
}

/**
 * Cheap client-side validity check for a delegation we previously cached.
 *
 * Not a security control — the server re-verifies everything. This exists so a cached auth header
 * bundle is dropped as soon as its session can no longer back it (expired, or the tab's session
 * key is gone), instead of being sent and coming back 401 in a way that reads like a server bug.
 */
export function sessionDelegationStillValid(raw: string, wallet: string): boolean {
  try {
    const d = JSON.parse(raw) as SessionDelegation;
    if (!d?.wallet || d.wallet.toLowerCase() !== wallet.toLowerCase()) return false;
    if (!Number.isFinite(d.expiresAt)) return false;
    if (d.expiresAt - RENEW_SKEW_SEC <= Math.floor(Date.now() / 1000)) return false;
    // The delegation is only usable while we still hold the matching private key.
    const live = readStored(wallet.toLowerCase());
    return !!live && live.sessionAddress === d.sessionAddress;
  } catch {
    return false;
  }
}

/**
 * Verify a delegation blob. Shared by client and server so the two cannot drift — a server that
 * accepts something the client would not build (or vice versa) is how auth bugs get shipped.
 *
 * Returns the authorized wallet, or null. Callers must additionally check that the returned wallet
 * matches the X-Wallet-Address on the request; this function only proves the delegation is
 * internally valid.
 */
export function verifyDelegation(
  raw: string,
  opts: { nowSec?: number; expectedDomain?: string | readonly string[] },
): { wallet: string; sessionAddress: string } | null {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  let d: SessionDelegation;
  try {
    d = JSON.parse(raw) as SessionDelegation;
  } catch {
    return null;
  }

  if (!d?.sessionAddress || !d?.wallet || !d?.signature) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.sessionAddress)) return null;
  if (!/^0x[0-9a-f]{40}$/.test(d.wallet.toLowerCase())) return null;

  // Expiry, with the same 120s backdating tolerance the existing verifiers allow for clock skew.
  if (!Number.isFinite(d.expiresAt) || !Number.isFinite(d.issuedAt)) return null;
  if (d.expiresAt <= now) return null;
  if (d.issuedAt > now + 120) return null;
  // Reject a delegation claiming a longer life than the client is allowed to mint. Without this a
  // tampered blob could assert a ten-year expiry and the signature check alone would pass it.
  if (d.expiresAt - d.issuedAt > SESSION_MAX_AGE_SEC + 60) return null;

  // Origin binding: a delegation signed for another site must not authenticate here.
  if (opts.expectedDomain) {
    const ok = typeof opts.expectedDomain === "string" ? [opts.expectedDomain] : opts.expectedDomain;
    if (!ok.includes(d.domain)) return null;
  }

  try {
    const recovered = verifyMessage(buildDelegationMessage({
      sessionAddress: d.sessionAddress,
      wallet: d.wallet,
      chainId: d.chainId,
      domain: d.domain,
      issuedAt: d.issuedAt,
      expiresAt: d.expiresAt,
      nonce: d.nonce,
    }), d.signature);
    if (recovered.toLowerCase() !== d.wallet.toLowerCase()) return null;
  } catch {
    return null;
  }

  return { wallet: d.wallet.toLowerCase(), sessionAddress: d.sessionAddress };
}
