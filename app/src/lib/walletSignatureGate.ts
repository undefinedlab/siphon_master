/**
 * One wallet prompt per answer — not per caller, and not per timer tick.
 *
 * Every signing path in this app had the same shape: cache the success, dedupe the concurrent
 * callers, and remember *nothing* about a rejection. So a rejected signature left no trace, the
 * inflight entry was dropped in `finally`, and the next caller opened a fresh prompt. With
 * several of those callers on 3s/20s/30s/60s timers, one "Reject" turns into a prompt every
 * ~40 seconds: a user left siphon.money open for three hours and collected ~260 of them, and
 * MetaMask stacks them ("1 of 15") so the tab is unusable long before anyone reads one.
 *
 * Rejecting is an answer. This records it per (wallet, purpose) so the *automatic* callers stop
 * asking, while an explicit user action can clear it and ask again.
 *
 * Deliberately NOT applied to signatures a user asks for by clicking something (creating an API
 * key, a write challenge for a transaction they just confirmed) — there the next prompt is the
 * direct result of a new click, which is exactly when re-asking is correct.
 */
import { isUserRejection } from './walletRejection';

/** What the signature unlocks. Keep these stable — they are the decline-memory keys. */
export type SignaturePurpose =
  | 'enc-key'          // note encryption key (private balance, note sync)
  | 'session'          // soft privileged session (asp-set, builder, screen)
  | 'request'          // per-request privileged auth
  | 'read-auth'        // long-lived executor read auth
  | 'fhe-key';         // deterministic FHE client key seed

const declined = new Set<string>();

const keyFor = (wallet: string, purpose: SignaturePurpose) =>
  `${wallet.toLowerCase()}:${purpose}`;

export class SignatureDeclinedError extends Error {
  readonly purpose: SignaturePurpose;
  constructor(purpose: SignaturePurpose) {
    super(`Wallet signature for "${purpose}" was declined. Reconnect your wallet to retry.`);
    this.name = 'SignatureDeclinedError';
    this.purpose = purpose;
  }
}

export function isSignatureDeclined(err: unknown): boolean {
  return err instanceof SignatureDeclinedError;
}

/**
 * Ask again next time — a deliberate reconnect, or an action the user just clicked, is fresh
 * consent. Pass `purpose` to reopen only one lane (a user confirming a write has consented to
 * the write's auth, not necessarily to everything else).
 */
export function clearSignatureDeclines(wallet?: string, purpose?: SignaturePurpose): void {
  if (!wallet) {
    declined.clear();
    return;
  }
  if (purpose) {
    declined.delete(keyFor(wallet, purpose));
    return;
  }
  const prefix = `${wallet.toLowerCase()}:`;
  for (const k of [...declined]) if (k.startsWith(prefix)) declined.delete(k);
}

/**
 * Run `sign` unless this wallet already refused this purpose.
 *
 * Only a *user rejection* latches. A transient failure (dropped connection, wallet busy) must
 * stay retryable — latching those would lock someone out of their own balance until they
 * happened to find the reconnect button.
 *
 * `onDeclined` fires once, on the transition into declined, so callers can tell the user what
 * they just lost without every subsequent tick re-toasting.
 */
export async function signGuarded<T>(
  wallet: string,
  purpose: SignaturePurpose,
  sign: () => Promise<T>,
  onDeclined?: () => void,
): Promise<T> {
  const key = keyFor(wallet, purpose);
  // Throw *before* calling sign() — the whole point is that no prompt opens.
  if (declined.has(key)) throw new SignatureDeclinedError(purpose);
  try {
    return await sign();
  } catch (err) {
    if (isUserRejection(err)) {
      declined.add(key);
      onDeclined?.();
    }
    throw err;
  }
}
