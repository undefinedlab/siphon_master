/**
 * Host comparison for the "is this request from our own site?" guards.
 *
 * Siphon is served at BOTH siphon.money and www.siphon.money — the apex 308-redirects to www.
 * A browser sitting on siphon.money keeps `Origin: https://siphon.money` across that redirect,
 * so an exact `origin.host !== host` compare rejected every /api/* call the dapp made from the
 * apex domain (403 origin_required) — prices, compliance-fee, and every eth_call through
 * /api/rpc, which surfaced as "could not decode result data (value=0x)" and a balance that
 * never loaded.
 *
 * Treat apex and www as the same site; everything else still has to match exactly.
 */

/** Lowercase, trim, and drop a leading `www.` label. Port (if present) is preserved. */
export function normalizeSiteHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

/** True when both hosts are the same site, ignoring only the apex/www distinction. */
export function isSameSiteHost(a: string, b: string): boolean {
  if (!a || !b) return false;
  return normalizeSiteHost(a) === normalizeSiteHost(b);
}

/**
 * Whether `Sec-Fetch-Site` proves this request came from our own pages.
 *
 * Origin and Referer are the wrong things to gate a GET on. Browsers omit `Origin` entirely on
 * same-origin GET/HEAD — it is only attached to non-GET requests and to CORS ones — and this app
 * serves `Referrer-Policy: no-referrer`, so it strips the other half too. A same-origin `fetch()`
 * of /api/price therefore arrives with NEITHER header, which read as "a scraper" and 403'd every
 * GET the dapp made while POSTs sailed through.
 *
 * `Sec-Fetch-Site` is the header actually meant for this. It is a forbidden header name, so page
 * scripts cannot set or forge it, which makes it a STRONGER signal than an Origin a curl can type:
 *   same-origin  exactly this origin          → ours
 *   same-site    apex ↔ www, any subdomain    → ours
 *   cross-site   another site                 → not ours
 *   none         typed URL, bookmark, no page → not a page request at all
 * Absent means a pre-2020 browser or a non-browser client; those fall back to the Origin/Referer
 * check so nothing that used to work stops working.
 */
export function secFetchSiteAllows(secFetchSite: string | null): boolean | null {
  switch ((secFetchSite || "").trim().toLowerCase()) {
    case "same-origin":
    case "same-site":
      return true;
    case "cross-site":
    case "none":
      return false;
    default:
      return null; // header absent — caller falls back to Origin/Referer
  }
}
