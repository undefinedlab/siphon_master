/**
 * Name the ASP postman for the Devnet ZK vault (authority-only `set_postman`).
 *
 * The postman key signs `publish_roots` from the ASP host; the vault authority (also the
 * program upgrade authority) stays on this machine. Run once per postman rotation.
 *
 *   cd siphon-app
 *   node ../siphon-contracts-v2/solana/scripts/set-postman-devnet.mjs <POSTMAN_PUBKEY>
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../../../siphon-app");
const require = createRequire(import.meta.url);
const web3 = require(path.join(app, "node_modules/@solana/web3.js/lib/index.cjs.js"));
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } =
  web3;

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID || "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH",
);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const postmanArg = process.argv[2];
if (!postmanArg) {
  console.error("usage: set-postman-devnet.mjs <POSTMAN_PUBKEY>");
  process.exit(1);
}
const postman = new PublicKey(postmanArg);

// SOLANA_KEYPAIR (JSON array) when the vault authority is not the CLI default key.
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(
    process.env.SOLANA_KEYPAIR ||
      fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf8"),
  )),
);
const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seed) => PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];

const vault = pda("siphon-vault-v1");
const postmanConfig = pda("siphon-postman-v1");
const connection = new Connection(RPC, "confirmed");

// publish_roots writes an EXISTING compliance account; a fresh vault has none until the authority
// creates it. Zero roots: the postman's first publish replaces them.
const compliance = pda("siphon-compliance-v1");
if (!(await connection.getAccountInfo(compliance, "confirmed"))) {
  const csig = await sendAndConfirmTransaction(connection, new Transaction().add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: compliance, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("set_compliance"), Buffer.alloc(32), Buffer.alloc(32)]),
  })), [authority], { commitment: "confirmed" });
  console.log("set_compliance (zero roots)", compliance.toBase58(), csig);
}

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: false },
    { pubkey: postmanConfig, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc("set_postman"), postman.toBuffer()]),
});
const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority], {
  commitment: "confirmed",
});
const info = await connection.getAccountInfo(postmanConfig, "confirmed");
const stored = new PublicKey(info.data.subarray(9, 41));
if (!stored.equals(postman)) throw new Error(`postman PDA holds ${stored.toBase58()}, expected ${postman.toBase58()}`);
console.log("set_postman", postmanConfig.toBase58(), "→", postman.toBase58(), sig);
