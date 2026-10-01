/**
 * Bootstrap all 14 VK PDAs on Devnet (init_vk_pda + write_vk_chunk).
 *   cd siphon-app && node ../siphon-contracts-v2/solana/scripts/upload-vk-devnet.mjs
 *
 * Idempotent: skips circuits whose PDA already matches the local .vk.bin.
 * Pace txs to avoid public Devnet RPC 429s.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// VK_DIR picks the set: target/deploy/vk-ceremony (MPC ceremony, matches the app) is the product set.
const vkDir = process.env.VK_DIR ? path.resolve(process.env.VK_DIR) : path.join(root, "target", "deploy", "vk");
const appWeb3 = path.resolve(here, "../../../siphon-app/node_modules/@solana/web3.js/lib/index.cjs.js");
const require = createRequire(import.meta.url);
if (!fs.existsSync(appWeb3)) throw new Error(`Missing ${appWeb3}`);

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require(appWeb3);

const CIRCUITS = [
  "withdraw1", "withdraw2", "withdraw3", "withdraw4", "withdraw5", "withdraw6",
  "merge2", "merge3", "merge4", "merge5", "merge6",
  "swap", "split", "ragequit",
];

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID ||
    process.env.SIPHON_ZK_PROGRAM_ID ||
    "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH",
);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const CHUNK = 900;
const VK_BYTES = 2120;
const TX_PAUSE_MS = Number(process.env.VK_UPLOAD_PAUSE_MS || 800);

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair() {
  const raw = process.env.SOLANA_KEYPAIR;
  if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

function u8(n) {
  return Buffer.from([n]);
}

function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function vecU8(data) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  return Buffer.concat([len, data]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTx(connection, payer, ix) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await sleep(TX_PAUSE_MS);
      return await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], {
        commitment: "confirmed",
        skipPreflight: false,
      });
    } catch (e) {
      const msg = String(e?.message || e);
      const rateLimited = msg.includes("429") || /Too many requests/i.test(msg);
      if (!rateLimited || attempt === 7) throw e;
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      console.warn(`rate-limited; retry in ${wait}ms`);
      await sleep(wait);
    }
  }
}

const payer = loadKeypair();
const connection = new Connection(RPC, "confirmed");
const [vault] = pda([Buffer.from("siphon-vault-v1")]);
const registry = {};

for (let ci = 0; ci < CIRCUITS.length; ci++) {
  const name = CIRCUITS[ci];
  const binPath = path.join(vkDir, `${name}.vk.bin`);
  if (!fs.existsSync(binPath)) {
    console.warn(`SKIP ${name} — run node scripts/export-vk-accounts.mjs first`);
    continue;
  }
  const blob = fs.readFileSync(binPath);
  if (blob.length < VK_BYTES) throw new Error(`${binPath} too short`);

  const [vk] = pda([Buffer.from("siphon-vk-v1"), u8(ci)]);
  const existing = await connection.getAccountInfo(vk);
  if (existing && existing.data.length >= VK_BYTES && existing.data.subarray(0, VK_BYTES).equals(blob.subarray(0, VK_BYTES))) {
    registry[name] = { circuitIndex: ci, vk: vk.toBase58(), skipped: true };
    console.log(`OK ${name} already uploaded → ${vk.toBase58()}`);
    continue;
  }

  if (!existing) {
    const initData = Buffer.concat([disc("init_vk_pda"), u8(ci)]);
    const initIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: vk, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initData,
    });
    await sendTx(connection, payer, initIx);
    console.log(`init_vk_pda ${name} → ${vk.toBase58()}`);
  }

  for (let off = 0; off < VK_BYTES; off += CHUNK) {
    const chunk = blob.subarray(off, Math.min(off + CHUNK, VK_BYTES));
    const data = Buffer.concat([disc("write_vk_chunk"), u16le(off), vecU8(chunk)]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: vk, isSigner: false, isWritable: true },
      ],
      data,
    });
    await sendTx(connection, payer, ix);
  }
  registry[name] = { circuitIndex: ci, vk: vk.toBase58() };
  console.log(`Uploaded VK ${name} (${VK_BYTES} B)`);
}

const out = path.join(vkDir, "devnet-addresses.json");
fs.mkdirSync(vkDir, { recursive: true });
fs.writeFileSync(out, JSON.stringify(registry, null, 2));
console.log(`Wrote ${out}`);
