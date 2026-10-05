/**
 * Solana Devnet spends prove against the ASP's current admitted/revoked roots, and the program
 * only accepts roots the postman has written to the compliance PDA. Admit publishes once, when
 * the label first enters the set. A later admit — or a publish that failed — leaves the PDA
 * behind, and the path proxy then answers publish_pending before a witness can be built.
 *
 * This asks solasp to publish (one in-flight call per process) so the read that noticed the
 * skew can be served against the root that just landed.
 */
import { aspBaseUrl, aspProxyHeaders } from "./aspServerUrl";
import { verifyAspRootsCurrent, type AspRootFreshness } from "./aspRootFreshness";

type Roots = { admittedRoot?: unknown; revokedRoot?: unknown };

const SOLANA_ZK_CHAIN_ID = "900002";

export type SolanaCatchUp =
  | { action: "serve" }
  | { action: "reload" }
  | { action: "deny"; error: Exclude<AspRootFreshness, { ok: true }>["error"] | string };

type PublishResult = { ok: boolean; detail?: string };

let inflight: Promise<PublishResult> | null = null;

export function resetSolanaRootPublishForTests(): void {
  inflight = null;
}

async function defaultPublishRequest(): Promise<PublishResult> {
  const base = aspBaseUrl(SOLANA_ZK_CHAIN_ID);
  if (!base) return { ok: false, detail: "asp_unconfigured" };
  const response = await fetch(`${base.replace(/\/+$/, "")}/solana/publish-roots`, {
    method: "POST",
    headers: aspProxyHeaders(base, { "Content-Type": "application/json" }, SOLANA_ZK_CHAIN_ID),
    body: JSON.stringify({ chainId: Number(SOLANA_ZK_CHAIN_ID) }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
  };
  if (!response.ok || data.ok === false) {
    return { ok: false, detail: data.message || data.error || `HTTP ${response.status}` };
  }
  return { ok: true };
}

/** One Solana root publish at a time. Concurrent withdraws share it. */
export async function publishSolanaComplianceRoots(
  chainId: string | null,
  request: () => Promise<PublishResult> = defaultPublishRequest,
): Promise<PublishResult> {
  if (chainId !== SOLANA_ZK_CHAIN_ID) return { ok: false, detail: "not_solana" };
  if (!inflight) {
    inflight = request().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Decide what a set-read proxy should do with roots the chain does not currently accept.
 *
 * `serve` — these roots match the PDA (they already did, or the publish just caught up).
 * `reload` — a publish landed, but these roots are still not the PDA's; fetch the set again.
 * `deny` — not a Solana publish skew, or the postman could not publish.
 */
export async function solanaPublishCatchUp(
  chainId: string | null,
  roots: Roots,
  deps: {
    check?: typeof verifyAspRootsCurrent;
    publish?: (chainId: string) => Promise<PublishResult>;
  } = {},
): Promise<SolanaCatchUp> {
  const check = deps.check ?? verifyAspRootsCurrent;
  const publish = deps.publish ?? ((id: string) => publishSolanaComplianceRoots(id));
  const first = await check(chainId, roots);
  if (first.ok) return { action: "serve" };
  if (first.error !== "publish_pending" || chainId !== SOLANA_ZK_CHAIN_ID) {
    return { action: "deny", error: first.error };
  }
  const published = await publish(chainId);
  if (!published.ok) {
    const why = published.detail ? ` (${published.detail})` : "";
    return { action: "deny", error: `publish_pending${why}` };
  }
  const second = await check(chainId, roots);
  return second.ok ? { action: "serve" } : { action: "reload" };
}
