/**
 * Per-wallet KYT (Know Your Transaction) soft-screen cache.
 * Level 1 Trust companion to TOS — deposit path still re-screens at tx time.
 */
import { getSelectedChainId } from "@/lib/networks";
import { TRUST_TOS_EVENT } from "@/lib/tosAcceptance";

export type KytDecision = "admit" | "deny" | "clear";

export type KytStatusRecord = {
  version: 1;
  wallet: string;
  chainId: number;
  checkedAt: string;
  decision: KytDecision;
  reasons: string[];
  source: "asp" | "oracle" | "both";
};

/**
 * One record per wallet PER CHAIN. Each chain's ASP keeps its own KYT entitlement (Arbitrum's
 * returns kyt_fee_required for a wallet cleared only on Base), so a wallet-wide record showed
 * Level 1 as done on a chain where the deposit would then be refused after the approve was paid.
 * Defaults to the selected chain — bridged homes (Ethereum, Tempo, Solana) select Base, their vault.
 */
function storageKey(wallet: string, chainId: number = getSelectedChainId()): string {
  return `siphon-kyt-status:${chainId}:${wallet.toLowerCase()}`;
}

/** Soft expiry — encourage a fresh screen after a day. */
const KYT_TTL_MS = 24 * 60 * 60 * 1000;

function notifyTrustChanged(wallet: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TRUST_TOS_EVENT, { detail: { wallet: wallet.toLowerCase() } }));
}

/** Pre-per-chain key. Its record names the chain it was screened on, so it still counts there. */
const legacyKey = (wallet: string) => `siphon-kyt-status:${wallet.toLowerCase()}`;

export function readKytStatus(wallet: string | null | undefined): KytStatusRecord | null {
  if (!wallet || typeof window === "undefined") return null;
  try {
    const chainId = getSelectedChainId();
    let raw = localStorage.getItem(storageKey(wallet, chainId));
    if (!raw) {
      const legacy = localStorage.getItem(legacyKey(wallet));
      if (legacy && (JSON.parse(legacy) as Partial<KytStatusRecord>).chainId === chainId) raw = legacy;
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KytStatusRecord>;
    if (parsed.wallet?.toLowerCase() !== wallet.toLowerCase()) return null;
    if (parsed.version !== 1 || !parsed.checkedAt || !parsed.decision) return null;
    if (Date.now() - new Date(parsed.checkedAt).getTime() > KYT_TTL_MS) return null;
    return parsed as KytStatusRecord;
  } catch {
    return null;
  }
}

export function isKytPassed(wallet: string | null | undefined): boolean {
  const rec = readKytStatus(wallet);
  return rec != null && (rec.decision === "admit" || rec.decision === "clear");
}

export function saveKytStatus(args: Omit<KytStatusRecord, "version">): KytStatusRecord {
  const record: KytStatusRecord = { version: 1, ...args, wallet: args.wallet.toLowerCase() };
  localStorage.setItem(storageKey(args.wallet, args.chainId), JSON.stringify(record));
  notifyTrustChanged(args.wallet);
  return record;
}

export function clearKytStatus(wallet: string): void {
  localStorage.removeItem(storageKey(wallet));
  notifyTrustChanged(wallet);
}
