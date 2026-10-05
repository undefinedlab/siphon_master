"use client";

import {
  defaultSizeForKind,
  isAllowedSize,
  isWidgetComingSoon,
  migratePlacedKinds,
  WIDGET_LIBRARY,
} from "@/components/widgets/config/widgetLibrary";

export type WidgetKind =
  | "coins"
  | "opportunities"
  | "wallet"
  | "fear-greed"
  | "market-cap"
  | "market-volume"
  | "dominance"
  | "news"
  | "swap"
  | "runs"
  | "predictions"
  | "chart";

export type SizePreset = "1x1" | "1x2" | "2x1" | "2x2" | "4x2" | "6x1" | "6x2";

export type PlacedWidget = {
  id: string;
  kind: WidgetKind;
  size: SizePreset;
  /** When set, root of the widget gets this id (for /#anchors on the primary tile). */
  anchorId?: string;
};

export const STORAGE_KEY = "siphon-build-dashboard-widgets-v9";

export const SIZE_TO_GRID: Record<SizePreset, { col: number; row: number }> = {
  "1x1": { col: 1, row: 1 },
  "1x2": { col: 1, row: 2 },
  "2x1": { col: 2, row: 1 },
  "2x2": { col: 2, row: 2 },
  "4x2": { col: 4, row: 2 },
  "6x1": { col: 6, row: 1 },
  "6x2": { col: 6, row: 2 },
};

/** 2-column mobile dashboard: wide desktop tiles become full-width rows. */
export const MOBILE_SIZE_TO_GRID: Record<SizePreset, { col: number; row: number }> = {
  "1x1": { col: 1, row: 1 },
  // "1x2" is the TALL preset (swap / runs / predictions). Collapsing it to a single row on mobile
  // clipped tall interactive content — the Quick swap lost its RECEIVE row + PAY & RUN button.
  // Keep it full-width AND 2 rows tall so the content fits.
  "1x2": { col: 2, row: 2 },
  "2x1": { col: 2, row: 1 },
  "2x2": { col: 2, row: 2 },
  "4x2": { col: 2, row: 2 },
  "6x1": { col: 2, row: 1 },
  "6x2": { col: 2, row: 2 },
};

export function gridSpanForLayout(
  size: SizePreset,
  spec: { cols: number },
): { col: number; row: number } {
  return spec.cols <= 2 ? MOBILE_SIZE_TO_GRID[size] : SIZE_TO_GRID[size];
}

export const SIZE_ORDER: SizePreset[] = [
  "1x1",
  "1x2",
  "2x1",
  "2x2",
  "4x2",
  "6x2",
  "6x1",
];

export const WIDGET_META: Record<WidgetKind, { label: string; hint: string }> =
  Object.fromEntries(
    Object.entries(WIDGET_LIBRARY).map(([kind, spec]) => [
      kind,
      { label: spec.label, hint: spec.hint },
    ]),
  ) as Record<WidgetKind, { label: string; hint: string }>;

