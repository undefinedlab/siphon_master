/**
 * Siphon API for Solana Devnet (chain 900002). Same gateway and routes as the v5 EVM lanes; the
 * wallet is a Solana keypair or adapter and signs every intent with ed25519.
 *
 *   const { api_key } = await SolanaDevnetApi.claimDevnetKey(wallet)       // free, Devnet only
 *   const api = new SolanaDevnetApi({ apiKey: api_key, wallet })
 *   const { account_id } = await api.createAccount({ chainId: 900002, externalRef: "me", idempotencyKey: "a1" })
 *   const dep = await api.depositSolana(account_id, { asset: "SOL", amount: 50_000_000n, persist: save })
 *   await api.waitAdmitted(dep.note.label)                                   // ~5-minute ASP batches
 *   const w = await prepareSolanaWithdrawal({ asset: "SOL", amount: …, recipient, notes, data: api, connection: api.connection })
 *   await api.payoutSolana({ accountId: account_id, asset: "SOL", recipient, amountMinor: …, spend: w.spend, idempotencyKey: "p1" })
 *
 * Every secret (note secrets, the FHE client key, order bounds) stays in this process. What crosses
 * the API is checked here against what was built here.
 */
import { randomBytes } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { SiphonApi, type Operation } from "../v5/api";
import { hashPrecommitment, randomUserSalt } from "../v5/noteCrypto";
import { payeeIdEvm } from "../v5/payee";
import { DEFAULT_DEVNET_RPC, DECIMALS, PROGRAM_ID, SOLANA_DEVNET_CHAIN_ID, USDC_MINT, assetIdOf, bytesToHex, le32, mintFor } from "./constants";
import { readLeafIndex, sendDepositTransaction, verifyDepositTransaction } from "./deposit";
import {
  canary,
  deriveClientKey,
  deriveServerKey,
  encryptCents,
  encryptConditionTree,
  encryptPrice,
  sealClientKey,
  type ConditionNode,
  type DecryptorAttestation,
} from "./fhe";
import { noteFromDeposit, noteFromReturn, prepareSolanaDeposit, type PendingSolanaDeposit, type SolanaNote } from "./notes";
import { prepareSolanaSplit, prepareSolanaWithdrawal, readChainHead, type SolanaSpend } from "./prove";
import { solanaApiSigner, type SolanaWallet } from "./wallet";

const CHAIN = SOLANA_DEVNET_CHAIN_ID;
const Q = { chain_id: CHAIN }; // routes with no chain in the path or body bind it from the query

export interface VaultState {
  deposit_nonce: number;
  deposits_paused: boolean;
  scope_id: string;
  leaf_count: number;
  state_root: string;
  admitted_root: string;
  revoked_root: string;
  settlement_wallet: string | null;
  meteora_pool: string | null;
}

/** Secrets of an order's RETURN note — the swap output is deposited under them. Persist first. */
export interface PendingReturn {
  strategyId?: string;
  legIndex?: number;
  nullifier: string;
  secret: string;
  userSalt: string;
  precommitment: string;
  mintOut: string;
}

export interface Order {
  id: string;
  status: string;
  strategy_type?: string | null;
  tx_hash?: string | null;
  execution_error?: string | null;
  settlement?: { waiting?: string; returned_note?: { commitment: string; deposit_nonce: string; leaf_index?: string; amount: string; mint: string } } | null;
  legs?: { leg_index: number; status: string; settlement?: Order["settlement"] }[] | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Human units for the executor's `amount`. The intent hash covers the JSON body, and Python and JS
 * print floats differently below 1e-4 ("1e-05" vs "0.00001") — so such amounts would never verify.
 */
function human(minor: bigint, sym: "SOL" | "USDC"): number {
  const v = Number(minor) / 10 ** DECIMALS[sym];
  if (!(v >= 1e-4)) throw new Error(`order amounts below 0.0001 ${sym} are not supported`);
  return v;
}

export class SolanaDevnetApi extends SiphonApi {
  readonly connection: Connection;
  readonly solWallet: SolanaWallet;

