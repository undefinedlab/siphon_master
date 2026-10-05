/**
 * Self-serve commercial API keys — pay USDC from the connected wallet, mint a key.
 * Talks to the api-gateway via the Next proxy at /api/gateway.
 */
import { Contract, ethers } from "ethers";
import { getNetwork } from "./networks";
import { getSigner } from "./nexus";
import { sha256Hex } from "@/lib/walletAuthHeaders";

export type CreditPack = {
  id: string;
  label: string;
  usdc_minor: number;
  plan: string;
};

export type PacksResponse = {
  packs: CreditPack[];
  collector: string;
  usdc_by_chain: Record<string, string>;
  min_custom_usdc_minor?: number;
};

export type KeySummary = {
  api_key_id: string;
  plan: string;
  status: string;
  balance_minor: number;
  created_at: string | null;
};

export type PurchaseResult = {
  api_key: string;
  api_key_id: string;
  plan: string;
  balance_minor: number;
  pack_id: string;
  tx_hash: string;
  collector: string;
  usdc: string;
};

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

function gatewayBase(): string {
  if (typeof window !== "undefined") return "/api/gateway";
  return (
    process.env.API_GATEWAY_URL ||
    process.env.NEXT_PUBLIC_API_GATEWAY_URL ||
    "http://localhost:8000"
  ).replace(/\/+$/, "");
}

/**
 * READ auth. `Siphon API v1:{chain}:{ts}`, verified by the gateway's `verify_wallet_sig`.
 *
 * Only valid on read routes. Fund-moving routes are behind `verify_wallet_intent`, which requires
 * the v2 intent below — sending this to one of those is a guaranteed 401.
 */
async function walletAuthHeaders(chainId: number): Promise<Record<string, string>> {
  const signer = getSigner();
  if (!signer) throw new Error("Wallet not connected.");
  const address = await signer.getAddress();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `Siphon API v1:${chainId}:${timestamp}`;
  const signature = await signer.signMessage(message);
  return {
    "X-Wallet-Address": address,
    "X-Signature": signature,
    "X-Timestamp": timestamp,
  };
}

/**
 * Stable JSON: keys sorted at every level, no whitespace.
 *
 * Must match Python's `json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
 * byte for byte — the gateway hashes its own re-encoding of the parsed body and compares, so any
 * difference is an unexplainable 401 rather than a decode error. JSON.stringify already matches on
 * separators and unicode; insertion order is the only thing it does differently, hence the sort.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The exact text `canonical_intent_message` rebuilds server-side (api-gateway wallet_sig.py).
 *
 * Exported for the parity test. Keep the two in lockstep: the message is compared by recovering an
 * address from it, so a one-character drift rejects every purchase and looks like a wallet problem.
 */
export async function buildIntentMessage(args: {
  chainId: number | string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}): Promise<string> {
  const bodySha256 = await sha256Hex(new TextEncoder().encode(canonicalJson(args.body ?? {})));
  return [
    "Siphon API v2",
    `chain_id:${args.chainId}`,
    `timestamp:${args.timestamp}`,
    `nonce:${args.nonce}`,
    `method:${args.method.toUpperCase()}`,
    `path:${args.path}`,
    `body_sha256:${bodySha256}`,
  ].join("\n");
}

/**
 * WRITE auth for fund-moving gateway routes (`verify_wallet_intent`).
 *
 * Deliberately signed by the WALLET, never a session key: `verify_wallet_intent` does not accept
 * delegations, and it should not — an API credential that can spend is the thing this whole
 * signing scheme exists to prevent.
 *
 * `path` must be the path the GATEWAY sees, not the browser's. The dashboard talks to
 * /api/gateway/v1/keys/purchase and the proxy forwards it upstream as /v1/keys/purchase; signing
 * the browser-side path would bind the wrong route.
 */
