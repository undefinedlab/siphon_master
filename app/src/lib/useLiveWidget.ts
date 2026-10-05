"use client";

import { useEffect, useState } from "react";

function getBase(): string {
  return (
    process.env.NEXT_PUBLIC_ASI_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_ASI_API?.trim() ||
    ""
  );
}

export function useLiveWidget<T>(kind: string, fallback: T, pollMs = 0): T {
  const [data, setData] = useState<T>(fallback);

  useEffect(() => {
    const base = getBase();
    if (!base) return;
    let cancelled = false;

    function doFetch() {
      fetch(`${base}/v1/widget/${kind}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((json: T) => {
          if (!cancelled) setData(json);
        })
        .catch(() => {
          /* keep fallback */
        });
    }

    doFetch();
    const timer = pollMs > 0 ? window.setInterval(doFetch, pollMs) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [kind, pollMs]);

  return data;
}
