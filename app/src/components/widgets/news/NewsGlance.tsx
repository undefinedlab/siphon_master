"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useNews } from "./useNews";

const HOLD_MS = 5000;

function subscribeMobileLayout(onChange: () => void) {
  const mq = window.matchMedia("(max-width: 768px)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getMobileLayoutSnapshot() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function useMobileLayout() {
  return useSyncExternalStore(subscribeMobileLayout, getMobileLayoutSnapshot, () => false);
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function NewsGlance() {
  const isMobile = useMobileLayout();
  const { data: liveNews, loading } = useNews();
  const items = (liveNews ?? []).slice(0, 5).map((n) => ({
    id: n.id,
    title: n.title,
    url: n.url,
    source: n.source,
    time: formatRelativeTime(n.published_at),
  }));

  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (items.length <= 1) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, HOLD_MS);
    return () => window.clearInterval(id);
  }, [items.length]);

  useEffect(() => {
    if (items.length === 0) {
      setIndex(0);
      return;
    }
    if (index >= items.length) {
      setIndex(0);
    }
  }, [index, items.length]);

  const n = items[index];
  const mobileItems =
    isMobile && items.length > 0
      ? items.length === 1
        ? [items[0]]
        : [items[index], items[(index + 1) % items.length]]
      : n
        ? [n]
        : [];

  if (loading && !n) {
    return (
      <div className="build-news-empty flex min-h-[100px] flex-1 items-center justify-center px-3 text-xs">
        Loading headlines…
      </div>
    );
  }

  if (!n) {
    return (
      <div className="build-news-empty flex min-h-[100px] flex-1 items-center justify-center px-3 text-xs">
        No headlines available.
      </div>
    );
  }

  return (
    <div className={`build-news-glance flex min-h-0 flex-1 flex-col${isMobile ? " build-news-glance--mobile-duo" : ""}`}>
      <div className="build-news-header">
        <span className="build-news-header-label">News</span>
        {!isMobile ? (
          <span className="build-news-meta">
            {n.source} · {n.time}
          </span>
        ) : null}
      </div>

      <div className="build-news-articles">
        {mobileItems.map((item) => (
          <article key={item.id} className="build-news-article animate-news-fade" aria-live="polite">
            {isMobile ? (
              <span className="build-news-article-meta">
                {item.source} · {item.time}
              </span>
            ) : null}
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="build-news-title block hover:underline"
            >
              {item.title}
            </a>
          </article>
        ))}
      </div>

      <div className="build-news-dots" role="tablist" aria-label="News headlines">
        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => setIndex(i)}
            className={`build-news-dot ${i === index ? "build-news-dot--active" : ""}`}
            aria-label={`Show headline ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
}
