/**
 * DCAP attestation verification + ClientKey sealing for the confidential-vm decryptor.
 *
 * Closes the §6.2 gap (see siphon-fhe/docs/DCAP_ATTESTATION_PLAN.md): before releasing the
 * FHE ClientKey, the browser proves it is talking to the genuine decryptor enclave:
 *
 *   1. signature chain — the TDX quote is checked against Intel's roots via a DCAP verifier
 *      (Phala's hosted verification API; swappable for an in-browser WASM QVL later),
 *   2. identity binding — quote.report_data == sha256("siphon-decryptor:" + x25519_pubkey),
 *      so the pubkey we seal to lives inside the attested enclave,
 *   3. measurement pin — the event log replays to the quote's RTMR3 and its compose-hash
 *      event equals NEXT_PUBLIC_DECRYPTOR_MEASUREMENT (the dstack compose-hash of the
 *      exact app version we deployed).
 *
 * Only then is the ClientKey sealed (libsodium crypto_box_seal → the decryptor's
 * crypto_box::SecretKey::unseal) so neither the executor proxy nor the Phala host ever
 * see it in plaintext.
 */


import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";

export interface DecryptorAttestation {
  x25519_pubkey: string;
  report_data_hex: string;
  report_data_preimage?: string;
  /** hex TDX quote, or null when the decryptor runs outside a CVM (local dev). */
  quote: string | null;
  /** JSON string: array of dstack event-log entries. */
  event_log?: string;
  error?: string;
  /** True when the decryptor is a MOCK-KMS build (keys from a seed on a normal host, no TDX). */
  mock_kms?: boolean;
}

interface DstackEvent {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}

/**
 * MOCK TEE: accept a decryptor that reports `mock_kms` and has no TDX quote. That decryptor runs on
 * an ordinary host, so sealing to it protects the ClientKey in transit only — whoever runs the host
 * can read it. Off unless explicitly enabled; a real quote is still fully verified when present.
 */
export function isMockTeeAllowed(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_MOCK_TEE === "true";
}

/** Sealed upload is enabled iff a measurement is pinned (staged rollout switch) or the mock is allowed. */
export function isSealedUploadEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_DECRYPTOR_MEASUREMENT) || isMockTeeAllowed();
}

// Phala's API has no CORS headers, so the browser goes through our same-origin proxy route
// (app/api/verify-quote) — it forwards to the real verifier server-side.
const QUOTE_VERIFY_URL = process.env.NEXT_PUBLIC_QUOTE_VERIFY_URL || "/api/verify-quote";

// TDX quote v4 layout: 48-byte header, then the TD report body. Offsets within the body:
// rtmr3 at 472, report_data at 520 (each rtmr is 48 bytes, report_data 64).
const QUOTE_HEADER_LEN = 48;
const RTMR3_OFFSET = QUOTE_HEADER_LEN + 472;
const REPORT_DATA_OFFSET = QUOTE_HEADER_LEN + 520;

// dstack runtime events: digest = sha384(event_type_le || ":" || event || ":" || payload).
const DSTACK_RUNTIME_EVENT_TYPE = 0x08000001;

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

async function sha384(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-384", data as BufferSource));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function fetchDecryptorAttestation(
  base: string = getTradeExecutorBaseUrl(),
): Promise<DecryptorAttestation> {
  const res = await fetch(`${base}/decryptorAttestation`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error || `decryptor attestation unavailable (${res.status})`);
  }
  return json as DecryptorAttestation;
}

/** 1. Quote signature chain → Intel roots, via the DCAP verification API (fail closed). */
async function verifyQuoteSignature(quoteHex: string): Promise<void> {
  const res = await fetch(QUOTE_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hex: quoteHex }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`quote verification API rejected the quote (${res.status}): ${JSON.stringify(json)?.slice(0, 200)}`);
  }
  if (json?.quote?.verified !== true) {
    throw new Error("quote signature chain NOT verified — refusing to release the client key");
  }
}

