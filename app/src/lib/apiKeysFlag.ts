/**
 * Is the commercial API-key surface live yet?
 *
 * One switch for the whole feature — the dashboard tab, the panel and the gateway proxy all read
 * it, so the UI and the endpoint can never disagree. Flipping this single line launches or locks it.
 *
 * It was locked while a purchase could lose money: the client claimed at one confirmation and the
 * gateway requires two, and the tx hash was discarded on that guaranteed first failure. That is
 * fixed (a durable receipt and a retry that follows the gateway's own answer), so the client side
 * no longer needs the lock.
 *
 * What it still depends on is the GATEWAY: `API_GATEWAY_URL` must point at a gateway that has
 * `API_CREDIT_COLLECTOR` set (it refuses to quote a payment address without one, so the panel shows
 * an error instead of taking a payment) and that serves the v5 routes the keys are sold for.
 *
 * No gateway → Coming Soon for paid Base/Arb keys (avoids the red `api_gateway_unconfigured`
 * state). Free Solana Devnet claim (POST /v1/keys/devnet) stays open in the dashboard and the
 * gateway proxy even while this flag is true — see ApiKeysPanel + /api/gateway.
 * Force paid keys open with NEXT_PUBLIC_API_KEYS_LIVE=1 once a gateway is wired.
 */
function envTruthy(v: string | undefined): boolean {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function envFalsey(v: string | undefined): boolean {
  const s = (v || "").trim().toLowerCase();
  return s === "0" || s === "false" || s === "no";
}

const cluster = (process.env.NEXT_PUBLIC_CLUSTER || "").trim().toLowerCase();
const gatewayConfigured = Boolean(
  (process.env.NEXT_PUBLIC_API_GATEWAY_URL || process.env.API_GATEWAY_URL || "").trim(),
);
const forceLive = envTruthy(process.env.NEXT_PUBLIC_API_KEYS_LIVE);
const forceSoon =
  envTruthy(process.env.NEXT_PUBLIC_API_KEYS_COMING_SOON) ||
  envFalsey(process.env.NEXT_PUBLIC_API_KEYS_LIVE);

/** Locked = Coming Soon tab + panel (no gateway calls). */
export const API_KEYS_COMING_SOON =
  forceSoon ||
  (!forceLive && (cluster === "local" || !gatewayConfigured));
