/**
 * ZK ceremony kind helpers (public/zk/CEREMONY.json + NEXT_PUBLIC_ZK_CEREMONY).
 * Keeps mainnet / production from silently running on DEV-beacon artifacts.
 */

export type CeremonyKind = "mpc" | "dev-beacon" | "unknown";

export function normalizeCeremonyKind(raw: string | null | undefined): CeremonyKind {
  const k = String(raw || "").trim().toLowerCase();
  if (k === "mpc" || k === "production" || k === "prod") return "mpc";
  if (k === "dev-beacon" || k === "dev" || k === "beacon") return "dev-beacon";
  if (!k) return "unknown";
  return "unknown";
}

export function isDevBeaconCeremony(kind: CeremonyKind): boolean {
  return kind === "dev-beacon" || kind === "unknown";
}

/** True when we must refuse DEV beacon zkeys (mainnet-ish + production lock). */
export function ceremonyProductionLock(env: NodeJS.ProcessEnv = process.env): boolean {
  const envName = (
    env.NEXT_PUBLIC_SIPHON_ENV ||
    env.SIPHON_ENV ||
    env.VERCEL_ENV ||
    env.NODE_ENV ||
    ""
  )
    .trim()
    .toLowerCase();
  return envName === "production" || envName === "prod" || envName === "mainnet";
}

export function allowDevZkeysOnMainnet(env: NodeJS.ProcessEnv = process.env): boolean {
  if (ceremonyProductionLock(env)) return false;
  const v = (env.NEXT_PUBLIC_ALLOW_DEV_ZKEYS_ON_MAINNET || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Pure check used by assertCeremonyAllowed + release script.
 * Returns an error message or null if OK.
 */
export function ceremonyKindError(args: {
  chainId: number;
  kind: CeremonyKind;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const { chainId, kind } = args;
  const env = args.env ?? process.env;
  if (chainId !== 8453 && chainId !== 42161 && chainId !== 1) return null;
  if (!isDevBeaconCeremony(kind)) return null;
  if (allowDevZkeysOnMainnet(env)) return null;
  if (ceremonyProductionLock(env)) {
    return "Hard ASP on Base/Ethereum mainnet requires an MPC ceremony in production (CEREMONY.json kind=mpc).";
  }
  return (
    "Hard ASP on Base/Ethereum mainnet requires an MPC ceremony (NEXT_PUBLIC_ZK_CEREMONY=mpc / public/zk/CEREMONY.json). " +
    "DEV beacon zkeys are forbidden unless NEXT_PUBLIC_ALLOW_DEV_ZKEYS_ON_MAINNET=1 (non-production only)."
  );
}

/** For release CI: fail if CEREMONY.json is still dev-beacon while STRICT/release flags are set. */
export function releaseCeremonyError(
  kind: CeremonyKind,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const strict =
    env.STRICT_BUILD === "1" ||
    env.REQUIRE_MPC_CEREMONY === "1" ||
    ceremonyProductionLock(env) ||
    // Vercel production always requires mpc artifacts in the tree (ZK-01).
    (env.VERCEL_ENV || "").trim().toLowerCase() === "production";
  if (!strict) return null;
  if (kind === "mpc") return null;
  return (
    `Release/production build requires CEREMONY.json kind=mpc (got "${kind}"). ` +
    `Set REQUIRE_MPC_CEREMONY=0 only for intentional testnet artifact deploys.`
  );
}

/**
 * Hard refuse: Base/Ethereum mainnet + production runtime must not even attempt
 * a beacon ceremony, regardless of ALLOW_DEV_ZKEYS (belt with ceremonyKindError).
 */
export function mainnetCeremonyHardError(
  chainId: number,
  kind: CeremonyKind,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (chainId !== 8453 && chainId !== 42161 && chainId !== 1) return null;
  if (!isDevBeaconCeremony(kind)) return null;
  if (!ceremonyProductionLock(env)) return null;
  return "Production mainnet refuses DEV-beacon ZK artifacts (CEREMONY.json must be kind=mpc).";
}
