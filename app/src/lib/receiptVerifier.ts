/**
 * Trustless receipt verification — runs entirely client-side, no Siphon server in the loop.
 *
 * Confirms three things:
 *   1. the receipt is UNALTERED  — recompute the canonical digest from the presented fields;
 *   2. the signature is GENUINE   — recover the signer from the enclave's EIP-191 signature;
 *   3. the signer IS the enclave  — the recovered address is report_data-bound inside the
 *                                   order-signer's live TDX attestation quote.
 *
 * The digest math mirrors the executor's receipt_signer.py byte-for-byte (sorted keys, no spaces,
 * raw UTF-8) so the same signature verifies in Python and in the browser.
 */
import { sha256, toUtf8Bytes, getBytes, verifyMessage } from "ethers";
import type { Receipt } from "./receiptClient";

/** Deterministic JSON: recursively sorted keys, no whitespace, raw UTF-8. Matches Python's
 *  json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False). */
function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(rec[k])).join(",") + "}";
}

function sha256Hex(s: string): string {
  return sha256(toUtf8Bytes(s));
}

/** Hash of the identity block. Given a full identity object (owner) recompute it; a public
 *  verifier passes the receipt's `identity_hash` straight through. */
export function identityHash(identity: Record<string, unknown> | null | undefined): string {
  return sha256Hex(canonicalJson(identity ?? {}));
}

/** Recompute the canonical receipt digest. Uses `identity_hash` (public commitment) so it works
 *  from the shareable public view too. */
export function canonicalDigest(r: Partial<Receipt>, identityHashOverride?: string): string {
  const body: Record<string, unknown> = {
    kind: r.kind ?? null,
    tx_hash: r.tx_hash ?? null,
    chain_id: r.chain_id ?? null,
    token: r.token ?? null,
    amount: r.amount ?? null,
    counterparty: r.counterparty ?? null,
    occurred_at: r.occurred_at ?? null,
    identity_hash: identityHashOverride ?? (r as { identity_hash?: string }).identity_hash ?? identityHash(r.identity as Record<string, unknown> | undefined),
    shielded_ref_hash: r.shielded_ref_hash ?? "",
  };
  return sha256Hex(canonicalJson(body));
}

export interface VerifyReport {
  valid: boolean;
  digestMatches: boolean;
  signatureValid: boolean;
  attestedEnclave: boolean | null; // null = attestation not checked (no order-signer URL)
  recoveredSigner: string | null;
  recomputedDigest: string;
  reason?: string;
}

/**
 * Verify a receipt. When `orderSignerUrl` is given, also fetches its /attestation and confirms the
 * recovered signer is the report_data-bound enclave address (full trust). Without it, only the
 * digest + signature are checked (authenticity, minus the enclave binding).
 */
export async function verifyReceipt(
  receipt: Partial<Receipt> & { identity_hash?: string },
  orderSignerUrl?: string,
): Promise<VerifyReport> {
  const recomputedDigest = canonicalDigest(receipt);
  const digestMatches = !receipt.digest || receipt.digest === recomputedDigest;

  let recoveredSigner: string | null = null;
  let signatureValid = false;
  if (receipt.tee_signature) {
    try {
      // Enclave signs EIP-191 over the 32 digest bytes (encode_defunct(hexstr=digest)).
      recoveredSigner = verifyMessage(getBytes(recomputedDigest), receipt.tee_signature);
      signatureValid = !receipt.tee_address ||
        recoveredSigner.toLowerCase() === receipt.tee_address.toLowerCase();
    } catch {
      signatureValid = false;
    }
  }

  let attestedEnclave: boolean | null = null;
  if (orderSignerUrl && recoveredSigner) {
    try {
      const res = await fetch(`${orderSignerUrl.replace(/\/+$/, "")}/attestation`);
      if (res.ok) {
        const att = await res.json();
        // The attestation binds report_data = sha256("siphon-order-signer:"+address); the
        // endpoint returns that address. Full DCAP quote validation lives in decryptorAttestation.
        attestedEnclave = String(att?.address || "").toLowerCase() === recoveredSigner.toLowerCase();
      } else {
        attestedEnclave = false;
      }
    } catch {
      attestedEnclave = false;
    }
  }

  const valid = digestMatches && signatureValid && !!recoveredSigner && attestedEnclave !== false;
  const reason = !digestMatches
    ? "Receipt fields don't match the signed digest (altered)."
    : !signatureValid
    ? "Signature is invalid or not from the claimed signer."
    : attestedEnclave === false
    ? "Signer is not the attested Siphon enclave."
    : undefined;

  return { valid, digestMatches, signatureValid, attestedEnclave, recoveredSigner, recomputedDigest, reason };
}
