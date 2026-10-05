"use client";

/**
 * Shepherd-style guided tour that runs on the REAL, already-mounted dashboard: each stop leaves
 * live UI elements exactly as crisp as normal (everything else dims) with a floating video
 * explaining them (the video carries its own narration — no redundant on-screen text here). A
 * stop can list several selectors (e.g. the suggestions marquee + the input composer, but not the
 * settings/widgets buttons flanking them) — each one gets its OWN independent cutout hole hugging
 * its own box, not a single bounding rectangle spanning the gap between them. That needs an SVG
 * mask (a plain CSS box-shadow cutout can only ever punch one hole; two independent box-shadow
 * cutouts would each darken the other's hole). The mask rect also naturally blocks every click on
 * the page — including inside the holes — since SVG hit-testing follows geometry, not the mask.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import styles from "./dashboardTour.module.css";

export type TourStop = {
  /** Each selector's element gets its own independent highlight hole — not a merged bounding box. */
  selectors: readonly string[];
  video: string;
  label: string;
  /** When set, forces Build.tsx's widgetsVisible state before measuring this stop's target. */
  widgetsVisible?: boolean;
  /** Override the glow's spread/strength for this stop — e.g. near-zero for a big region like the widget grid. */
  glowPad?: number;
  glowOpacity?: number;
  /**
   * Skip finding/spotlighting a target entirely — just show the video centered on a full dark
   * backdrop. Use when the target fills the whole viewport (e.g. the node canvas): a "hole" cut to
   * match it covers virtually the entire mask, so nothing actually reads as darkened/highlighted,
   * and the video card's rect-relative positioning has nothing sane to anchor to.
   */
  center?: boolean;
  /** Nudge the video card on mobile only (px). Ignored on desktop — offset there often pushes Next off-screen. */
  cardOffsetY?: number;
  /**
   * Sit the card along the bottom of the viewport, below the highlighted target, and shrink it so
   * it stays inside the screen. Used when a tall clip would cover the thing it is pointing at.
   */
  anchor?: "bottom";
};

const FIND_TIMEOUT_MS = 3000;
const CARD_CHROME_PX = 64; /* controls row + gap + videoWrap padding */
const EDGE_PADDING = 16;
/** Desktop: whole card (buttons included) must stay at least this far from the viewport bottom. */
const DESKTOP_BOTTOM_INSET = 5;
const DESKTOP_TOP_INSET = 5;
const HOLE_RADIUS = 12;
const HOLE_PAD = 6;
const DEFAULT_GLOW_PAD = 16;
const DEFAULT_GLOW_OPACITY = 0.045;

function cardHalfWidthEstimate(viewportWidth: number): number {
  /* Match CSS: min(620px, 92vw) / 2, capped by max-width calc(100vw - 2rem). */
  const cardWidth = Math.min(620, viewportWidth * 0.92, viewportWidth - 32);
  return cardWidth / 2;
}

function clampCardTop(
  top: number,
  cardHeight: number,
  viewportHeight: number,
  topInset: number,
  bottomInset: number,
): number {
  const maxTop = Math.max(topInset, viewportHeight - cardHeight - bottomInset);
  return Math.min(Math.max(top, topInset), maxTop);
}

