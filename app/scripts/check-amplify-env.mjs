#!/usr/bin/env node
/**
 * Amplify env parity check.
 *
 * GAPS Epic 1 says: "every env var actually referenced in code is confirmed present
 * (not just copied blind)". This is that check, mechanised.
 *
 * Run it in the Amplify build (or locally with the Amplify env exported) BEFORE the
 * DNS cutover. It scans src/ for every NEXT_PUBLIC_* reference and reports which are
 * missing from the environment.
 *
 * Why this matters more than usual here: several of these flags are FAIL-CLOSED
 * security switches (NEXT_PUBLIC_ASP_FAIL_CLOSED, NEXT_PUBLIC_ASP_ORACLE_FAIL_CLOSED,
 * NEXT_PUBLIC_HARD_ASP_SOFT_OVERRIDE, NEXT_PUBLIC_ALLOW_*). A missing value does not
 * throw — it silently picks a default, which may be the WRONG side of a security
 * decision. And NEXT_PUBLIC_* is build-inlined, so a wrong value ships into the
 * bundle and needs a rebuild, not a restart, to fix.
 *
 *   node scripts/check-amplify-env.mjs           # report only
 *   node scripts/check-amplify-env.mjs --strict  # exit 1 if any REQUIRED var missing
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/**
 * Vars that MUST be present for a correct production deploy.
 * Everything else is treated as optional/dev-only and merely reported.
 *
 * Keep this list honest: adding a var here makes the build fail without it, which is
 * the point for anything whose absence is a security or correctness regression.
 */
const REQUIRED = new Set([
  // Backing services
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  // Wallet connect — handoff §10.2: "must be set there or mobile breaks"
  "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
  // TEE measurement pin — must track the deployed decryptor (CLAUDE.md).
  // Waived when NEXT_PUBLIC_ALLOW_MOCK_TEE=true (Railway / Arbitrum mock-kms PoC).
  "NEXT_PUBLIC_DECRYPTOR_MEASUREMENT",
  // Error reporting. Unset is not a crash, it is SILENCE: Sentry.init() no-ops without a DSN, so
  // the build succeeds, the app runs, and the dashboard stays empty with nothing to indicate why.
  // The whole value of error tracking is that it works on the day something breaks, and the day
  // you notice it was never configured is that day.
  "NEXT_PUBLIC_SENTRY_DSN",
]);

if (process.env.NEXT_PUBLIC_ALLOW_MOCK_TEE === "true") {
  REQUIRED.delete("NEXT_PUBLIC_DECRYPTOR_MEASUREMENT");
}

// Deliberately NOT required, though it is tempting to add them:
//   NEXT_PUBLIC_ASP_FAIL_CLOSED, NEXT_PUBLIC_ASP_ORACLE_FAIL_CLOSED
//     Both default to "1" in sanctionsScreen.ts — i.e. unset already means BLOCK, the
//     strict side. They exist to LOOSEN behaviour, so demanding them would fail builds
//     over settings whose default is already correct.
//   NEXT_PUBLIC_DEFAULT_CHAIN_ID
//     Falls back to 8453 (Base mainnet) in code.

/**
 * Vars that MUST NOT be enabled in a production build. These are dev escapes; if any
 * is truthy in prod the build is wrong regardless of what else passes.
 */
const MUST_BE_OFF_IN_PROD = [
  "NEXT_PUBLIC_ALLOW_DEV_ZKEYS_ON_MAINNET",
  "NEXT_PUBLIC_ALLOW_PLAINTEXT_CLIENTKEY",
  "NEXT_PUBLIC_ALLOW_PLAINTEXT_NOTE_EXPORT",
  "NEXT_PUBLIC_HARD_ASP_SOFT_OVERRIDE",
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const referenced = new Set();
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
    // Filter the template-literal artefact `NEXT_PUBLIC_SUPABASE_` (a prefix, not a var).
    if (m[0].endsWith("_")) continue;
    referenced.add(m[0]);
  }
}

const missing = [...referenced].filter((v) => !process.env[v]).sort();
const missingRequired = missing.filter((v) => REQUIRED.has(v));
const missingOptional = missing.filter((v) => !REQUIRED.has(v));

const truthy = (v) => ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());
const dangerousOn = MUST_BE_OFF_IN_PROD.filter((v) => truthy(process.env[v]));

console.log(`Referenced NEXT_PUBLIC_* vars: ${referenced.size}`);
console.log(`Present: ${referenced.size - missing.length}   Missing: ${missing.length}`);