  constructor(opts: { apiKey: string; wallet: SolanaWallet; baseUrl?: string; rpcUrl?: string; fetch?: typeof fetch }) {
    super({ apiKey: opts.apiKey, wallet: solanaApiSigner(opts.wallet), baseUrl: opts.baseUrl, fetch: opts.fetch });
    this.solWallet = opts.wallet;
    this.connection = new Connection(opts.rpcUrl || DEFAULT_DEVNET_RPC, "confirmed");
  }

  get owner(): string {
    return this.solWallet.publicKey.toBase58();
  }

  /** A free Devnet API key for this wallet. Claiming again revokes the previous one. */
  static async claimDevnetKey(wallet: SolanaWallet, opts: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    const api = new SolanaDevnetApi({ apiKey: "", wallet, baseUrl: opts.baseUrl, fetch: opts.fetch });
    const delivery = randomBytes(32);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", delivery));
    const body = { chain_id: CHAIN, delivery_key_sha256: bytesToHex(digest) };
    const headers = { ...(await api.intent(CHAIN, "POST", "/v1/keys/devnet", body)), "X-Delivery-Key": `0x${delivery.toString("hex")}`, "Idempotency-Key": crypto.randomUUID() };
    return api.call<{ api_key: string; api_key_id: string; plan: string; chain_ids: number[] }>("POST", "/v1/keys/devnet", { body, headers });
  }

  vault(): Promise<VaultState> {
    return this.call("GET", `/v1/chains/${CHAIN}/vault`);
  }

  // ── deposits ────────────────────────────────────────────────────────────────────────────────

  /**
   * Prepare, screen, sign and send a deposit, then attach it to its operation. `persist` receives the
   * note secrets BEFORE anything is sent — store them durably, they are the only way to spend it.
   * A deposit landing first moves the vault's nonce; that is retried once with fresh secrets.
   */
  async depositSolana(accountId: string, p: { asset: string; amount: bigint | number | string; persist: (d: PendingSolanaDeposit) => Promise<void> | void }) {
    for (let attempt = 0; ; attempt++) {
      const v = await this.vault();
      if (v.deposits_paused) throw new Error("deposits are paused on the Solana Devnet vault");
      const pending = await prepareSolanaDeposit({ asset: p.asset, amount: p.amount, depositNonce: v.deposit_nonce, scopeId: v.scope_id });
      await p.persist(pending);
      const path = `/v1/accounts/${encodeURIComponent(accountId)}/deposits`;
      const body = {
        chain_id: CHAIN, asset: pending.asset, amount_minor: BigInt(pending.amount),
        precommitment: pending.precommitment, user_salt: pending.userSalt, commitment: pending.commitment,
      };
      let r: { operation: Operation; transactions: { transaction: string }[] };
      try {
        r = await this.call("POST", path, { body, headers: { ...(await this.intent(CHAIN, "POST", path, body)), "Idempotency-Key": crypto.randomUUID() } });
      } catch (e) {
        // 409 from the simulation: the nonce moved under us. One retry with a fresh nonce.
        if (attempt === 0 && (e as { status?: number }).status === 409) continue;
        throw e;
      }
      const tx = await verifyDepositTransaction(r.transactions[0].transaction, this.solWallet.publicKey, pending);
      const signature = await sendDepositTransaction(this.connection, this.solWallet, tx);
      const operation = await this.submitOperation(r.operation.operation_id, CHAIN, signature);
      const note = noteFromDeposit(pending, await readLeafIndex(this.connection, pending.commitment));
      return { pending, note, signature, operation };
    }
  }

  /** Admitted ⇒ spendable. The Solana ASP admits confirmed deposits in ~5-minute batches. */
  async waitAdmitted(label: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
    const until = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
    for (;;) {
      const s = await this.labelStatus(CHAIN, label);
      if (s.revoked) throw new Error("this deposit's label was revoked by the ASP — it can only be ragequit");
      if (s.admitted) {
        // Spendable once a witness is served: the gateway answers 409 until the postman has put the
        // admitted root that contains this label on-chain.
        try {
          await this.complianceWitness(CHAIN, [label]);
          return;
        } catch (e) {
          if ((e as { status?: number }).status !== 409) throw e;
        }
      }
      if (Date.now() > until) throw new Error("waitAdmitted: timed out — the deposit is safe; check again later");
      await sleep(opts.intervalMs ?? 15_000);
    }
  }

  // ── payouts and splits (relayed: no wallet transaction, no fee on Devnet) ────────────────────

