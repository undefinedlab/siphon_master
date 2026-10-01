/**
 * Relay a Devnet ZK withdraw or split: the relayer (settlement keypair) commits the browser-built
 * publics and submits the spend, paying fees and rent, so the user signs nothing. A withdraw's
 * proof binds the payee (limb 15), so the relayer can only pay the recipient the user proved for;
 * a split pays no one — its 8 commitments are re-hashed on chain to the proof's MerkleRoot8.
 *
 * stdin: { program_id?, publics[25], proof_hex, binder_hex, nullifiers_hex[], circuit_index,
 *          mint + recipient (withdraw) | split_commitments_hex[8] (split) }
 * stdout: one JSON line.
 *   exit 0  { ok: true, commit_sig, spend_sig }
 *   exit 3  NEEDS_REPROOF — nothing sent (a root the proof cites is no longer accepted)
 *   exit 1  FAILED
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} = require("@solana/spl-token");

const SPEND_CU = 1_400_000;
const WSOL = "So11111111111111111111111111111111111111112";

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function fail(code, error) {
  emit({ ok: false, code, error });
  process.exit(code === "NEEDS_REPROOF" ? 3 : 1);
}

function loadKeypair() {
  const raw = (process.env.SOLANA_RELAYER_KEYPAIR || "").trim();
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  if (raw && !raw.includes(path.sep) && raw.length > 80) return Keypair.fromSecretKey(Buffer.from(raw, "base64"));
  const p = raw && fs.existsSync(raw) ? raw : path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
function fieldToLe32(x) {
  const b = Buffer.alloc(32);
  let v = BigInt(x);
  for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
const anchorCode = (err) => {
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(String(err?.message || err));
  return m ? parseInt(m[1], 16) : null;
};

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const pkg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const publics = pkg.publics;
if (!Array.isArray(publics) || publics.length !== 25) fail("BAD_PACKAGE", "publics must be 25 limbs");
const split = Array.isArray(pkg.split_commitments_hex);
const action = BigInt(publics[0]);
if (split ? action !== 3n : action !== 0n) fail("BAD_PACKAGE", "only WITHDRAW (0) and SPLIT (3) are relayed");
if (!pkg.proof_hex || pkg.proof_hex.length !== 512) fail("BAD_PACKAGE", "proof_hex must be 256 bytes");
if (!pkg.binder_hex || pkg.binder_hex.length !== 64) fail("BAD_PACKAGE", "binder_hex must be 32 bytes");
const circuitIndex = Number(pkg.circuit_index);
if (split ? circuitIndex !== 12 : !(circuitIndex >= 0 && circuitIndex <= 5)) {
  fail("BAD_PACKAGE", "circuit_index must be a withdraw (0-5) or the split (12)");
}
if (split && (pkg.split_commitments_hex.length !== 8 || pkg.split_commitments_hex.some((h) => !/^[0-9a-f]{64}$/i.test(h)))) {
  fail("BAD_PACKAGE", "split_commitments_hex must be 8 × 32 bytes");
}
const nullifiers = (pkg.nullifiers_hex || []).map((h) => Buffer.from(h, "hex"));
if (!nullifiers.length || nullifiers.length > 6) fail("BAD_PACKAGE", "nullifiers_hex: 1 to 6");

const programId = new PublicKey(pkg.program_id || process.env.SIPHON_ZK_PROGRAM_ID);
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const payer = loadKeypair();
const recipient = split ? null : new PublicKey(pkg.recipient);
const mint = split ? null : new PublicKey(pkg.mint);
const seed = (s, ...extra) => PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], programId)[0];
const vault = seed("siphon-vault-v1");
const tree = seed("siphon-tree-v1");
const compliance = seed("siphon-compliance-v1");
const binder = Buffer.from(pkg.binder_hex, "hex");
const pending = seed("siphon-pending-inputs-v1", binder);

const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
if (!vaultInfo) fail("NO_VAULT", "ZK vault missing");
// VaultAccount: … allowed_mint at 114, vk_accounts at 178 (see execute-zk-meteora.mjs).
const allowed = new PublicKey(vaultInfo.data.subarray(114, 146));
if (mint && !mint.equals(allowed) && mint.toBase58() !== WSOL) fail("BAD_PACKAGE", `mint ${mint.toBase58()} is not held by this vault`);
if (await connection.getAccountInfo(seed("siphon-nf-v1", nullifiers[0]), "confirmed")) fail("SPENT", "this note is already spent");

let commitSig = null;
// ponytail: a junk package still costs the relayer the pending account's rent once the commit lands;
// devnet only, behind a Phantom session and a rate limit. Verify the Groth16 proof first if this is
// ever exposed beyond devnet.
if (!(await connection.getAccountInfo(pending, "confirmed"))) {
  commitSig = await sendAndConfirmTransaction(connection, new Transaction().add(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: pending, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("commit_public_inputs"), binder, ...publics.map(fieldToLe32)]),
  })), [payer], { commitment: "confirmed" });
}

const vk = new PublicKey(vaultInfo.data.subarray(178 + circuitIndex * 32, 210 + circuitIndex * 32));
const payeeAta = split ? null : getAssociatedTokenAddressSync(mint, recipient, true);
const spendTx = split
  ? new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: SPEND_CU }),
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: tree, isSigner: false, isWritable: true },
        { pubkey: compliance, isSigner: false, isWritable: false },
        { pubkey: pending, isSigner: false, isWritable: true },
        { pubkey: vk, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: seed("siphon-nf-v1", nullifiers[0]), isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([
        disc("spend_split"), binder, Buffer.from(pkg.proof_hex, "hex"),
        ...pkg.split_commitments_hex.map((h) => Buffer.from(h, "hex")), Buffer.from([circuitIndex]),
      ]),
    }),
  )
  : null;
let spendSig;
try {
  spendSig = await sendAndConfirmTransaction(connection, spendTx ?? new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: SPEND_CU }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payeeAta, recipient, mint),
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: tree, isSigner: false, isWritable: true },
        { pubkey: compliance, isSigner: false, isWritable: false },
        { pubkey: pending, isSigner: false, isWritable: true },
        { pubkey: vk, isSigner: false, isWritable: false },
        { pubkey: getAssociatedTokenAddressSync(mint, vault, true), isSigner: false, isWritable: true },
        { pubkey: payeeAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...Array.from({ length: 6 }, (_, i) => ({
          pubkey: nullifiers[i] ? seed("siphon-nf-v1", nullifiers[i]) : payer.publicKey,
          isSigner: false,
          isWritable: true,
        })),
      ],
      data: Buffer.concat([disc("spend"), binder, Buffer.from(pkg.proof_hex, "hex"), recipient.toBuffer(), Buffer.from([circuitIndex])]),
    }),
  ), [payer], { commitment: "confirmed" });
} catch (err) {
  const code = anchorCode(err);
  if (code === 6013 || code === 6014) fail("NEEDS_REPROOF", `spend rejected (${code}): roots moved — prove again`);
  // A confirmation timeout is not a failed spend: if the nullifier exists, it landed.
  if (!(await connection.getAccountInfo(seed("siphon-nf-v1", nullifiers[0]), "confirmed"))) {
    fail("FAILED", String(err?.message || err).slice(0, 400));
  }
  spendSig = "unconfirmed";
}
emit({ ok: true, commit_sig: commitSig, spend_sig: spendSig });
