"use client";

/**
 * Root error boundary — the last line before a blank page.
 *
 * WHY THIS FILE EXISTS
 * Sentry's browser SDK hooks `window.onerror` and unhandled promise rejections, but React
 * *render* errors never reach either: React catches them itself and hands them to the nearest
 * error boundary. With no boundary, Next renders its own fallback and the exception is swallowed.
 *
 * So the SDK can be correctly installed, the DSN correctly set, and a component crashing mid-render
 * still produces nothing in Sentry — which is exactly what we were seeing: an empty dashboard apart
 * from deliberately thrown test errors. Component crashes are one of the most common frontend
 * failures and were the entire blind spot.
 *
 * `global-error.tsx` replaces the root layout when it fires, so it must render its own <html> and
 * <body>. It only catches errors in the App Router tree; errors inside the root layout itself are
 * not recoverable by React at all.
 *
 * WHAT IT MUST NOT DO
 * Never render `error.message`. This app holds spendable material, and a thrown message can easily
 * carry a commitment, tag, or note field — putting it on screen leaks it to anyone looking at the
 * user's display, and into any screenshot they send us. `beforeSend` in sentry.client.config.ts
 * redacts what goes TO Sentry; this file governs what goes on the SCREEN, and the two are separate
 * problems. The digest is safe to show: it is a server-generated hash, and it is what lets us match
 * a user's report to the captured event.
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The whole point of this file. Without this call the boundary would render a nice fallback
    // and still report nothing.
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#ededed",
          fontFamily:
            "var(--font-source-code), ui-monospace, SFMono-Regular, Menlo, monospace",
          padding: "24px",
        }}
      >
        <main style={{ maxWidth: 520, lineHeight: 1.6 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 12px" }}>
            Something broke
          </h1>
          <p style={{ fontSize: 14, opacity: 0.75, margin: "0 0 20px" }}>
            This page hit an unexpected error and stopped. The problem has been reported.
          </p>

          {/* Funds reassurance, not decoration: a crash mid-flow makes people think a deposit or
              withdrawal was lost. Notes live in the browser and on-chain, not in this component
              tree, so a render crash cannot lose them. Saying so prevents panic actions like
              re-submitting a withdrawal that already landed. */}
          <p style={{ fontSize: 13, opacity: 0.6, margin: "0 0 20px" }}>
            Your funds and notes are unaffected — nothing about them lives in this page.
          </p>

          <button
            onClick={() => reset()}
            style={{
              fontFamily: "inherit",
              fontSize: 14,
              padding: "10px 18px",
              cursor: "pointer",
              background: "transparent",
              color: "#ededed",
              border: "1px solid #333",
              borderRadius: 6,
            }}
          >
            Try again
          </button>

          {/* Never error.message — see the header comment. The digest carries no user data and is
              the handle for matching this crash to its Sentry event. */}
          {error.digest && (
            <p style={{ fontSize: 12, opacity: 0.4, marginTop: 20 }}>
              Reference: {error.digest}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
