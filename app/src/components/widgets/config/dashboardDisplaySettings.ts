"use client";

import type { WidgetGridSpec } from "./widgetPages";

export type GridCols = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type GridRows = 1 | 2 | 3 | 4 | 5 | 6;

export const GRID_COL_MIN = 1;
export const GRID_COL_MAX = 8;
export const GRID_ROW_MIN = 1;
export const GRID_ROW_MAX = 6;

export type DashboardColorPreset =
  | "white"
  | "neutral"
  | "frost"
  | "mint"
  | "amber"
  | "violet";

export type DashboardFontColorPreset =
  | "white"
  | "dark"
  | "silver"
  | "frost"
  | "amber"
  | "mint";

export type DashboardPageBgPreset =
  | "void"
  | "charcoal"
  | "slate"
  | "navy"
  | "forest"
  | "wine"
  | "light";

/** 1 = darkest, 5 = lightest variant of the selected backdrop. */
export type PageBgShade = 1 | 2 | 3 | 4 | 5;

export type PageBgTone = "dark" | "light";

export type DashboardDisplaySettings = {
  gridCols: GridCols;
  gridRows: GridRows;
  colorPreset: DashboardColorPreset;
  pageBgPreset: DashboardPageBgPreset;
  pageBgShade: PageBgShade;
  fontColorPreset: DashboardFontColorPreset;
};

export const DISPLAY_SETTINGS_KEY = "siphon-build-dashboard-display-v2";

export const DEFAULT_DISPLAY_SETTINGS: DashboardDisplaySettings = {
  gridCols: 6,
  gridRows: 3,
  colorPreset: "neutral",
  pageBgPreset: "void",
  pageBgShade: 3,
  fontColorPreset: "white",
};

