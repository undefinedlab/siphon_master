"use client";

import { useEffect, useState } from "react";
import {
  type OpportunityCard,
  type OpportunityCategory,
  type OpportunityKind,
  opportunitiesByCategory,
} from "@/data/opportunities";
import { useLiveWidget } from "@/lib/useLiveWidget";

type ApiOpportunity = {
  id: string;
  category?: string;
  title: string;
  subtitle?: string;
  apy_percent?: number | null;
  risk_level?: string;
  chain?: string;
  cta?: { label: string; href: string };
};

function apiKind(cat?: string): OpportunityKind {
  const c = (cat ?? "").toLowerCase();
  if (c === "stake") return "Stake";
  if (c === "lp") return "LP";
  if (c === "save" || c === "cash") return "Save";
  if (c === "borrow") return "Borrow";
  if (c === "bridge") return "Bridge";
  if (c === "vault") return "Vault";
  return "Earn";
}

function apiCategory(kind: OpportunityKind): OpportunityCategory {
  if (kind === "Save" || kind === "Cash") return "save";
  if (kind === "Borrow" || kind === "Bridge") return "invest";
  return "yield";
}

function mapApiOpportunity(o: ApiOpportunity): OpportunityCard {
  const kind = apiKind(o.category);
  return {
    id: o.id,
    kind,
    category: apiCategory(kind),
    headline: o.title,
    context: [o.subtitle, o.chain].filter(Boolean).join(" · "),
    metric: o.apy_percent != null ? `${o.apy_percent.toFixed(1)}%` : "—",
    metricLabel: o.apy_percent != null ? "APY" : "Rate",
  };
}

const CAT_TABS: { id: OpportunityCategory; label: string; hint: string }[] = [
  { id: "yield", label: "Yield", hint: "Lend, stake, LP" },
  { id: "save", label: "Save", hint: "Cash & savings" },
  { id: "invest", label: "Invest", hint: "Credit & strategies" },
];

function MarqueeEdgeFades() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-9 sm:w-12"
        style={{
          background:
            "linear-gradient(to right, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.2) 55%, transparent 100%)",
        }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-9 sm:w-12"
        style={{
          background:
            "linear-gradient(to left, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.2) 55%, transparent 100%)",
        }}
        aria-hidden
      />
    </>
  );
}

function splitIntoTwoRows(items: OpportunityCard[]): [
  OpportunityCard[],
  OpportunityCard[],
] {
  const a: OpportunityCard[] = [];
  const b: OpportunityCard[] = [];
  items.forEach((item, i) => {
    if (i % 2 === 0) a.push(item);
    else b.push(item);
  });
  return [a, b];
}

function OppCardRibbon({ o }: { o: OpportunityCard }) {
  return (
    <article
      tabIndex={0}
      className="build-opp-ribbon-card group relative flex h-[84px] w-[222px] shrink-0 cursor-pointer flex-col justify-center overflow-hidden rounded-xl border px-3 py-3 outline-none transition-[border-color,box-shadow] duration-200 ease-out hover:z-[2] focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--defi-text)_20%,transparent)] focus-visible:ring-offset-2 sm:h-[90px] sm:w-[234px] sm:px-3.5 sm:py-3.5"
    >
      <div className="flex min-w-0 items-start gap-2.5 sm:gap-3">
        <div className="min-w-0 flex-1">
          <span className="widget-badge">{o.kind}</span>
          <h3 className="mt-1.5 line-clamp-1 text-[13px] font-semibold leading-snug tracking-tight text-[var(--defi-text)] sm:text-[14px]">
            {o.headline}
          </h3>
          <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-[var(--defi-text-muted)]">
            {o.context}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[8px] font-semibold uppercase tracking-[0.12em] text-[var(--defi-text-subtle)]">
            {o.metricLabel ?? "Rate"}
          </p>
          <p className="mt-1 text-[15px] font-semibold tabular-nums leading-none tracking-tight text-[var(--defi-text)] sm:text-base">
            {o.metric}
          </p>
        </div>
      </div>
    </article>
  );
}

function MarqueeRow({
  items,
  reducedMotion,
  rowIndex,
}: {
  items: OpportunityCard[];
  reducedMotion: boolean;
  rowIndex: number;
}) {
  const durationSec = 42 + rowIndex * 10;
  const reverse = rowIndex === 1;
  if (items.length === 0) return null;
  const trackGap = "gap-4";

  if (reducedMotion) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center overflow-hidden">
        <MarqueeEdgeFades />
        <div
          className={`flex min-h-0 w-full items-center overflow-x-auto overflow-y-hidden px-4 py-1 sm:px-5 ${trackGap} scrollbar-hide`}
        >
          {items.map((o) => (
            <OppCardRibbon key={o.id} o={o} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 items-center overflow-hidden px-4 py-1 sm:px-5">
      <MarqueeEdgeFades />
      <div
        className="marquee-track flex w-max items-center will-change-transform"
        style={{
          animation: `marquee-slide ${durationSec}s linear infinite${reverse ? " reverse" : ""}`,
        }}
      >
        <div className={`flex shrink-0 items-center ${trackGap} pr-4`}>
          {items.map((o) => (
            <OppCardRibbon key={o.id} o={o} />
          ))}
        </div>
        <div className={`flex shrink-0 items-center ${trackGap} pr-4`}>
          {items.map((o) => (
            <OppCardRibbon key={`${o.id}-dup`} o={o} />
          ))}
        </div>
      </div>
    </div>
  );
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function OpportunityPanel({ sectionId }: { sectionId?: string }) {
  const [category, setCategory] = useState<OpportunityCategory>("yield");
  const liveOpps = useLiveWidget<ApiOpportunity[] | null>("opportunities", null, 60_000);

  const allCards: OpportunityCard[] = liveOpps
    ? liveOpps.map(mapApiOpportunity)
    : [];

  const items = allCards.length > 0
    ? allCards.filter((o) => o.category === category)
    : opportunitiesByCategory(category);

  const reducedMotion = usePrefersReducedMotion();
  const [rowA, rowB] = splitIntoTwoRows(items);

  return (
    <div
      {...(sectionId ? { id: sectionId } : {})}
      className="widget-hover widget-card"
    >
      <div className="widget-card-header">
        <div>
          <p className="widget-card-title">Opportunities</p>
          <p className="widget-card-subtitle">Illustrative rates — not investment advice</p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-1 sm:w-auto sm:items-end" role="tablist" aria-label="Opportunity category">
          <div className="widget-tabs">
            {CAT_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={category === t.id}
                onClick={() => setCategory(t.id)}
                className={`widget-tab ${category === t.id ? "widget-tab--active" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="hidden text-[10px] text-[var(--defi-text-subtle)] sm:block">
            {CAT_TABS.find((c) => c.id === category)?.hint}
          </span>
        </div>
      </div>

      <div
        key={category}
        className="widget-card-body gap-3 px-1 py-3 sm:gap-3.5 sm:px-2 sm:py-4"
        aria-label="Scrolling opportunities"
      >
        <MarqueeRow items={rowA} reducedMotion={reducedMotion} rowIndex={0} />
        <MarqueeRow items={rowB} reducedMotion={reducedMotion} rowIndex={1} />
      </div>
    </div>
  );
}