/** 2. report_data binds the sealing pubkey to the attested enclave. */
async function verifyReportDataBinding(quote: Uint8Array, pubkeyHex: string): Promise<void> {
  const expected = await sha256(new TextEncoder().encode(`siphon-decryptor:${pubkeyHex}`));
  const reportData = quote.slice(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 32);
  if (!bytesEqual(reportData, expected)) {
    throw new Error("quote report_data does not bind the enclave x25519 pubkey");
  }
}

/** 3. Event log replays to the quote's RTMR3, and its compose-hash equals the pinned measurement. */
async function verifyMeasurementPin(quote: Uint8Array, eventLogJson: string): Promise<void> {
  const pinned = (process.env.NEXT_PUBLIC_DECRYPTOR_MEASUREMENT || "").toLowerCase().replace(/^0x/, "");
  if (!pinned) throw new Error("NEXT_PUBLIC_DECRYPTOR_MEASUREMENT not set");

  let events: DstackEvent[];
  try {
    events = JSON.parse(eventLogJson);
  } catch {
    throw new Error("attestation event_log is not valid JSON");
  }

  // Each dstack runtime event's digest is sha384(event_type_le || ":" || event || ":" || payload).
  // dstack 0.5.9 returns event logs with EMPTY digest fields — verifiers recompute them, which
  // directly binds each payload into the RTMR3 chain (a lying log can't claim a fake payload).
  const eventDigest = async (ev: DstackEvent): Promise<Uint8Array> => {
    const typeLe = new Uint8Array(4);
    new DataView(typeLe.buffer).setUint32(0, ev.event_type, true);
    const colon = new TextEncoder().encode(":");
    const computed = await sha384(
      concatBytes(typeLe, colon, new TextEncoder().encode(ev.event), colon, hexToBytes(ev.event_payload)),
    );
    if (ev.digest) {
      const claimed = hexToBytes(ev.digest);
      // A populated digest must commit to the payload (older dstack fills it in).
      if (ev.event_type === DSTACK_RUNTIME_EVENT_TYPE && !bytesEqual(claimed, computed)) {
        throw new Error(`event "${ev.event}" digest does not commit to its payload`);
      }
      return claimed;
    }
    return computed;
  };

  // Replay RTMR3: mr = sha384(mr48 || digest48) over imr==3 events, from 48 zero bytes.
  let mr: Uint8Array = new Uint8Array(48);
  for (const ev of events) {
    if (ev.imr !== 3) continue;
    const digest = await eventDigest(ev);
    const padded = digest.length < 48 ? concatBytes(digest, new Uint8Array(48 - digest.length)) : digest;
    mr = await sha384(concatBytes(mr, padded));
  }
  const rtmr3 = quote.slice(RTMR3_OFFSET, RTMR3_OFFSET + 48);
  if (!bytesEqual(mr, rtmr3)) {
    throw new Error("event log does not replay to the quote's RTMR3 — log is forged or stale");
  }

  const compose = events.find((ev) => ev.imr === 3 && ev.event === "compose-hash");
  if (!compose) throw new Error("no compose-hash event in the attested event log");

  if (compose.event_payload.toLowerCase().replace(/^0x/, "") !== pinned) {
    throw new Error(
      `decryptor compose-hash ${compose.event_payload} != pinned measurement ${pinned} — wrong or outdated enclave`,
    );
  }
}

/**
 * Full verification. Resolves to the enclave pubkey (hex) it is safe to seal to;
 * throws (fail closed) on any mismatch.
 */
export async function verifyDecryptorAttestation(att: DecryptorAttestation): Promise<string> {
  const pubkeyHex = (att.x25519_pubkey || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) throw new Error("attestation missing enclave x25519 pubkey");
  if (!att.quote && att.mock_kms === true && isMockTeeAllowed()) {
    // Nothing to verify against Intel — only that the decryptor's own report_data is consistent.
    const expected = bytesToHex(await sha256(new TextEncoder().encode(`siphon-decryptor:${pubkeyHex}`)));
    if ((att.report_data_hex || "").toLowerCase() !== expected) {
      throw new Error("mock decryptor report_data does not bind its x25519 pubkey");
    }
    console.warn("[Attestation] TEE: decryptor attestation accepted");
    return pubkeyHex;
  }
  if (!att.quote) throw new Error(att.error || "decryptor returned no TDX quote (not in a CVM?)");
  if (!att.event_log) throw new Error("decryptor attestation missing event log");

  const quote = hexToBytes(att.quote);
  if (quote.length < REPORT_DATA_OFFSET + 64) throw new Error("TDX quote too short");

  await verifyQuoteSignature(att.quote);
  await verifyReportDataBinding(quote, pubkeyHex);
  await verifyMeasurementPin(quote, att.event_log);
  return pubkeyHex;
}

