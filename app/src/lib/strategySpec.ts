/**
 * Level-2 strategy model: unified spec, validation, and payload mapping.
 */

export type StrategyKind =
  | "Limit Order"
  | "Stop Loss"
  | "Take Profit"
  | "Range"
  | "TWAP"
  | "Buy Dip"
  | "Sell Rally"
  | "DCA"
  | "Predictions"
  | "Perps";

export type StrategySide = "buy" | "sell";
export type StrategyRuntimeTier = "single_shot" | "scheduled";
export type TriggerComparator = "gte" | "lte";

export interface StrategyNodeFields {
  strategy?: string | null;
  side?: string | null;
  priceGoal?: string | null;
  rangeLow?: string | null;
  rangeHigh?: string | null;
  gridLevels?: string | null;
  sliceCount?: string | null;
  intervalSeconds?: string | null;
  intervals?: string | null;
  maxSlippageBps?: string | null;
  positionPct?: string | null;
  // Predictions (Polymarket) — resolved market identity for the POLYMARKET payload.
  polyTokenId?: string | null;
  polyMarketId?: string | null;
  polyOutcome?: string | null;
  polyMarketQuestion?: string | null;
  polyOdds?: string | null;
  // Perps (Hyperliquid)
  hlCoin?: string | null;
  hlLeverage?: string | null;
  hlTakeProfit?: string | null;
  hlStopLoss?: string | null;
}

export function parseHumanIntervalToSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber);

  const match = value.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (!amount || amount <= 0) return null;
  if (["s", "sec", "secs", "second", "seconds"].includes(unit)) return amount;
  if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return amount * 60;
  if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) return amount * 3600;
  if (["d", "day", "days"].includes(unit)) return amount * 86400;
  if (["w", "week", "weeks"].includes(unit)) return amount * 604800;
  return null;
}

export type ScheduleUnit = "seconds" | "minutes" | "hours" | "blocks";

const SCHEDULE_BLOCK_SEC = 12;

export function scheduleUnitToSeconds(
  value: string,
  unit: ScheduleUnit
): number | undefined {
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  switch (unit) {
    case "seconds":
      return Math.floor(n);
    case "minutes":
      return Math.floor(n * 60);
    case "hours":
      return Math.floor(n * 3600);
    case "blocks":
      return Math.floor(n * SCHEDULE_BLOCK_SEC);
  }
}

export function displayScheduleFromSeconds(intervalSeconds: string | null | undefined): {
  value: string;
  unit: ScheduleUnit;
} {
  const sec = Number(String(intervalSeconds ?? "").trim());
  if (!Number.isFinite(sec) || sec <= 0) return { value: "", unit: "seconds" };
  if (sec % 3600 === 0 && sec >= 3600) return { value: String(sec / 3600), unit: "hours" };
  if (sec % 60 === 0 && sec >= 60) return { value: String(sec / 60), unit: "minutes" };
  return { value: String(sec), unit: "seconds" };
}

export function resolveScheduleIntervalSeconds(fields: {
  scheduleValue?: string | null;
  scheduleUnit?: string | null;
  intervalSeconds?: string | null;
}): number | undefined {
  const value = String(fields.scheduleValue ?? "").trim();
  const unit = (fields.scheduleUnit || "seconds") as ScheduleUnit;
  if (value) {
    return scheduleUnitToSeconds(value, unit);
  }
  const legacy = Number(String(fields.intervalSeconds ?? "").trim());
  if (Number.isFinite(legacy) && legacy > 0) return Math.floor(legacy);
  return undefined;
}

function secondsUntilTime(atTime: string): number | undefined {
  const raw = String(atTime).trim();
  if (!raw) return undefined;
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return undefined;
  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return Math.floor((target.getTime() - now.getTime()) / 1000);
}

