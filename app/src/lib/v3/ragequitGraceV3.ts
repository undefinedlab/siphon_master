/** A deposit may request its public exit ticket for five minutes after its mined block. */
export const RAGEQUIT_GRACE_SECONDS = 5 * 60;

export function withinRagequitGrace(
  depositTimestampSeconds: number,
  currentTimestampSeconds: number,
): boolean {
  if (!Number.isFinite(depositTimestampSeconds) || !Number.isFinite(currentTimestampSeconds)) {
    return false;
  }
  if (depositTimestampSeconds <= 0 || currentTimestampSeconds < 0) return false;
  return currentTimestampSeconds <= depositTimestampSeconds + RAGEQUIT_GRACE_SECONDS;
}

export function noteRagequitGrace(args: {
  depositTimestampSeconds?: number;
  createdAtMs?: number;
  nowMs?: number;
}): { known: boolean; active: boolean; deadlineMs?: number } {
  const nowMs = args.nowMs ?? Date.now();
  const startMs =
    typeof args.depositTimestampSeconds === "number" && args.depositTimestampSeconds > 0
      ? args.depositTimestampSeconds * 1_000
      : typeof args.createdAtMs === "number" && args.createdAtMs > 0
        ? args.createdAtMs
        : undefined;
  if (startMs === undefined) return { known: false, active: false };
  const deadlineMs = startMs + RAGEQUIT_GRACE_SECONDS * 1_000;
  return { known: true, active: nowMs <= deadlineMs, deadlineMs };
}
