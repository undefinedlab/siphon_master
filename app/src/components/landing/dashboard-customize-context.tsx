"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { RotateCcw } from "lucide-react";
import {
  ALL_KINDS,
  DEFAULT_PLACED,
  STORAGE_KEY,
  WIDGET_META,
  loadPlacedFromStorage,
  defaultSizeForKind,
  type PlacedWidget,
  type WidgetKind,
} from "@/components/widgets/config/grid";
import { WIDGET_KIND_ICONS } from "@/components/landing/widget-kind-icons";
import {
  canResizeKind,
  cycleSizeForKind,
  COMING_SOON_WIDGET_KINDS,
  isWidgetAddable,
  WIDGET_LIBRARY,
} from "@/components/widgets/config/widgetLibrary";
import {
  applyPageBgTheme,
  buildDashboardThemeClasses,
  DASHBOARD_COLOR_PRESETS,
  DASHBOARD_FONT_COLOR_PRESETS,
  DASHBOARD_PAGE_BG_PRESETS,
  DEFAULT_DISPLAY_SETTINGS,
  desktopGridSpecFromSettings,
  GRID_COL_MAX,
  GRID_ROW_MAX,
  PAGE_BG_SHADE_OPTIONS,
  loadDisplaySettings,
  saveDisplaySettings,
  type DashboardColorPreset,
  type DashboardDisplaySettings,
  type DashboardFontColorPreset,
  type DashboardPageBgPreset,
  type GridCols,
  type GridRows,
  type PageBgShade,
} from "@/components/widgets/config/dashboardDisplaySettings";

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `w-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function loadPlaced(): PlacedWidget[] {
  return loadPlacedFromStorage();
}

function savePlaced(placed: PlacedWidget[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(placed));
}

type CustomizePanelMode = "widgets" | "settings";

type DashboardCustomizeContextValue = {
  placed: PlacedWidget[];
  hydrated: boolean;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  closePanel: () => void;
  addable: WidgetKind[];
  addWidget: (kind: WidgetKind) => void;
  removeWidget: (id: string) => void;
  cycleWidgetSize: (id: string) => void;
  resetDefault: () => void;
  displaySettings: DashboardDisplaySettings;
  themeClassName: string;
  desktopGridSpec: { cols: number; rows: number };
  gridCols: GridCols;
  gridRows: GridRows;
  colorPreset: DashboardColorPreset;
  pageBgPreset: DashboardPageBgPreset;
  pageBgShade: PageBgShade;
  fontColorPreset: DashboardFontColorPreset;
  setGridCols: (cols: GridCols) => void;
  setGridRows: (rows: GridRows) => void;
  setColorPreset: (preset: DashboardColorPreset) => void;
  setPageBgPreset: (preset: DashboardPageBgPreset) => void;
  setPageBgShade: (shade: PageBgShade) => void;
  setFontColorPreset: (preset: DashboardFontColorPreset) => void;
};

const DashboardCustomizeContext = createContext<DashboardCustomizeContextValue | null>(
  null,
);

export function DashboardCustomizeProvider({ children }: { children: ReactNode }) {
  const [placed, setPlaced] = useState<PlacedWidget[]>(DEFAULT_PLACED);
  const [hydrated, setHydrated] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [displaySettings, setDisplaySettings] = useState<DashboardDisplaySettings>(
    DEFAULT_DISPLAY_SETTINGS,
  );

  useEffect(() => {
    setPlaced(loadPlaced());
    setDisplaySettings(loadDisplaySettings());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    savePlaced(placed);
  }, [placed, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveDisplaySettings(displaySettings);
  }, [displaySettings, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    applyPageBgTheme(displaySettings);
  }, [
    displaySettings.pageBgPreset,
    displaySettings.pageBgShade,
    displaySettings.fontColorPreset,
    hydrated,
  ]);

  useEffect(() => {
    if (!panelOpen) return;
    window.dispatchEvent(new CustomEvent("build-dashboard-customize-open"));
  }, [panelOpen]);

  const usedKinds = useMemo(() => new Set(placed.map((p) => p.kind)), [placed]);
  const addable = useMemo(
    () => ALL_KINDS.filter((k) => !usedKinds.has(k) && isWidgetAddable(k)),
    [usedKinds],
  );

  const addWidget = useCallback((kind: WidgetKind) => {
    if (!isWidgetAddable(kind)) return;
    setPlaced((p) => [...p, { id: uid(), kind, size: defaultSizeForKind(kind) }]);
  }, []);

  const removeWidget = useCallback((id: string) => {
    setPlaced((p) => p.filter((x) => x.id !== id));
  }, []);

  const cycleWidgetSize = useCallback((id: string) => {
    setPlaced((p) =>
      p.map((x) => {
        if (x.id !== id || !canResizeKind(x.kind)) return x;
        return { ...x, size: cycleSizeForKind(x.kind, x.size) };
      }),
    );
  }, []);

  const resetDefault = useCallback(() => {
    setPlaced(DEFAULT_PLACED.map((d) => ({ ...d, id: uid() })));
  }, []);

  const setGridCols = useCallback((gridCols: GridCols) => {
    setDisplaySettings((s) => ({ ...s, gridCols }));
  }, []);

  const setGridRows = useCallback((gridRows: GridRows) => {
    setDisplaySettings((s) => ({ ...s, gridRows }));
  }, []);

  const setColorPreset = useCallback((colorPreset: DashboardColorPreset) => {
    setDisplaySettings((s) => ({ ...s, colorPreset }));
  }, []);

  const setPageBgPreset = useCallback((pageBgPreset: DashboardPageBgPreset) => {
    setDisplaySettings((s) => ({ ...s, pageBgPreset }));
  }, []);

  const setPageBgShade = useCallback((pageBgShade: PageBgShade) => {
    setDisplaySettings((s) => ({ ...s, pageBgShade }));
  }, []);

  const setFontColorPreset = useCallback((fontColorPreset: DashboardFontColorPreset) => {
    setDisplaySettings((s) => ({ ...s, fontColorPreset }));
  }, []);

  const themeClassName = useMemo(
    () => buildDashboardThemeClasses(displaySettings),
    [displaySettings],
  );

  const desktopGridSpec = useMemo(
    () => desktopGridSpecFromSettings(displaySettings),
    [displaySettings],
  );

  const closePanel = useCallback(() => setPanelOpen(false), []);
  const togglePanel = useCallback(() => setPanelOpen((o) => !o), []);

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  const value = useMemo(
    () => ({
      placed,
      hydrated,
      panelOpen,
      setPanelOpen,
      togglePanel,
      closePanel,
      addable,
      addWidget,
      removeWidget,
      cycleWidgetSize,
      resetDefault,
      displaySettings,
      themeClassName,
      desktopGridSpec,
      gridCols: displaySettings.gridCols,
      gridRows: displaySettings.gridRows,
      colorPreset: displaySettings.colorPreset,
      pageBgPreset: displaySettings.pageBgPreset,
      pageBgShade: displaySettings.pageBgShade,
      fontColorPreset: displaySettings.fontColorPreset,
      setGridCols,
      setGridRows,
      setColorPreset,
      setPageBgPreset,
      setPageBgShade,
      setFontColorPreset,
    }),
    [
      placed,
      hydrated,
      panelOpen,
      closePanel,
      togglePanel,
      addable,
      addWidget,
      removeWidget,
      cycleWidgetSize,
      resetDefault,
      displaySettings,
      themeClassName,
      desktopGridSpec,
      setGridCols,
      setGridRows,
      setColorPreset,
      setPageBgPreset,
      setPageBgShade,
      setFontColorPreset,
    ],
  );

  return (
    <DashboardCustomizeContext.Provider value={value}>
      {children}
    </DashboardCustomizeContext.Provider>
  );
}

export function useDashboardCustomize() {
  const ctx = useContext(DashboardCustomizeContext);
  if (!ctx) {
    throw new Error("useDashboardCustomize must be used within DashboardCustomizeProvider");
  }
  return ctx;
}

const GRID_PICKER_MAX_COLS = GRID_COL_MAX;
const GRID_PICKER_MAX_ROWS = GRID_ROW_MAX;

function GridDensityPicker({
  gridCols,
  gridRows,
  setGridCols,
  setGridRows,
}: {
  gridCols: GridCols;
  gridRows: GridRows;
  setGridCols: (cols: GridCols) => void;
  setGridRows: (rows: GridRows) => void;
}) {
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);

  const previewCols = hover
    ? (Math.min(GRID_PICKER_MAX_COLS, hover.c + 1) as GridCols)
    : gridCols;
  const previewRows = hover
    ? (Math.min(GRID_PICKER_MAX_ROWS, hover.r + 1) as GridRows)
    : gridRows;

  return (
    <div className="build-widget-grid-density-picker-wrap">
      <div
        className="build-widget-grid-density-picker"
        role="grid"
        aria-label={`Widget grid size, ${gridCols} columns by ${gridRows} rows`}
        style={{
          gridTemplateColumns: `repeat(${GRID_PICKER_MAX_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${GRID_PICKER_MAX_ROWS}, minmax(0, 1fr))`,
        }}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: GRID_PICKER_MAX_COLS * GRID_PICKER_MAX_ROWS }).map((_, i) => {
          const c = i % GRID_PICKER_MAX_COLS;
          const r = Math.floor(i / GRID_PICKER_MAX_COLS);
          const inPreview = c < previewCols && r < previewRows;
          const isCorner = c + 1 === previewCols && r + 1 === previewRows;

          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              className={[
                "build-widget-grid-density-picker-cell",
                inPreview ? "build-widget-grid-density-picker-cell--in-range" : "",
                isCorner && inPreview ? "build-widget-grid-density-picker-cell--corner" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={`Set grid to ${c + 1} by ${r + 1}`}
              aria-pressed={gridCols === c + 1 && gridRows === r + 1}
              onMouseEnter={() => setHover({ c, r })}
              onFocus={() => setHover({ c, r })}
              onBlur={() => setHover(null)}
              onClick={() => {
                setGridCols(Math.min(GRID_PICKER_MAX_COLS, c + 1) as GridCols);
                setGridRows(Math.min(GRID_PICKER_MAX_ROWS, r + 1) as GridRows);
              }}
            />
          );
        })}
      </div>
      <p className="build-widget-grid-density-size" aria-live="polite">
        {previewCols} × {previewRows}
      </p>
    </div>
  );
}

/** Widget library — hero band on desktop; inline when customizing. */
export function DashboardCustomizePanel({
  variant = "default",
}: {
  variant?: "default" | "mobile" | "hero";
}) {
  const {
    panelOpen,
    addable,
    addWidget,
    resetDefault,
    closePanel,
    gridCols,
    gridRows,
    colorPreset,
    pageBgPreset,
    pageBgShade,
    fontColorPreset,
    setGridCols,
    setGridRows,
    setColorPreset,
    setPageBgPreset,
    setPageBgShade,
    setFontColorPreset,
  } = useDashboardCustomize();
  const [panelMode, setPanelMode] = useState<CustomizePanelMode>("widgets");

  const allOnBoard = addable.length === 0;
  const showLibraryGrid = !allOnBoard || COMING_SOON_WIDGET_KINDS.length > 0;

  if (variant === "default") return null;
  if (variant !== "hero" && !panelOpen) return null;

  return (
    <div
      id="dashboard-customize-panel"
      role="region"
      aria-label={panelMode === "widgets" ? "Add dashboard widgets" : "Dashboard settings"}
      className={[
        "build-widget-customize-panel",
        variant === "hero" ? "build-widget-customize-panel--hero" : "",
        variant === "mobile" ? "build-widget-customize-panel--mobile" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="build-widget-customize-topbar">
        <div
          className="build-widget-customize-mode-tabs"
          role="tablist"
          aria-label="Customize panel sections"
        >
          <button
            type="button"
            role="tab"
            aria-selected={panelMode === "widgets"}
            className={`build-widget-customize-mode-tab${panelMode === "widgets" ? " build-widget-customize-mode-tab--active" : ""}`}
            onClick={() => setPanelMode("widgets")}
          >
            Widgets
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panelMode === "settings"}
            className={`build-widget-customize-mode-tab${panelMode === "settings" ? " build-widget-customize-mode-tab--active" : ""}`}
            onClick={() => setPanelMode("settings")}
          >
            Settings
          </button>
        </div>
        <div className="build-widget-customize-head-actions">
          {panelMode === "widgets" ? (
            <button
              type="button"
              onClick={resetDefault}
              className="build-widget-customize-reset-icon"
              title="Reset all widgets to original layout"
              aria-label="Reset all widgets to original layout"
            >
              <RotateCcw className="size-3.5" strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            onClick={closePanel}
            className="build-widget-customize-done build-widget-customize-close-mobile"
            title="Done customizing"
            aria-label="Done customizing"
          >
            Done
          </button>
        </div>
      </div>

      <div className="build-widget-customize-panel-head">
        <div className="min-w-0">
          <p className="build-widget-customize-title">
            {panelMode === "widgets" ? "Widget library" : "Dashboard settings"}
          </p>
          <p
            className={[
              "build-widget-customize-subtitle",
              panelMode !== "settings" ? "build-widget-customize-subtitle--placeholder" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-hidden={panelMode !== "settings"}
          >
            {panelMode === "settings"
              ? "Grid size, backdrop, font color, and widget area tint"
              : "\u00a0"}
          </p>
        </div>
      </div>

      {panelMode === "settings" ? (
        <div className="build-widget-customize-settings">
          <div className="build-widget-customize-settings-row">
            <section className="build-widget-customize-settings-section build-widget-customize-settings-section--grid">
              <p className="build-widget-customize-settings-label">Widget grid</p>
              <GridDensityPicker
                gridCols={gridCols}
                gridRows={gridRows}
                setGridCols={setGridCols}
                setGridRows={setGridRows}
              />
            </section>

            <section className="build-widget-customize-settings-section build-widget-customize-settings-section--bg">
              <p className="build-widget-customize-settings-label">Background</p>
              <div
                className="build-widget-customize-color-row build-widget-customize-color-row--page"
                role="radiogroup"
                aria-label="Page background color"
              >
                {DASHBOARD_PAGE_BG_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={pageBgPreset === preset.id}
                    aria-label={preset.label}
                    className={`build-widget-customize-color-dot build-widget-customize-color-dot--page${pageBgPreset === preset.id ? " build-widget-customize-color-dot--active" : ""}`}
                    onClick={() => setPageBgPreset(preset.id)}
                    title={preset.label}
                  >
                    <span
                      className="build-widget-customize-color-dot-inner"
                      style={{ background: preset.swatch }}
                    />
                  </button>
                ))}
              </div>
              <div className="build-widget-page-bg-shade">
                <span className="build-widget-page-bg-shade-label">Depth</span>
                <div className="build-widget-page-bg-shade-steps" role="group" aria-label="Background depth">
                  {PAGE_BG_SHADE_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={pageBgShade === n}
                      className={`build-widget-page-bg-shade-step${pageBgShade === n ? " build-widget-page-bg-shade-step--active" : ""}`}
                      onClick={() => setPageBgShade(n)}
                      title={n === 1 ? "Darker" : n === 5 ? "Lighter" : `Depth ${n}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="build-widget-customize-settings-section build-widget-customize-settings-section--font">
              <p className="build-widget-customize-settings-label">Font color</p>
              <div
                className="build-widget-customize-color-row build-widget-customize-color-row--font"
                role="radiogroup"
                aria-label="Dashboard font color"
              >
                {DASHBOARD_FONT_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={fontColorPreset === preset.id}
                    aria-label={preset.label}
                    className={`build-widget-customize-color-dot build-widget-customize-color-dot--font${fontColorPreset === preset.id ? " build-widget-customize-color-dot--active" : ""}`}
                    onClick={() => setFontColorPreset(preset.id)}
                    title={preset.label}
                  >
                    <span
                      className="build-widget-customize-color-dot-inner"
                      style={{ background: preset.swatch }}
                    />
                  </button>
                ))}
              </div>
            </section>

            <section className="build-widget-customize-settings-section build-widget-customize-settings-section--accent">
              <p className="build-widget-customize-settings-label">Widget area</p>
              <div
                className="build-widget-customize-color-row"
                role="radiogroup"
                aria-label="Widget area accent color"
              >
                {DASHBOARD_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={colorPreset === preset.id}
                    aria-label={preset.label}
                    className={`build-widget-customize-color-dot build-widget-customize-color-dot--widget${colorPreset === preset.id ? " build-widget-customize-color-dot--active" : ""}`}
                    onClick={() => setColorPreset(preset.id)}
                    title={preset.label}
                  >
                    <span
                      className="build-widget-customize-color-dot-inner"
                      style={{ background: preset.swatch }}
                    />
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      ) : null}

      {panelMode === "widgets" && allOnBoard && COMING_SOON_WIDGET_KINDS.length === 0 ? (
        <div className="build-widget-customize-body build-widget-customize-body--all-placed">
          <p className="build-widget-customize-all-placed-msg">All widgets are on the board.</p>
        </div>
      ) : null}

      {panelMode === "widgets" && showLibraryGrid ? (
        <ul className="build-widget-customize-grid">
          {addable.map((k) => {
            const Icon = WIDGET_KIND_ICONS[k];
            return (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => addWidget(k)}
                  className="build-widget-customize-card"
                >
                  <span className="build-widget-customize-card-top">
                    <span className="widget-badge">{WIDGET_LIBRARY[k].tier}</span>
                  </span>
                  <span className="build-widget-customize-card-icon" aria-hidden>
                    <Icon strokeWidth={1.65} />
                  </span>
                  <span className="build-widget-customize-card-foot">
                    <span className="build-widget-customize-card-label">{WIDGET_META[k].label}</span>
                    <span className="build-widget-customize-card-hint">{WIDGET_META[k].hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {COMING_SOON_WIDGET_KINDS.map((k) => {
            const Icon = WIDGET_KIND_ICONS[k];
            return (
              <li key={k}>
                <div
                  className="build-widget-customize-card build-widget-customize-card--soon"
                  aria-disabled="true"
                  title="Coming soon"
                >
                  <span className="build-widget-customize-card-top">
                    <span className="widget-badge widget-badge--soon">Soon</span>
                  </span>
                  <span className="build-widget-customize-card-icon" aria-hidden>
                    <Icon strokeWidth={1.65} />
                  </span>
                  <span className="build-widget-customize-card-foot">
                    <span className="build-widget-customize-card-label">{WIDGET_META[k].label}</span>
                    <span className="build-widget-customize-card-hint">{WIDGET_META[k].hint}</span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** @deprecated Use DashboardCustomizePanel in the hero band instead. */
export function DashboardCustomizeChatPicker() {
  return null;
}
