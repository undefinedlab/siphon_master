import library from "./widget-library.json";
import type { SizePreset, WidgetKind } from "./grid";

export type WidgetTier = "starter" | "glance" | "core" | "optional";

export type WidgetLibraryEntry = {
  label: string;
  hint: string;
  tier: WidgetTier;
  defaultSize: SizePreset;
  allowedSizes: SizePreset[];
  resizable: boolean;
  component: string;
  description: string;
  comingSoon?: boolean;
};

type WidgetLibraryFile = {
  widgets: Record<string, WidgetLibraryEntry>;
  defaultLayout: Array<{ kind: string; size: SizePreset; anchorId?: string }>;
  starterKinds: string[];
};

const lib = library as WidgetLibraryFile;

export const WIDGET_LIBRARY = lib.widgets as Record<WidgetKind, WidgetLibraryEntry>;

export const STARTER_WIDGET_KINDS = lib.starterKinds as WidgetKind[];

export function getWidgetSpec(kind: WidgetKind): WidgetLibraryEntry {
  return WIDGET_LIBRARY[kind];
}

export function defaultSizeForKind(kind: WidgetKind): SizePreset {
  return WIDGET_LIBRARY[kind]?.defaultSize ?? "2x2";
}

export function allowedSizesForKind(kind: WidgetKind): SizePreset[] {
  return WIDGET_LIBRARY[kind]?.allowedSizes ?? ["2x2"];
}

export function canResizeKind(kind: WidgetKind): boolean {
  return WIDGET_LIBRARY[kind]?.resizable ?? true;
}

export function cycleSizeForKind(kind: WidgetKind, current: SizePreset): SizePreset {
  const allowed = allowedSizesForKind(kind);
  if (allowed.length === 0) return current;
  const i = allowed.indexOf(current);
  if (i === -1) return allowed[0];
  return allowed[(i + 1) % allowed.length];
}

export function isAllowedSize(kind: WidgetKind, size: SizePreset): boolean {
  return allowedSizesForKind(kind).includes(size);
}

/** Widgets visible in the library but not addable to the board yet. */
export const COMING_SOON_WIDGET_KINDS = (Object.entries(WIDGET_LIBRARY) as [WidgetKind, WidgetLibraryEntry][])
  .filter(([, spec]) => spec.comingSoon)
  .map(([kind]) => kind);

export function isWidgetComingSoon(kind: WidgetKind): boolean {
  return WIDGET_LIBRARY[kind]?.comingSoon === true;
}

export function isWidgetAddable(kind: WidgetKind): boolean {
  return !isWidgetComingSoon(kind);
}

/** Migrate legacy combined market-size tile to cap + volume starters. */
export function migratePlacedKinds(
  placed: Array<{ kind: string; size: SizePreset; id: string; anchorId?: string }>,
): Array<{ kind: WidgetKind; size: SizePreset; id: string; anchorId?: string }> {
  const out: Array<{ kind: WidgetKind; size: SizePreset; id: string; anchorId?: string }> = [];
  for (const p of placed) {
    if (p.kind === "market-size") {
      out.push({
        id: `${p.id}-cap`,
        kind: "market-cap",
        size: isAllowedSize("market-cap", p.size) ? p.size : "1x1",
      });
      out.push({
        id: `${p.id}-vol`,
        kind: "market-volume",
        size: isAllowedSize("market-volume", p.size) ? p.size : "1x1",
      });
      continue;
    }
    if (!(p.kind in WIDGET_LIBRARY)) continue;
    const kind = p.kind as WidgetKind;
    const size = isAllowedSize(kind, p.size) ? p.size : defaultSizeForKind(kind);
    out.push({ ...p, kind, size });
  }
  return out;
}
