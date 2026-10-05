/**
 * Local + Devnet: skip Trust L1/L2 UI gates (ToS, KYT badge, zkKYC).
 * Live ASP deposit screening is unchanged — this is UX-only.
 */
import { getProductChain } from "@/lib/chains/ChainModeContext";

export function trustEnforcementEnabled(): boolean {
  if (typeof process !== "undefined") {
    const skip = (process.env.NEXT_PUBLIC_SKIP_TRUST || "").trim().toLowerCase();
    if (skip === "1" || skip === "true" || skip === "yes") return false;
    const cluster = (process.env.NEXT_PUBLIC_CLUSTER || "").trim().toLowerCase();
    if (cluster === "devnet" || cluster === "local") return false;
  }

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
    try {
      if (getProductChain().id === "solana-devnet") return false;
    } catch {
      /* provider not mounted yet */
    }
  }

  return true;
}