/** Start delay before downstream execution — not recurring cadence. */
export function resolveScheduleStartDelaySeconds(fields: {
  scheduleTrigger?: string | null;
  scheduleValue?: string | null;
  scheduleUnit?: string | null;
  scheduleAt?: string | null;
  intervalSeconds?: string | null;
}): number | undefined {
  if (fields.scheduleTrigger === "at") {
    return secondsUntilTime(String(fields.scheduleAt ?? ""));
  }
  const value = String(fields.scheduleValue ?? "").trim();
  if (!value) return 0;
  const unit = (fields.scheduleUnit || "blocks") as ScheduleUnit;
  return scheduleUnitToSeconds(value, unit);
}

/** Cadence between loop iterations (each X). */
export function resolveLoopIntervalSeconds(fields: {
  loopIntervalValue?: string | null;
  loopIntervalUnit?: string | null;
  intervalSeconds?: string | null;
}): number | undefined {
  const value = String(fields.loopIntervalValue ?? "").trim();
  if (value) {
    const unit = (fields.loopIntervalUnit || "hours") as ScheduleUnit;
    return scheduleUnitToSeconds(value, unit);
  }
  const legacy = Number(String(fields.intervalSeconds ?? "").trim());
  if (Number.isFinite(legacy) && legacy > 0) return Math.floor(legacy);
  return undefined;
}

export interface StrategyPayload {
  strategy_type: string;
  side?: StrategySide;
  upper_bound: number;
  lower_bound: number;
  grid_levels?: number;
  slices?: number;
  interval_sec?: number;
  start_delay_sec?: number;
  max_slippage_bps?: number;
  /** Polymarket market identity — consumed by the trade-executor's POLYMARKET path. */
  poly_meta?: {
    token_id: string;
    market_id: string;
    outcome: string | null;
    side: "BUY" | "SELL";
  };
  /** Hyperliquid perp params — consumed by the trade-executor's HYPERLIQUID path. */
  hl_meta?: {
    coin: string;
    side: "LONG" | "SHORT";
    leverage: number;
    take_profit_px?: number;
    stop_loss_px?: number;
    trigger_dir: "above" | "below";
  };
  price_feed_id?: string;
  /** Limit Order trigger tree (AND/OR of price LEAFs). When set, the executor evaluates this in
   * preference to upper_bound/lower_bound. Carries the user's actual target(s); see
   * buildGraphRunPlan. */
  condition_tree?: unknown;
}

export const L2_STRATEGY_KINDS: StrategyKind[] = [
  "Limit Order",
  "Stop Loss",
  "Take Profit",
  "Range",
  "TWAP",
];

export const ACTIVE_BUILD_STRATEGIES: StrategyKind[] = [
  "Limit Order",
  "Stop Loss",
  "Take Profit",
  "Range",
];

export type GridLegType = "LIMIT_BUY" | "LIMIT_SELL";

export interface RangeGridLeg {
  index: number;
  price: number;
  legType: GridLegType;
}

/** Evenly spaced prices from low→high; even index = buy, odd = sell. */
export function computeRangeGridLegs(
  low: number,
  high: number,
  levels: number,
  // Every rung trades the SAME direction as the deposit swap (asset_in -> asset_out). The old
  // alternating buy/sell made half the rungs fire on the WRONG side of the price and swap backwards
  // (buy high / sell low) — a silent loss, because execution always swaps asset_in -> asset_out
  // regardless of the leg label. Caller passes the coherent side (buy when paying a stablecoin,
  // sell when paying the base asset).
  side: GridLegType = "LIMIT_BUY"
): RangeGridLeg[] {
  if (levels <= 1) {
    return [{ index: 0, price: low, legType: side }];
  }
  const step = (high - low) / (levels - 1);
  return Array.from({ length: levels }, (_, index) => ({
    index,
    price: low + index * step,
    legType: side,
  }));
}

export const ALL_STRATEGY_KINDS: StrategyKind[] = [
  ...L2_STRATEGY_KINDS,
  "Buy Dip",
  "Sell Rally",
  "DCA",
  "Predictions",
  "Perps",
];

