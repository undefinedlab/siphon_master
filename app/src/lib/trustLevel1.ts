/**
 * Level 1 Trust gate: Terms of Use + Privacy acceptance (UI + soft deposit gate).
 *
 * KYT status in localStorage is intentionally NOT authoritative (CLIENT-01) — it is
 * forgeable. Deposit compliance is enforced by live ASP + oracle via
 * assertDepositScreened() in handler.deposit. TrustPanel may still show KYT for UX.
 *
 * Devnet / SKIP_TRUST: UX gates are off so hackathon flows are not blocked by prod KYT.
 */
import { assertTosAccepted, isTosAccepted, TOS_REQUIRED_MESSAGE } from "@/lib/tosAcceptance";
import { isKytPassed } from "@/lib/kytStatus";
import { trustEnforcementEnabled } from "@/lib/trustBypass";

export const LEVEL1_KYT_REQUIRED_MESSAGE =
  "Level 1 Trust required — complete KYT in Trust before depositing.";

export const LEVEL1_REQUIRED_MESSAGE =
  "Level 1 Trust required — accept Terms before depositing. Screening runs at deposit time.";

/**
 * UX completeness (Terms + local KYT badge). Not a security control — forgeable.
 * Prefer assertLevel1Trust + assertDepositScreened for deposit authorization.
 * Returns true when Trust enforcement is disabled (Devnet / SKIP_TRUST).
 */
export function isLevel1TrustComplete(wallet: string | null | undefined): boolean {
  if (!trustEnforcementEnabled()) return true;
  return isTosAccepted(wallet) && isKytPassed(wallet);
}

/**
 * Soft deposit gate: Terms only. Do not trust localStorage KYT here.
 * Live screening: handler.deposit → assertDepositScreened (ASP + oracle).
 * No-op when Trust enforcement is disabled (Devnet / SKIP_TRUST).
 */
export function assertLevel1Trust(wallet: string | null | undefined): void {
  if (!trustEnforcementEnabled()) return;
  assertTosAccepted(wallet);
}

export { TOS_REQUIRED_MESSAGE };
