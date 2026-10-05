#!/usr/bin/env node
/**
 * Siphon MCP server — Solana Devnet (chain 900002) only.
 *
 * Gives Claude Code, Codex or any MCP client the Siphon vault as tools: private deposits, relayed
 * private payouts, instant private swaps and resting FHE-encrypted limit orders. Every secret (note
 * secrets, the FHE client key, order prices) is made and kept on this machine; proofs are proven
 * here. Funds are Devnet test tokens — this server never touches a mainnet chain.
 *
 * Env (all optional):
 *   SIPHON_SOLANA_KEYPAIR  Solana keypair JSON (`solana-keygen` format). Default: a fresh Devnet
 *                          wallet at ~/.siphon-mcp/devnet-wallet.json, created on first run.
 *   SIPHON_API_KEY         A Devnet API key (sk_…). Default: claimed for the wallet on first use.
 *   SIPHON_HOME            State directory. Default ~/.siphon-mcp (notes, key, zk cache).
 *   SIPHON_API_URL         Default Railway api-gateway.  SOLANA_RPC_URL: default Devnet RPC.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { formatUnits, parseUnits } from "ethers";
import { z } from "zod";
import { solana } from "../../sdk-ts/src";
import { ata } from "../../sdk-ts/src/solana/constants";
import { Store, exclusive, type Note, type OrderRecord } from "./state";

const VERSION = "0.1.0";
const CHAIN = solana.SOLANA_DEVNET_CHAIN_ID;
const HOME = (process.env.SIPHON_HOME || join(homedir(), ".siphon-mcp")).replace(/^~/, homedir());
/** Railway siphon-sol-devnet — not legacy api.siphon.money. */
const API_URL = process.env.SIPHON_API_URL || "https://api-gateway-production-41e4.up.railway.app";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
process.env.SIPHON_ZK_CACHE_DIR ||= join(HOME, "zk"); // the SDK's provers cache circuit files here

type Asset = "SOL" | "USDC";
const ASSET = z.enum(["SOL", "USDC"]);
const MINT: Record<Asset, string> = { SOL: solana.WSOL_MINT.toBase58(), USDC: solana.USDC_MINT.toBase58() };
const assetOfMint = (mint: string): Asset => (mint === MINT.SOL ? "SOL" : "USDC");
const human = (minor: bigint | string, a: Asset) => formatUnits(BigInt(minor), solana.DECIMALS[a]);
const minor = (amount: string, a: Asset) => {
  const v = parseUnits(amount.trim(), solana.DECIMALS[a]);
  if (v <= 0n) throw new Error("amount must be positive");
  return v;
};

// ── wallet + state ────────────────────────────────────────────────────────────────────────────

