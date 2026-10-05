/**
 * Per-wallet Terms + Privacy acceptance (client localStorage).
 * Versioned so a Terms update can re-prompt.
 * Level 1 Trust — required before deposits / private-path commercial actions.
 */
import { EFFECTIVE_DATE } from "@/lib/siteLegal";

export const TOS_ACCEPTANCE_VERSION = EFFECTIVE_DATE;

/** Fired on window after accept/revoke so Overview / API Keys can unlock without reload. */
export const TOS_REQUIRED_MESSAGE =
  "Level 1 Trust required — accept Terms and clear KYT in Trust before depositing.";

export const TRUST_TOS_EVENT = "trustTosChanged";

export type TosAcceptanceRecord = {
  version: string;
  wallet: string;
  acceptedAt: string;
  terms: true;
  privacy: true;
};

function storageKey(wallet: string): string {
  return `siphon-tos-accepted:${wallet.toLowerCase()}`;
}

function notifyTosChanged(wallet: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TRUST_TOS_EVENT, { detail: { wallet: wallet.toLowerCase() } }));
}

export function readTosAcceptance(wallet: string | null | undefined): TosAcceptanceRecord | null {
  if (!wallet || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TosAcceptanceRecord>;
    const walletMatch = parsed.wallet?.toLowerCase() === wallet.toLowerCase();
    const flagsOk = parsed.terms === true && parsed.privacy === true;
    if (!walletMatch || !flagsOk) return null;

    // Current version — accept as-is.
    if (parsed.version === TOS_ACCEPTANCE_VERSION && parsed.acceptedAt) {
      return parsed as TosAcceptanceRecord;
    }

    // Stale / missing version from an earlier build — migrate forward so Level 1 stays unlocked.
    const migrated: TosAcceptanceRecord = {
      version: TOS_ACCEPTANCE_VERSION,
      wallet: wallet.toLowerCase(),
      acceptedAt: typeof parsed.acceptedAt === "string" ? parsed.acceptedAt : new Date().toISOString(),
      terms: true,
      privacy: true,
    };
    localStorage.setItem(storageKey(wallet), JSON.stringify(migrated));
    return migrated;
  } catch {
    return null;
  }
}

export function isTosAccepted(wallet: string | null | undefined): boolean {
  return readTosAcceptance(wallet) != null;
}

/** Throws when Level 1 Trust is missing — use at deposit / purchase entrypoints. */
export function assertTosAccepted(wallet: string | null | undefined): void {
  if (!isTosAccepted(wallet)) {
    throw new Error(TOS_REQUIRED_MESSAGE);
  }
}

export function saveTosAcceptance(wallet: string): TosAcceptanceRecord {
  const record: TosAcceptanceRecord = {
    version: TOS_ACCEPTANCE_VERSION,
    wallet: wallet.toLowerCase(),
    acceptedAt: new Date().toISOString(),
    terms: true,
    privacy: true,
  };
  localStorage.setItem(storageKey(wallet), JSON.stringify(record));
  notifyTosChanged(wallet);
  return record;
}

export function clearTosAcceptance(wallet: string): void {
  localStorage.removeItem(storageKey(wallet));
  notifyTosChanged(wallet);
}
