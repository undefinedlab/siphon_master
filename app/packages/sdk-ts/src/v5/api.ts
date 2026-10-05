/**
 * Siphon API v2 client (api-gateway 2.0.0, `/v1/*`). Pairs with the local v5 core: secrets and
 * proofs are made here, the API does screening, calldata, relaying and bookkeeping.
 *
 *   const api = new SiphonApi({ apiKey, wallet })          // wallet: an ethers Signer
 *   const pending = await prepareDeposit({ chainId, token, amount })   // persist it first!
 *   const r = await api.deposit(accountId, pending)        // phase "approve" → send, call again
 *   … send r.transactions, then api.submitOperation(r.operation.operation_id, chainId, txHash)
 *   const note = await finalizeDeposit(pending, receipt)
 *   const w = await prepareWithdrawal({ …, notes, data: api })          // proves locally
 *   await api.payout({ accountId, …, spend: w.bundle })
 */
import { getAddress } from "ethers";
import { chainConfig } from "./constants";
import { depositTransactions, spendTransaction, type PendingDeposit, type UnsignedTx } from "./deposit";
import { noteAssetIdFor } from "./noteCrypto";
import type { SpendBundle } from "./withdraw";
import type { ComplianceWitness, V5DataSource } from "./types";

/** Railway siphon-sol-devnet api-gateway (not legacy api.siphon.money). */
export const DEFAULT_API_URL = "https://api-gateway-production-41e4.up.railway.app";

/** Anything that can sign EIP-191 messages — an ethers Signer, a viem account adapter, … */
export interface WalletSigner {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
}

export class SiphonApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: unknown) {
    super(message);
    this.name = "SiphonApiError";
  }
}