function loadKeypair(): Keypair {
  const explicit = process.env.SIPHON_SOLANA_KEYPAIR?.replace(/^~/, homedir());
  const file = explicit || join(HOME, "devnet-wallet.json");
  if (!existsSync(file)) {
    if (explicit) throw new Error(`SIPHON_SOLANA_KEYPAIR points at ${file}, which does not exist`);
    // A dedicated Devnet wallet by default — never the user's ~/.config/solana/id.json, which may
    // be a real mainnet wallet.
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
}

const keypair = loadKeypair();
const wallet = solana.keypairWallet(keypair);
const owner = keypair.publicKey.toBase58();
const store = new Store(join(HOME, "devnet", `${owner}.json`), owner);
const connection = new Connection(RPC_URL, "confirmed");

let apiPromise: Promise<solana.SolanaDevnetApi> | null = null;
/** The API client, claiming a free Devnet key and opening the Siphon account on first use. */
function api(): Promise<solana.SolanaDevnetApi> {
  apiPromise ??= (async () => {
    let apiKey = process.env.SIPHON_API_KEY || store.state.apiKey;
    if (!apiKey) {
      // Claiming revokes this wallet's previous Devnet key — fine for the dedicated wallet.
      apiKey = (await solana.SolanaDevnetApi.claimDevnetKey(wallet, { baseUrl: API_URL })).api_key;
      store.state.apiKey = apiKey;
      store.save();
    }
    const a = new solana.SolanaDevnetApi({ apiKey, wallet, baseUrl: API_URL, rpcUrl: RPC_URL });
    if (!store.state.accountId) {
      const { account_id } = await a.createAccount({ chainId: CHAIN, externalRef: owner, idempotencyKey: `acct-${owner}` });
      store.state.accountId = account_id;
      store.save();
    }
    return a;
  })().catch((e) => {
    apiPromise = null;
    throw e;
  });
  return apiPromise;
}

let clientKey: Promise<string> | null = null;
/**
 * The wallet's FHE key, registered with the executor and decryptor once per process. Devnet's
 * decryptor is a mock (no TDX quote), as the dapp accepts with NEXT_PUBLIC_ALLOW_MOCK_TEE: sealing
 * then protects the key in transit only, and the decryptor's operator could read order prices.
 * Acceptable for Devnet test tokens; the tool descriptions and README say so.
 */
function fheKey(a: solana.SolanaDevnetApi): Promise<string> {
  clientKey ??= a.setupFheKeys({ allowMockTee: true }).catch((e) => {
    clientKey = null;
    throw e;
  });
  return clientKey;
}

/** Labels the ASP has admitted (spendable). An admission is permanent unless revoked. */
const admitted = new Set<string>();
async function labelState(a: solana.SolanaDevnetApi, label: string): Promise<"admitted" | "waiting" | "revoked"> {
  if (admitted.has(label)) return "admitted";
  const s = await a.labelStatus(CHAIN, label);
  if (s.revoked) return "revoked";
  if (s.admitted) admitted.add(label);
  return s.admitted ? "admitted" : "waiting";
}

/** Free notes of `asset` the ASP has admitted — what a spend may use. */
async function spendable(a: solana.SolanaDevnetApi, asset: Asset): Promise<Note[]> {
  const out: Note[] = [];
  for (const n of store.free(MINT[asset])) if ((await labelState(a, n.label)) === "admitted") out.push(n);
  return out;
}

/** Deposits whose secrets were saved before sending: keep the ones that landed, drop the rest. */
async function settlePendingDeposits(): Promise<void> {
  const keep: typeof store.state.pendingDeposits = [];
  for (const d of store.state.pendingDeposits) {
    const leaf = await solana.readLeafIndex(connection, d.commitment);
    const savedAt = (d as { savedAt?: number }).savedAt ?? 0;
    if (leaf !== undefined) store.addNote(solana.noteFromDeposit(d, leaf));
    // A Solana transaction cannot land after its blockhash expires (~90 s); an hour is generous.
    else if (Date.now() - savedAt < 3600_000) keep.push(d);
  }
  store.state.pendingDeposits = keep;
  store.save();
}

// ── market ────────────────────────────────────────────────────────────────────────────────────

/** SOL/USD as the executor's fallback sees it: the median of public spot prices. */
async function solUsd(): Promise<number | null> {
  const sources: [string, (j: any) => number][] = [
    ["https://api.coinbase.com/v2/prices/SOL-USD/spot", (j) => Number(j.data.amount)],
    ["https://api.kraken.com/0/public/Ticker?pair=SOLUSD", (j) => Number((Object.values(j.result)[0] as any).c[0])],
    ["https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", (j) => Number(j.price)],
  ];
  const got = (
    await Promise.all(
      sources.map(([url, pick]) =>
        fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).then(pick).catch(() => NaN),
      ),
    )
  ).filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  return got.length ? got[Math.floor(got.length / 2)] : null;
}

// ── orders ────────────────────────────────────────────────────────────────────────────────────

const ENDED = new Set(["FAILED", "ABORTED", "CANCELLED", "EXPIRED"]);

/** Fold the executor's view of each order into the store: claim fills, free what ended unfilled. */
async function reconcileOrders(a: solana.SolanaDevnetApi): Promise<solana.Order[]> {
  const live = await a.orders();
  for (const rec of store.state.orders) {
    if (!rec.id || rec.claimed) continue;
    const o = live.find((x) => x.id === rec.id) ?? (await a.order(rec.id).catch(() => null));
    if (!o) continue;
    rec.status = o.status;
    const ret = await a.claimReturn(o, rec.ret).catch(() => null);
    const tag = `order:${rec.id}`;
    if (ret) {
      store.addNote(ret);
      store.markSpent(rec.reserved);
      store.release(tag); // the order's change note is real now that the spend landed
      rec.claimed = true;
    } else if (ENDED.has(o.status.toUpperCase())) { // the API reports statuses lower-case
      // Unfilled: the inputs were never spent and the change never existed.
      store.state.notes = store.state.notes.filter((n) => !(n.reservedBy === tag && !rec.reserved.includes(n.commitment)));
      store.release(tag);
      rec.claimed = true;
    }
  }
  store.save();
  return live;
}