export const ALL_KINDS = Object.keys(WIDGET_META) as WidgetKind[];

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `w-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const LEGACY_V6_DEFAULT_KINDS = new Set([
  "fear-greed",
  "market-cap",
  "market-volume",
  "dominance",
  "news",
  "coins",
  "swap",
  "opportunities",
]);

const LEGACY_DEFAULT_KINDS = new Set([
  "swap",
  "fear-greed",
  "market-cap",
  "market-volume",
  "news",
  "coins",
  "opportunities",
  "wallet",
]);

function isLegacyV6DefaultLayout(placed: PlacedWidget[]): boolean {
  const kinds = new Set(placed.map((p) => p.kind));
  if (kinds.size !== LEGACY_V6_DEFAULT_KINDS.size) return false;
  for (const kind of LEGACY_V6_DEFAULT_KINDS) {
    if (!kinds.has(kind as WidgetKind)) return false;
  }
  return true;
}

function isLegacyDefaultLayout(placed: PlacedWidget[]): boolean {
  const kinds = new Set(placed.map((p) => p.kind));
  if (kinds.size !== LEGACY_DEFAULT_KINDS.size) return false;
  for (const kind of LEGACY_DEFAULT_KINDS) {
    if (!kinds.has(kind as WidgetKind)) return false;
  }
  return true;
}

function freshDefaultPlaced(): PlacedWidget[] {
  return DEFAULT_PLACED.map((d) => ({ ...d, id: uid() }));
}

/** Glance row + coins / strategies + compact swap & runs. */
export const DEFAULT_PLACED: PlacedWidget[] = [
  { id: "default-fg", kind: "fear-greed", size: "1x1" },
  { id: "default-cap", kind: "market-cap", size: "1x1" },
  { id: "default-vol", kind: "market-volume", size: "1x1" },
  { id: "default-dom", kind: "dominance", size: "1x1" },
  { id: "default-news", kind: "news", size: "2x1" },
  { id: "default-coins", kind: "coins", size: "2x2", anchorId: "movers" },
  {
    id: "default-strategies",
    kind: "opportunities",
    size: "2x2",
    anchorId: "strategies",
  },
  { id: "default-swap", kind: "swap", size: "1x2" },
  { id: "default-runs", kind: "runs", size: "1x2" },
];

export function cycleSize(size: SizePreset): SizePreset {
  const i = SIZE_ORDER.indexOf(size);
  return SIZE_ORDER[(i + 1) % SIZE_ORDER.length];
}

function stripComingSoonWidgets(placed: PlacedWidget[]): PlacedWidget[] {
  return placed.filter((p) => !isWidgetComingSoon(p.kind));
}

function migrateWalletToWide(placed: PlacedWidget[]): PlacedWidget[] {
  return placed.map((p) =>
    p.kind === "wallet" && p.size === "2x2" ? { ...p, size: "2x1" as SizePreset } : p,
  );
}

function migrateSwapRunsToTall(placed: PlacedWidget[]): PlacedWidget[] {
  return placed.map((p) =>
    (p.kind === "swap" || p.kind === "runs") && p.size === "1x1"
      ? { ...p, size: "1x2" as SizePreset }
      : p,
  );
}

export function loadPlacedFromStorage(): PlacedWidget[] {
  if (typeof window === "undefined") return DEFAULT_PLACED;
  const keys = [
    STORAGE_KEY,
    "siphon-build-dashboard-widgets-v8",
    "siphon-build-dashboard-widgets-v6",
    "siphon-build-dashboard-widgets-v5",
    "siphon-build-dashboard-widgets-v4",
    "siphon-build-dashboard-widgets-v3",
  ];
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Array<{
        id: string;
        kind: string;
        size: SizePreset;
        anchorId?: string;
      }>;
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      const migrated = migratePlacedKinds(parsed);
      const valid = migrated.filter(
        (p) =>
          p &&
          typeof p.id === "string" &&
          ALL_KINDS.includes(p.kind) &&
          p.size in SIZE_TO_GRID &&
          isAllowedSize(p.kind, p.size) &&
          (p.anchorId === undefined || typeof p.anchorId === "string"),
      );
      if (valid.length > 0) {
        const next = stripComingSoonWidgets(
          key === "siphon-build-dashboard-widgets-v5" && isLegacyDefaultLayout(valid)
            ? freshDefaultPlaced()
            : key === "siphon-build-dashboard-widgets-v6" && isLegacyV6DefaultLayout(valid)
              ? freshDefaultPlaced()
              : migrateWalletToWide(migrateSwapRunsToTall(valid)),
        );
        if (key !== STORAGE_KEY) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        }
        return next;
      }
    } catch {
      continue;
    }
  }
  return freshDefaultPlaced();
}

export { defaultSizeForKind, isAllowedSize, migratePlacedKinds };
