/**
 * Sentry — browser runtime (GAPS Epic 3).
 *
 * PRIVACY IS THE CONSTRAINT HERE, NOT COVERAGE.
 *
 * This app holds note secrets (nullifier, secret, label), wallet-derived encryption keys, and
 * user salts in browser memory. An error reporter that ships breadcrumbs, request bodies, or
 * local variables off-device is a note-secret exfiltration channel wearing a monitoring badge.
 * A leaked `nullifier`+`secret` pair is spendable funds.
 *
 * So this config is deliberately narrow:
 *   - `sendDefaultPii: false`  — no IPs, no cookies, no user identifiers
 *   - Session Replay is NOT enabled — it records DOM, which renders balances and addresses
 *   - `beforeSend` redacts anything that pattern-matches a secret before the event leaves
 *   - breadcrumbs from fetch/xhr carry URLs only, never bodies
 *
 * If you are tempted to raise the sample rates or turn on Replay to debug something: don't.
 * Reproduce locally instead. The blast radius of getting this wrong is user funds.
 */
import * as Sentry from "@sentry/nextjs";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

// Only initialise when a DSN is configured. No DSN => Sentry is a no-op, which is the
// correct default for local dev and for any environment that has not opted in.
if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NEXT_PUBLIC_SIPHON_ENV || "development",

    // Route events through our own origin instead of *.ingest.sentry.io, which ad blockers
    // block outright (ERR_BLOCKED_BY_CLIENT — observed locally with uBlock). Without this a
    // meaningful, unknowable share of browser errors never arrive, and a quiet dashboard
    // cannot be read as "no errors". See src/app/api/monitoring/route.ts.
    tunnel: "/api/monitoring",

    // Performance: sample lightly. This is an error tracker, not an APM.
    tracesSampleRate: 0.1,

    // Session Replay records the DOM. This app renders balances, note counts and addresses.
    // Leave both at zero.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // No IP addresses, cookies, or user identifiers.
    sendDefaultPii: false,

    // Keep the breadcrumb trail short — fewer chances to capture something sensitive.
    maxBreadcrumbs: 30,

    beforeBreadcrumb(crumb) {
      // fetch/xhr breadcrumbs can carry request bodies. Keep the URL, drop the payload.
      if (crumb.category === "fetch" || crumb.category === "xhr") {
        if (crumb.data) {
          delete (crumb.data as Record<string, unknown>).body;
          delete (crumb.data as Record<string, unknown>).input;
        }
      }
      // Console breadcrumbs replay whatever was logged, including anything a debug
      // statement printed. Not worth the risk.
      if (crumb.category === "console") return null;
      return crumb;
    },

    beforeSend(event) {
      return redactEvent(event);
    },
  });
}

/** Keys whose values must never leave the device, matched case-insensitively as substrings. */
const SECRET_KEY_PATTERN =
  /(nullifier|secret|salt|privkey|private_?key|mnemonic|seed|enc_?blob|clientkey|serverkey|jwt|token|password|dsn|anon_?key)/i;

/** Long hex/base64 runs — a raw field element or ciphertext blob that slipped into a string. */
const LONG_OPAQUE = /\b(0x)?[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+/=_-]{60,}\b/g;

function scrubString(s: string): string {
  return s.replace(LONG_OPAQUE, "[redacted]");
}

/** Recursively redact secret-shaped keys and long opaque values. Depth-capped. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-capped]";
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function redactEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (event.message) event.message = scrubString(event.message);

  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubString(ex.value);
    // Local variables in stack frames are the highest-risk surface: a frame inside
    // note-crypto would carry the nullifier and secret as locals. Drop them entirely.
    for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;
  }

  if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>;
  if (event.contexts) event.contexts = scrub(event.contexts) as typeof event.contexts;
  if (event.request?.data) event.request.data = scrub(event.request.data);

  // Query strings can carry tags/addresses; keep the path, drop the query.
  if (event.request?.url) event.request.url = event.request.url.split("?")[0];

  return event;
}
