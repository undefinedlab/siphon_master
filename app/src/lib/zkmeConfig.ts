/** Client-safe zkMe widget configuration (appId is public; API key stays server-only). */

export function isZkKycEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_ZKME_ENABLED === "0") return false;
  return Boolean(zkMeAppId());
}

export function zkMeAppId(): string {
  return (process.env.NEXT_PUBLIC_ZKME_APP_ID || "").trim();
}

export function zkMeProgramNo(): string | undefined {
  const v = (process.env.NEXT_PUBLIC_ZKME_PROGRAM_NO || "").trim();
  return v || undefined;
}

export function chainIdToHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

/**
 * Chain id passed to ZkMeWidget — decimal string only ("137", "8453").
 * Cross-chain zkKYC accounts should use "137" per zkMe docs (not the dapp's active chain).
 */
export function zkMeWidgetChainId(_selectedChainId?: number): string {
  const override = (process.env.NEXT_PUBLIC_ZKME_CHAIN_ID || "").trim();
  if (override) {
    if (override.startsWith("0x")) {
      const n = Number.parseInt(override.slice(2), 16);
      if (Number.isFinite(n) && n > 0) return String(n);
    }
    return override;
  }
  return "137";
}

/** MeID only — zkKYC omits mode (email/social is implicit). */
export function zkMeWidgetLoginMode(lv: "zkKYC" | "MeID" = "zkKYC"): "wallet" | "email" | undefined {
  if (lv !== "MeID") return undefined;
  const raw = (process.env.NEXT_PUBLIC_ZKME_LOGIN_MODE || "wallet").trim().toLowerCase();
  return raw === "email" ? "email" : "wallet";
}
