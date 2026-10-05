import { NextRequest, NextResponse } from "next/server";
import { gateOutboundProxy } from "@/lib/outboundProxyGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sentry tunnel.
 *
 * WHY: ad blockers (uBlock, Brave shields, most tracker lists) block requests to
 * *.ingest.sentry.io outright — the browser console shows ERR_BLOCKED_BY_CLIENT and the event
 * is simply lost. That is not a small slice of users. Without this, Sentry's error count is a
 * lower bound of unknown size, and a quiet dashboard cannot be read as "no errors".
 *
 * The browser POSTs envelopes to this same-origin path instead; the server forwards them to
 * Sentry. Same-origin requests are not on blocklists.
 *
 * SECURITY: this is an unauthenticated endpoint that makes an outbound request, so it is an
 * SSRF risk if written naively. Three guards:
 *   1. The destination host is pinned to the host in our own DSN — never taken from the request.
 *   2. The project id in the envelope header must match our DSN's project id, so the endpoint
 *      cannot be used to relay traffic into someone else's Sentry project.
 *   3. Body size is capped; oversized or malformed envelopes are dropped.
 *
 * PRIVACY: redaction still happens client-side in sentry.client.config.ts BEFORE the envelope
 * is built. This route forwards opaque bytes and deliberately does not parse or log them.
 */

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";

/** Parse the DSN once at module load. Invalid/absent DSN disables the tunnel entirely. */
const parsed = (() => {
  if (!DSN) return null;
  try {
    const u = new URL(DSN);
    const projectId = u.pathname.replace(/^\//, "");
    if (!projectId || !/^\d+$/.test(projectId)) return null;
    return { host: u.host, projectId };
  } catch {
    return null;
  }
})();

/** Envelopes are small. Anything larger is not a legitimate Sentry payload. */
const MAX_BODY_BYTES = 1_000_000;

export async function POST(request: NextRequest) {
  const limited = gateOutboundProxy(
    request,
    "monitoring",
    Number(process.env.MONITORING_RATE_MAX || "120"),
  );
  if (limited) return limited;

  // No DSN configured => Sentry is off. Accept and drop so the client never errors.
  if (!parsed) return new NextResponse(null, { status: 204 });

  let body: string;
  try {
    body = await request.text();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  if (!body || body.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 204 });
  }

  // Envelope format: the first line is a JSON header carrying the target DSN.
  // Verify it points at OUR project before forwarding anything.
  const headerLine = body.slice(0, body.indexOf("\n"));
  let envelopeProjectId: string | null = null;
  try {
    const header = JSON.parse(headerLine) as { dsn?: string };
    if (!header.dsn) return new NextResponse(null, { status: 204 });
    const u = new URL(header.dsn);
    if (u.host !== parsed.host) return new NextResponse(null, { status: 204 });
    envelopeProjectId = u.pathname.replace(/^\//, "");
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  if (envelopeProjectId !== parsed.projectId) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    await fetch(`https://${parsed.host}/api/${parsed.projectId}/envelope/`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-sentry-envelope" },
      // Never let a slow Sentry hold a server connection open.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Losing an error report must never surface as an error to the user.
  }

  return new NextResponse(null, { status: 204 });
}
