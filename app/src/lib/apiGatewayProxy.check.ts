// Runnable self-check for /api/gateway — the security properties, not the happy path.
//   npx tsx src/lib/apiGatewayProxy.check.ts
//
// Hits the local dev server. Skips (exit 0) when it is not running, so this never fails CI on a
// missing server — only on a logic regression.
//
// This route was disabled outright in 08ae6c0 for forwarding arbitrary paths plus the caller's
// Authorization header to an internal service. Re-opening it is only safe while all four of the
// properties below hold, and each of them is one edit away from silently going missing: widening
// ALLOWED, adding a verb, dropping the same-origin call, or re-adding 'authorization' to FORWARD.
// None of those would fail a type-check or show up in the UI — the panel would keep working.
import assert from "node:assert";
import { API_KEYS_COMING_SOON } from "./apiKeysFlag";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:3000";
// Middleware blocks non-browser user agents before the route ever runs (x-crawler-block).
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const sameOrigin = { "User-Agent": UA, "Sec-Fetch-Site": "same-origin" };

async function hit(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}/api/gateway/${path}`, {
    ...init,
    headers: { ...sameOrigin, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
}

async function main() {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(3_000) });
  } catch {
    console.log("apiGatewayProxy.check: SKIPPED — dev server not running");
    return;
  }

  // 0. While the surface is feature-locked, NOTHING reaches the upstream gateway — not even an
  //    allowlisted read. The properties below describe an open proxy and simply do not apply yet;
  //    asserting them against a locked route would fail, and deleting them would lose the only
  //    thing guarding the re-open. So the check follows the flag.
  if (API_KEYS_COMING_SOON) {
    for (const p of ["v1/keys/packs", "v1/keys", "v1/keys/purchase"]) {
      const res = await hit(p);
      assert.strictEqual(
        res.status,
        503,
        `${p} returned ${res.status} while paid API keys are locked — the money paths must stay shut`,
      );
    }
    // The money path stays shut for POST too, not just for the GETs the UI happens to use.
    const buy = await hit("v1/keys/purchase", { method: "POST", body: "{}" });
    assert.strictEqual(buy.status, 503, `POST purchase returned ${buy.status} while locked`);
    // Free Devnet claim is the intentional exception — must not get the paid-surface 503.
    const dn = await hit("v1/keys/devnet", { method: "POST", body: "{}" });
    const dnBody = (await dn.json().catch(() => ({}))) as { error?: string };
    assert.notStrictEqual(
      dnBody.error,
      "not_yet_available",
      "POST v1/keys/devnet must stay open while paid keys are locked",
    );
    console.log("apiGatewayProxy.check: OK — paid keys locked; Devnet claim path open");
    return;
  }

  // 1. An allowlisted path+method reaches the gateway. Anything but 404/403 proves the route is
  //    live; the body shape is the gateway's contract, asserted where it is consumed.
  const packs = await hit("v1/keys/packs");
  assert.ok(
    packs.status !== 404 && packs.status !== 403,
    `allowlisted path was rejected (${packs.status}) — ALLOWED or the origin gate regressed`,
  );

  // 2. Every path NOT on the allowlist is 404, including traversal-shaped ones. The catch-all
  //    segment still matches everything, so the allowlist is the only thing limiting reach —
  //    a wildcard here would expose the gateway's admin surface to any browser.
  for (const p of ["v1/admin", "v1/usage", "v1/keys/packs/../../admin", "", "v1"]) {
    const res = await hit(p);
    assert.strictEqual(res.status, 404, `${p || "(root)"} should be 404, got ${res.status}`);
  }

  // 3. A method not allowed for an allowlisted path is refused, and refused as 404 rather than
  //    405 — a 405 confirms the path exists, which is free reconnaissance.
  const wrongVerb = await hit("v1/keys/packs", { method: "POST" });
  assert.strictEqual(wrongVerb.status, 404, `POST to a GET-only path got ${wrongVerb.status}`);

  // 4. Cross-site callers are refused outright, so this is not an open relay to the gateway.
  const crossSite = await fetch(`${BASE}/api/gateway/v1/keys/packs`, {
    headers: { "User-Agent": UA, "Sec-Fetch-Site": "cross-site" },
    signal: AbortSignal.timeout(20_000),
  });
  assert.strictEqual(crossSite.status, 403, `cross-site got ${crossSite.status}, expected 403`);

  console.log("apiGatewayProxy.check: OK — allowlist, method gate and origin gate all hold");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
