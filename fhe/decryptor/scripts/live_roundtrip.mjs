#!/usr/bin/env node
// Live end-to-end verification of the DCAP sealed-ClientKey flow against a deployed decryptor.
// Mirrors siphon-app/src/lib/decryptorAttestation.ts step for step (keep the two in sync):
//   1. GET /attestation  → quote + event_log + x25519 pubkey
//   2. verify: Phala DCAP API (signature chain), report_data binding, RTMR3 replay,
//      compose-hash == EXPECTED_MEASUREMENT
//   3. crypto_box_seal the fixture ClientKey to the attested pubkey → POST /clientKey
//   4. POST /decrypt with encrypted 1 and 0 → expect triggered true / false
//
// Usage:
//   DECRYPTOR_URL=https://<app>-5002.<gw>.phala.network \
//   EXPECTED_MEASUREMENT=<compose-hash> \
//   node live_roundtrip.mjs <fixture.json produced by `cargo run --example roundtrip_fixture`>
//
// Run from a directory where libsodium-wrappers resolves (e.g. siphon-app).

import { readFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import _sodium from "libsodium-wrappers";

const DECRYPTOR_URL = process.env.DECRYPTOR_URL?.replace(/\/$/, "");
const EXPECTED_MEASUREMENT = (process.env.EXPECTED_MEASUREMENT || "").toLowerCase().replace(/^0x/, "");
const VERIFY_URL = process.env.QUOTE_VERIFY_URL || "https://cloud-api.phala.network/api/v1/attestations/verify";
const TEST_USER = process.env.TEST_USER || "0xdcaproundtriptest";

if (!DECRYPTOR_URL || !EXPECTED_MEASUREMENT) {
  console.error("set DECRYPTOR_URL and EXPECTED_MEASUREMENT");
  process.exit(2);
}

const hexToBytes = (h) => Uint8Array.from((h.replace(/^0x/, "").match(/.{2}/g) || []).map((b) => parseInt(b, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sha = async (alg, data) => new Uint8Array(await crypto.subtle.digest(alg, data));
const concat = (...ps) => {
  const out = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of ps) { out.set(p, o); o += p.length; }
  return out;
};

const QUOTE_HEADER_LEN = 48;
const RTMR3_OFFSET = QUOTE_HEADER_LEN + 472;
const REPORT_DATA_OFFSET = QUOTE_HEADER_LEN + 520;
const DSTACK_RUNTIME_EVENT_TYPE = 0x08000001;

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }
function ok(msg) { console.log(`  ok: ${msg}`); }

const fixture = JSON.parse(readFileSync(process.argv[2] || "fixture.json", "utf8"));

console.log("1. fetching attestation…");
const att = await (await fetch(`${DECRYPTOR_URL}/attestation`)).json();
if (!/^[0-9a-f]{64}$/.test(att.x25519_pubkey || "")) fail("missing x25519 pubkey");
if (!att.quote) fail(`no quote: ${att.error || "not in a CVM?"}`);
const quote = hexToBytes(att.quote);
ok(`pubkey ${att.x25519_pubkey.slice(0, 12)}…, quote ${quote.length} bytes`);

console.log("2a. quote signature chain (Phala DCAP verify API)…");
const vres = await fetch(VERIFY_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ hex: att.quote }),
});
const vjson = await vres.json().catch(() => null);
if (!vres.ok) fail(`verify API ${vres.status}: ${JSON.stringify(vjson)?.slice(0, 300)}`);
if (vjson?.quote?.verified !== true) fail(`quote.verified !== true: ${JSON.stringify(vjson)?.slice(0, 300)}`);
ok("signature chain verified to Intel roots");

console.log("2b. report_data binding…");
const expectRd = await sha("SHA-256", new TextEncoder().encode(`siphon-decryptor:${att.x25519_pubkey}`));
if (!eq(quote.slice(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 32), expectRd)) fail("report_data mismatch");
ok("report_data binds the sealing pubkey");

console.log("2c. RTMR3 replay + compose-hash pin…");
// dstack 0.5.9 returns empty digest fields — recompute from (event_type, event, payload),
// which binds each payload directly into the RTMR3 chain.
const events = JSON.parse(att.event_log);
const colon = new TextEncoder().encode(":");
const eventDigest = async (ev) => {
  if (ev.digest) return hexToBytes(ev.digest);
  const typeLe = new Uint8Array(4);
  new DataView(typeLe.buffer).setUint32(0, ev.event_type, true);
  return sha("SHA-384", concat(typeLe, colon, new TextEncoder().encode(ev.event), colon, hexToBytes(ev.event_payload)));
};
let mr = new Uint8Array(48);
for (const ev of events) {
  if (ev.imr !== 3) continue;
  let d = await eventDigest(ev);
  if (d.length < 48) d = concat(d, new Uint8Array(48 - d.length));
  mr = await sha("SHA-384", concat(mr, d));
}
if (!eq(mr, quote.slice(RTMR3_OFFSET, RTMR3_OFFSET + 48))) fail("event log does not replay to RTMR3");
const compose = events.find((e) => e.imr === 3 && e.event === "compose-hash");
if (!compose) fail("no compose-hash event");
if (compose.event_payload.toLowerCase().replace(/^0x/, "") !== EXPECTED_MEASUREMENT) {
  fail(`compose-hash ${compose.event_payload} != expected ${EXPECTED_MEASUREMENT}`);
}
ok(`RTMR3 replays; compose-hash == ${EXPECTED_MEASUREMENT.slice(0, 12)}…`);

console.log("3. sealing fixture ClientKey + upload…");
await _sodium.ready;
const sealed = _sodium.crypto_box_seal(hexToBytes(fixture.client_key_hex), hexToBytes(att.x25519_pubkey));
const up = await (await fetch(`${DECRYPTOR_URL}/clientKey`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ user_id: TEST_USER, client_key: bytesToHex(sealed) }),
})).json();
if (!up.ok) fail(`sealed upload rejected: ${up.error}`);
ok(`sealed upload accepted (${sealed.length} bytes)`);

console.log("4. decrypt round trip…");
for (const [name, hexCt, expect] of [["one", fixture.encrypted_one_hex, true], ["zero", fixture.encrypted_zero_hex, false]]) {
  const d = await (await fetch(`${DECRYPTOR_URL}/decrypt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: TEST_USER, encrypted_result: hexCt }),
  })).json();
  if (d.error) fail(`decrypt(${name}): ${d.error}`);
  if (d.triggered !== expect) fail(`decrypt(${name}) = ${d.triggered}, expected ${expect}`);
  ok(`decrypt(${name}) → ${d.triggered}`);
}

console.log("\nPASS: full DCAP sealed round trip verified live.");
