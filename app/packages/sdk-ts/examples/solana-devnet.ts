/**
 * Solana Devnet end to end through the Siphon API: free key → account → private SOL deposit → ASP
 * admission → relayed private payout to a fresh wallet (no fee, no wallet transaction).
 *
 *   SOLANA_KEYPAIR=~/.config/solana/id.json bun examples/solana-devnet.ts [lamports]
 *
 * The wallet needs ~0.1 devnet SOL. Note secrets go to ./solana-notes.json BEFORE anything is sent —
 * keep that file: it is the only way to spend what this deposits.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { Keypair } from "@solana/web3.js";
import { solana } from "../src";

const path = (process.env.SOLANA_KEYPAIR || `${homedir()}/.config/solana/id.json`).replace(/^~/, homedir());
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const wallet = solana.keypairWallet(kp);
const amount = BigInt(process.argv[2] || "20000000"); // 0.02 SOL
const store = "./solana-notes.json";
const saved: unknown[] = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : [];
const persist = (x: unknown) => writeFileSync(store, JSON.stringify([...saved, x], null, 2));
const baseUrl = process.env.SIPHON_API_URL;

console.log("wallet", kp.publicKey.toBase58());
const apiKey = process.env.SIPHON_API_KEY || (await solana.SolanaDevnetApi.claimDevnetKey(wallet, { baseUrl })).api_key;
const api = new solana.SolanaDevnetApi({ apiKey, wallet, baseUrl, rpcUrl: process.env.SOLANA_RPC_URL });
const { account_id } = await api.createAccount({ chainId: solana.SOLANA_DEVNET_CHAIN_ID, externalRef: kp.publicKey.toBase58(), idempotencyKey: `acct-${kp.publicKey.toBase58()}` });
console.log("account", account_id);

const dep = await api.depositSolana(account_id, { asset: "SOL", amount, persist });
console.log("deposited", dep.signature, "leaf", dep.note.leafIndex);
console.log("waiting for ASP admission (~5 min batches)…");
await api.waitAdmitted(dep.note.label);

const recipient = Keypair.generate().publicKey.toBase58();
const w = await solana.prepareSolanaWithdrawal({ asset: "SOL", amount: amount / 2n, recipient, notes: [dep.note], data: api, connection: api.connection });
if (w.change) persist({ change: w.change });
const r = await api.payoutSolana({ accountId: account_id, asset: "SOL", recipient, amountMinor: amount / 2n, spend: w.spend, idempotencyKey: `pay-${dep.note.commitment}` });
console.log("paid", amount / 2n, "lamports of WSOL to", recipient, "— tx", r.tx_hash, "op", r.operation.operation_id);