/**
 * Prove and place one SOL↔USDC order. The order's proof spends the notes it selects when it fires,
 * so those whole notes stay reserved until then; the change note becomes spendable after the fill.
 * ponytail: no carving split first (the dapp carves) — the API split relay fails at its spend step
 * (commit lands, spend 502s; 2026-10-12). Carve here once that relay works.
 */
async function placeOrder(p: {
  kind: "swap" | "order";
  assetIn: Asset;
  amount: bigint;
  strategyType: "LIMIT_SELL" | "LIMIT_BUY";
  upperBound?: number;
  lowerBound?: number;
  windowHours: number;
  maxSlippageBps: number;
}) {
  const a = await api();
  const assetOut: Asset = p.assetIn === "SOL" ? "USDC" : "SOL";
  const notes = await spendable(a, p.assetIn);
  const total = notes.reduce((s, n) => s + BigInt(n.value), 0n);
  if (total < p.amount) {
    throw new Error(`not enough spendable private ${p.assetIn}: have ${human(total, p.assetIn)}, need ${human(p.amount, p.assetIn)} (deposits are spendable once the ASP admits them, ~5 min)`);
  }
  const key = await fheKey(a);
  const idem = randomUUID();
  let rec: OrderRecord | undefined;
  const placed = await a.placeOrder({
    strategyType: p.strategyType,
    assetIn: p.assetIn,
    assetOut,
    amountMinor: p.amount,
    notes,
    clientKey: key,
    upperBound: p.upperBound,
    lowerBound: p.lowerBound,
    windowHours: p.windowHours,
    maxSlippageBps: p.maxSlippageBps,
    executeNow: p.kind === "swap",
    idempotencyKey: idem,
    persist: ({ ret, change, spent }) => {
      const tag = `order:pending-${idem}`;
      rec = { id: "", kind: p.kind, assetIn: p.assetIn, amountMinor: p.amount.toString(), ret, reserved: spent.map((n) => n.commitment), createdAt: new Date().toISOString() };
      store.state.orders.push(rec);
      store.reserve(rec.reserved, tag);
      if (change) store.addNote({ ...change, reservedBy: tag, pendingChange: true });
      store.save();
    },
  }).catch((e) => {
    // Refused before it was placed: nothing was spent.
    if (rec) {
      const tag = `order:pending-${idem}`;
      store.state.notes = store.state.notes.filter((n) => !(n.reservedBy === tag && !rec!.reserved.includes(n.commitment)));
      store.release(tag);
      store.state.orders = store.state.orders.filter((o) => o !== rec);
      store.save();
    }
    throw e;
  });
  rec!.id = placed.strategyId;
  for (const n of store.state.notes) if (n.reservedBy === `order:pending-${idem}`) n.reservedBy = `order:${placed.strategyId}`;
  store.save();
  return { order_id: placed.strategyId, asset_in: p.assetIn, asset_out: assetOut, amount: human(p.amount, p.assetIn) };
}

// ── server ────────────────────────────────────────────────────────────────────────────────────

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (v: unknown): Result => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
function tool<A>(fn: (args: A) => Promise<unknown>, mutates = false) {
  return async (args: A): Promise<Result> => {
    try {
      return ok(await (mutates ? exclusive(() => fn(args)) : fn(args)));
    } catch (e) {
      const status = (e as { status?: number }).status;
      return { isError: true, content: [{ type: "text", text: `${status ? `HTTP ${status}: ` : ""}${e instanceof Error ? e.message : String(e)}` }] };
    }
  };
}

const server = new McpServer(
  { name: "siphon", version: VERSION },
  {
    instructions:
      "Siphon private vault on Solana Devnet (test tokens). Use these tools for private deposits, private payouts to any Solana address, private SOL↔USDC swaps and limit/stop orders with encrypted trigger prices. Start with siphon_wallet and siphon_private_balance. New deposits need ~5 minutes of compliance admission before they are spendable. Keep amounts small: the Devnet swap pool is thin.",
  },
);