/** Strategy kinds shown in the Build page dropdown (excludes legacy aliases). */
export const BUILD_UI_STRATEGY_KINDS: StrategyKind[] = [
  ...L2_STRATEGY_KINDS,
  "Perps",
];

export const SINGLE_PRICE_STRATEGIES: StrategyKind[] = [
  "Limit Order",
  "Stop Loss",
  "Take Profit",
];

export function isStrategyKind(value: string | null | undefined): value is StrategyKind {
  return Boolean(value && (ALL_STRATEGY_KINDS as readonly string[]).includes(value));
}

export function normalizeStrategyKind(raw: string | null | undefined): StrategyKind {
  if (raw === "Buy Dip") return "Limit Order";
  if (raw === "Sell Rally") return "Take Profit";
  if (isStrategyKind(raw)) return raw;
  // Predictions aliases from the LLM / node data: POLYMARKET, "Prediction Market", "prediction"…
  if (raw && /\b(polymarket|predictions?)\b/i.test(raw)) return "Predictions";
  if (raw && /\b(perp|perps|hyperliquid|hl-?perp)\b/i.test(raw)) return "Perps";
  return "Limit Order";
}

export function getRuntimeTier(kind: StrategyKind): StrategyRuntimeTier {
  if (kind === "TWAP" || kind === "DCA") return "scheduled";
  return "single_shot";
}

export function isBuildStrategyActive(kind: string): boolean {
  return (ACTIVE_BUILD_STRATEGIES as readonly string[]).includes(kind);
}

const STABLE_COINS = new Set(["USDC", "USDT"]);

/** Infer buy/sell from swap direction: stable → asset = buy, asset → stable = sell. */
export function inferSideFromSwap(
  fromCoin?: string | null,
  toCoin?: string | null
): StrategySide {
  const from = (fromCoin || "").toUpperCase();
  const to = (toCoin || "").toUpperCase();
  if (STABLE_COINS.has(from) && !STABLE_COINS.has(to)) return "buy";
  if (!STABLE_COINS.has(from) && STABLE_COINS.has(to)) return "sell";
  return "buy";
}

export function defaultSideForKind(kind: StrategyKind): StrategySide {
  switch (kind) {
    case "Buy Dip":
    case "Limit Order":
    case "Predictions":
    case "Perps":
      return "buy";
    case "Stop Loss":
    case "Take Profit":
    case "Sell Rally":
      return "sell";
    default:
      return "buy";
  }
}

export function triggerComparator(kind: StrategyKind, side: StrategySide): TriggerComparator {
  switch (kind) {
    case "Stop Loss":
    case "Buy Dip":
      return "lte";
    case "Take Profit":
    case "Sell Rally":
      return "gte";
    case "Limit Order":
      return side === "buy" ? "lte" : "gte";
    default:
      return "gte";
  }
}

export function strategyTypeForPayload(kind: StrategyKind, side: StrategySide): string {
  // FHE engine only needs two trigger patterns:
  // LIMIT_BUY  → price <= lower_bound
  // LIMIT_SELL → price >= upper_bound
  // Stop Loss / Take Profit / Limit Order differ in UI labels and graph flow, not trigger math.
  switch (kind) {
    case "Range":
      return "RANGE_GRID";
    case "TWAP":
      return "TWAP";
    case "DCA":
      return "DCA";
    case "Predictions":
      return "POLYMARKET";
    case "Perps":
      return "HYPERLIQUID";
    default: {
      const comparator = triggerComparator(kind, side);
      return comparator === "lte" ? "LIMIT_BUY" : "LIMIT_SELL";
    }
  }
}

export interface StrategyValidationResult {
  valid: boolean;
  error?: string;
  requiresScheduler?: boolean;
}