  async payoutSolana(p: { accountId: string; asset: string; recipient: string; amountMinor: bigint | number | string; spend: SolanaSpend; idempotencyKey: string; reference?: string }) {
    const amount = BigInt(p.amountMinor);
    const pub = p.spend.public_inputs;
    const recipient = new PublicKey(p.recipient);
    // Bind what policy approves to what the proof pays — the gateway re-checks amount and asset,
    // the program re-checks the payee.
    if (BigInt(pub[0]) !== 0n) throw new Error("payout: the spend is not a WITHDRAW");
    if (BigInt(pub[5]) !== amount) throw new Error("payout: amountMinor differs from the proof's payout (limb 5)");
    if (BigInt(pub[17]) !== assetIdOf(p.asset)) throw new Error("payout: asset differs from the proof's asset (limb 17)");
    if (BigInt(pub[15]) !== (await payeeIdEvm(`0x${bytesToHex(recipient.toBytes().subarray(0, 20))}`))) {
      throw new Error("payout: recipient differs from the proof's payee (limb 15)");
    }
    const body = {
      chain_id: CHAIN, account_id: p.accountId, asset: mintFor(p.asset).asset, recipient: recipient.toBase58(),
      amount_minor: amount, solana_spend: p.spend, reference: p.reference, submission_mode: "relay",
    };
    return this.call<{ operation: Operation; tx_hash: string | null }>("POST", "/v1/payouts", {
      body, headers: { ...(await this.intent(CHAIN, "POST", "/v1/payouts", body)), "Idempotency-Key": p.idempotencyKey },
    });
  }

  async split(p: { accountId: string; spend: SolanaSpend; splitCommitments: string[]; idempotencyKey: string }) {
    const body = { chain_id: CHAIN, account_id: p.accountId, solana_spend: p.spend, split_commitments: p.splitCommitments };
    return this.call<{ operation: Operation; tx_hash: string | null }>("POST", "/v1/splits", {
      body, headers: { ...(await this.intent(CHAIN, "POST", "/v1/splits", body)), "Idempotency-Key": p.idempotencyKey },
    });
  }

  /** Wait until the tree holds `leaves` (the split's slices are indexed and on-chain). */
  async waitForLeaves(leaves: bigint[], timeoutMs = 3 * 60_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const head = await readChainHead(this.connection);
      const got = await this.stateLeaves(CHAIN).catch(() => [] as bigint[]);
      if (got.length >= leaves.length && leaves.every((l, i) => got[i] === l)) {
        const { computeStateRoot } = await import("../v5/stateTree");
        if ((await computeStateRoot(got)) === head.stateRoot) return;
      }
      if (Date.now() > until) throw new Error("the split landed but the tree has not caught up — retry shortly");
      await sleep(3_000);
    }
  }

  // ── FHE keys (orders) ───────────────────────────────────────────────────────────────────────

  private async signedPut(path: string, body: Record<string, unknown>, method = "PUT") {
    return this.call<Record<string, unknown>>(method, path, { body, query: Q, headers: await this.intent(CHAIN, method, path, body) });
  }

  /**
   * Make sure the executor can evaluate and the decryptor can read this wallet's orders: the server
   * key on file, the client key sealed to the decryptor, and a canary proving they are one generation.
   * Returns the client key, which encrypts the order bounds.
   */
  async setupFheKeys(opts: { allowMockTee?: boolean } = {}): Promise<string> {
    const clientKey = await deriveClientKey(this.solWallet);
    const status = await this.call<{ server_key_present: boolean }>("GET", "/v1/fhe-keys", { query: Q, headers: await this.read(CHAIN) });
    const uploadServer = async () =>
      this.signedPut("/v1/fhe-keys/server", { server_key: await deriveServerKey(clientKey), canary: await canary(clientKey) });
    if (!status.server_key_present) await uploadServer();
    const att = await this.call<DecryptorAttestation>("GET", "/v1/fhe-keys/attestation");
    await this.signedPut("/v1/fhe-keys/client", { client_key: await sealClientKey(clientKey, att, opts) });
    const check = async () => (await this.signedPut("/v1/fhe-keys/self-check", { encrypted_canary: await canary(clientKey) }, "POST")).consistent === true;
    if (await check()) return clientKey;
    await uploadServer(); // a server key from another key generation was on file
    if (!(await check())) throw new Error("FHE keys are still inconsistent after re-upload — the decryptor may have restarted; retry");
    return clientKey;
  }

