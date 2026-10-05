"use client";

/**
 * Sentry verification page — dev/preview only.
 *
 * Exists because "the SDK is installed" and "errors actually arrive" are different claims, and
 * the gap between them is silent: a missing client hook, a CSP block, or an unset DSN all look
 * identical from the app (nothing happens, no console error worth noticing).
 *
 * The second button matters more than the first: it throws an error whose message and context
 * are stuffed with note-secret-shaped values, so you can confirm in the Sentry UI that the
 * redaction in sentry.client.config.ts actually strips them before the event leaves the browser.
 * A reporter that ships nullifiers is worse than no reporter.
 *
 * Delete this route, or gate it behind a non-production check, before it ships anywhere public.
 */
import * as Sentry from "@sentry/nextjs";
import { notFound } from "next/navigation";
import { useState } from "react";

export default function SentryCheckPage() {
  // Debug route: throws errors on demand and ships fake note-secret payloads to Sentry.
  // Harmless, but it has no business being reachable in production — 404 it there. Keyed on the
  // build, not NEXT_PUBLIC_SIPHON_ENV: prod never set that, so the page was live on siphon.money.
  // NEXT_PUBLIC_SIPHON_DEBUG=1 (same switch as the console hooks) keeps it on a debug build.
  if (process.env.NODE_ENV === "production" && (process.env.NEXT_PUBLIC_SIPHON_DEBUG || "").trim() !== "1") notFound();

  const [note, setNote] = useState<string>("");
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 720, lineHeight: 1.6 }}>
      <h1>Sentry check</h1>

      <p>
        DSN configured:{" "}
        <strong style={{ color: dsn ? "#16a34a" : "#dc2626" }}>
          {dsn ? "yes" : "no — Sentry is a no-op without NEXT_PUBLIC_SENTRY_DSN"}
        </strong>
      </p>
      {dsn && (
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          ingest host: {(() => { try { return new URL(dsn).origin; } catch { return "unparseable"; } })()}
        </p>
      )}

      <hr style={{ margin: "24px 0" }} />

      <p>
        <button
          style={{ padding: "10px 16px", fontSize: 15, cursor: "pointer" }}
          onClick={() => {
            setNote("thrown — check Sentry Issues");
            throw new Error("Siphon Sentry check: plain client error");
          }}
        >
          1 · Throw a plain error
        </button>
      </p>

      <p>
        <button
          style={{ padding: "10px 16px", fontSize: 15, cursor: "pointer" }}
          onClick={() => {
            setNote("captured with secret-shaped payload — verify redaction in the Sentry UI");
            const err = new Error(
              // Long hex should be redacted by the LONG_OPAQUE pattern.
              `Siphon redaction check: commitment 0x${"a".repeat(64)} for tag 0x${"b".repeat(40)}`,
            );
            // Use captureException with an explicit `extra`. Setting `err.extra = {...}` does
            // NOT work — Sentry ignores arbitrary properties on Error instances, so the payload
            // never reaches event.extra and the key-based redaction path goes untested while
            // appearing to pass. (That is exactly what happened on the first attempt.)
            Sentry.captureException(err, {
              extra: {
                // Secret-shaped KEYS — must be redacted by SECRET_KEY_PATTERN.
                nullifier: "11111111111111111111",
                secret: "22222222222222222222",
                userSalt: "4242",
                // Safe fields — must SURVIVE, or reports are useless.
                amount: "1000",
                label: "555",
              },
            });
          }}
        >
          2 · Throw an error carrying fake note secrets
        </button>
      </p>

      {note && <p style={{ marginTop: 20, fontStyle: "italic" }}>{note}</p>}

      <hr style={{ margin: "24px 0" }} />

      <p style={{ fontSize: 14, opacity: 0.8 }}>
        In the Sentry issue for button 2, confirm: <code>nullifier</code>, <code>secret</code> and{" "}
        <code>userSalt</code> read <code>[redacted]</code>; the long hex in the message is{" "}
        <code>[redacted]</code>; and <code>amount</code>/<code>label</code> are still visible.
        If a raw nullifier appears, stop and fix the redaction before deploying.
      </p>
      <p style={{ fontSize: 14, opacity: 0.8 }}>
        Nothing arriving at all? Check the browser console for a CSP violation naming the ingest
        host — that is the most likely cause.
      </p>
    </main>
  );
}