export function validateStrategyFields(
  kind: StrategyKind,
  fields: StrategyNodeFields
): StrategyValidationResult {
  if (kind === "Range") {
    const low = parseFloat(fields.rangeLow ?? "");
    const high = parseFloat(fields.rangeHigh ?? "");
    const grids = parseInt(fields.gridLevels ?? "", 10);
    if (!low || !high || low >= high) {
      return { valid: false, error: "Range needs a valid low and high price (low < high)." };
    }
    if (!grids || grids < 2) {
      return { valid: false, error: "Range needs at least 2 grid levels." };
    }
    return { valid: true, requiresScheduler: false };
  }

  if (kind === "TWAP") {
    const slices = parseInt(fields.sliceCount ?? "", 10);
    const interval = parseInt(fields.intervalSeconds ?? "", 10);
    if (!slices || slices < 2) {
      return { valid: false, error: "TWAP needs at least 2 slices." };
    }
    if (!interval || interval <= 0) {
      return { valid: false, error: "TWAP needs a positive interval in seconds." };
    }
    return { valid: true, requiresScheduler: true };
  }

  if (kind === "DCA") {
    const intervalSec = parseHumanIntervalToSeconds(fields.intervals);
    if (!intervalSec) {
      return { valid: false, error: "DCA needs an interval schedule." };
    }
    const buys = parseInt(fields.sliceCount ?? "0", 10);
    if (!buys || buys < 2) {
      return { valid: false, error: "DCA needs at least 2 buys." };
    }
    return { valid: true, requiresScheduler: true };
  }

  if (kind === "Predictions") {
    if (!fields.polyTokenId || !fields.polyMarketId) {
      return { valid: false, error: "Predictions needs a resolved Polymarket market (token id)." };
    }
    if (!fields.polyOutcome) {
      return { valid: false, error: "Predictions needs an outcome (e.g. Yes or No)." };
    }
    return { valid: true, requiresScheduler: false };
  }

  if (kind === "Perps") {
    const coin = (fields.hlCoin || fields.polyOutcome || "").trim();
    if (!coin) {
      return { valid: false, error: "Perps needs a coin (e.g. BTC, ETH)." };
    }
    const lev = parseInt(fields.hlLeverage ?? "1", 10);
    if (!Number.isFinite(lev) || lev < 1 || lev > 50) {
      return { valid: false, error: "Perps leverage must be 1–50." };
    }
    return { valid: true, requiresScheduler: false };
  }

  const price = parseFloat(fields.priceGoal ?? "");
  if (!price || price <= 0) {
    const label =
      kind === "Stop Loss"
        ? "stop price"
        : kind === "Take Profit" || kind === "Sell Rally"
          ? "target price"
          : kind === "Buy Dip"
            ? "dip price"
            : "trigger price";
    return { valid: false, error: `Strategy needs a valid ${label}.` };
  }

  if (kind === "Stop Loss" || kind === "Take Profit") {
    const pctRaw = (fields.positionPct ?? "").trim();
    if (pctRaw) {
      const pct = parseFloat(pctRaw);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return { valid: false, error: `${kind} position % must be between 1 and 100.` };
      }
    }
  }

  return { valid: true, requiresScheduler: false };
}

export function resolvePositionPct(fields: StrategyNodeFields): number {
  const raw = (fields.positionPct ?? "").trim();
  if (!raw) return 100;
  const pct = parseFloat(raw);
  if (!Number.isFinite(pct) || pct <= 0) return 100;
  return Math.min(100, pct);
}