server.registerTool(
  "siphon_wallet",
  {
    title: "Devnet wallet",
    description:
      "The public Solana Devnet wallet this server signs with: address, public SOL and USDC balances, and where its Siphon state lives. Use it first, and to see what to fund.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async () => {
    const sol = await connection.getBalance(keypair.publicKey);
    const usdc = await connection
      .getTokenAccountBalance(ata(keypair.publicKey, solana.USDC_MINT))
      .then((b) => b.value.uiAmountString ?? "0")
      .catch(() => "0");
    return {
      network: "Solana Devnet (test tokens, no real value)",
      address: owner,
      public_balance: { SOL: (sol / LAMPORTS_PER_SOL).toString(), USDC: usdc },
      api_key: process.env.SIPHON_API_KEY ? "from SIPHON_API_KEY" : store.state.apiKey ? "free Devnet key (claimed by this server)" : "claimed on first use",
      state_file: store.file,
      funding: sol < 0.05 * LAMPORTS_PER_SOL
        ? "Low on Devnet SOL: get some at https://faucet.solana.com (paste the address). Devnet USDC: https://faucet.circle.com (Solana Devnet)."
        : undefined,
    };
  }),
);

server.registerTool(
  "siphon_private_balance",
  {
    title: "Private balance",
    description:
      "What this wallet holds privately in the Siphon Devnet vault, per asset: spendable (admitted by the compliance ASP), waiting for admission (new deposits, ~5 min), and reserved by open orders. Also picks up deposits that landed after an interruption.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async () => {
    const a = await api();
    await exclusive(settlePendingDeposits);
    const out: Record<string, { spendable: string; waiting_for_admission: string; reserved_by_orders: string; revoked: string; notes: number }> = {};
    for (const asset of ["SOL", "USDC"] as Asset[]) {
      const sum = { spendable: 0n, waiting: 0n, reserved: 0n, revoked: 0n, notes: 0 };
      for (const n of store.state.notes.filter((x) => x.token === MINT[asset] && !x.pendingChange)) {
        sum.notes++;
        if (n.reservedBy) sum.reserved += BigInt(n.value);
        else {
          const s = await labelState(a, n.label);
          sum[s === "admitted" ? "spendable" : s === "revoked" ? "revoked" : "waiting"] += BigInt(n.value);
        }
      }
      out[asset] = {
        spendable: human(sum.spendable, asset),
        waiting_for_admission: human(sum.waiting, asset),
        reserved_by_orders: human(sum.reserved, asset),
        revoked: human(sum.revoked, asset),
        notes: sum.notes,
      };
    }
    return { network: "Solana Devnet", private_balance: out, unconfirmed_deposits: store.state.pendingDeposits.length };
  }),
);

server.registerTool(
  "siphon_market",
  {
    title: "Market and vault status",
    description: "The current SOL/USD price (median of public spot feeds, as the executor's fallback uses) and the Devnet vault's status. Use before choosing an order price.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async () => {
    const a = await api();
    const v = await a.vault();
    return {
      sol_usd: await solUsd(),
      vault: {
        deposits_paused: v.deposits_paused,
        notes_in_tree: v.leaf_count,
        orders_enabled: Boolean(v.settlement_wallet && v.meteora_pool),
        swap_venue: v.meteora_pool ? `Meteora DLMM ${v.meteora_pool} (Devnet pool, thin liquidity — keep orders small)` : null,
      },
    };
  }),
);

server.registerTool(
  "siphon_deposit",
  {
    title: "Private deposit",
    description:
      "Deposit SOL or USDC from the Devnet wallet into the Siphon vault. The note secrets are saved locally before anything is sent. The deposit becomes spendable once the compliance ASP admits it (~5 minutes; check siphon_private_balance).",
    inputSchema: { asset: ASSET, amount: z.string().describe("Human units, e.g. \"0.05\" SOL or \"2\" USDC") },
    annotations: { destructiveHint: false, openWorldHint: true },
  },
  tool(async ({ asset, amount }: { asset: Asset; amount: string }) => {
    const a = await api();
    const dep = await a.depositSolana(store.state.accountId!, {
      asset,
      amount: minor(amount, asset),
      persist: (d) => {
        store.state.pendingDeposits.push({ ...d, savedAt: Date.now() } as typeof d);
        store.save();
      },
    });
    store.state.pendingDeposits = store.state.pendingDeposits.filter((d) => d.commitment !== dep.pending.commitment);
    store.addNote(dep.note);
    store.save();
    return {
      deposited: `${amount} ${asset}`,
      transaction: `https://explorer.solana.com/tx/${dep.signature}?cluster=devnet`,
      status: "waiting for compliance admission (~5 min) — then it is spendable",
    };
  }, true),
);

