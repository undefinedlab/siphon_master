/**
 * Client-only market spark history.
 *
 * Reuses the existing market-global poll — no extra API calls. Samples are stored in
 * localStorage so the line builds across visits. When history is thin, synthesize a
 * shape from the 24h % we already have on the payload.
 */

const STORAGE_KEY = "siphon-market-spark-v1";
const MAX_SAMPLES = 32;
/** Ignore duplicate pushes closer than this (ms). */
const MIN_INTERVAL_MS = 90_000;

export type MarketSparkSample = {
  t: number;
  cap: number;
  vol: number;
};

function readSamples(): MarketSparkSample[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MarketSparkSample[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) =>
        s &&
        typeof s.t === "number" &&
        typeof s.cap === "number" &&
        typeof s.vol === "number" &&
        Number.isFinite(s.cap) &&
        Number.isFinite(s.vol),
    );
  } catch {
    return [];
  }
}

function writeSamples(samples: MarketSparkSample[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(samples.slice(-MAX_SAMPLES)));
  } catch {
    /* quota / private mode */
  }
}

/** Record a poll snapshot; returns the updated series (may be unchanged if debounced). */
export function recordMarketSparkSample(
  cap: number | null | undefined,
  vol: number | null | undefined,
): MarketSparkSample[] {
  if (cap == null || vol == null || !Number.isFinite(cap) || !Number.isFinite(vol)) {
    return readSamples();
  }
  const samples = readSamples();
  const now = Date.now();
  const last = samples[samples.length - 1];
  if (last) {
    const tooSoon = now - last.t < MIN_INTERVAL_MS;
    const sameCap = Math.abs(last.cap - cap) / Math.max(last.cap, 1) < 1e-6;
    const sameVol = Math.abs(last.vol - vol) / Math.max(last.vol, 1) < 1e-6;
    if (tooSoon && sameCap && sameVol) return samples;
  }
  samples.push({ t: now, cap, vol });
  const trimmed = samples.slice(-MAX_SAMPLES);
  writeSamples(trimmed);
  return trimmed;
}

export function readMarketSparkSamples(): MarketSparkSample[] {
  return readSamples();
}

/**
 * Deterministic faux path from a 24h % change — stable across renders, scales with magnitude.
 * Used until enough local samples exist.
 */
export function synthesizeSparkFromChange(changePct: number, count = 16): number[] {
  const endMult = 1 + changePct / 100;
  let seed =
    (Math.floor(Math.abs(changePct) * 1e4) ^ (changePct >= 0 ? 0x9e3779b9 : 0x85ebca6b)) >>> 0;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed & 0xffff) / 0xffff;
  };

  const wiggleAmp = Math.min(0.06, Math.abs(changePct) / 200);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const smooth = t * t * (3 - 2 * t);
    const drift = 1 + (endMult - 1) * smooth;
    const wiggle = (rand() - 0.5) * 2 * wiggleAmp * Math.sin(Math.PI * t);
    values.push(100 * (drift + wiggle));
  }
  values[0] = 100;
  values[count - 1] = 100 * endMult;
  return values;
}

/** Prefer real samples; fall back to a change-% synthesis when history is thin. */
export function sparkValuesFor(
  series: number[],
  changePct: number | null | undefined,
): number[] | undefined {
  if (series.length >= 3) return series;
  if (changePct != null && Number.isFinite(changePct)) {
    return synthesizeSparkFromChange(changePct);
  }
  if (series.length >= 2) return series;
  return undefined;
}
