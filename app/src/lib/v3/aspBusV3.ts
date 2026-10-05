/**
 * When the next ASP "bus" leaves — the moment a deposit waiting for admission becomes spendable.
 *
 * There are no fixed clock boundaries. ComplianceHub accepts at most one admitted-root publish per
 * `admitEpochSeconds` after `lastAdmitPublish`, and the postman checks every ~60s, so a deposit
 * boards at max(now, lastAdmitPublish + epoch) plus up to one postman tick. After a quiet spell that
 * is about a minute; right behind another publish it is just over six.
 */
import { Contract } from "ethers";
import { v3Config } from "./configV3";

const HUB_ABI = [
  "function lastAdmitPublish() view returns (uint64)",
  "function admitEpochSeconds() view returns (uint64)",
];
/** ASP_POSTMAN_INTERVAL on the box. */
export const POSTMAN_TICK_MS = 60_000;

/**
 * Latest time the next bus can leave, in ms — a FIXED instant, so a countdown to it actually
 * counts down. Already in the past means the epoch gate is open and the very next postman tick
 * boards everyone waiting ("boarding now", under a minute). Pure, for the tests and the UI.
 */
export function busDepartureMs(lastPublishSec: number, epochSec: number): number {
  return (lastPublishSec + epochSec) * 1_000 + POSTMAN_TICK_MS;
}

const cache = new Map<number, { at: number; last: number; epoch: number }>();

/** Next departure for `chainId`, or null when the hub is not configured or unreadable. */
export async function nextBusAtMs(chainId: number, nowMs: number = Date.now()): Promise<number | null> {
  const hit = cache.get(chainId);
  if (hit && nowMs - hit.at < 30_000) return busDepartureMs(hit.last, hit.epoch);
  const hub = v3Config(chainId)?.complianceHub;
  if (!hub || /^0x0{40}$/i.test(hub)) return null;
  try {
    // Lazy, like noteStoreV3: zkHandler pulls in most of the app and would close an import cycle.
    const { getReadProvider } = await import("../zkHandler");
    const c = new Contract(hub, HUB_ABI, getReadProvider(chainId));
    const [last, epoch] = await Promise.all([c.lastAdmitPublish(), c.admitEpochSeconds()]);
    cache.set(chainId, { at: nowMs, last: Number(last), epoch: Number(epoch) });
    return busDepartureMs(Number(last), Number(epoch));
  } catch {
    return null;
  }
}

/** "4:05" — the remaining time to `targetMs`, floored at 0:00. */
export function countdown(targetMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.ceil((targetMs - nowMs) / 1_000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One line for a note waiting on the bus: a live countdown, or "boarding now" once it is due. */
export function busEtaText(targetMs: number | null | undefined, nowMs: number = Date.now()): string {
  if (!targetMs) return "waiting for the next compliance bus (up to ~6 min)";
  return targetMs > nowMs
    ? `next compliance bus in ${countdown(targetMs, nowMs)}`
    : "boarding the compliance bus now (under a minute)";
}
