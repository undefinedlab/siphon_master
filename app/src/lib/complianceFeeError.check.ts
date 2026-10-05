// Runnable self-check: a failed compliance-fee request must not be reported as a missing vault.
//   npx tsx src/lib/complianceFeeError.check.ts
//
// TrustPanel read `vault` straight off the parsed body and, when it was absent, told the user
// "Compliance vault not configured — contact support". Every failure mode produces a body without
// `vault`, so a 503 (ASP_URL unset on this deployment), a 401 (expired wallet signature), a 429
// and an unreachable ASP all rendered as the same deployment diagnosis — handed to a user whose
// entitlement is typically already active and who can do nothing with it.
//
// This mirrors that decision so the mapping is testable without a browser or a wallet.
import assert from "node:assert";

type Body = { paid?: boolean; vault?: string; error?: string };

/** Mirrors TrustPanel.ensureComplianceFee — keep the branches in step. */
function decide(status: number, body: Body): string {
  const ok = status >= 200 && status < 300;
  if (!ok) {
    if (status === 401 || status === 403) return "reconnect";
    if (status === 429) return "rate_limited";
    if (body.error === "asp_unconfigured") return "unconfigured";
    return "unreachable";
  }
  if (body.paid) return "already_paid";
  if (!body.vault) return "no_vault_for_chain";
  return "pay";
}

function main() {
  // --- the failures that used to masquerade as a config problem ------------------------------
  assert.strictEqual(decide(401, {}), "reconnect", "an expired signature is not a missing vault");
  assert.strictEqual(decide(403, {}), "reconnect");
  assert.strictEqual(decide(429, {}), "rate_limited", "a rate limit is not a missing vault");
  assert.strictEqual(decide(500, {}), "unreachable");
  assert.strictEqual(decide(502, {}), "unreachable");
  assert.strictEqual(decide(503, { error: "asp_unreachable" }), "unreachable");

  // The ONE case the original message was right about: this deployment has no ASP_URL.
  assert.strictEqual(decide(503, { error: "asp_unconfigured" }), "unconfigured");

  // --- the success paths ----------------------------------------------------------------------
  // Live ASP answer for a wallet with an active entitlement — must short-circuit before any
  // vault check, or a paid user is asked to pay again.
  assert.strictEqual(
    decide(200, { paid: true, vault: "0x8fe01f5a6f9d62a846b91ce95814424f7cf5406d" }),
    "already_paid",
  );
  // paid:true with NO vault must still short-circuit; the vault is irrelevant once paid.
  assert.strictEqual(decide(200, { paid: true }), "already_paid");

  // A genuine 2xx with no vault for this chain is the only time we blame configuration.
  assert.strictEqual(decide(200, { paid: false }), "no_vault_for_chain");

  assert.strictEqual(
    decide(200, { paid: false, vault: "0x74f5f4c010bac584830538084a5cfe47e477a062" }),
    "pay",
  );

  console.log(
    "complianceFeeError.check: OK — 6 request failures no longer report a missing vault, " +
      "asp_unconfigured still does, and a paid wallet short-circuits before the vault check",
  );
}

main();
