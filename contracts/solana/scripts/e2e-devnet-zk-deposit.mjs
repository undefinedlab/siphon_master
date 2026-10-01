/**
 * Devnet E2E — ZK vault deposit (WSOL / SOL product path).
 *
 * Does not require VKs or a prover: deposits Poseidon commitment + inserts tree leaf.
 *
 *   cd siphon-app
 *   $env:NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID="BnrNK4TsDXtDCdDfXskV7Gsj7ai6SX9PmDDpHHzhWJKF"
 *   node ../siphon-contracts-v2/solana/scripts/e2e-devnet-zk-deposit.mjs
 *
 * Optional: AMOUNT_LAMPORTS=50000000 (default 0.05 SOL)
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const appMods = path.resolve(here, "../../../siphon-app/node_modules");
const require = createRequire(import.meta.url);
const web3 = require(path.join(appMods, "@solana/web3.js/lib/index.cjs.js"));
const spl = require(path.join(appMods, "@solana/spl-token"));

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = web3;
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} = spl;

const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID ||
    process.env.SIPHON_ZK_PROGRAM_ID ||
    "F8UqgsnSrrtGe2EETRWKJU8iRMNiKowEDFQcVLAPjEQH",
);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const AMOUNT = BigInt(process.env.AMOUNT_LAMPORTS || Math.floor(0.05 * LAMPORTS_PER_SOL));

const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DOMAIN_VAULT_SCOPE = 3n;
const DOMAIN_CHAIN_SOL = 6n;

function loadKeypair() {
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function pda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

function modField(x) {
  const r = x % FIELD;
  return r < 0n ? r + FIELD : r;
}

function fieldFromBe32(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return modField(v);
}

function fieldToLe32(x) {
  const b = Buffer.alloc(32);
  let v = modField(x);
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function le32ToField(b) {
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return modField(v);
}

function randomFieldLimb() {
  // 31 random bytes → always < FIELD
  const b = Buffer.concat([randomBytes(31), Buffer.from([0])]);
  let v = 0n;
  for (let i = 0; i < 32; i++) v |= BigInt(b[i]) << BigInt(8 * i);
  if (v === 0n) v = 1n;
  return fieldToLe32(v);
}

async function getPoseidon() {
  const { buildPoseidon } = await import(
    pathToFileURL(path.join(appMods, "circomlibjs/main.js")).href
  ).catch(async () => {
    // CJS fallback
    return { buildPoseidon: require(path.join(appMods, "circomlibjs")).buildPoseidon };
  });
  return buildPoseidon();
}

function pathToFileURL(p) {
  const { pathToFileURL: toUrl } = require("node:url");
  return toUrl(p);
}

async function poseidonN(poseidon, inputs) {
  return BigInt(poseidon.F.toObject(poseidon(inputs.map(modField))));
}

async function main() {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const [vault] = pda([Buffer.from("siphon-vault-v1")]);
  const [tree] = pda([Buffer.from("siphon-tree-v1")]);

  const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
  if (!vaultInfo) throw new Error("ZK vault missing — run init-vault-devnet-zk.mjs first");

  // VaultAccount (after 8-byte Anchor disc): bump(1) authority(32) program_version(32)
  // deposit_nonce(8) state_root(32) deposits_paused(1) allowed_mint(32) vault_scope_id(32) …
  const depositNonce = vaultInfo.data.readBigUInt64LE(73);
  const vaultScopeLe = vaultInfo.data.subarray(146, 178);

  const poseidon = await getPoseidon();
  const scopeLocal = await poseidonN(poseidon, [
    DOMAIN_CHAIN_SOL,
    fieldFromBe32(PROGRAM_ID.toBytes()),
    fieldFromBe32(vault.toBytes()),
  ]);
  const scopeOnchain = le32ToField(vaultScopeLe);
  if (scopeLocal !== scopeOnchain) {
    throw new Error(
      `vault_scope_id mismatch client=${scopeLocal} onchain=${scopeOnchain}`,
    );
  }

  const nullifier = randomFieldLimb();
  const secret = randomFieldLimb();
  const userSalt = randomFieldLimb();
  const pre = await poseidonN(poseidon, [le32ToField(nullifier), le32ToField(secret)]);
  const stem = await poseidonN(poseidon, [
    DOMAIN_VAULT_SCOPE,
    scopeOnchain,
    depositNonce,
  ]);
  const label = await poseidonN(poseidon, [stem, le32ToField(userSalt)]);
  const assetId = fieldFromBe32(NATIVE_MINT.toBytes());
  const inner = await poseidonN(poseidon, [AMOUNT, label, assetId]);
  const commitment = await poseidonN(poseidon, [inner, pre]);
  const commitmentLe = fieldToLe32(commitment);
  const [leaf] = pda([Buffer.from("siphon-leaf-v1"), commitmentLe]);

  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  const vaultWsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);

  const amountLe = Buffer.alloc(8);
  amountLe.writeBigUInt64LE(AMOUNT);
  const depositData = Buffer.concat([
    disc("deposit"),
    amountLe,
    userSalt,
    fieldToLe32(pre),
    commitmentLe,
  ]);

  const depositIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tree, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: userWsol, isSigner: false, isWritable: true },
      { pubkey: vaultWsol, isSigner: false, isWritable: true },
      { pubkey: leaf, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: depositData,
  });

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      userWsol,
      payer.publicKey,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: userWsol,
      lamports: Number(AMOUNT),
    }),
    createSyncNativeInstruction(userWsol),
    depositIx,
  );

  console.log("program", PROGRAM_ID.toBase58());
  console.log("vault", vault.toBase58());
  console.log("tree", tree.toBase58());
  console.log("leaf", leaf.toBase58());
  console.log("amount lamports", AMOUNT.toString());
  console.log("deposit_nonce", depositNonce.toString());
  console.log("commitment", commitmentLe.toString("hex"));

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log("deposit ok", sig);

  const leafInfo = await connection.getAccountInfo(leaf, "confirmed");
  if (!leafInfo) throw new Error("leaf PDA missing after deposit");
  const leafIndex = leafInfo.data.readBigUInt64LE(9);
  console.log("leaf_index", leafIndex.toString());

  const treeInfo = await connection.getAccountInfo(tree, "confirmed");
  // TreeAccount zero-copy: disc(8) bump/len/head/pad(8) next_index(8) root(32)
  const nextIndex = treeInfo.data.readBigUInt64LE(16);
  console.log("tree next_index", nextIndex.toString());
  if (nextIndex !== leafIndex + 1n) {
    throw new Error(`tree next_index ${nextIndex} != leaf+1 ${leafIndex + 1n}`);
  }

  const out = {
    programId: PROGRAM_ID.toBase58(),
    vault: vault.toBase58(),
    tree: tree.toBase58(),
    leaf: leaf.toBase58(),
    signature: sig,
    leafIndex: Number(leafIndex),
    amountLamports: AMOUNT.toString(),
    commitmentHex: commitmentLe.toString("hex"),
  };
  const outPath = path.join(rootDeploy(), "devnet-zk-deposit-e2e.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("wrote", outPath);
}

function rootDeploy() {
  return path.join(here, "../target/deploy");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
