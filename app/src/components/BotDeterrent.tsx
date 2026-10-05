"use client";

import { useEffect } from "react";

/**
 * Client-side friction for drive-by scraping (copy/paste into AI tools).
 * Server headers and middleware remain the primary control; this is a backstop.
 */
export default function BotDeterrent() {
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest("[data-sensitive]")) return;
      event.preventDefault();
    };

    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  return null;
}
