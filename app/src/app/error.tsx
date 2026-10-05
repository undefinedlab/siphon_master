"use client";

/**
 * Route-level error boundary.
 *
 * Pairs with global-error.tsx, and this is the one that fires in practice. React walks up to the
 * NEAREST boundary, so a component crashing inside /dapp lands here and the root layout survives —
 * the user keeps the app shell instead of being dropped onto a bare replacement page.
 * global-error.tsx only takes over when the root layout itself is what failed.
 *
 * Both report to Sentry. Without a boundary React errors reach neither `window.onerror` nor the
 * unhandled-rejection hook, so they are invisible to the SDK no matter how it is configured.
 *
 * Same rule as global-error: never render `error.message`. A thrown message in this app can carry
 * a commitment, tag or note field, and putting it on screen leaks it to onlookers and into any
 * screenshot a user sends us. sentry.client.config.ts governs what reaches Sentry; this governs
 * what reaches the screen.
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        fontFamily:
          "var(--font-source-code), ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      <div style={{ maxWidth: 520, lineHeight: 1.6 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: "0 0 12px" }}>
          This section failed to load
        </h2>
        <p style={{ fontSize: 14, opacity: 0.75, margin: "0 0 20px" }}>
          Something went wrong rendering this view. The problem has been reported.
        </p>

        {/* A crash during a deposit or withdrawal flow reads as "my money is gone". It is not:
            note secrets live in browser storage and on-chain, not in this component tree. Saying
            so prevents the panic retry that turns a display bug into a duplicated transaction. */}
        <p style={{ fontSize: 13, opacity: 0.6, margin: "0 0 20px" }}>
          Your funds and notes are unaffected.
        </p>

        <button
          onClick={() => reset()}
          style={{
            fontFamily: "inherit",
            fontSize: 14,
            padding: "10px 18px",
            cursor: "pointer",
            background: "transparent",
            color: "inherit",
            border: "1px solid #333",
            borderRadius: 6,
          }}
        >
          Try again
        </button>

        {error.digest && (
          <p style={{ fontSize: 12, opacity: 0.4, marginTop: 20 }}>
            Reference: {error.digest}
          </p>
        )}
      </div>
    </main>
  );
}