export const GRID_COL_OPTIONS: GridCols[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const GRID_ROW_OPTIONS: GridRows[] = [1, 2, 3, 4, 5, 6];
export const PAGE_BG_SHADE_OPTIONS: PageBgShade[] = [1, 2, 3, 4, 5];

/** Desktop widget band height — driven by `--build-desktop-widget-band-height` in Build.css */
export const DESKTOP_WIDGET_BAND_HEIGHT =
  "var(--build-desktop-widget-band-height, clamp(280px, 36vh, 400px))";
export const DESKTOP_GRID_GAP = "0.85rem";

export const DASHBOARD_COLOR_PRESETS: {
  id: DashboardColorPreset;
  label: string;
  swatch: string;
}[] = [
  { id: "white", label: "White", swatch: "linear-gradient(145deg, #ffffff 0%, #e4e4e7 100%)" },
  { id: "neutral", label: "Neutral", swatch: "linear-gradient(145deg, #f4f4f5 0%, #71717a 100%)" },
  { id: "frost", label: "Frost", swatch: "linear-gradient(145deg, #bae6fd 0%, #2563eb 100%)" },
  { id: "mint", label: "Mint", swatch: "linear-gradient(145deg, #6ee7b7 0%, #059669 100%)" },
  { id: "amber", label: "Amber", swatch: "linear-gradient(145deg, #fde68a 0%, #d97706 100%)" },
  { id: "violet", label: "Violet", swatch: "linear-gradient(145deg, #ddd6fe 0%, #7c3aed 100%)" },
];

export const DASHBOARD_FONT_COLOR_PRESETS: {
  id: DashboardFontColorPreset;
  label: string;
  swatch: string;
}[] = [
  { id: "white", label: "White", swatch: "#f4f4f5" },
  { id: "dark", label: "Dark", swatch: "#18181b" },
  { id: "silver", label: "Silver", swatch: "#a1a1aa" },
  { id: "frost", label: "Frost", swatch: "#7dd3fc" },
  { id: "amber", label: "Amber", swatch: "#fcd34d" },
  { id: "mint", label: "Mint", swatch: "#6ee7b7" },
];

export const DASHBOARD_PAGE_BG_PRESETS: {
  id: DashboardPageBgPreset;
  label: string;
  swatch: string;
  base: string;
  tone: PageBgTone;
}[] = [
  {
    id: "void",
    label: "Void",
    swatch: "linear-gradient(145deg, #27272a 0%, #000000 100%)",
    base: "#000000",
    tone: "dark",
  },
  {
    id: "charcoal",
    label: "Charcoal",
    swatch: "linear-gradient(145deg, #52525b 0%, #18181b 100%)",
    base: "#18181b",
    tone: "dark",
  },
  {
    id: "slate",
    label: "Slate",
    swatch: "linear-gradient(145deg, #64748b 0%, #1e293b 100%)",
    base: "#1a2433",
    tone: "dark",
  },
  {
    id: "navy",
    label: "Navy",
    swatch: "linear-gradient(145deg, #3b82f6 0%, #172554 100%)",
    base: "#14213f",
    tone: "dark",
  },
  {
    id: "forest",
    label: "Forest",
    swatch: "linear-gradient(145deg, #34d399 0%, #14532d 100%)",
    base: "#12281c",
    tone: "dark",
  },
  {
    id: "wine",
    label: "Wine",
    swatch: "linear-gradient(145deg, #c084fc 0%, #581c87 100%)",
    base: "#241030",
    tone: "dark",
  },
  {
    id: "light",
    label: "Light",
    swatch: "linear-gradient(145deg, #ffffff 0%, #e4e4e7 100%)",
    base: "#f0f0f2",
    tone: "light",
  },
];

function parseColorPreset(raw: unknown): DashboardColorPreset {
  return DASHBOARD_COLOR_PRESETS.some((p) => p.id === raw)
    ? (raw as DashboardColorPreset)
    : DEFAULT_DISPLAY_SETTINGS.colorPreset;
}

function parsePageBgPreset(raw: unknown): DashboardPageBgPreset {
  return DASHBOARD_PAGE_BG_PRESETS.some((p) => p.id === raw)
    ? (raw as DashboardPageBgPreset)
    : DEFAULT_DISPLAY_SETTINGS.pageBgPreset;
}

function parsePageBgShade(raw: unknown): PageBgShade {
  const n = Number(raw);
  return PAGE_BG_SHADE_OPTIONS.includes(n as PageBgShade)
    ? (n as PageBgShade)
    : DEFAULT_DISPLAY_SETTINGS.pageBgShade;
}

function parseFontColorPreset(raw: unknown): DashboardFontColorPreset {
  return DASHBOARD_FONT_COLOR_PRESETS.some((p) => p.id === raw)
    ? (raw as DashboardFontColorPreset)
    : DEFAULT_DISPLAY_SETTINGS.fontColorPreset;
}

function clampGridCols(n: number): GridCols {
  return Math.min(GRID_COL_MAX, Math.max(GRID_COL_MIN, Math.round(n))) as GridCols;
}

function clampGridRows(n: number): GridRows {
  return Math.min(GRID_ROW_MAX, Math.max(GRID_ROW_MIN, Math.round(n))) as GridRows;
}

function parseGridCols(raw: unknown): GridCols {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DISPLAY_SETTINGS.gridCols;
  return clampGridCols(n);
}

function parseGridRows(raw: unknown): GridRows {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DISPLAY_SETTINGS.gridRows;
  return clampGridRows(n);
}

function migrateLegacyScale(scale: number): Pick<DashboardDisplaySettings, "gridCols" | "gridRows"> {
  if (scale <= 1) return { gridCols: 8, gridRows: 4 };
  if (scale === 2) return { gridCols: 7, gridRows: 3 };
  if (scale >= 4) return { gridCols: 5, gridRows: 2 };
  return { gridCols: 6, gridRows: 3 };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function overlayFromBg(bg: string, tone: PageBgTone): string {
  const [r, g, b] = hexToRgb(bg);
  const alpha = tone === "light" ? 0.94 : 0.97;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function resolveDarkShade(base: string, shade: PageBgShade): string {
  const t = (shade - 1) / 4;
  const floor = mixHex("#000000", base, 0.22);
  const ceiling = mixHex("#000000", base, 0.78);
  return mixHex(floor, ceiling, t);
}

function resolveLightShade(shade: PageBgShade): string {
  const t = (shade - 1) / 4;
  return mixHex("#c4c4c8", "#ffffff", t);
}

export function resolvePageBg(
  settings: Pick<DashboardDisplaySettings, "pageBgPreset" | "pageBgShade">,
): { bg: string; overlay: string; tone: PageBgTone } {
  const preset =
    DASHBOARD_PAGE_BG_PRESETS.find((p) => p.id === settings.pageBgPreset) ??
    DASHBOARD_PAGE_BG_PRESETS[0];

  if (preset.tone === "light") {
    const bg = resolveLightShade(settings.pageBgShade);
    return { bg, overlay: overlayFromBg(bg, "light"), tone: "light" };
  }

  const bg = resolveDarkShade(preset.base, settings.pageBgShade);
  return { bg, overlay: overlayFromBg(bg, "dark"), tone: "dark" };
}

export function pageBgSwatch(
  preset: (typeof DASHBOARD_PAGE_BG_PRESETS)[number],
  shade: PageBgShade = 2,
): string {
  if (preset.tone === "light") return resolveLightShade(shade);
  return resolveDarkShade(preset.base, shade);
}

function aiPromptChromeVars(tone: PageBgTone, bg: string): Record<string, string> {
  if (tone === "light") {
    return {
      "--build-ai-composer-bg": "rgba(255, 255, 255, 0.82)",
      "--build-ai-composer-border": "rgba(0, 0, 0, 0.1)",
      "--build-ai-composer-inset": "rgba(255, 255, 255, 0.65)",
      "--build-ai-input-border": "rgba(0, 0, 0, 0.14)",
      "--build-ai-input-border-focus": "rgba(0, 0, 0, 0.26)",
      "--build-ai-input-bg": "rgba(0, 0, 0, 0.03)",
      "--build-ai-input-bg-focus": "rgba(0, 0, 0, 0.05)",
      "--build-ai-input-text": "rgba(0, 0, 0, 0.9)",
      "--build-ai-input-placeholder": "rgba(0, 0, 0, 0.38)",
      "--build-ai-widgets-btn-border": "rgba(0, 0, 0, 0.12)",
      "--build-ai-widgets-btn-border-hover": "rgba(0, 0, 0, 0.22)",
      "--build-ai-widgets-btn-border-active": "rgba(0, 0, 0, 0.32)",
      "--build-ai-widgets-btn-bg": "rgba(255, 255, 255, 0.78)",
      "--build-ai-widgets-btn-bg-hover": "rgba(255, 255, 255, 0.92)",
      "--build-ai-widgets-btn-text": "rgba(0, 0, 0, 0.82)",
      "--build-ai-disclaimer-text": "rgba(0, 0, 0, 0.42)",
      "--build-ai-thread-bg": "rgba(255, 255, 255, 0.76)",
      "--build-ai-icon-btn-border": "rgba(0, 0, 0, 0.14)",
      "--build-ai-icon-btn-border-hover": "rgba(0, 0, 0, 0.24)",
    };
  }

  const lum = relativeLuminance(bg);
  const edge = (base: number, spread: number) =>
    Math.min(0.42, base + lum * spread).toFixed(3);

  return {
    "--build-ai-composer-bg": "rgba(0, 0, 0, 0.28)",
    "--build-ai-composer-border": "transparent",
    "--build-ai-composer-inset": `rgba(255, 255, 255, ${edge(0.04, 0.08)})`,
    "--build-ai-input-border": `rgba(255, 255, 255, ${edge(0.08, 0.16)})`,
    "--build-ai-input-border-focus": `rgba(255, 255, 255, ${edge(0.16, 0.22)})`,
    "--build-ai-input-bg": `rgba(255, 255, 255, ${Math.min(0.08, 0.03 + lum * 0.08).toFixed(3)})`,
    "--build-ai-input-bg-focus": `rgba(255, 255, 255, ${Math.min(0.12, 0.05 + lum * 0.1).toFixed(3)})`,
    "--build-ai-input-text": "rgba(255, 255, 255, 0.94)",
    "--build-ai-input-placeholder": `rgba(255, 255, 255, ${edge(0.28, 0.18)})`,
    "--build-ai-widgets-btn-border": `rgba(255, 255, 255, ${edge(0.12, 0.18)})`,
    "--build-ai-widgets-btn-border-hover": `rgba(255, 255, 255, ${edge(0.2, 0.22)})`,
    "--build-ai-widgets-btn-border-active": `rgba(255, 255, 255, ${edge(0.3, 0.26)})`,
    "--build-ai-widgets-btn-bg": `rgba(0, 0, 0, ${Math.min(0.34, 0.22 + lum * 0.14).toFixed(3)})`,
    "--build-ai-widgets-btn-bg-hover": `rgba(255, 255, 255, ${Math.min(0.12, 0.05 + lum * 0.08).toFixed(3)})`,
    "--build-ai-widgets-btn-text": "rgba(255, 255, 255, 0.88)",
    "--build-ai-disclaimer-text": `rgba(255, 255, 255, ${edge(0.28, 0.16)})`,
    "--build-ai-thread-bg": "rgba(0, 0, 0, 0.22)",
    "--build-ai-icon-btn-border": `rgba(255, 255, 255, ${edge(0.1, 0.16)})`,
    "--build-ai-icon-btn-border-hover": `rgba(255, 255, 255, ${edge(0.18, 0.2)})`,
  };
}

export function loadDisplaySettings(): DashboardDisplaySettings {
  if (typeof window === "undefined") return DEFAULT_DISPLAY_SETTINGS;

  const read = (raw: string | null): DashboardDisplaySettings | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<
        DashboardDisplaySettings & { widgetScale?: number }
      >;
      if (parsed.gridCols != null || parsed.gridRows != null) {
        return {
          gridCols: parseGridCols(parsed.gridCols),
          gridRows: parseGridRows(parsed.gridRows),
          colorPreset: parseColorPreset(parsed.colorPreset),
          pageBgPreset: parsePageBgPreset(parsed.pageBgPreset),
          pageBgShade: parsePageBgShade(parsed.pageBgShade),
          fontColorPreset: parseFontColorPreset(parsed.fontColorPreset),
        };
      }
      if (parsed.widgetScale != null) {
        const migrated = migrateLegacyScale(Number(parsed.widgetScale));
        return {
          ...migrated,
          colorPreset: parseColorPreset(parsed.colorPreset),
          pageBgPreset: parsePageBgPreset(parsed.pageBgPreset),
          pageBgShade: parsePageBgShade(parsed.pageBgShade),
          fontColorPreset: parseFontColorPreset(parsed.fontColorPreset),
        };
      }
      return null;
    } catch {
      return null;
    }
  };

  return (
    read(localStorage.getItem(DISPLAY_SETTINGS_KEY)) ??
    read(localStorage.getItem("siphon-build-dashboard-display-v1")) ??
    DEFAULT_DISPLAY_SETTINGS
  );
}

export function saveDisplaySettings(settings: DashboardDisplaySettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(settings));
}

