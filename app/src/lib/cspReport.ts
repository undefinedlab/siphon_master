/**
 * Pure helpers for CSP Report-Only collection — kept free of Next.js so bun tests can
 * assert exactly what we log for legacy vs Reporting-API payloads.
 */

export type CspViolationSummary = {
  type?: string;
  document?: unknown;
  violated?: unknown;
  effective?: unknown;
  blocked?: unknown;
  source?: unknown;
  line?: unknown;
  disposition?: unknown;
  rawKeys?: string[];
};

/**
 * Normalize browser CSP report bodies into compact summaries we log.
 * Supports:
 *  - Legacy: `{ "csp-report": { ... } }`  (Content-Type: application/csp-report)
 *  - Reporting API: `[{ type, url, body: { ... } }]` (application/reports+json)
 */
export function summarizeCspPayload(payload: unknown): CspViolationSummary[] {
  const summaries: CspViolationSummary[] = [];

  if (payload && typeof payload === "object" && !Array.isArray(payload) && "csp-report" in payload) {
    const r = (payload as { "csp-report"?: Record<string, unknown> })["csp-report"] ?? {};
    summaries.push({
      document: r["document-uri"] ?? r["documentURI"],
      violated: r["violated-directive"] ?? r["violatedDirective"],
      effective: r["effective-directive"] ?? r["effectiveDirective"],
      blocked: r["blocked-uri"] ?? r["blockedURI"],
      source: r["source-file"] ?? r["sourceFile"],
      line: r["line-number"] ?? r["lineNumber"],
      disposition: r["disposition"],
    });
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const row = item as {
        type?: string;
        url?: string;
        body?: Record<string, unknown>;
      };
      const body = row.body ?? {};
      summaries.push({
        type: row.type,
        document: row.url ?? body["documentURL"],
        violated: body["effectiveDirective"] ?? body["violatedDirective"],
        blocked: body["blockedURL"],
        source: body["sourceFile"],
        line: body["lineNumber"],
        disposition: body["disposition"],
      });
    }
  }

  if (summaries.length === 0 && payload && typeof payload === "object") {
    summaries.push({ rawKeys: Object.keys(payload as object).slice(0, 12) });
  }

  return summaries;
}

/** Process-local rate limit for the report endpoint. */
export function createCspReportRateLimit(opts?: {
  windowMs?: number;
  maxPerWindow?: number;
  now?: () => number;
}) {
  const windowMs = opts?.windowMs ?? 60_000;
  const maxPerWindow = opts?.maxPerWindow ?? 120;
  const now = opts?.now ?? Date.now;
  let windowStart = now();
  let windowCount = 0;

  return {
    allow(): boolean {
      const t = now();
      if (t - windowStart > windowMs) {
        windowStart = t;
        windowCount = 0;
      }
      windowCount += 1;
      return windowCount <= maxPerWindow;
    },
    /** Test helper */
    reset() {
      windowStart = now();
      windowCount = 0;
    },
    get count() {
      return windowCount;
    },
  };
}
