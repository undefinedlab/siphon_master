/**
 * Sentry — server runtime (Next route handlers / SSR).
 *
 * Server-side errors can carry env values and request bodies in scope, so the same redaction
 * rules apply. Note the server DSN is read from SENTRY_DSN (not NEXT_PUBLIC_*) so it is not
 * inlined into the client bundle.
 */
import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NEXT_PUBLIC_SIPHON_ENV || "development",
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    maxBreadcrumbs: 30,
    beforeSend(event) {
      // Request bodies on /api routes can carry enc_blob, tags, or proof witnesses.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.url) event.request.url = event.request.url.split("?")[0];
      }
      for (const ex of event.exception?.values ?? []) {
        for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;
      }
      return event;
    },
  });
}