export function buildDashboardThemeClasses(settings: DashboardDisplaySettings): string {
  const { tone } = resolvePageBg(settings);
  return [
    "build-dashboard-theme",
    `build-dashboard-theme--page-${settings.pageBgPreset}`,
    `build-dashboard-theme--tone-${tone}`,
    `build-dashboard-theme--color-${settings.colorPreset}`,
    `build-dashboard-theme--font-${settings.fontColorPreset}`,
  ].join(" ");
}

function fontColorCssVars(preset: DashboardFontColorPreset): Record<string, string> {
  const pack = (text: string, muted: string, subtle: string, aiText: string, aiPlaceholder: string) => ({
    "--defi-text": text,
    "--defi-text-muted": muted,
    "--defi-text-subtle": subtle,
    "--build-ui-text": text,
    "--build-ui-text-muted": muted,
    "--build-ui-text-subtle": subtle,
    "--foreground": text,
    "--build-ai-input-text": aiText,
    "--build-ai-input-placeholder": aiPlaceholder,
    "--build-ai-disclaimer-text": muted,
    "--build-ai-widgets-btn-text": aiText,
  });

  switch (preset) {
    case "dark":
      return pack(
        "rgba(15, 15, 18, 0.92)",
        "rgba(15, 15, 18, 0.62)",
        "rgba(15, 15, 18, 0.45)",
        "rgba(15, 15, 18, 0.9)",
        "rgba(15, 15, 18, 0.42)",
      );
    case "silver":
      return pack(
        "rgba(212, 212, 216, 0.94)",
        "rgba(161, 161, 170, 0.88)",
        "rgba(113, 113, 122, 0.82)",
        "rgba(228, 228, 231, 0.94)",
        "rgba(161, 161, 170, 0.72)",
      );
    case "frost":
      return pack(
        "rgba(186, 230, 253, 0.96)",
        "rgba(125, 211, 252, 0.78)",
        "rgba(56, 189, 248, 0.62)",
        "rgba(224, 242, 254, 0.96)",
        "rgba(125, 211, 252, 0.62)",
      );
    case "amber":
      return pack(
        "rgba(253, 230, 138, 0.96)",
        "rgba(252, 211, 77, 0.78)",
        "rgba(245, 158, 11, 0.62)",
        "rgba(254, 243, 199, 0.96)",
        "rgba(252, 211, 77, 0.62)",
      );
    case "mint":
      return pack(
        "rgba(167, 243, 208, 0.96)",
        "rgba(110, 231, 183, 0.78)",
        "rgba(52, 211, 153, 0.62)",
        "rgba(209, 250, 229, 0.96)",
        "rgba(110, 231, 183, 0.62)",
      );
    case "white":
    default:
      return pack(
        "rgba(255, 255, 255, 0.94)",
        "rgba(255, 255, 255, 0.55)",
        "rgba(255, 255, 255, 0.38)",
        "rgba(255, 255, 255, 0.94)",
        "rgba(255, 255, 255, 0.38)",
      );
  }
}

