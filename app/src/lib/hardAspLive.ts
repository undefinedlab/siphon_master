/**
 * Hard ASP on-chain liveness probe.
 *
 * Soft-era entrypoints (current Base + Sepolia) lack aspPostman / Hard withdraw.
 * Client + FHE speak Hard ASP only — refuse deposit/spend until the live EP matches.
 */
import { Contract, Interface } from "ethers";
import { zkUrl } from "./zkAssets";
import { getNetwork, getReadProviderRpcUrl } from "./networks";
import { JsonRpcProvider } from "ethers";
import {
  ceremonyKindError,
  mainnetCeremonyHardError,
  normalizeCeremonyKind,
  type CeremonyKind,
} from "./zkCeremony";

export {
  allowDevZkeysOnMainnet,
  ceremonyKindError,
  ceremonyProductionLock,
  mainnetCeremonyHardError,
  normalizeCeremonyKind,
  releaseCeremonyError,
} from "./zkCeremony";
export type { CeremonyKind } from "./zkCeremony";

/** Hard ASP Entrypoint selectors we require. */
const HARD_ASP_ABI = [
  "function aspPostman() view returns (address)",
  "function currentAspRoot() view returns (uint256)",
  "function aspRootExists(uint256) view returns (bool)",
  "function ragequit(address,uint256,uint256,uint256,uint256[2],uint256[2][2],uint256[2])",
];

export type HardAspLiveResult = {
  ok: boolean;
  chainId: number;
  entrypoint: string;
  hasAspPostman: boolean;
  aspPostman: string | null;
  currentAspRoot: string | null;
  error?: string;
};

const _cache = new Map<number, { ts: number; result: HardAspLiveResult }>();
const TTL_MS = 60_000;

function probeErrText(e: unknown): string {
  if (!e) return "unknown error";
  const err = e as { shortMessage?: string; code?: string; message?: string };
  return err.shortMessage || err.message || String(e);
}

/**
 * Bounded retry for the two read probes. A single flaky/rate-limited eth_call throws
 * CALL_EXCEPTION ("missing revert data") against a perfectly healthy Entrypoint — without this,
 * one blip is reported to the user as a broken deployment and blocks the deposit.
 */
async function probeRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let delay = 250;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries - 1) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