export function buildStrategyPayload(
  kind: StrategyKind,
  fields: StrategyNodeFields
): StrategyPayload {
  const resolvedSide: StrategySide =
    fields.side === "buy" || fields.side === "sell"
      ? fields.side
      : defaultSideForKind(kind);

  const strategy_type = strategyTypeForPayload(kind, resolvedSide);
  const comparator = triggerComparator(kind, resolvedSide);

  if (kind === "Range") {
    return {
      strategy_type,
      side: resolvedSide,
      lower_bound: parseFloat(fields.rangeLow ?? "0"),
      upper_bound: parseFloat(fields.rangeHigh ?? "0"),
      grid_levels: parseInt(fields.gridLevels ?? "0", 10),
      // Grids settle through the same buildGridLegs path that reads bounds.max_slippage_bps.
      // Omitting it here pinned every rung to the fallback tolerance with no way to change it,
      // while TWAP and DCA both let the user set one.
      max_slippage_bps: fields.maxSlippageBps
        ? parseInt(fields.maxSlippageBps, 10)
        : undefined,
    };
  }

  if (kind === "TWAP") {
    return {
      strategy_type,
      side: resolvedSide,
      lower_bound: 0,
      upper_bound: 0,
      slices: parseInt(fields.sliceCount ?? "0", 10),
      interval_sec: parseInt(fields.intervalSeconds ?? "0", 10),
      max_slippage_bps: fields.maxSlippageBps
        ? parseInt(fields.maxSlippageBps, 10)
        : undefined,
    };
  }

  if (kind === "Predictions") {
    // Odds trigger (priceGoal = odds %, 0..100) rides the same bound fields the FHE engine
    // already compares; the market identity travels in poly_meta.
    const oddsPct = parseFloat(fields.priceGoal ?? "0");
    return {
      strategy_type,
      side: resolvedSide,
      upper_bound: comparator === "gte" ? oddsPct : 0,
      lower_bound: comparator === "lte" ? oddsPct : 0,
      poly_meta: {
        token_id: fields.polyTokenId ?? "",
        market_id: fields.polyMarketId ?? "",
        outcome: fields.polyOutcome ?? null,
        side: resolvedSide === "sell" ? "SELL" : "BUY",
      },
    };
  }

  if (kind === "Perps") {
    const coin = (fields.hlCoin || "BTC").trim().toUpperCase();
    const lev = Math.min(50, Math.max(1, parseInt(fields.hlLeverage ?? "1", 10) || 1));
    const entry = parseFloat(fields.priceGoal ?? "0");
    const tp = parseFloat(fields.hlTakeProfit ?? "0");
    const sl = parseFloat(fields.hlStopLoss ?? "0");
    const isLong = resolvedSide !== "sell";
    // No entry price → fire immediately (below a huge bound).
    const trigger_dir: "above" | "below" = !entry
      ? "below"
      : isLong
        ? "below"
        : "above";
    const threshold = entry > 0 ? entry : 1e15;
    return {
      strategy_type: "HYPERLIQUID",
      side: resolvedSide,
      upper_bound: trigger_dir === "above" ? threshold : 0,
      lower_bound: trigger_dir === "below" ? threshold : 0,
      price_feed_id: `hyperliquid:${coin}`,
      hl_meta: {
        coin,
        side: isLong ? "LONG" : "SHORT",
        leverage: lev,
        take_profit_px: tp > 0 ? tp : undefined,
        stop_loss_px: sl > 0 ? sl : undefined,
        trigger_dir,
      },
    };
  }

  const triggerPrice = parseFloat(fields.priceGoal ?? "0");
  if (kind === "DCA") {
    // DCA = N equal time-scheduled buys, modeled as TWAP slices (encrypted fire-times) so it reuses
    // the whole multi-leg split/execute/engine path. slices = buy count; interval_sec = gap between
    // buys (from the human 'intervals' schedule).
    return {
      strategy_type,
      side: resolvedSide,
      lower_bound: 0,
      upper_bound: 0,
      slices: parseInt(fields.sliceCount ?? "0", 10),
      interval_sec: parseHumanIntervalToSeconds(fields.intervals) ?? 0,
      // Carried for the same reason TWAP carries it — DCA rides the identical multi-leg path, so
      // dropping it here silently ignored whatever the user typed and fell back to the default.
      max_slippage_bps: fields.maxSlippageBps
        ? parseInt(fields.maxSlippageBps, 10)
        : undefined,
    };
  }

  return {
    strategy_type,
    side: resolvedSide,
    upper_bound: comparator === "gte" ? triggerPrice : 0,
    lower_bound: comparator === "lte" ? triggerPrice : 0,
  };
}
