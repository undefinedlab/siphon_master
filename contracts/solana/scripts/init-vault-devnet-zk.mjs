/**
 * Initialize Siphon Devnet ZK vault + tree after program deploy.
 *   cd siphon-app && node ../siphon-contracts-v2/solana/scripts/init-vault-devnet-zk.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const appWeb3 = path.resolve(here, "../../../siphon-app/node_modules/@solana/web3.js/lib/index.cjs.js");
const require = createRequire(import.meta.url);
if (!fs.existsSync(appWeb3)) throw new Error(`Missing ${appWeb3}. npm i in siphon-app.`);

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require(appWeb3);

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID ||
    process.env.SIPHON_ZK_PROGRAM_ID ||
    "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH",
);
const MINT = new PublicKey(
  process.env.NEXT_PUBLIC_SOLANA_USDC_MINT || "DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie",
);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
/** PROTOCOL PROGRAM_VERSION limb (v3 compliance split). */
const PROGRAM_VERSION = 5;

function loadKeypair() {
  const raw = process.env.SOLANA_KEYPAIR;
  if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

const [vault] = pda([Buffer.from("siphon-vault-v1")]);
const [tree] = pda([Buffer.from("siphon-tree-v1")]);
const authority = loadKeypair();
const connection = new Connection(RPC, "confirmed");

const vInfo = await connection.getAccountInfo(vault);
if (vInfo) {
  console.log("ZK vault already initialized:", vault.toBase58(), "tree:", tree.toBase58());
  process.exit(0);
}

const version = Buffer.alloc(32);
version.writeUInt32LE(PROGRAM_VERSION, 0);
const data = Buffer.concat([disc("initialize_vault"), version]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: tree, isSigner: false, isWritable: true },
    { pubkey: MINT, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});
const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
console.log("Initialized ZK vault", vault.toBase58(), "tree", tree.toBase58(), "tx", sig);
