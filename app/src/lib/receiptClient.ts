/**
 * Compliant receipts — client for the executor's /receipt API.
 *
 * A receipt is a privately-held, enclave-notarised record of a shielded deposit/withdrawal. This
 * client mints them (wallet-sig gated so only the owner can), lists the owner's receipts, fetches a
 * shareable public view, and verifies authenticity. Nothing here touches the chain; the identity
 * layer is only ever returned to the authenticated owner.
 */
import { getTradeExecutorBaseUrl } from "./tradeExecutorClient";
import { getWalletAuthHeaders, getWalletWriteAuthHeaders } from "./walletAuthHeaders";
import { getSigner } from "./nexus";

export interface ReceiptIdentity {
  merchant_name?: string;
  merchant_email?: string;
  merchant_address?: string;
  tax_id?: string;
  payee_name?: string;
  payee_email?: string;
  payee_address?: string;
  memo?: string;
}

export interface Receipt {
  id: string;
  kind: "deposit" | "withdraw";
  tx_hash: string | null;
  chain_id: number | null;
  token: string | null;
  amount: string | null;
  counterparty: string | null;
  occurred_at: string | null;
  shielded_ref_hash: string | null;
  digest: string | null;
  tee_signature: string | null;
  tee_address: string | null;
  attestation_ref: string | null;
  status: string;
  created_at: string | null;
  /** Owner-only; present on list/create, absent on the public share view. */
  identity?: ReceiptIdentity;
}

export interface NewReceiptInput {
  kind: "deposit" | "withdraw";
  tx_hash?: string;
  chain_id?: number;
  token?: string;
  amount?: string;
  counterparty?: string;
  occurred_at?: string;
  identity?: ReceiptIdentity;
  /** Optional note reference; stored as a hash only, never the raw secret. */
  shielded_ref?: string;
  strategy_id?: string;
}

/** Mint a receipt for a settled transaction. Requires a connected wallet (it's the owner). */
export async function createReceipt(input: NewReceiptInput): Promise<Receipt> {
  const signer = getSigner();
  if (!signer) throw new Error("Connect a wallet to create a receipt.");
  const res = await fetch(`${getTradeExecutorBaseUrl()}/receipt`, {
    method: "POST",
    headers: await getWalletWriteAuthHeaders(signer),
    body: JSON.stringify(input),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Create receipt failed (${res.status})`);
  return json.receipt as Receipt;
}

/** The authenticated owner's receipts (identity included). */
export async function listReceipts(): Promise<Receipt[]> {
  const signer = getSigner();
  if (!signer) return [];
  const res = await fetch(`${getTradeExecutorBaseUrl()}/receipts`, {
    headers: await getWalletAuthHeaders(signer),
  });
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({}));
  return (json?.receipts ?? []) as Receipt[];
}

/** Public, shareable view of one receipt (no identity). */
export async function getPublicReceipt(id: string): Promise<Receipt | null> {
  const res = await fetch(`${getTradeExecutorBaseUrl()}/receipt/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  return (json?.receipt ?? null) as Receipt | null;
}

export interface VerifyResult {
  valid: boolean;
  digest_matches: boolean;
  signature_valid: boolean;
  recovered_signer: string | null;
  recomputed_digest: string | null;
  attestation_ref: string | null;
}

/** Server-assisted verification (recomputes digest + recovers signer). For fully trustless
 *  verification, pair with the client-side verifier in receiptVerifier.ts. */
export async function verifyReceipt(receipt: Partial<Receipt>): Promise<VerifyResult> {
  const res = await fetch(`${getTradeExecutorBaseUrl()}/receipt/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(receipt),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Verify failed (${res.status})`);
  return json as VerifyResult;
}
