/**
 * Devnet bidirectional E2E on siphon-pool-v1 (public venue):
 *   USDC note → strategy_swap → WSOL
 *   WSOL note → strategy_swap → USDC
 *
 * Uses existing vault-allowed mint (SOLANA_USDC_MINT / default live test mint).
 *
 *   node siphon-contracts-v2/solana/scripts/e2e-devnet-bidi.mjs
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
  mintTo,
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} = spl;

const PROGRAM_ID = new PublicKey(
  process.env.SIPHON_PROGRAM_ID || "Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj",
);
const USDC_MINT = new PublicKey(
  process.env.SOLANA_USDC_MINT ||
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT ||
    "DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie",
);
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const COMMIT_DOMAIN = Buffer.from("siphon-solana-devnet-deposit-v1");

function loadKeypair() {
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function pda(seed) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID);
}

async function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

async function commitmentHash(amount, mint, userSalt, precommitment) {
  const amountLe = Buffer.alloc(8);
  amountLe.writeBigUInt64LE(BigInt(amount));
  return sha256(Buffer.concat([COMMIT_DOMAIN, amountLe, mint.toBuffer(), userSalt, precommitment]));
}

async function sendIx(connection, payer, ix, signers = []) {
  const tx = new Transaction().add(ix);
  return sendAndConfirmTransaction(connection, tx, [payer, ...signers], {
    commitment: "confirmed",
  });
}

async function depositNote(connection, authority, mint, amount, userAta) {
  const [vault] = pda("siphon-vault-v1");
  const userSalt = randomBytes(32);
  if (userSalt.every((b) => b === 0)) userSalt[0] = 1;
  const precommitment = randomBytes(32);
  const commitment = await commitmentHash(amount, mint, userSalt, precommitment);
  const [note] = PublicKey.findProgramAddressSync(
    [Buffer.from("siphon-note-v1"), commitment],
    PROGRAM_ID,
  );
  const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
  const amountLe = Buffer.alloc(8);
  amountLe.writeBigUInt64LE(BigInt(amount));
  const data = Buffer.concat([disc("deposit"), amountLe, userSalt, precommitment]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: note, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const sig = await sendIx(connection, authority, ix);
  return { note, commitment, sig, vaultAta };
}

async function strategySwap(connection, authority, note, vaultIn, poolIn, poolOut, recipientOut) {
  const [vault] = pda("siphon-vault-v1");
  const [pool] = pda("siphon-pool-v1");
  const minOut = Buffer.alloc(8);
  minOut.writeBigUInt64LE(1n);
  const data = Buffer.concat([disc("strategy_swap"), minOut]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: note, isSigner: false, isWritable: true },
      { pubkey: vaultIn, isSigner: false, isWritable: true },
      { pubkey: poolIn, isSigner: false, isWritable: true },
      { pubkey: poolOut, isSigner: false, isWritable: true },
      { pubkey: recipientOut, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
  return sendIx(connection, authority, ix);
}

async function main() {
  const authority = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const [vault] = pda("siphon-vault-v1");
  const [pool] = pda("siphon-pool-v1");

  console.log("authority", authority.publicKey.toBase58());
  console.log("usdc", USDC_MINT.toBase58());
  console.log("vault", vault.toBase58());
  console.log("pool", pool.toBase58());
  console.log("balance", await connection.getBalance(authority.publicKey));

  const authUsdc = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    USDC_MINT,
    authority.publicKey,
  );
  const authWsol = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    NATIVE_MINT,
    authority.publicKey,
  );

  // Top up test USDC if we are mint authority
  try {
    await mintTo(connection, authority, USDC_MINT, authUsdc.address, authority, 10_000_000n);
    console.log("minted +10 USDC");
  } catch (e) {
    console.log("mint skip:", e.message?.slice(0, 80) || e);
  }

  // Wrap 0.05 SOL for WSOL deposit
  const wrapLamports = BigInt(Math.floor(0.05 * LAMPORTS_PER_SOL));
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: authWsol.address,
        lamports: Number(wrapLamports),
      }),
      createSyncNativeInstruction(authWsol.address),
    );
    await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
    console.log("wrapped", wrapLamports.toString(), "lamports");
  }

  const poolUsdc = getAssociatedTokenAddressSync(USDC_MINT, pool, true);
  const poolWsol = getAssociatedTokenAddressSync(NATIVE_MINT, pool, true);
  const vaultUsdc = getAssociatedTokenAddressSync(USDC_MINT, vault, true);
  const vaultWsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);

  // Ensure vault WSOL ATA
  await getOrCreateAssociatedTokenAccount(connection, authority, NATIVE_MINT, vault, true);

  // ── Side A: USDC → WSOL ──
  const usdcAmt = 1_000_000n;
  const depA = await depositNote(connection, authority, USDC_MINT, usdcAmt, authUsdc.address);
  console.log("deposit USDC", depA.sig, "note", depA.note.toBase58());
  const wsolBefore = BigInt((await connection.getTokenAccountBalance(authWsol.address)).value.amount);
  const swapA = await strategySwap(
    connection,
    authority,
    depA.note,
    vaultUsdc,
    poolUsdc,
    poolWsol,
    authWsol.address,
  );
  const wsolAfter = BigInt((await connection.getTokenAccountBalance(authWsol.address)).value.amount);
  const wsolGained = wsolAfter - wsolBefore;
  console.log("USDC→WSOL", swapA, "gained", wsolGained.toString());
  if (wsolGained <= 0n) throw new Error("USDC→WSOL produced no out");

  // ── Side B: WSOL → USDC ──
  const wsolAmt = 10_000_000n; // 0.01 SOL
  const depB = await depositNote(connection, authority, NATIVE_MINT, wsolAmt, authWsol.address);
  console.log("deposit WSOL", depB.sig, "note", depB.note.toBase58());
  const usdcBefore = BigInt((await connection.getTokenAccountBalance(authUsdc.address)).value.amount);
  const swapB = await strategySwap(
    connection,
    authority,
    depB.note,
    vaultWsol,
    poolWsol,
    poolUsdc,
    authUsdc.address,
  );
  const usdcAfter = BigInt((await connection.getTokenAccountBalance(authUsdc.address)).value.amount);
  const usdcGained = usdcAfter - usdcBefore;
  console.log("WSOL→USDC", swapB, "gained", usdcGained.toString());
  if (usdcGained <= 0n) throw new Error("WSOL→USDC produced no out");

  const outPath = path.resolve(here, "../target/deploy/devnet-bidi-e2e.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        programId: PROGRAM_ID.toBase58(),
        vault: vault.toBase58(),
        pool: pool.toBase58(),
        usdcMint: USDC_MINT.toBase58(),
        usdcToWsol: { note: depA.note.toBase58(), tx: swapA, wsolGained: wsolGained.toString() },
        wsolToUsdc: { note: depB.note.toBase58(), tx: swapB, usdcGained: usdcGained.toString() },
      },
      null,
      2,
    ),
  );
  console.log("PASS bidi — wrote", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