function unionRect(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Pure CSS/border icons — no SVG, no icon font, nothing that can silently fail to paint. */
function ExpandIcon() {
  return (
    <span className={styles.expandGlyph} aria-hidden>
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function CollapseIcon() {
  return (
    <span className={styles.collapseGlyph} aria-hidden>
      <span />
      <span />
    </span>
  );
}

interface DashboardTourProps {
  stops: readonly TourStop[];
  onComplete: () => void;
  /**
   * Reset Build.tsx's widgetsVisible to the app default (true) once the tour finishes. Only
   * meaningful when a stop actually forced it — leave false when the tour runs on state the user
   * already set up themselves (e.g. the deferred node-canvas explainer), so finishing it doesn't
   * disrupt what they were doing.
   */
  restoreWidgetsOnFinish?: boolean;
}

export default function DashboardTour({
  stops,
  onComplete,
  restoreWidgetsOnFinish = true,
}: DashboardTourProps) {
  const maskId = useId();
  const [stopIndex, setStopIndex] = useState(0);
  const [rects, setRects] = useState<DOMRect[]>([]);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [cardHeight, setCardHeight] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const lockRef = useRef(false);
  const finishedRef = useRef(false);

  const stop = stops[stopIndex];
  const found = rects.length > 0 && !stop.center;

  useEffect(() => {
    setExpanded(false);
    setCardHeight(0);
  }, [stopIndex]);

  // Track real card height; if it still spills past the bottom inset, pull `top` up via remeasure.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.height > 0) setCardHeight(r.height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stopIndex, expanded, visible]);

  // Defensive: every current stop lives in the Builder view — make sure the app is on it.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("pro-view-mode-change", { detail: "blueprint" }));
  }, []);

  // Scroll shouldn't do anything while the tour is up — not advance it, not scroll the real
  // dashboard underneath. Next/Done or Skip are the only way through.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Drive Build.tsx's widgetsVisible state for stops that need the canvas or widget grid crisp.
  useEffect(() => {
    if (stop.widgetsVisible === undefined) return;
    window.dispatchEvent(
      new CustomEvent("siphon:tour-widgets-visible", { detail: stop.widgetsVisible }),
    );
  }, [stop.widgetsVisible]);

  // Locate + track the current stop's target elements — one rect per element, kept separate.
  useEffect(() => {
    setRects([]);
    setVisible(false);

    if (stop.center) {
      const t = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(t);
    }

    let cancelled = false;
    let raf = 0;
    const deadline = Date.now() + FIND_TIMEOUT_MS;
    let attachedEls: Element[] = [];

    const update = () => {
      if (cancelled || attachedEls.length === 0) return;
      setRects(attachedEls.map((el) => el.getBoundingClientRect()));
    };
    const resizeObserver = new ResizeObserver(update);
    const onResizeOrScroll = () => update();

    const poll = () => {
      if (cancelled) return;
      const els = stop.selectors
        .map((sel) => document.querySelector(sel))
        .filter((el): el is Element => el !== null);

      if (els.length === stop.selectors.length) {
        attachedEls = els;
        for (const el of els) resizeObserver.observe(el);
        window.addEventListener("resize", onResizeOrScroll);
        window.addEventListener("scroll", onResizeOrScroll, true);
        update();
        raf = requestAnimationFrame(() => {
          if (!cancelled) setVisible(true);
        });
        return;
      }

      if (Date.now() >= deadline) {
        // Degrade gracefully: show the video centered, no cutout.
        setVisible(true);
        return;
      }
      raf = requestAnimationFrame(poll);
    };
    poll();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, true);
    };
  }, [stop.selectors, stop.center]);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (restoreWidgetsOnFinish) {
      const defaultVisible =
        typeof window === "undefined" || !window.matchMedia("(max-width: 768px)").matches;
      window.dispatchEvent(new CustomEvent("siphon:tour-widgets-visible", { detail: defaultVisible }));
    }
    onComplete();
  }, [onComplete, restoreWidgetsOnFinish]);

  const advance = useCallback(() => {
    if (lockRef.current) return;
    lockRef.current = true;
    window.setTimeout(() => {
      lockRef.current = false;
    }, 500);

    if (stopIndex >= stops.length - 1) {
      finish();
      return;
    }
    setStopIndex((i) => i + 1);
  }, [stopIndex, stops.length, finish]);

  const toggleExpanded = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  }, []);

  // Deliberately no wheel/swipe-to-advance here (unlike the single-screen intro): with real
  // dashboard content visible underneath, an incidental scroll shouldn't skip a video. Advancing
  // is Next/Done or Skip only. Escape still exits, for keyboard accessibility.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  // Always position with pixel `top` + translateX(-50%). On desktop the card (buttons included)
  // must stay ≥ DESKTOP_BOTTOM_INSET from the viewport bottom — never flash past it.
  const cardStyle: CSSProperties = {};
  let cardAnchored = false;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 390;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
  const cardHalfWidth = cardHalfWidthEstimate(viewportWidth);
  const isMobile = viewportWidth <= 768;
  const preferCenteredOnMobile = isMobile;
  const topInset = isMobile ? EDGE_PADDING : DESKTOP_TOP_INSET;
  const bottomInset = isMobile ? EDGE_PADDING : DESKTOP_BOTTOM_INSET;
  // Mobile-only nudge. Desktop ignores — it was pushing Next off-screen.
  const cardOffsetY = isMobile ? (stop.cardOffsetY ?? 0) : 0;
  const anchorBottom = stop.anchor === "bottom" && !expanded;

  // Cap the card first so layout can never exceed the viewport, then place it.
  // A bottom-anchored clip is shorter so it can sit under the highlight without leaving the screen.
  const maxCardHeight = Math.max(180, viewportHeight - topInset - bottomInset);
  const videoFrac = anchorBottom ? 0.38 : expanded ? 0.78 : 0.52;
  const videoMaxPx = Math.max(
    120,
    Math.min(viewportHeight * videoFrac, maxCardHeight - CARD_CHROME_PX),
  );
  // Pessimistic height for clamping before/without measure — never underestimate or top sits too low.
  const heightForClamp = Math.min(
    maxCardHeight,
    Math.max(cardHeight || 0, videoMaxPx + CARD_CHROME_PX),
  );

  if (anchorBottom) {
    const floor = viewportHeight - bottomInset;
    const union = found ? unionRect(rects) : null;
    let top = floor - heightForClamp;
    if (union) {
      const below = union.bottom + 16;
      const room = floor - below;
      // Prefer the gap under the highlight so the video does not cover what it underlines.
      if (top < below && room >= 160) top = below;
    }
    cardAnchored = true;
    cardStyle.left = viewportWidth / 2;
    cardStyle.top = clampCardTop(
      top,
      Math.min(heightForClamp, Math.max(160, floor - top)),
      viewportHeight,
      topInset,
      bottomInset,
    );
  } else if (found && !expanded && !preferCenteredOnMobile) {
    const union = unionRect(rects);
    const spaceBelow = viewportHeight - union.bottom - bottomInset;
    const spaceAbove = union.top - topInset;
    if (spaceBelow >= heightForClamp || spaceAbove >= heightForClamp) {
      cardAnchored = true;
      const centerX = union.left + union.width / 2;
      const minX = cardHalfWidth + EDGE_PADDING;
      const maxX = viewportWidth - cardHalfWidth - EDGE_PADDING;
      const clampedX =
        minX <= maxX
          ? Math.min(Math.max(centerX, minX), maxX)
          : viewportWidth / 2;
      cardStyle.left = clampedX;
      let top: number;
      if (spaceBelow >= heightForClamp) {
        top = union.bottom + 20;
      } else {
        top = union.top - heightForClamp - 20;
      }
      cardStyle.top = clampCardTop(top, heightForClamp, viewportHeight, topInset, bottomInset);
    }
  }

  const cardCentered = !cardAnchored;
  if (cardCentered) {
    cardStyle.left = viewportWidth / 2;
    const idealTop = viewportHeight / 2 - heightForClamp / 2 + cardOffsetY;
    cardStyle.top = clampCardTop(idealTop, heightForClamp, viewportHeight, topInset, bottomInset);
  }

  const placedTop = typeof cardStyle.top === "number" ? cardStyle.top : topInset;
  // Hard CSS ceiling: whatever `top` we chose, the card cannot grow past bottomInset from the floor.
  cardStyle.maxHeight = Math.max(160, viewportHeight - placedTop - bottomInset);

  const videoMaxHeight = `${Math.min(videoMaxPx, Math.max(120, (cardStyle.maxHeight as number) - CARD_CHROME_PX))}px`;

  return (
    <div className={`${styles.overlay} ${visible ? styles.overlayVisible : ""}`}>
      {found && !expanded ? (
        <svg className={styles.maskSvg}>
          <defs>
            <mask id={maskId}>
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              {rects.map((r, i) => (
                <rect
                  key={i}
                  x={r.left - HOLE_PAD}
                  y={r.top - HOLE_PAD}
                  width={r.width + HOLE_PAD * 2}
                  height={r.height + HOLE_PAD * 2}
                  rx={HOLE_RADIUS}
                  ry={HOLE_RADIUS}
                  fill="black"
                />
              ))}
            </mask>
          </defs>
          {/* One dark rect, masked with a hole per element — click-blocks the whole viewport too,
              since SVG hit-testing follows geometry, not the mask. */}
          <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.78)" mask={`url(#${maskId})`} />
          {/* A soft light radiating from behind each element — filled, larger than the hole, and
              heavily blurred, rather than a bright ring traced at the edge. Pad/opacity can be
              dialed down per stop (e.g. near-zero for a big region like the widget grid). */}
          {rects.map((r, i) => {
            const pad = stop.glowPad ?? DEFAULT_GLOW_PAD;
            return (
              <rect
                key={i}
                className={styles.glowRect}
                style={{ fill: `rgba(255,255,255,${stop.glowOpacity ?? DEFAULT_GLOW_OPACITY})` }}
                x={r.left - pad}
                y={r.top - pad}
                width={r.width + pad * 2}
                height={r.height + pad * 2}
                rx={HOLE_RADIUS + pad / 2}
                ry={HOLE_RADIUS + pad / 2}
              />
            );
          })}
        </svg>
      ) : (
        <div className={styles.fallbackDim} />
      )}

      <div
        key={stopIndex}
        ref={cardRef}
        className={`${styles.card} ${cardCentered ? styles.cardCentered : ""} ${expanded ? styles.cardExpanded : ""} ${isMobile ? "" : styles.cardDesktop}`}
        style={cardStyle}
      >
        <div className={styles.controls}>
          <button type="button" className={styles.skipButton} onClick={finish}>
            Skip
          </button>
          <button type="button" className={styles.nextButton} onClick={advance}>
            {stopIndex >= stops.length - 1 ? "Done" : "Next"}
          </button>
        </div>
        <div className={styles.videoWrap}>
          <video
            className={`${styles.video} ${expanded ? styles.videoExpanded : ""}`}
            style={{ maxHeight: videoMaxHeight }}
            src={stop.video}
            aria-label={stop.label}
            autoPlay
            muted
            loop
            playsInline
          />
          <button
            type="button"
            className={styles.expandButton}
            onClick={toggleExpanded}
            aria-label={expanded ? "Collapse video" : "Expand video"}
          >
            {expanded ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        </div>
      </div>
    </div>
  );
}
