"use client";

import { ChevronDown, ChevronsDown, ChevronsUp, ChevronUp, Settings, Trash2, LayoutGrid } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { WIDGET_META } from "@/components/widgets/config/grid";
import {
  DESKTOP_WIDGET_BAND_HEIGHT,
  desktopRowHeightCss,
} from "@/components/widgets/config/dashboardDisplaySettings";
import {
  MOBILE_WIDGET_GRID,
  paginateWidgets,
} from "@/components/widgets/config/widgetPages";
import { renderWidget } from "@/components/widgets/WidgetFactory";
import {
  useDashboardCustomize,
} from "@/components/landing/dashboard-customize-context";
import { canResizeKind } from "@/components/widgets/config/widgetLibrary";

const PAGE_EXIT_MS = 240;
const PAGE_FADE_MS = 380;
const LONG_PRESS_MS = 4000;
const SWIPE_THRESHOLD_PX = 52;
const WHEEL_THRESHOLD = 48;
const PAGE_NAV_COOLDOWN_MS = 480;
const LONG_PRESS_MOVE_CANCEL_PX = 14;

type WidgetPhase = "idle" | "exit" | "enter";

type DashboardWidgetGridProps = {
  /** Hide collapse — build page toggles the whole band from the chat input. */
  hideCollapseControl?: boolean;
};

