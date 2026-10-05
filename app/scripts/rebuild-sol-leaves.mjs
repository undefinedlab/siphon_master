/**
 * Diagnose fetchZkStateLeaves against live Devnet.
 * Run: node scripts/rebuild-sol-leaves.mjs
 */
import { createHash } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function leToField(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}
function disc(name) {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

const programId = new PublicKey("F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH");
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("siphon-vault-v1")], programId);
const [tree] = PublicKey.findProgramAddressSync([Buffer.from("siphon-tree-v1")], programId);
const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const conn = new Connection(rpc, "confirmed");

const treeInfo = await conn.getAccountInfo(tree, "confirmed");
const nextIndex = Number(treeInfo.data.readBigUInt64LE(16));
console.log("rpc", rpc);
console.log("nextIndex", nextIndex);

const depositDisc = disc("DepositEvent");
const changeDisc = disc("LeafInserted");
const DEPOSIT_FIELDS = 32 + 32 + 32 + 8 + 8;
const CHANGE_FIELDS = 32 + 8;

const sigs = [];
let before;
for (;;) {
  const page = await conn.getSignaturesForAddress(vault, { before, limit: 1000 }, "confirmed");
  for (const s of page) if (!s.err) sigs.push(s.signature);
  if (page.length < 1000) break;
  before = page[page.length - 1].signature;
}
console.log("sigs", sigs.length);

const found = new Map();
let nullTx = 0;
let noLogs = 0;
const BATCH = 5;
for (let i = 0; i < sigs.length; i += BATCH) {
  if (i > 0) await new Promise((r) => setTimeout(r, 80));
  let txs;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      txs = await Promise.all(
        sigs.slice(i, i + BATCH).map((sig) =>
          conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
        ),
      );
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("batch", i, "attempt", attempt, msg.slice(0, 80));
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  if (!txs) throw new Error("batch failed after retries at " + i);
  for (const t of txs) {
    if (!t) {
      nullTx++;
      continue;
    }
    const logs = t.meta?.logMessages ?? [];
    if (logs.length === 0) noLogs++;
    for (const line of logs) {
      if (!line.startsWith("Program data: ")) continue;
      const raw = Buffer.from(line.slice("Program data: ".length), "base64");
      if (raw.length < 8) continue;
      const body = raw.subarray(8);
      if (depositDisc.equals(raw.subarray(0, 8)) && body.length >= DEPOSIT_FIELDS) {
        const commitment = body.subarray(64, 96);
        const idx = Number(body.readBigUInt64LE(96));
        found.set(idx, leToField(commitment));
      } else if (changeDisc.equals(raw.subarray(0, 8)) && body.length >= CHANGE_FIELDS) {
        const commitment = body.subarray(0, 32);
        const idx = Number(body.readBigUInt64LE(32));
        found.set(idx, leToField(commitment));
      }
    }
  }
  if (i % 50 === 0) console.log("progress", i, "/", sigs.length, "found", found.size);
}

const missing = [];
for (let i = 0; i < nextIndex; i++) if (!found.has(i)) missing.push(i);
console.log("found", found.size, "nullTx", nullTx, "noLogs", noLogs, "missing", missing.slice(0, 20));
if (missing.length) process.exit(1);
console.log("OK contiguous", nextIndex);
