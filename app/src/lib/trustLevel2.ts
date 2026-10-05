/**
 * Level 2 Trust — zk.me identity credentials (zkKYC / zkKYB / zkKYA).
 *
 * Local cache is UX-only; gated actions re-verify with zkMe via verifyKycWithZkMeServices.
 */
import { TRUST_TOS_EVENT } from "@/lib/tosAcceptance";
import { checkKycFeePaid, KYC_FEE_REQUIRED_MESSAGE } from "@/lib/complianceFee";
import {
  isZkKycEnabled,
  zkMeAppId,
  zkMeProgramNo,
} from "@/lib/zkmeConfig";

export type Level2Kind = "zkkyc" | "zkkyb" | "zkya";

export type Level2StatusRecord = {
  version: 1;
  wallet: string;
  kind: Level2Kind;
  verifiedAt: string;
  programNo?: string;
  source: "zkme_widget";
};

export const LEVEL2_REQUIRED_MESSAGE =
  "Level 2 Trust required — pay the $0.50/year KYC fee and complete zkKYC in the Trust tab.";

function storageKey(wallet: string, kind: Level2Kind): string {
  return `siphon-trust-l2:${kind}:${wallet.toLowerCase()}`;
}

function notifyTrustChanged(wallet: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TRUST_TOS_EVENT, { detail: { wallet: wallet.toLowerCase() } }),
  );
}

export function readLevel2Status(
  wallet: string | null | undefined,
  kind: Level2Kind = "zkkyc",
): Level2StatusRecord | null {
  if (!wallet || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(wallet, kind));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Level2StatusRecord>;
    if (parsed.wallet?.toLowerCase() !== wallet.toLowerCase()) return null;
    if (parsed.version !== 1 || parsed.kind !== kind || !parsed.verifiedAt) return null;
    return parsed as Level2StatusRecord;
  } catch {
    return null;
  }
}

export function saveLevel2Status(
  args: Omit<Level2StatusRecord, "version">,
): Level2StatusRecord {
  const record: Level2StatusRecord = {
    version: 1,
    ...args,
    wallet: args.wallet.toLowerCase(),
  };
  localStorage.setItem(storageKey(args.wallet, args.kind), JSON.stringify(record));
  notifyTrustChanged(args.wallet);
  return record;
}

export function clearLevel2Status(wallet: string, kind: Level2Kind = "zkkyc"): void {
  localStorage.removeItem(storageKey(wallet, kind));
  notifyTrustChanged(wallet);
}

/** UX badge — may be stale; call verifyLevel2Trust before sensitive actions. */
export function isLevel2TrustComplete(
  wallet: string | null | undefined,
  kind: Level2Kind = "zkkyc",
): boolean {
  if (!isZkKycEnabled()) return true;
  return readLevel2Status(wallet, kind) != null;
}

/** Live check against zkMe — authoritative for gating. */
export async function verifyLevel2Trust(
  wallet: string | null | undefined,
  kind: Level2Kind = "zkkyc",
): Promise<boolean> {
  if (!wallet) return false;
  if (!isZkKycEnabled()) return true;
  if (kind !== "zkkyc") return false;

  const entitled = await checkKycFeePaid(wallet);
  if (!entitled) {
    clearLevel2Status(wallet, kind);
    return false;
  }

  const { verifyKycWithZkMeServices } = await import("@zkmelabs/widget");
  const appId = zkMeAppId();
  if (!appId) return false;

  const programNo = zkMeProgramNo();
  const result = await verifyKycWithZkMeServices(
    appId,
    wallet.toLowerCase(),
    programNo ? { programNo } : undefined,
  );

  if (result.isGrant) {
    saveLevel2Status({
      wallet,
      kind: "zkkyc",
      verifiedAt: result.verifyTimeAsIso ?? new Date().toISOString(),
      programNo: result.programNo,
      source: "zkme_widget",
    });
    return true;
  }

  clearLevel2Status(wallet, kind);
  return false;
}

export async function assertLevel2Trust(
  wallet: string | null | undefined,
  kind: Level2Kind = "zkkyc",
): Promise<void> {
  if (!isZkKycEnabled()) return;
  if (wallet && !(await checkKycFeePaid(wallet))) {
    throw new Error(KYC_FEE_REQUIRED_MESSAGE);
  }
  const ok = await verifyLevel2Trust(wallet, kind);
  if (!ok) throw new Error(LEVEL2_REQUIRED_MESSAGE);
}