function softOverride(): boolean {
  const v = (process.env.NEXT_PUBLIC_HARD_ASP_SOFT_OVERRIDE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Mainnet (Base 8453 / ETH 1) must not use DEV-beacon zkeys unless explicitly allowed. */
export async function assertCeremonyAllowed(chainId: number): Promise<void> {
  if (chainId !== 8453 && chainId !== 42161 && chainId !== 1) return;

  let ceremony: CeremonyKind = normalizeCeremonyKind(
    (process.env.NEXT_PUBLIC_ZK_CEREMONY || "").trim(),
  );
  if (ceremony === "unknown" && typeof fetch !== "undefined") {
    try {
      const res = await fetch(zkUrl("/zk/CEREMONY.json"), { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { kind?: string };
        ceremony = normalizeCeremonyKind(data.kind);
      }
    } catch {
      /* fall through */
    }
  }
  if (ceremony === "unknown") ceremony = "dev-beacon";

  const hard = mainnetCeremonyHardError(chainId, ceremony);
  if (hard) throw new Error(hard);

  const err = ceremonyKindError({ chainId, kind: ceremony });
  if (err) throw new Error(err);
}

export async function probeHardAspLive(chainId: number): Promise<HardAspLiveResult> {
  // Only SUCCESSFUL probes are cached. Caching a failure meant one transient RPC blip blocked
  // every deposit for the whole TTL, and the user just saw a fixed "incomplete deploy" banner
  // with no way to retry into a good result.
  const hit = _cache.get(chainId);
  if (hit && hit.result.ok && Date.now() - hit.ts < TTL_MS) return hit.result;

  const net = getNetwork(chainId);
  const entrypoint = net.entrypoint;
  const base: HardAspLiveResult = {
    ok: false,
    chainId,
    entrypoint,
    hasAspPostman: false,
    aspPostman: null,
    currentAspRoot: null,
  };

  try {
    const provider = new JsonRpcProvider(getReadProviderRpcUrl(chainId), chainId);
    const code = await probeRetry(() => provider.getCode(entrypoint));
    if (!code || code === "0x") {
      return { ...base, error: `No code at entrypoint ${entrypoint}` };
    }

    const ep = new Contract(entrypoint, HARD_ASP_ABI, provider);
    let aspPostman: string | null = null;
    let currentAspRoot: string | null = null;
    try {
      aspPostman = String(await probeRetry(() => ep.aspPostman()));
    } catch (e) {
      const result = {
        ...base,
        error:
          "Entrypoint is soft-era (no aspPostman). Deploy Hard ASP Entrypoint on this chain and " +
          `update networks.ts. (probe error: ${probeErrText(e)})`,
      };
      return result;
    }

    try {
      currentAspRoot = (await probeRetry(() => ep.currentAspRoot())).toString();
    } catch (e) {
      const result = {
        ...base,
        hasAspPostman: true,
        aspPostman,
        // Do NOT claim "incomplete deploy" from a bare throw — a rate-limited or lagging RPC
        // raises CALL_EXCEPTION/"missing revert data" on a perfectly good Entrypoint, and the old
        // message sent people hunting a redeploy that was never needed. Carry the real reason.
        error:
          "Could not read currentAspRoot() from Entrypoint " +
          `${entrypoint} on chain ${chainId} — ${probeErrText(e)}. ` +
          "If this is transient (rate limit / lagging RPC) just retry; if it persists the Hard ASP " +
          "deploy really is incomplete.",
      };
      return result;
    }

    const result: HardAspLiveResult = {
      ok: true,
      chainId,
      entrypoint,
      hasAspPostman: true,
      aspPostman,
      currentAspRoot,
    };
    _cache.set(chainId, { ts: Date.now(), result });
    return result;
  } catch (e) {
    // Failures are deliberately NOT cached — see probeHardAspLive's cache note.
    return { ...base, error: probeErrText(e) };
  }
}

/**
 * Call before deposit / private spend / ragequit.
 * Soft override is for emergency debugging only — proofs will still fail on soft bytecode.
 */
export async function assertHardAspLive(chainId: number): Promise<HardAspLiveResult> {
  await assertCeremonyAllowed(chainId);
  if (softOverride()) {
    console.warn(
      `[hardAsp] NEXT_PUBLIC_HARD_ASP_SOFT_OVERRIDE=1 — skipping Hard ASP liveness gate on chain ${chainId}`,
    );
    return {
      ok: true,
      chainId,
      entrypoint: getNetwork(chainId).entrypoint,
      hasAspPostman: false,
      aspPostman: null,
      currentAspRoot: null,
      error: "soft_override",
    };
  }
  const live = await probeHardAspLive(chainId);
  if (!live.ok) {
    const name = getNetwork(chainId).name;
    if (chainId === 8453) {
      throw new Error(
        `Private vaults on ${name} are offline until Hard ASP is deployed. ` +
          (live.error || "Entrypoint is still soft-era."),
      );
    }
    throw new Error(
      live.error ||
        `Hard ASP is not live on ${name} yet. Redeploy Entrypoint+vaults with ASP/ragequit verifiers, then update NEXT_PUBLIC_ENTRYPOINT_ADDRESS / networks.ts.`,
    );
  }
  return live;
}

/** Clear probe cache (after cutover / address change). */
export function invalidateHardAspLiveCache(): void {
  _cache.clear();
}

/** Selector helpers for CLI / deploy checks (keccak of signatures). */
export function hardAspRequiredSelectors(): string[] {
  const iface = new Interface(HARD_ASP_ABI);
  return ["aspPostman()", "currentAspRoot()", "aspRootExists(uint256)"].map((s) =>
    iface.getFunction(s.split("(")[0])!.selector,
  );
}