/** @deprecated Use applyPageBgTheme */
export function applyPageBgPreset(preset: DashboardPageBgPreset) {
  applyPageBgTheme({ ...DEFAULT_DISPLAY_SETTINGS, pageBgPreset: preset });
}

export function applyPageBgTheme(settings: DashboardDisplaySettings) {
  if (typeof document === "undefined") return;
  const resolved = resolvePageBg(settings);
  const aiVars = {
    ...aiPromptChromeVars(resolved.tone, resolved.bg),
    ...fontColorCssVars(settings.fontColorPreset),
  };
  const root = document.documentElement;
  root.style.setProperty("--build-page-bg", resolved.bg);
  root.style.setProperty("--build-page-overlay", resolved.overlay);
  root.dataset.buildPageBg = settings.pageBgPreset;
  root.dataset.buildPageTone = resolved.tone;
  root.dataset.buildFontColor = settings.fontColorPreset;
  for (const [key, value] of Object.entries(aiVars)) {
    root.style.setProperty(key, value);
  }
}

export function desktopGridSpecFromSettings(
  settings: DashboardDisplaySettings,
): WidgetGridSpec {
  return { cols: settings.gridCols, rows: settings.gridRows };
}

export function desktopRowHeightCss(rows: GridRows): string {
  return `calc((${DESKTOP_WIDGET_BAND_HEIGHT} - ${rows - 1} * ${DESKTOP_GRID_GAP}) / ${rows})`;
}