  // ── orders ──────────────────────────────────────────────────────────────────────────────────

  private async orderLeg(p: { assetIn: string; amountMinor: bigint; notes: SolanaNote[]; settlement: string; pool: string }) {
    const pairIn = mintFor(p.assetIn);
    const w = await prepareSolanaWithdrawal({ asset: pairIn.asset, amount: p.amountMinor, recipient: p.settlement, notes: p.notes, data: this, connection: this.connection });
    const nullifier = randomUserSalt();
    const secret = randomUserSalt();
    const userSalt = randomUserSalt();
    const mintOut = pairIn.asset === "SOL" ? USDC_MINT : mintFor("SOL").mint;
    const ret: PendingReturn = {
      nullifier: nullifier.toString(), secret: secret.toString(), userSalt: userSalt.toString(),
      precommitment: (await hashPrecommitment(nullifier, secret)).toString(), mintOut: mintOut.toBase58(),
    };
    const n = Number(w.spend.public_inputs[1]);
    const pkg = {
      venue: "meteora-dlmm",
      program_id: PROGRAM_ID.toBase58(),
      circuit: `withdraw${n}`,
      circuit_index: w.spend.circuit_index,
      binder_hex: randomBytes(32).toString("hex"),
      proof_hex: w.spend.proof_hex,
      publics: w.spend.public_inputs,
      nullifiers_hex: w.spend.public_inputs.slice(9, 9 + n).map((x) => bytesToHex(le32(BigInt(x)))),
      mint: pairIn.mint.toBase58(),
      settlement: p.settlement,
      meteora_pool: p.pool,
      solana_side: pairIn.asset === "SOL" ? "sell_wsol" : "sell_usdc",
      solana_mint: pairIn.mint.toBase58(),
      solana_usdc_mint: USDC_MINT.toBase58(),
      state_root: w.spend.public_inputs[2],
      amount_base_units: w.plan.primaryValue.toString(),
      commitment_hex: bytesToHex(le32(BigInt(w.plan.selected[0].commitment))),
      return_precommitment: ret.precommitment,
      return_user_salt: ret.userSalt,
    };
    return { pkg, ret, spent: w.spent, change: w.change };
  }

  private async settlement(): Promise<{ wallet: string; pool: string }> {
    const v = await this.vault();
    if (!v.settlement_wallet || !v.meteora_pool) throw new Error("the Devnet executor has no settlement wallet or Meteora pool configured");
    return { wallet: v.settlement_wallet, pool: v.meteora_pool };
  }

  private async createStrategy(body: Record<string, unknown>, idempotencyKey: string) {
    return this.call<{ id: string; status: string }>("POST", "/v1/strategies", {
      body, headers: { ...(await this.intent(CHAIN, "POST", "/v1/strategies", body)), "Idempotency-Key": idempotencyKey },
    });
  }