/** Python `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` — byte for byte. */
export function canonicalJson(value: unknown): string {
  // bigint → a bare JSON integer: exact at any size (wei amounts pass 2^53 at ~0.009 ETH), and
  // Python re-encodes the parsed int to the same digits, so the intent hash still matches.
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact text api-gateway `canonical_intent_message` rebuilds. */
export async function intentMessage(a: { chainId: number; timestamp: string; nonce: string; method: string; path: string; body: unknown }): Promise<string> {
  return [
    "Siphon API v2",
    `chain_id:${a.chainId}`,
    `timestamp:${a.timestamp}`,
    `nonce:${a.nonce}`,
    `method:${a.method.toUpperCase()}`,
    `path:${a.path}`,
    `body_sha256:${await sha256Hex(canonicalJson(a.body ?? {}))}`,
  ].join("\n");
}

export interface Operation {
  operation_id: string;
  kind: string;
  status: string;
  phase: string;
  chain_id: number | null;
  tx_hash: string | null;
  next_action: string | null;
  error_code: string | null;
  [k: string]: unknown;
}

export interface DepositResponse {
  operation: Operation | null;
  phase: "approve" | "deposit";
  commitment: string | null;
  transactions: (UnsignedTx & { chain_id: number; purpose: string })[];
}

export interface PayoutResponse {
  operation: Operation;
  submission_mode: "relay" | "unsigned";
  transaction: (UnsignedTx & { chain_id: number; purpose: string }) | null;
  tx_hash: string | null;
}

export class SiphonApi implements V5DataSource {
  private readonly base: string;
  constructor(private readonly opts: { apiKey: string; wallet?: WalletSigner; baseUrl?: string; fetch?: typeof fetch }) {
    this.base = (opts.baseUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  }

  protected async call<T>(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string | number | boolean | string[]> } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(init.query || {})) {
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
    const res = await (this.opts.fetch || fetch)(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      // Send the canonical encoding: it is what the intent signature covers.
      body: init.body !== undefined ? canonicalJson(init.body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new SiphonApiError(res.status, json.error_code || "error", json.detail || res.statusText, json);
    return json as T;
  }

  protected wallet(): WalletSigner {
    if (!this.opts.wallet) throw new Error("This call needs the account wallet (pass `wallet` to SiphonApi).");
    return this.opts.wallet;
  }

  /** v2 intent headers: the wallet signs the exact method, path, chain and body. */
  protected async intent(chainId: number, method: string, path: string, body: unknown): Promise<Record<string, string>> {
    const w = this.wallet();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const signature = await w.signMessage(await intentMessage({ chainId, timestamp, nonce, method, path, body }));
    return { "X-Wallet-Address": await w.getAddress(), "X-Signature": signature, "X-Timestamp": timestamp, "X-Nonce": nonce };
  }

  /** v1 read signature: `Siphon API v1:{chain}:{ts}:{nonce}`. */
  protected async read(chainId: number): Promise<Record<string, string>> {
    const w = this.wallet();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const signature = await w.signMessage(`Siphon API v1:${chainId}:${timestamp}:${nonce}`);
    return { "X-Wallet-Address": await w.getAddress(), "X-Signature": signature, "X-Timestamp": timestamp, "X-Nonce": nonce };
  }

  // ── chain reads (V5DataSource) ────────────────────────────────────────────────────────────

  chains() {
    return this.call<{ chains: Record<string, unknown>[] }>("GET", "/v1/chains");
  }

  async stateLeaves(chainId: number): Promise<bigint[]> {
    const LIMIT = 5000;
    const MAX_LEAVES = 1 << 24; // far above any live tree; a server claiming more is lying
    const out: bigint[] = [];
    for (;;) {
      const page = await this.call<{ total_count: number; leaves: string[] }>("GET", `/v1/chains/${chainPath(chainId)}/state-leaves`, {
        query: { from_index: out.length, limit: LIMIT },
      });
      if (!Number.isSafeInteger(page.total_count) || page.total_count > MAX_LEAVES || page.leaves.length > LIMIT) {
        throw new Error("stateLeaves: implausible page from the API");
      }
      out.push(...page.leaves.map((x) => BigInt(x)));
      if (out.length >= page.total_count) return out;
      if (page.leaves.length === 0) throw new Error("stateLeaves: the API stopped before total_count");
    }
  }

  /** Wallet-signed: admission paths are about the wallet's own deposits. */
  async complianceWitness(chainId: number, labels: string[], opts?: { requireAdmittedPath?: boolean }): Promise<ComplianceWitness> {
    labels.forEach(checkLabel);
    return this.call("GET", `/v1/chains/${chainPath(chainId)}/compliance/witness`, {
      query: { labels, require_admitted: opts?.requireAdmittedPath !== false },
      headers: await this.read(chainId),
    });
  }

  /** Admitted ⇒ spendable. Deposits are admitted in ~5-minute batches after they confirm. */
  async labelStatus(chainId: number, label: string) {
    checkLabel(label);
    return this.call<{ label: string; admitted: boolean; revoked: boolean }>(
      "GET", `/v1/chains/${chainPath(chainId)}/compliance/labels/${encodeURIComponent(label)}`, { headers: await this.read(chainId) },
    );
  }

  // ── compliance fee (per wallet, per chain, yearly) ──────────────────────────────────────────

  async complianceFee(chainId: number) {
    return this.call<{ paid: boolean; vault: string | null; fee_wei: string | null; product: string }>("GET", "/v1/compliance-fee", {
      query: { chain_id: chainId },
      headers: await this.read(chainId),
    });
  }

  async verifyComplianceFee(chainId: number, txHash: string) {
    const body = { chain_id: chainId, tx_hash: txHash };
    return this.call("POST", "/v1/compliance-fee/verify", { body, headers: await this.intent(chainId, "POST", "/v1/compliance-fee/verify", body) });
  }

  // ── accounts, deposits, payouts, operations ─────────────────────────────────────────────────

  async createAccount(p: { chainId: number; externalRef: string; label?: string; idempotencyKey: string }) {
    const body = { chain_id: p.chainId, external_ref: p.externalRef, label: p.label };
    return this.call<{ account_id: string; wallet_address: string }>("POST", "/v1/accounts", {
      body,
      headers: { ...(await this.intent(p.chainId, "POST", "/v1/accounts", body)), "Idempotency-Key": p.idempotencyKey },
    });
  }

  /**
   * Screen + get the transactions for a prepared deposit. `asset` is ETH, WETH or USDC.
   * Phase "approve": send the approval, then call again with a NEW idempotency key.
   */
  async deposit(accountId: string, d: PendingDeposit, p: { asset: string; idempotencyKey: string }): Promise<DepositResponse> {
    const cfg = chainConfig(d.chainId);
    const token = p.asset.toUpperCase() === "USDC" ? cfg.usdc : p.asset.toUpperCase() === "WETH" ? cfg.weth : p.asset.toUpperCase() === "ETH" ? null : undefined;
    if (token === undefined || (token === null) !== d.native || (token && token.toLowerCase() !== d.token.toLowerCase())) {
      throw new Error(`deposit: asset ${p.asset} does not match the prepared deposit's token ${d.token}`);
    }
    const path = `/v1/accounts/${encodeURIComponent(accountId)}/deposits`;
    const body = { chain_id: d.chainId, asset: p.asset, amount_minor: BigInt(d.amount), precommitment: d.precommitment, user_salt: d.userSalt };
    const r = await this.call<DepositResponse>("POST", path, { body, headers: { ...(await this.intent(d.chainId, "POST", path, body)), "Idempotency-Key": p.idempotencyKey } });
    // Never forward calldata we did not build: a hostile or compromised API could name its own
    // precommitment (the deposit becomes its note) or approve its own spender.
    const local = depositTransactions(d);
    const expected = r.phase === "approve" ? local.slice(0, 1) : local.slice(-1);
    if (d.native && r.phase === "approve") throw new Error("deposit: the API asked to approve for a native ETH deposit");
    if (r.transactions.length !== expected.length || r.transactions.some((tx, i) => !sameTx(tx, expected[i]))) {
      throw new Error("deposit: the API returned transactions that differ from the locally built ones — refusing them");
    }
    return { ...r, transactions: r.transactions.map((tx, i) => ({ ...tx, ...expected[i] })) };
  }

  async submitOperation(operationId: string, chainId: number, txHash: string): Promise<Operation> {
    const path = `/v1/operations/${encodeURIComponent(operationId)}/submission`;
    const body = { chain_id: chainId, tx_hash: txHash };
    return this.call("POST", path, { body, headers: await this.intent(chainId, "POST", path, body) });
  }

  operation(operationId: string): Promise<Operation> {
    return this.call("GET", `/v1/operations/${encodeURIComponent(operationId)}`);
  }

  /**
   * Pay out a locally-proven withdrawal. Relay mode (default) also needs a single-use relayer
   * challenge, signed by the same wallet — fetched and signed here.
   */
  async payout(p: {
    chainId: number;
    accountId: string;
    asset: string;
    recipient: string;
    amountMinor: bigint | number | string;
    spend: SpendBundle;
    idempotencyKey: string;
    mode?: "relay" | "unsigned";
    reference?: string;
  }): Promise<PayoutResponse> {
    const mode = p.mode || "relay";
    const amount = BigInt(p.amountMinor);
    const { chain_id: bundleChain, ...spend } = p.spend;
    // Bind what we ask the API to approve to what the proof actually does — otherwise policy and
    // screening would run on one payee/amount while the chain pays another.
    if (bundleChain !== p.chainId) throw new Error("payout: spend bundle is for another chain");
    if (getAddress(p.recipient) !== getAddress(spend.extra.rawPayee)) throw new Error("payout: recipient differs from the proof's payee (extra.rawPayee)");
    if (BigInt(spend.public_inputs[5]) !== amount) throw new Error("payout: amountMinor differs from the proof's payout (public_inputs[5])");
    if (BigInt(spend.public_inputs[17]) !== noteAssetIdFor(p.chainId, p.asset.toUpperCase() === "ETH" ? "" : p.asset.toUpperCase() === "USDC" ? chainConfig(p.chainId).usdc : p.asset.toUpperCase() === "WETH" ? chainConfig(p.chainId).weth : p.asset)) {
      throw new Error("payout: asset differs from the proof's asset (public_inputs[17])");
    }
    const body = {
      chain_id: p.chainId, account_id: p.accountId, asset: p.asset, recipient: getAddress(p.recipient),
      amount_minor: amount, spend, reference: p.reference, submission_mode: mode,
    };
    const headers: Record<string, string> = { ...(await this.intent(p.chainId, "POST", "/v1/payouts", body)), "Idempotency-Key": p.idempotencyKey };
    if (mode === "relay") {
      const ch = await this.call<{ nonce: string; message: string }>("POST", "/v1/wallet-challenges", { query: { chain_id: p.chainId } });
      // Sign text WE build from the chain we are paying out on — never the API's. The chain is what
      // stops a signature meant for one relayer host being replayed at another (G-8), and a message
      // that differs from ours (another chain, a login for another site) is refused outright.
      const expected = `Siphon auth v2:write:${p.chainId}:${ch.nonce}`;
      if (!/^[0-9a-f]{16,128}$/.test(ch.nonce) || ch.message !== expected) {
        throw new Error(`payout: the relayer challenge is not \`Siphon auth v2:write:${p.chainId}:<nonce>\` — refusing to sign it`);
      }
      headers["X-Write-Nonce"] = ch.nonce;
      headers["X-Write-Signature"] = await this.wallet().signMessage(expected);
    }
    const r = await this.call<PayoutResponse>("POST", "/v1/payouts", { body, headers });
    if (mode === "unsigned") {
      // Return the spend we encode ourselves, and refuse an API reply that differs from it.
      const local = spendTransaction(p.spend);
      if (!r.transaction || !sameTx(r.transaction, local)) throw new Error("payout: the API's spend transaction differs from the locally built one — refusing it");
      return { ...r, transaction: { ...r.transaction, ...local } };
    }
    return r;
  }
}

function sameTx(a: { to: string; data: string; value: string }, b: { to: string; data: string; value: string }): boolean {
  return a.to.toLowerCase() === b.to.toLowerCase() && a.data.toLowerCase() === b.data.toLowerCase() && BigInt(a.value) === BigInt(b.value);
}

function chainPath(chainId: number): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`invalid chainId ${chainId}`);
  return chainId;
}

function checkLabel(label: string): void {
  if (!/^[0-9]{1,78}$/.test(label)) throw new Error(`invalid label ${label}: expected a decimal field element`);
}