async function walletIntentHeaders(
  chainId: number,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, string>> {
  const signer = getSigner();
  if (!signer) throw new Error("Wallet not connected.");
  const address = await signer.getAddress();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const signature = await signer.signMessage(
    await buildIntentMessage({ chainId, timestamp, nonce, method, path, body }),
  );
  return {
    "X-Wallet-Address": address,
    "X-Signature": signature,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
  };
}

/**
 * One-time key that seals the minted API key in the gateway's idempotency record.
 *
 * The gateway stores the key sealed rather than in plaintext, so a replayed purchase can still
 * return it. It must stay STABLE for the life of a payment for the same reason the idempotency key
 * does — the envelope is opened with whatever key the retry presents, and `parse_delivery_key`
 * rejects a mismatch. It lives with the receipt, not in a local const.
 */
export function newDeliveryKey(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return "0x" + Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deliveryKeySha256(deliveryKey: string): Promise<string> {
  const hex = deliveryKey.slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  // Hashed over the raw BYTES, not the hex string — key_delivery.py does bytes.fromhex first.
  return sha256Hex(bytes);
}

/** Solana Devnet: the one chain whose API keys are free (gateway `POST /v1/keys/devnet`). */
export const DEVNET_API_CHAIN_ID = 900_002;

export type DevnetKeyResult = {
  api_key: string;
  api_key_id: string;
  plan: string;
  chain_ids: number[];
  revoked_previous: number;
};

/**
 * Claim the free Devnet key for a Solana wallet. One active key per wallet: claiming again revokes
 * the previous one, so a lost key is never a lockout. Signed by the Solana wallet itself (ed25519
 * over the same v2 intent an EVM purchase signs, base64 signature), never a session key.
 */
export async function claimDevnetApiKey(
  wallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<DevnetKeyResult> {
  const deliveryKey = newDeliveryKey();
  const body = { chain_id: DEVNET_API_CHAIN_ID, delivery_key_sha256: await deliveryKeySha256(deliveryKey) };
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const message = await buildIntentMessage({
    chainId: DEVNET_API_CHAIN_ID,
    timestamp,
    nonce,
    method: "POST",
    path: "/v1/keys/devnet", // the gateway-side path, as for /v1/keys/purchase
    body,
  });
  const signature = await signMessage(new TextEncoder().encode(message));
  const res = await fetch(`${gatewayBase()}/v1/keys/devnet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Wallet-Address": wallet,
      "X-Signature": btoa(String.fromCharCode(...signature)),
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "Idempotency-Key": crypto.randomUUID(),
      "X-Delivery-Key": deliveryKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
    throw new Error(err.detail || err.title || `Devnet key claim failed (${res.status})`);
  }
  return res.json();
}

export async function fetchCreditPacks(): Promise<PacksResponse> {
  const res = await fetch(`${gatewayBase()}/v1/keys/packs`);
  if (!res.ok) {
    let detail = `Failed to load credit packs (${res.status})`;
    try {
      const body = await res.json();
      detail = body.error || body.detail || body.title || detail;
      if (body.hint) detail = `${detail}\n${body.hint}`;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) detail = text;
    }
    throw new Error(detail);
  }
  return res.json();
}

export async function listWalletApiKeys(chainId: number): Promise<KeySummary[]> {
  const auth = await walletAuthHeaders(chainId);
  const res = await fetch(`${gatewayBase()}/v1/keys?chain_id=${chainId}`, {
    headers: { ...auth, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to list API keys (${res.status})`);
  }
  const body = (await res.json()) as { keys: KeySummary[] };
  return body.keys || [];
}

/**
 * A paid-but-unclaimed purchase, kept until the gateway credits it.
 *
 * The USDC transfer and the credit are two steps, and the second one FAILS BY DESIGN on the first
 * try: `tx.wait()` resolves at 1 confirmation and the gateway requires 2 (config.py
 * `confirmations = {8453: 2, 11155111: 2}`). Until now the tx hash was a local `const` inside the
 * purchase handler, so that guaranteed first failure threw it away — the USDC had left the wallet
 * and the only record was a toast. On Base that is real money.
 *
 * Persisting it makes the payment a receipt that survives a failed confirm, a closed tab and a
 * reload. `verify_usdc_payment` only reads the receipt, so re-posting the same hash later simply
 * works.
 */
export interface PendingPurchase {
  chainId: number;
  packId: string;
  usdcMinor: number;
  txHash: string;
  /** Stable across retries — see confirmApiKeyPurchase. */
  idempotencyKey: string;
  /**
   * Also stable across retries. Optional only so receipts written before this field existed still
   * load; confirmApiKeyPurchase mints one and writes it back when it is missing.
   */
  deliveryKey?: string;
  ts: number;
}

const PENDING_PREFIX = "siphon-api-pending-purchase";
const pendingKey = (chainId: number, wallet: string) =>
  `${PENDING_PREFIX}-${chainId}-${wallet.toLowerCase()}`;

export function savePendingPurchase(wallet: string, p: PendingPurchase): void {
  try {
    localStorage.setItem(pendingKey(p.chainId, wallet), JSON.stringify(p));
  } catch {
    /* storage disabled — the purchase still proceeds, it just cannot be resumed later */
  }
}

export function loadPendingPurchase(chainId: number, wallet: string): PendingPurchase | null {
  try {
    const raw = localStorage.getItem(pendingKey(chainId, wallet));
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingPurchase;
    return p && typeof p.txHash === "string" && p.txHash.startsWith("0x") ? p : null;
  } catch {
    return null;
  }
}

export function clearPendingPurchase(chainId: number, wallet: string): void {
  try {
    localStorage.removeItem(pendingKey(chainId, wallet));
  } catch {
    /* ignore */
  }
}

/**
 * Is this failure worth waiting out, or is it final?
 *
 * Only two things are transient: the payment is on-chain but not deep enough yet, and the gateway
 * could not reach the chain to look (now a 503 — it used to be indistinguishable from a rejected
 * payment). Everything else — wrong recipient, reverted transfer, bad auth — will say the same
 * thing forever, and retrying those just hides a real answer behind a spinner.
 *
 * Matched on the gateway's own wording, so it is exactly the kind of thing that stops working when
 * someone rewords a message. apiKeys.check.ts pins the real strings.
 */
export function isRetryablePurchaseError(message: string, status?: number): boolean {
  if (status === 503) return true;
  return /not yet confirmed|missing, failed, or not yet|could not reach the chain/i.test(message);
}

/** Pay pack USDC from the connected wallet to the API credit collector. */
export async function payApiCreditPack(
  chainId: number,
  pack: CreditPack,
  collector: string,
): Promise<{ txHash: string; pending: PendingPurchase }> {
  const signer = getSigner();
  if (!signer) throw new Error("Wallet not connected.");
  const fromAddr = await signer.getAddress();
  const net = getNetwork(chainId);
  const usdc = new Contract(net.usdc, ERC20_ABI, signer);
  const amount = BigInt(pack.usdc_minor);
  const from = fromAddr;
  const bal: bigint = await usdc.balanceOf(from);
  if (bal < amount) {
    const need = ethers.formatUnits(amount, 6);
    const has = ethers.formatUnits(bal, 6);
    throw new Error(
      `API credit needs ${need} USDC in your ${net.name} wallet, but it holds only ${has} USDC ` +
        `(this is charged from your wallet balance, not your shielded vault).`,
    );
  }
  // Only ever pay the address the gateway quoted — it credits a transfer to THAT address and no
  // other. This used to fall back to the chain's executor wallet, which on Arbitrum is a different
  // address from the collector: the USDC would leave and no credit could ever be claimed for it.
  if (!ethers.isAddress(collector)) {
    throw new Error("The API gateway did not return a payment address. Nothing was sent — try again shortly.");
  }
  const tx = await usdc.transfer(collector, amount);
  // Persist BEFORE awaiting: if the tab closes or the wallet drops between broadcast and receipt,
  // the hash is still recoverable. A hash for a tx that never lands is harmless — the gateway
  // rejects it and the caller can clear it.
  const pending: PendingPurchase = {
    chainId,
    packId: pack.id,
    usdcMinor: Number(pack.usdc_minor),
    txHash: tx.hash as string,
    // Stable for the life of this payment. A fresh UUID per attempt would defeat the gateway's
    // idempotency exactly when it matters — on the retry after the confirmation race.
    idempotencyKey: crypto.randomUUID(),
    deliveryKey: newDeliveryKey(),
    ts: Date.now(),
  };
  savePendingPurchase(from, pending);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    clearPendingPurchase(chainId, from);
    throw new Error("USDC payment transaction failed.");
  }
  return { txHash: tx.hash as string, pending };
}

/**
 * After payment confirms, mint the API key and credit prepaid balance.
 *
 * Retries while the gateway says the payment is not yet deep enough. `tx.wait()` returns at ONE
 * confirmation and the gateway wants two, so the first attempt loses that race every single time —
 * this used to surface as "Payment transaction is missing, failed, or not yet confirmed" on a
 * payment that was already on-chain and perfectly valid. Waiting for a fixed count client-side
 * would only work until someone changes the gateway's threshold; retrying against the gateway's own
 * answer adapts to whatever it is.
 *
 * `idempotencyKey` must be STABLE across those retries. It used to be a fresh UUID per call, which
 * defeated the gateway's de-duplication precisely on the retry path — the one place a double credit
 * could happen.
 */
export async function confirmApiKeyPurchase(
  chainId: number,
  packId: string,
  txHash: string,
  usdcMinor?: number,
  opts?: {
    idempotencyKey?: string;
    /** Must be the receipt's, so a retry can reopen the envelope the first attempt sealed. */
    deliveryKey?: string;
    timeoutMs?: number;
    onWait?: (attempt: number) => void;
  },
): Promise<PurchaseResult> {
  // /v1/keys/purchase moves money, so it is behind verify_wallet_intent — the canonical v2 intent
  // over method+path+body+nonce, not the v1 read message. This used to send the v1 message with no
  // X-Nonce, which the route can only ever reject.
  const deliveryKey = opts?.deliveryKey ?? newDeliveryKey();
  const body: Record<string, unknown> = {
    chain_id: chainId,
    pack_id: packId,
    tx_hash: txHash,
    delivery_key_sha256: await deliveryKeySha256(deliveryKey),
  };
  if (packId === "custom" && usdcMinor != null) {
    body.usdc_minor = usdcMinor;
  }
  // Signed ONCE, outside the retry loop: the intent binds a timestamp and a single-use nonce, so
  // re-signing per attempt would prompt the wallet on every retry, and reusing the signature is
  // exactly what the 300s freshness window and the nonce allow. A retry that outlives the window
  // fails loudly rather than silently double-charging.
  const auth = await walletIntentHeaders(chainId, "POST", "/v1/keys/purchase", body);
  const idem = opts?.idempotencyKey ?? crypto.randomUUID();
  const deadline = Date.now() + (opts?.timeoutMs ?? 180_000);
  let attempt = 0;

  for (;;) {
    const res = await fetch(`${gatewayBase()}/v1/keys/purchase`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": idem,
        "X-Delivery-Key": deliveryKey,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    let detail = `Purchase failed (${res.status})`;
    try {
      const err = await res.json();
      detail = err.detail || err.title || detail;
    } catch {
      /* ignore */
    }
    if (!isRetryablePurchaseError(detail, res.status) || Date.now() >= deadline) {
      throw new Error(detail);
    }
    attempt += 1;
    opts?.onWait?.(attempt);
    await new Promise((r) => setTimeout(r, Math.min(3_000 * attempt, 12_000)));
  }
}

export function usdcDollarsToMinor(dollars: string | number): number {
  const n = typeof dollars === "number" ? dollars : parseFloat(dollars);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a valid USDC amount.");
  return Math.round(n * 1_000_000);
}

export function formatUsdcMinor(minor: number): string {
  return ethers.formatUnits(BigInt(minor), 6);
}