  /**
   * A resting SOL↔USDC order (limit, stop-loss, take-profit…). The input is proven now as a spend to
   * the settlement wallet; when the encrypted trigger fires the executor spends, swaps on Meteora and
   * deposits the output under `return` — a note only this wallet can open (see `claimReturn`).
   * `persist` gets the return-note secrets and the change note BEFORE the order is placed.
   */
  async placeOrder(p: {
    strategyType: string;
    assetIn: string;
    assetOut: string;
    amountMinor: bigint | number | string;
    notes: SolanaNote[];
    clientKey: string;
    /** Bounds in dollars, or a condition tree with plaintext LEAF bounds (encrypted here). */
    upperBound?: number;
    lowerBound?: number;
    conditionTree?: ConditionNode;
    windowHours?: number;
    maxSlippageBps?: number;
    executeNow?: boolean;
    idempotencyKey: string;
    persist: (r: { ret: PendingReturn; change: SolanaNote | null; spent: SolanaNote[] }) => Promise<void> | void;
  }) {
    const { asset: inSym } = mintFor(p.assetIn);
    const { asset: outSym } = mintFor(p.assetOut);
    if (inSym === outSym) throw new Error("orders swap SOL ↔ USDC");
    const s = await this.settlement();
    const leg = await this.orderLeg({ assetIn: inSym, amountMinor: BigInt(p.amountMinor), notes: p.notes, settlement: s.wallet, pool: s.pool });
    await p.persist(leg);
    const triggers = p.conditionTree
      ? { condition_tree: await encryptConditionTree(p.conditionTree, p.clientKey) }
      : { encrypted_upper_bound: await encryptPrice(p.upperBound ?? 0, p.clientKey), encrypted_lower_bound: await encryptPrice(p.lowerBound ?? 0, p.clientKey) };
    const body = {
      strategy_type: p.strategyType,
      asset_in: inSym,
      asset_out: outSym,
      amount: human(BigInt(p.amountMinor), inSym),
      recipient_address: this.owner,
      from_chain: String(CHAIN),
      to_chain: String(CHAIN),
      output_mode: "vault",
      ...triggers,
      max_slippage_bps: p.maxSlippageBps ?? 100,
      execution_window_sec: Math.round((p.windowHours ?? 24) * 3600),
      schedule_anchor: Math.floor(Date.now() / 1000),
      is_private: true,
      zk_proof: leg.pkg,
      solana_side: leg.pkg.solana_side,
      ...(p.executeNow ? { execute_now: true } : {}),
    };
    const r = await this.createStrategy(body, p.idempotencyKey);
    return { strategyId: r.id, ret: { ...leg.ret, strategyId: r.id }, change: leg.change, spent: leg.spent };
  }

  /**
   * TWAP / DCA (time legs) or RANGE_GRID (price rungs). One note is split into a slice per leg via a
   * relayed split, then each slice is proven as its own order leg with its own return note.
   */
  async placeMultiLeg(p: {
    kind: "TWAP" | "DCA" | "RANGE_GRID";
    accountId: string;
    assetIn: string;
    assetOut: string;
    amountMinor: bigint | number | string;
    legs: number;
    /** TWAP/DCA: seconds between legs. */
    intervalSec?: number;
    /** RANGE_GRID: the dollar range the rungs span. */
    low?: number;
    high?: number;
    note: SolanaNote;
    clientKey: string;
    windowHours?: number;
    maxSlippageBps?: number;
    idempotencyKey: string;
    persist: (r: { slices: SolanaNote[]; rets: PendingReturn[] }) => Promise<void> | void;
  }) {
    const { asset: inSym } = mintFor(p.assetIn);
    const { asset: outSym } = mintFor(p.assetOut);
    const n = Math.floor(p.legs);
    const total = BigInt(p.amountMinor);
    if (!(n >= 2 && n <= 8)) throw new Error("multi-leg orders run 2 to 8 legs");
    const noteValue = BigInt(p.note.value);
    if (noteValue < total) throw new Error("the note is smaller than the order");
    if (noteValue > total && n > 7) throw new Error("use at most 7 legs, or a note of exactly the order's size");
    const each = total / BigInt(n);
    if (each <= 0n) throw new Error("amount too small for that many legs");
    const values = Array.from({ length: n }, (_, i) => (i === n - 1 ? total - each * BigInt(n - 1) : each));
    if (noteValue > total) values.push(noteValue - total); // the leftover stays in the vault

    const split = await prepareSolanaSplit({ note: p.note, values, data: this, connection: this.connection });
    await p.persist({ slices: split.slices, rets: [] });
    await this.split({ accountId: p.accountId, spend: split.spend, splitCommitments: split.splitCommitments, idempotencyKey: `${p.idempotencyKey}:split` });
    await this.waitForLeaves(split.leavesAfter);

    const s = await this.settlement();
    const timed = p.kind !== "RANGE_GRID";
    const interval = Math.max(1, Math.floor(p.intervalSec ?? 60));
    const stepPrice = n > 1 ? ((p.high ?? 0) - (p.low ?? 0)) / (n - 1) : 0;
    const legs: Record<string, unknown>[] = [];
    const rets: PendingReturn[] = [];
    for (let i = 0; i < n; i++) {
      const leg = await this.orderLeg({ assetIn: inSym, amountMinor: values[i], notes: [split.slices[i]], settlement: s.wallet, pool: s.pool });
      rets.push({ ...leg.ret, legIndex: i });
      // Same triggers as the dapp (multiLegBuilder): legs fire at i·interval; every grid rung trades
      // the deposit's direction — buy rungs when paying USDC, sell rungs when paying SOL.
      const trigger = timed
        ? { eval_mode: "time", encrypted_lower_bound: await encryptCents(BigInt(i * interval), p.clientKey) }
        : inSym === "USDC"
          ? { eval_mode: "price", side: "LIMIT_BUY", encrypted_lower_bound: await encryptPrice((p.low ?? 0) + i * stepPrice, p.clientKey) }
          : { eval_mode: "price", side: "LIMIT_SELL", encrypted_upper_bound: await encryptPrice((p.low ?? 0) + i * stepPrice, p.clientKey) };
      legs.push({ leg_index: i, amount: human(values[i], inSym), ...trigger, zk_proof: leg.pkg });
    }
    await p.persist({ slices: split.slices, rets });
    // Later legs must not expire before they fire.
    const windowHours = timed ? Math.max(p.windowHours ?? 24, ((n - 1) * interval + 3600) / 3600) : (p.windowHours ?? 24);
    const body = {
      strategy_type: p.kind,
      asset_in: inSym,
      asset_out: outSym,
      amount: human(total, inSym),
      recipient_address: this.owner,
      from_chain: String(CHAIN),
      to_chain: String(CHAIN),
      output_mode: "vault",
      legs,
      ...(timed ? { interval_sec: interval } : { grid_levels: n }),
      max_slippage_bps: p.maxSlippageBps ?? 100,
      schedule_anchor: Math.floor(Date.now() / 1000),
      execution_window_sec: Math.round(windowHours * 3600),
      is_private: true,
      solana_side: inSym === "SOL" ? "sell_wsol" : "sell_usdc",
    };
    const r = await this.createStrategy(body, p.idempotencyKey);
    return { strategyId: r.id, rets: rets.map((x) => ({ ...x, strategyId: r.id })), slices: split.slices };
  }