export function DashboardWidgetGrid({ hideCollapseControl = false }: DashboardWidgetGridProps) {
  const {
    placed,
    hydrated,
    panelOpen,
    setPanelOpen,
    togglePanel,
    removeWidget,
    cycleWidgetSize,
    desktopGridSpec,
    displaySettings,
    themeClassName,
  } = useDashboardCustomize();

  const [collapsed, setCollapsed] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [visiblePageIndex, setVisiblePageIndex] = useState(0);
  const [widgetPhase, setWidgetPhase] = useState<WidgetPhase>("idle");
  const [holdWidgetId, setHoldWidgetId] = useState<string | null>(null);
  const pendingPageRef = useRef(0);
  const hasPlayedInitialEnterRef = useRef(false);
  const [hasEnteredOnce, setHasEnteredOnce] = useState(false);
  const gridMainRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const touchStartYRef = useRef(0);
  const wheelAccumRef = useRef(0);
  const lastPageNavAtRef = useRef(0);

  const gridSpec = isMobileLayout ? MOBILE_WIDGET_GRID : desktopGridSpec;
  const pages = useMemo(() => paginateWidgets(placed, gridSpec), [placed, gridSpec]);
  const pageCount = pages.length;
  const safePageIndex = Math.min(pageIndex, Math.max(0, pageCount - 1));
  const currentPage = pages[visiblePageIndex];
  const pageWidgets = currentPage?.widgets ?? [];
  const pageRowsUsed = Math.max(1, currentPage?.rowsUsed ?? gridSpec.rows);
  const gridGap = isMobileLayout ? "0.65rem" : "0.85rem";
  const pageFullHeight = isMobileLayout
    ? `calc(${gridSpec.rows} * var(--build-widget-row-height) + ${Math.max(0, gridSpec.rows - 1)} * ${gridGap})`
    : DESKTOP_WIDGET_BAND_HEIGHT;
  const pageGridStyle = {
    gridTemplateColumns: `repeat(${gridSpec.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${pageRowsUsed}, minmax(0, 1fr))`,
    height: pageFullHeight,
    maxHeight: pageFullHeight,
    ...(isMobileLayout
      ? {}
      : {
          ["--build-widget-row-height" as string]: desktopRowHeightCss(
            displaySettings.gridRows,
          ),
        }),
  } as React.CSSProperties;

  useEffect(() => {
    setPageIndex(0);
    setVisiblePageIndex(0);
    pendingPageRef.current = 0;
  }, [gridSpec.cols, gridSpec.rows]);

  const requestPage = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(0, next), Math.max(0, pageCount - 1));
      pendingPageRef.current = clamped;
      setPageIndex(clamped);

      if (!hydrated) {
        setVisiblePageIndex(clamped);
        return;
      }

      if (clamped === visiblePageIndex && widgetPhase === "idle") return;
      if (widgetPhase === "exit") {
        pendingPageRef.current = clamped;
        return;
      }

      setWidgetPhase("exit");
    },
    [hydrated, pageCount, visiblePageIndex, widgetPhase],
  );

  const tryMobilePageNav = useCallback(
    (direction: 1 | -1) => {
      if (!isMobileLayout || pageCount <= 1 || panelOpen) return;
      const now = Date.now();
      if (now - lastPageNavAtRef.current < PAGE_NAV_COOLDOWN_MS) return;
      const next = safePageIndex + direction;
      if (next < 0 || next >= pageCount) return;
      lastPageNavAtRef.current = now;
      wheelAccumRef.current = 0;
      requestPage(next);
    },
    [isMobileLayout, pageCount, panelOpen, requestPage, safePageIndex],
  );

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressOriginRef.current = null;
    setHoldWidgetId(null);
  }, []);

  const openPanelFromLongPress = useCallback(() => {
    if (!hideCollapseControl) setCollapsed(false);
    setPanelOpen(true);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(12);
    }
  }, [hideCollapseControl, setPanelOpen]);

  const handleTogglePanel = () => {
    if (!panelOpen && !hideCollapseControl) setCollapsed(false);
    togglePanel();
  };

  const handleWidgetPointerDown = useCallback(
    (widgetId: string, event: React.PointerEvent<HTMLDivElement>) => {
      if (!isMobileLayout || panelOpen || event.pointerType === "mouse") return;
      if (event.isPrimary === false) return;

      clearLongPress();
      longPressOriginRef.current = { x: event.clientX, y: event.clientY };
      setHoldWidgetId(widgetId);
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        longPressOriginRef.current = null;
        setHoldWidgetId(null);
        openPanelFromLongPress();
      }, LONG_PRESS_MS);
    },
    [clearLongPress, isMobileLayout, openPanelFromLongPress, panelOpen],
  );

  const handleWidgetPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!longPressTimerRef.current || !longPressOriginRef.current) return;
      const dx = event.clientX - longPressOriginRef.current.x;
      const dy = event.clientY - longPressOriginRef.current.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_CANCEL_PX) {
        clearLongPress();
      }
    },
    [clearLongPress],
  );

  const handleWidgetPointerEnd = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleGridTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!isMobileLayout || pageCount <= 1 || panelOpen) return;
      touchStartYRef.current = event.touches[0]?.clientY ?? 0;
    },
    [isMobileLayout, pageCount, panelOpen],
  );

  const handleGridTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (!isMobileLayout || pageCount <= 1 || panelOpen || widgetPhase !== "idle") return;
      const endY = event.changedTouches[0]?.clientY ?? touchStartYRef.current;
      const deltaY = touchStartYRef.current - endY;
      if (deltaY > SWIPE_THRESHOLD_PX) {
        tryMobilePageNav(1);
      } else if (deltaY < -SWIPE_THRESHOLD_PX) {
        tryMobilePageNav(-1);
      }
    },
    [isMobileLayout, pageCount, panelOpen, tryMobilePageNav, widgetPhase],
  );

  useLayoutEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileLayout(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!hydrated || hasPlayedInitialEnterRef.current) return;
    hasPlayedInitialEnterRef.current = true;
    if (isMobileLayout) {
      setHasEnteredOnce(true);
      setWidgetPhase("idle");
      return;
    }
    setWidgetPhase("enter");
  }, [hydrated, isMobileLayout]);

  useEffect(() => {
    if (widgetPhase !== "exit") return;
    const timer = window.setTimeout(() => {
      setVisiblePageIndex(pendingPageRef.current);
      setWidgetPhase("enter");
    }, PAGE_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [widgetPhase]);

  useEffect(() => {
    if (widgetPhase !== "enter") return;
    const timer = window.setTimeout(() => {
      setWidgetPhase("idle");
      setHasEnteredOnce(true);
    }, PAGE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [widgetPhase, visiblePageIndex]);

  useEffect(() => {
    if (safePageIndex !== pageIndex) {
      setPageIndex(safePageIndex);
      pendingPageRef.current = safePageIndex;
      if (hydrated && safePageIndex !== visiblePageIndex && widgetPhase === "idle") {
        setWidgetPhase("exit");
      } else if (!hydrated) {
        setVisiblePageIndex(safePageIndex);
      }
    }
  }, [pageCount, pageIndex, safePageIndex, hydrated, visiblePageIndex, widgetPhase]);

  useEffect(() => {
    if (!isMobileLayout) return;
    const el = gridMainRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (pageCount <= 1 || panelOpen || widgetPhase !== "idle") return;
      event.preventDefault();
      wheelAccumRef.current += event.deltaY;
      if (wheelAccumRef.current > WHEEL_THRESHOLD) {
        tryMobilePageNav(1);
      } else if (wheelAccumRef.current < -WHEEL_THRESHOLD) {
        tryMobilePageNav(-1);
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isMobileLayout, pageCount, panelOpen, tryMobilePageNav, widgetPhase]);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  const gridReady = hydrated && (widgetPhase !== "idle" || hasEnteredOnce);
  const pageTransitioning = widgetPhase === "exit" || widgetPhase === "enter";
  const showDesktopToolbar = !isMobileLayout || !hideCollapseControl;

  return (
    <div
      id="dashboard"
      className={[
        themeClassName,
        "scroll-mt-28",
        panelOpen ? "widgets-editing" : "",
        collapsed ? "widgets-collapsed" : "",
        isMobileLayout ? "widgets-mobile" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className={[
          "build-widget-grid-shell",
          isMobileLayout ? "build-widget-grid-shell--mobile" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div
          ref={gridMainRef}
          className={[
            "build-widget-grid-main min-w-0",
            panelOpen ? "overflow-visible" : "overflow-x-hidden",
            collapsed ? "hidden" : "",
            isMobileLayout && pageCount > 1 ? "build-widget-grid-main--mobile-paged" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onTouchStart={handleGridTouchStart}
          onTouchEnd={handleGridTouchEnd}
        >
          {isMobileLayout && pageCount > 1 ? (
            <span className="sr-only" aria-live="polite">
              Page {safePageIndex + 1} of {pageCount}. Swipe up or down to change pages. Hold a
              widget for four seconds to customize.
            </span>
          ) : null}
          <div
            className={[
              `build-widget-grid build-widget-grid--paged build-widget-grid--cols-${gridSpec.cols} build-widget-grid--rows-${gridSpec.rows}`,
              widgetPhase === "exit" ? "build-widget-grid--exiting" : "",
              widgetPhase === "enter" ? "build-widget-grid--entering" : "",
              !gridReady ? "build-widget-grid--hidden" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={pageGridStyle}
          >
            {gridReady
              ? pageWidgets.map((p) => {
                  const isHolding = holdWidgetId === p.id;
                  return (
                    <div
                      key={`${visiblePageIndex}-${p.id}`}
                      className={[
                        "build-widget-cell relative min-h-0 min-w-0",
                        panelOpen ? "build-widget-cell--editing" : "",
                        isHolding ? "build-widget-cell--hold-pending" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{
                        gridColumn: `${p.col + 1} / span ${p.colSpan}`,
                        gridRow: `${p.row + 1} / span ${p.rowSpan}`,
                      }}
                      onPointerDown={(event) => handleWidgetPointerDown(p.id, event)}
                      onPointerMove={handleWidgetPointerMove}
                      onPointerUp={handleWidgetPointerEnd}
                      onPointerCancel={handleWidgetPointerEnd}
                    >
                      <div className="build-widget-cell-inner flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
                        {renderWidget(p)}
                        {panelOpen ? (
                          <div className="build-widget-edit-bar pointer-events-auto">
                            {canResizeKind(p.kind) ? (
                              <button
                                type="button"
                                onClick={() => cycleWidgetSize(p.id)}
                                className="build-widget-edit-btn build-widget-edit-btn--size"
                                title="Change size"
                                aria-label={`Change size (${p.size.replace("x", " by ")})`}
                              >
                                {isMobileLayout ? (
                                  <LayoutGrid className="size-3" aria-hidden />
                                ) : (
                                  <span className="build-widget-edit-btn-label">
                                    {p.size.replace("x", "×")}
                                  </span>
                                )}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => removeWidget(p.id)}
                              className="build-widget-edit-btn build-widget-edit-btn--danger"
                              aria-label={`Remove ${WIDGET_META[p.kind].label}`}
                            >
                              <Trash2 className="size-3 sm:size-3.5" strokeWidth={1.75} />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              : null}
          </div>
        </div>

        {showDesktopToolbar ? (
          <div className="build-widget-grid-toolbar">
            {!hideCollapseControl ? (
              <button
                type="button"
                onClick={() => setCollapsed((c) => !c)}
                className="build-widget-tool-btn"
                title={collapsed ? "Show dashboard" : "Collapse dashboard"}
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <ChevronsUp className="size-4" strokeWidth={1.75} aria-hidden />
                ) : (
                  <ChevronsDown className="size-4" strokeWidth={1.75} aria-hidden />
                )}
                <span className="sr-only">
                  {collapsed ? "Show dashboard" : "Collapse dashboard"}
                </span>
              </button>
            ) : null}
            {!isMobileLayout ? (
              <div className="build-widget-settings-slot">
                <div className="build-widget-settings-anchor">
                  <button
                    type="button"
                    onClick={handleTogglePanel}
                    className={`build-widget-tool-btn ${panelOpen ? "build-widget-tool-btn--active" : ""}`}
                    aria-expanded={panelOpen}
                    aria-controls="dashboard-customize-panel"
                    title={panelOpen ? "Done customizing" : "Customize dashboard"}
                    aria-label={panelOpen ? "Done customizing" : "Customize dashboard"}
                  >
                    <Settings className="size-4" strokeWidth={1.75} aria-hidden />
                    <span className="sr-only">
                      {panelOpen ? "Done customizing" : "Customize dashboard"}
                    </span>
                  </button>
                </div>
                {pageCount > 1 ? (
                  <nav
                    className="build-widget-page-nav build-widget-page-nav--toolbar"
                    aria-label="Dashboard pages"
                  >
                    <span className="build-widget-page-label">Pages</span>
                    <div className="build-widget-page-stepper">
                      <button
                        type="button"
                        className="build-widget-page-step-btn"
                        onClick={() => requestPage(safePageIndex - 1)}
                        disabled={safePageIndex === 0 || pageTransitioning}
                        aria-label="Previous page"
                      >
                        <ChevronUp className="size-3.5" strokeWidth={2} aria-hidden />
                      </button>
                      <div className="build-widget-page-dots" role="tablist" aria-label="Select page">
                        {pages.map((_, i) => (
                          <button
                            key={`page-${i}`}
                            type="button"
                            role="tab"
                            className={`build-widget-page-dot${i === safePageIndex ? " build-widget-page-dot--active" : ""}`}
                            onClick={() => requestPage(i)}
                            aria-label={`Page ${i + 1}`}
                            aria-selected={i === safePageIndex}
                            disabled={pageTransitioning}
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        className="build-widget-page-step-btn"
                        onClick={() => requestPage(safePageIndex + 1)}
                        disabled={safePageIndex >= pageCount - 1 || pageTransitioning}
                        aria-label="Next page"
                      >
                        <ChevronDown className="size-3.5" strokeWidth={2} aria-hidden />
                      </button>
                    </div>
                    <span className="build-widget-page-fraction" aria-live="polite">
                      {safePageIndex + 1}
                      <span className="build-widget-page-fraction-sep">/</span>
                      {pageCount}
                    </span>
                  </nav>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