server.registerTool(
  "siphon_send",
  {
    title: "Private payout",
    description:
      "Pay SOL or USDC from the private balance to any Solana address. The proof is made on this machine and the relayer submits it, so the recipient's transaction is not linked to this wallet. No fee on Devnet.",
    inputSchema: {
      asset: ASSET,
      amount: z.string().describe("Human units"),
      recipient: z.string().describe("Base58 Solana address. For privacy use a fresh address, not this wallet."),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  tool(async ({ asset, amount, recipient }: { asset: Asset; amount: string; recipient: string }) => {
    const a = await api();
    const value = minor(amount, asset);
    new PublicKey(recipient); // throws on a malformed address before any proving
    const notes = await spendable(a, asset);
    const w = await solana.prepareSolanaWithdrawal({ asset, amount: value, recipient, notes, data: a, connection });
    const tag = `payout:${randomUUID()}`;
    store.reserve(w.spent.map((n) => n.commitment), tag);
    if (w.change) store.addNote({ ...w.change, reservedBy: tag, pendingChange: true });
    store.save(); // the change note exists only in this file once the payout lands
    try {
      const r = await a.payoutSolana({ accountId: store.state.accountId!, asset, recipient, amountMinor: value, spend: w.spend, idempotencyKey: tag });
      store.markSpent(w.spent.map((n) => n.commitment));
      store.release(tag);
      store.save();
      return {
        paid: `${amount} ${asset}`,
        to: recipient,
        transaction: r.tx_hash ? `https://explorer.solana.com/tx/${r.tx_hash}?cluster=devnet` : null,
        operation: r.operation.operation_id,
      };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        // Refused: nothing was spent.
        store.state.notes = store.state.notes.filter((n) => !(n.reservedBy === tag && n.commitment === w.change?.commitment));
        store.release(tag);
        store.save();
      }
      // ponytail: an unknown outcome (network error, 5xx) leaves the notes reserved under `tag`
      // rather than risk a double spend; resolve by hand from the state file if it ever happens.
      throw e;
    }
  }, true),
);

server.registerTool(
  "siphon_swap",
  {
    title: "Instant private swap",
    description:
      "Swap SOL↔USDC from the private balance right now: the executor spends the notes, swaps on the Devnet Meteora pool and returns the output to the vault as a new private note. Check with siphon_orders; the output needs ASP admission (~5 min) before it is spendable.",
    inputSchema: {
      from: ASSET.describe("The asset to sell"),
      amount: z.string().describe("Human units of `from`"),
      max_slippage_pct: z.number().min(0.1).max(20).default(2),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  tool(async ({ from, amount, max_slippage_pct }: { from: Asset; amount: string; max_slippage_pct: number }) => {
    // Bounds that are already true, so the execute-now order fires at once:
    // LIMIT_SELL fires when price >= upper; LIMIT_BUY when price <= lower.
    const sell = from === "SOL";
    const r = await placeOrder({
      kind: "swap",
      assetIn: from,
      amount: minor(amount, from),
      strategyType: sell ? "LIMIT_SELL" : "LIMIT_BUY",
      upperBound: sell ? 0 : undefined,
      lowerBound: sell ? undefined : 1_000_000,
      windowHours: 1,
      maxSlippageBps: Math.round(max_slippage_pct * 100),
    });
    return { ...r, status: "submitted — the swap runs now; see siphon_orders" };
  }, true),
);

server.registerTool(
  "siphon_place_order",
  {
    title: "Private limit / stop order",
    description:
      "A resting SOL↔USDC order whose trigger price is FHE-encrypted on this machine — the executor evaluates it without ever seeing it (Devnet's decryptor is not TEE-attested yet, so its operator could). `when: \"at_or_above\"` covers limit sells and take-profits; `\"at_or_below\"` covers limit buys and stop-losses. The notes it spends stay reserved until it fires or is cancelled.",
    inputSchema: {
      sell: ASSET.describe("The asset the order sells (SOL → receives USDC, USDC → receives SOL)"),
      amount: z.string().describe("Human units of `sell`"),
      when: z.enum(["at_or_above", "at_or_below"]).describe("Fire when SOL/USD is at or above / at or below the price"),
      price_usd: z.number().positive().describe("SOL/USD trigger price"),
      expires_hours: z.number().min(1).max(168).default(24),
      max_slippage_pct: z.number().min(0.1).max(20).default(2),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  tool(async (p: { sell: Asset; amount: string; when: "at_or_above" | "at_or_below"; price_usd: number; expires_hours: number; max_slippage_pct: number }) => {
    const above = p.when === "at_or_above";
    const r = await placeOrder({
      kind: "order",
      assetIn: p.sell,
      amount: minor(p.amount, p.sell),
      strategyType: above ? "LIMIT_SELL" : "LIMIT_BUY",
      upperBound: above ? p.price_usd : undefined,
      lowerBound: above ? undefined : p.price_usd,
      windowHours: p.expires_hours,
      maxSlippageBps: Math.round(p.max_slippage_pct * 100),
    });
    return { ...r, trigger: `SOL/USD ${above ? ">=" : "<="} ${p.price_usd} (encrypted)`, expires_in_hours: p.expires_hours };
  }, true),
);

server.registerTool(
  "siphon_orders",
  {
    title: "Orders",
    description: "This wallet's swaps and orders with their status. Claims the output of filled ones into the private balance and frees the notes of ones that ended unfilled.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  tool(async () => {
    const a = await api();
    const live = await reconcileOrders(a);
    return live.map((o) => {
      const rec = store.state.orders.find((r) => r.id === o.id);
      return {
        order_id: o.id,
        kind: rec?.kind,
        status: o.status,
        sells: rec ? `${human(rec.amountMinor, rec.assetIn)} ${rec.assetIn}` : undefined,
        local: !rec?.claimed ? "open" : ENDED.has(o.status.toUpperCase()) ? "ended unfilled — notes released" : "filled — output claimed into the private balance",
        transaction: o.tx_hash ? `https://explorer.solana.com/tx/${o.tx_hash}?cluster=devnet` : undefined,
        error: o.execution_error ?? undefined,
      };
    });
  }, true),
);

server.registerTool(
  "siphon_cancel_order",
  {
    title: "Cancel order",
    description: "Cancel a resting order that has not fired. Its notes become spendable again.",
    inputSchema: { order_id: z.string() },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  tool(async ({ order_id }: { order_id: string }) => {
    const a = await api();
    await a.abort(order_id);
    await reconcileOrders(a);
    return { cancelled: order_id };
  }, true),
);

// Starter prompts — Claude Code lists these as /mcp__siphon__<name>.
const prompt = (name: string, title: string, text: string) =>
  server.registerPrompt(name, { title, description: title }, () => ({ messages: [{ role: "user", content: { type: "text", text } }] }));

prompt(
  "start",
  "Get started with Siphon on Devnet",
  "Use the Siphon MCP tools. Show my Siphon Devnet wallet and private balance. If the wallet has under 0.1 SOL, tell me exactly how to fund it from the Devnet faucets. Then explain in three short lines what a private deposit, a private payout and an encrypted order do.",
);
prompt(
  "first-private-payment",
  "Make a first private payment",
  "Using the Siphon MCP tools on Solana Devnet: deposit 0.05 SOL privately, check siphon_private_balance every minute until it is spendable (the compliance ASP admits deposits in ~5-minute batches), then pay 0.02 SOL privately to a brand-new address and show me the explorer link. Explain why the recipient's transaction is not linked to my wallet.",
);
prompt(
  "encrypted-limit-order",
  "Place an encrypted limit order",
  "Using the Siphon MCP tools: get the SOL/USD price with siphon_market, then place a private order selling 0.02 SOL if SOL/USD rises 5% above the current price, expiring in 24 hours. Show the order id and explain that the trigger price was encrypted on this machine before it left.",
);

await server.connect(new StdioServerTransport());