  async orders(): Promise<Order[]> {
    return (await this.call<{ strategies: Order[] }>("GET", "/v1/strategies", { query: Q, headers: await this.read(CHAIN) })).strategies;
  }

  order(id: string): Promise<Order> {
    return this.read(CHAIN).then((headers) => this.call<Order>("GET", `/v1/strategies/${encodeURIComponent(id)}`, { query: Q, headers }));
  }

  async abort(id: string) {
    const path = `/v1/strategies/${encodeURIComponent(id)}/abort`;
    return this.call("POST", path, { body: {}, query: Q, headers: await this.intent(CHAIN, "POST", path, {}) });
  }

  /**
   * An order (or leg) whose settlement waits on NEEDS_REPROOF cites roots the program dropped. Prove
   * the SAME reserved notes again and hand the executor the fresh package; the trigger is unchanged.
   */
  async reprove(p: { strategyId: string; legIndex?: number; assetIn: string; amountMinor: bigint; notes: SolanaNote[]; ret: PendingReturn }) {
    const s = await this.settlement();
    const leg = await this.orderLeg({ assetIn: p.assetIn, amountMinor: p.amountMinor, notes: p.notes, settlement: s.wallet, pool: s.pool });
    const zkp_data = { ...leg.pkg, return_precommitment: p.ret.precommitment, return_user_salt: p.ret.userSalt };
    const path = `/v1/strategies/${encodeURIComponent(p.strategyId)}/reprove`;
    const body = { zkp_data, ...(p.legIndex !== undefined ? { leg_index: p.legIndex } : {}) };
    return this.call("POST", path, { body, query: Q, headers: await this.intent(CHAIN, "POST", path, body) });
  }

  /** The note a filled order (or leg) returned to the vault, opened with the secrets kept at arm time. */
  async claimReturn(order: Order, ret: PendingReturn): Promise<SolanaNote | null> {
    const settlement = ret.legIndex !== undefined ? order.legs?.find((l) => l.leg_index === ret.legIndex)?.settlement : order.settlement;
    const returned = settlement?.returned_note;
    if (!returned) return null;
    return noteFromReturn({ returned, nullifier: ret.nullifier, secret: ret.secret, userSalt: ret.userSalt });
  }
}
