/**
 * Initialize Siphon Devnet vault after program deploy.
 * Usage (prefer from siphon-app so @solana/web3.js resolves):
 *   cd siphon-app && node ../siphon-contracts-v2/solana/scripts/init-vault-devnet.mjs
 *
 * Requires wallet keypair at ~/.config/solana/id.json or SOLANA_KEYPAIR env (JSON byte array).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const appWeb3 = path.resolve(
  here,
  "../../../siphon-app/node_modules/@solana/web3.js/lib/index.cjs.js",
);
const require = createRequire(import.meta.url);
if (!fs.existsSync(appWeb3)) {
  throw new Error(
    `Missing ${appWeb3}. Run from repo with siphon-app deps installed, or: cd siphon-app && npm i`,
  );
}
const web3 = require(appWeb3);
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = web3;

const PROGRAM_ID = new PublicKey(
  process.env.SIPHON_PROGRAM_ID || "Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj",
);
const MINT = new PublicKey(
  process.env.NEXT_PUBLIC_SOLANA_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function loadKeypair() {
  const raw = process.env.SOLANA_KEYPAIR;
  if (raw) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  const bytes = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from("siphon-vault-v1")],
  PROGRAM_ID,
);
const authority = loadKeypair();
const connection = new Connection(RPC, "confirmed");
const info = await connection.getAccountInfo(vault);
if (info) {
  console.log("Vault already initialized:", vault.toBase58());
  process.exit(0);
}

const data = Buffer.concat([disc("initialize_vault"), Buffer.alloc(32)]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: MINT, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});
const tx = new Transaction().add(ix);
const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
console.log("Initialized vault", vault.toBase58(), "tx", sig);