if (missingRequired.length) {
  console.log(`\n❌ MISSING REQUIRED (${missingRequired.length}):`);
  for (const v of missingRequired) console.log(`   - ${v}`);
}
if (missingOptional.length) {
  console.log(`\n⚠️  Missing optional/dev-only (${missingOptional.length}):`);
  for (const v of missingOptional) console.log(`   - ${v}`);
  console.log("   (fine if intentionally unset — confirm each is genuinely optional)");
}
if (dangerousOn.length) {
  console.log(`\n🚨 DEV ESCAPE ENABLED — must not ship to production:`);
  for (const v of dangerousOn) console.log(`   - ${v}=${process.env[v]}`);
}

/**
 * Server-side passthrough parity.
 *
 * Amplify withholds console env vars from the SSR runtime, so amplify.yml copies an
 * explicit allowlist into .env.production. A server var that is set in the console but
 * absent from that list is SILENTLY EMPTY in the Lambda — the console shows it set, the
 * code reads "". That is what made /api/compliance-fee answer asp_unconfigured while the
 * ASP was healthy, and later made OPENROUTER_MODEL fall back to the free model.
 *
 * A hand-maintained list cannot be trusted to stay in sync, so derive the answer instead.
 * We only flag a var that is BOTH read by src/ AND actually set in this build env — both
 * true means someone intended it to work, so a hit is a real misconfiguration, never noise.
 */
const NON_APP_ENV = new Set([
  "NODE_ENV", "NEXT_RUNTIME", "CI", "PORT", "PATH", "HOME", "HOSTNAME", "TZ", "LANG",
  "VERCEL", "VERCEL_ENV", "VERCEL_URL", "AWS_REGION", "AWS_APP_ID", "AWS_BRANCH",
]);

const serverRefs = new Set();
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");
  // Both `process.env.X` and the bare `env.X` / `env["X"]` form — rpcHttpGuard.ts takes
  // env as a parameter defaulting to process.env, so its reads never say "process.".
  for (const m of src.matchAll(/(?:process\.)?env(?:\.([A-Z][A-Z0-9_]{2,})|\[["']([A-Z][A-Z0-9_]{2,})["']\])/g)) {
    const name = m[1] || m[2];
    // NEXT_PUBLIC_* is swept wholesale by amplify.yml, so it is never at risk here.
    if (name.startsWith("NEXT_PUBLIC_") || NON_APP_ENV.has(name)) continue;
    serverRefs.add(name);
  }
}

let passthrough = null;
try {
  const yml = readFileSync(join(process.cwd(), "amplify.yml"), "utf8");
  // The `for v in A B C \ <newline> D E; do` loop that builds .env.production.server.
  const block = yml.match(/for v in ([\s\S]*?);\s*do/);
  if (block) passthrough = new Set(block[1].replace(/\\\s*\n/g, " ").trim().split(/\s+/));
} catch {
  /* running outside the repo root — skip rather than fail the build spuriously */
}

const notPassedThrough = passthrough
  ? [...serverRefs].filter((v) => process.env[v] && !passthrough.has(v)).sort()
  : [];

if (!passthrough) {
  console.log("\n⚠️  Could not parse the amplify.yml passthrough list — server-var parity unchecked.");
} else if (notPassedThrough.length) {
  console.log(`\n❌ SET IN THE ENVIRONMENT BUT NOT PASSED TO THE SSR RUNTIME (${notPassedThrough.length}):`);
  for (const v of notPassedThrough) console.log(`   - ${v}`);
  console.log("   These read as \"\" at runtime. Add each to the `for v in ...` list in amplify.yml.");
}

// Not a failure — it is on deliberately while the Phala CVMs are down — but it must never be
// forgotten: with it on, ANY executor reply of {mock_kms:true} skips the TDX quote + measurement pin.
// Turn it off as soon as every chain's decryptor is back in a real enclave.
if (process.env.NEXT_PUBLIC_ALLOW_MOCK_TEE === "true") {
  console.log(
    "\n⚠️  NEXT_PUBLIC_ALLOW_MOCK_TEE=true — decryptor attestation is NOT hardware-verified in this build " +
      "(mock TEE). Unset it once every chain's decryptor runs in a real CVM.",
  );
}

const strict = process.argv.includes("--strict");
if (strict && (missingRequired.length || dangerousOn.length || notPassedThrough.length)) {
  console.error("\nFAILED: required vars missing, dev escapes enabled, or server vars not passed through.");
  process.exit(1);
}
if (!missing.length && !dangerousOn.length && !notPassedThrough.length) {
  console.log("\n✅ All referenced vars present; no dev escapes; server vars reach the runtime.");
}