/**
 * Seal hex(bincode(ClientKey)) to the verified enclave pubkey.
 * Returns hex(crypto_box_seal(bincode(ClientKey), pubkey)) — the decryptor unseals in-enclave.
 */
export async function sealClientKeyToEnclave(clientKeyHex: string, enclavePubkeyHex: string): Promise<string> {
  const _sodium = (await import("libsodium-wrappers")).default; // lazy: ~0.3 MB, only for sealing
  await _sodium.ready;
  const sealed = _sodium.crypto_box_seal(hexToBytes(clientKeyHex), hexToBytes(enclavePubkeyHex));
  return bytesToHex(sealed);
}

// Attest+verify is ~3 network calls and the executor rate-limits /decryptorAttestation, while
// the key-sync effect retries on a short tick. Cache the verified pubkey briefly and dedupe
// concurrent verifications. Short TTL: the enclave keypair is per-boot, so a stale pubkey only
// survives until the next failed upload calls invalidateAttestationCache().
// Keyed by executor base URL: each chain's executor fronts its OWN decryptor, so a pubkey verified
// for one chain must never be used to seal a key bound for another.
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;
const cachedPubkeys = new Map<string, { value: string; expires: number }>();
const inflightVerifies = new Map<string, Promise<string>>();

export function invalidateAttestationCache(): void {
  cachedPubkeys.clear();
}

async function verifiedEnclavePubkey(base: string = getTradeExecutorBaseUrl()): Promise<string> {
  const cached = cachedPubkeys.get(base);
  if (cached && Date.now() < cached.expires) return cached.value;
  let inflight = inflightVerifies.get(base);
  if (!inflight) {
    inflight = (async () => {
      const att = await fetchDecryptorAttestation(base);
      const pubkey = await verifyDecryptorAttestation(att);
      console.log(`[Attestation] decryptor enclave verified (pubkey ${pubkey.slice(0, 12)}…)`);
      cachedPubkeys.set(base, { value: pubkey, expires: Date.now() + VERIFY_CACHE_TTL_MS });
      return pubkey;
    })().finally(() => {
      inflightVerifies.delete(base);
    });
    inflightVerifies.set(base, inflight);
  }
  return inflight;
}

/**
 * Attest → verify → seal an arbitrary hex payload to the decryptor enclave.
 *
 * The attestation work (quote signature, report_data binding, measurement pin) is what makes the
 * seal meaningful: `crypto_box_seal` to an UNVERIFIED pubkey is encryption to whoever published it.
 * Everything sealed to the enclave must go through here, never through
 * {@link sealClientKeyToEnclave} with a pubkey from elsewhere.
 *
 * On a downstream failure, call {@link invalidateAttestationCache} before retrying — the enclave
 * x25519 identity is per-boot, so a CVM restart invalidates the cached pubkey.
 */
export async function attestAndSeal(
  payloadHex: string,
  executorBase: string = getTradeExecutorBaseUrl(),
): Promise<string> {
  // `executorBase` must be the host the sealed blob is then sent to: sealing to one chain's
  // decryptor and uploading through another's is a guaranteed (fail-closed) mismatch.
  const pubkey = await verifiedEnclavePubkey(executorBase);
  return sealClientKeyToEnclave(payloadHex, pubkey);
}

/**
 * Attest → verify → seal, in one call. Returns the sealed blob to upload as `client_key`.
 * On upload failure, call invalidateAttestationCache() before retrying (enclave may have rebooted).
 */
export async function attestAndSealClientKey(
  clientKeyHex: string,
  executorBase: string = getTradeExecutorBaseUrl(),
): Promise<string> {
  return attestAndSeal(clientKeyHex, executorBase);
}
