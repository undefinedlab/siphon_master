// Runnable self-check for Sentry redaction — no test framework in this repo.
//   npx tsx src/lib/sentryRedaction.check.ts
//
// The Sentry client config claims it strips note secrets before events leave the browser.
// That claim is the only thing making an external error reporter acceptable in an app that
// holds spendable material in memory, so it gets tested rather than trusted.
//
// A leaked (nullifier, secret) pair is spendable funds. If this file fails, Sentry must not ship.
import assert from "node:assert";

// Mirrors of the patterns in sentry.client.config.ts. Kept in sync deliberately: importing the
// config would call Sentry.init() as a side effect.
const SECRET_KEY_PATTERN =
  /(nullifier|secret|salt|privkey|private_?key|mnemonic|seed|enc_?blob|clientkey|serverkey|jwt|token|password|dsn|anon_?key)/i;
const LONG_OPAQUE = /\b(0x)?[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+/=_-]{60,}\b/g;

const scrubString = (s: string) => s.replace(LONG_OPAQUE, "[redacted]");

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

const j = (v: unknown) => JSON.stringify(v);

// ---- secret-shaped keys are dropped regardless of value -------------------------------------
{
  const note = {
    nullifier: "12345678901234567890",
    secret: "98765432109876543210",
    label: "555",
    amount: "1000",
    userSalt: "4242",
  };
  const out = scrub(note) as Record<string, unknown>;
  assert.equal(out.nullifier, "[redacted]", "nullifier must be redacted");
  assert.equal(out.secret, "[redacted]", "secret must be redacted");
  assert.equal(out.userSalt, "[redacted]", "userSalt must be redacted (matches /salt/)");
  // Non-secret fields survive, or the reports are useless.
  assert.equal(out.amount, "1000", "amount should survive");
  assert.equal(out.label, "555", "short label should survive");
}

// ---- long opaque values are redacted even under an innocent key -----------------------------
{
  const commitment = "0x" + "a".repeat(64);
  const encBlob = "A".repeat(120);
  const out = scrub({ commitment, payload: encBlob, note: "ok" }) as Record<string, string>;
  assert.equal(out.commitment, "[redacted]", "long hex must be redacted");
  assert.equal(out.payload, "[redacted]", "long base64 must be redacted");
  assert.equal(out.note, "ok", "short strings survive");
}

// ---- nested structures are walked -----------------------------------------------------------
{
  const nested = { a: { b: { c: { nullifier: "123", ok: "keep" } } } };
  const out = j(scrub(nested));
  assert.ok(!out.includes('"nullifier":"123"'), "nested secret leaked");
  assert.ok(out.includes("keep"), "nested safe value dropped");
}

// ---- arrays of notes ------------------------------------------------------------------------
{
  const notes = [
    { nullifier: "111", amount: "5" },
    { nullifier: "222", amount: "7" },
  ];
  const out = j(scrub(notes));
  assert.ok(!out.includes("111") && !out.includes("222"), "array secrets leaked");
  assert.ok(out.includes('"amount":"5"'), "array safe values dropped");
}

// ---- cycles / deep nesting must not hang or throw --------------------------------------------
{
  type Cyc = { self?: Cyc; nullifier: string };
  const cyc: Cyc = { nullifier: "999" };
  cyc.self = cyc;
  const out = j(scrub(cyc));
  assert.ok(!out.includes("999"), "cyclic secret leaked");
  assert.ok(out.includes("depth-capped"), "depth cap should engage on a cycle");
}

// ---- error message scrubbing -----------------------------------------------------------------
{
  const msg = `failed to spend note 0x${"b".repeat(64)} for tag 0x${"c".repeat(40)}`;
  const out = scrubString(msg);
  assert.ok(!out.includes("b".repeat(64)), "commitment in message leaked");
  assert.ok(out.includes("failed to spend note"), "message text should survive");
}

// ---- the DSN itself must never be echoed back -------------------------------------------------
{
  const out = scrub({ dsn: "https://key@o1.ingest.sentry.io/1" }) as Record<string, string>;
  assert.equal(out.dsn, "[redacted]", "dsn key must be redacted");
}

console.log("sentryRedaction.check: OK — secrets redacted, safe fields preserved");
