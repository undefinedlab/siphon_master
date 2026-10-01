/**
 * Devnet E2E: mint test USDC → set vault mint → init/fund CPMM → deposit → strategy_swap.
 *
 * Jupiter has no Devnet USDC/SOL liquidity; this uses the on-vault siphon-pool-v1 CPMM.
 *
 * Usage (from repo, needs siphon-app node_modules):
 *   node siphon-contracts-v2/solana/scripts/e2e-devnet-strategy.mjs
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
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} = spl;

const PROGRAM_ID = new PublicKey(
  process.env.SIPHON_PROGRAM_ID || "Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj",
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

async function main() {
  const authority = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const [vault] = pda("siphon-vault-v1");
  const [pool] = pda("siphon-pool-v1");

  console.log("authority", authority.publicKey.toBase58());
  console.log("program", PROGRAM_ID.toBase58());
  console.log("vault", vault.toBase58());
  console.log("pool", pool.toBase58());
  console.log("balance", await connection.getBalance(authority.publicKey));

  // 1) Create faucet-mintable test USDC (6 decimals)
  console.log("Creating test USDC mint...");
  const usdcMint = await createMint(
    connection,
    authority,
    authority.publicKey,
    null,
    6,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  console.log("test USDC", usdcMint.toBase58());

  const authUsdc = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    usdcMint,
    authority.publicKey,
  );
  // 1000 USDC for pool + 1 USDC deposit
  await mintTo(connection, authority, usdcMint, authUsdc.address, authority, 1001_000_000n);
  console.log("minted 1001 USDC");

  // 2) set_allowed_mint
  {
    const data = Buffer.concat([disc("set_allowed_mint"), usdcMint.toBuffer()]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
      ],
      data,
    });
    const sig = await sendIx(connection, authority, ix);
    console.log("set_allowed_mint", sig);
  }

  // 3) initialize_pool (30 bps fee) if needed
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) {
    const poolUsdc = getAssociatedTokenAddressSync(usdcMint, pool, true);
    const poolWsol = getAssociatedTokenAddressSync(NATIVE_MINT, pool, true);
    const feeBps = Buffer.alloc(2);
    feeBps.writeUInt16LE(30);
    const data = Buffer.concat([disc("initialize_pool"), feeBps]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: poolUsdc, isSigner: false, isWritable: true },
        { pubkey: poolWsol, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendIx(connection, authority, ix);
    console.log("initialize_pool", sig);
  } else {
    console.log("pool already exists");
  }

  // 4) Wrap 2 SOL → WSOL and fund pool: 500 USDC + 2 SOL
  const authWsol = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    NATIVE_MINT,
    authority.publicKey,
  );
  const wrapLamports = 2n * BigInt(LAMPORTS_PER_SOL);
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
    console.log("wrapped 2 SOL");
  }

  const poolUsdc = getAssociatedTokenAddressSync(usdcMint, pool, true);
  const poolWsol = getAssociatedTokenAddressSync(NATIVE_MINT, pool, true);
  {
    const usdcAmt = Buffer.alloc(8);
    usdcAmt.writeBigUInt64LE(500_000_000n);
    const wsolAmt = Buffer.alloc(8);
    wsolAmt.writeBigUInt64LE(wrapLamports);
    const data = Buffer.concat([disc("fund_pool"), usdcAmt, wsolAmt]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: authUsdc.address, isSigner: false, isWritable: true },
        { pubkey: authWsol.address, isSigner: false, isWritable: true },
        { pubkey: poolUsdc, isSigner: false, isWritable: true },
        { pubkey: poolWsol, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendIx(connection, authority, ix);
    console.log("fund_pool", sig);
  }

  // 5) Deposit 1 USDC note
  const amount = 1_000_000n; // 1 USDC
  const userSalt = randomBytes(32);
  if (userSalt.every((b) => b === 0)) userSalt[0] = 1;
  const precommitment = randomBytes(32);
  const commitment = await commitmentHash(amount, usdcMint, userSalt, precommitment);
  const [note] = PublicKey.findProgramAddressSync(
    [Buffer.from("siphon-note-v1"), commitment],
    PROGRAM_ID,
  );
  const vaultUsdc = getAssociatedTokenAddressSync(usdcMint, vault, true);

  {
    const amountLe = Buffer.alloc(8);
    amountLe.writeBigUInt64LE(amount);
    const data = Buffer.concat([disc("deposit"), amountLe, userSalt, precommitment]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: authUsdc.address, isSigner: false, isWritable: true },
        { pubkey: vaultUsdc, isSigner: false, isWritable: true },
        { pubkey: note, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendIx(connection, authority, ix);
    console.log("deposit", sig, "note", note.toBase58());
    console.log("commitment", commitment.toString("hex"));
  }

  // 6) strategy_swap → WSOL to authority
  const recipientWsol = authWsol.address;
  const before = await connection.getTokenAccountBalance(recipientWsol);
  {
    const minOut = Buffer.alloc(8);
    minOut.writeBigUInt64LE(1n); // any positive out
    const data = Buffer.concat([disc("strategy_swap"), minOut]);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: note, isSigner: false, isWritable: true },
        { pubkey: vaultUsdc, isSigner: false, isWritable: true },
        { pubkey: poolUsdc, isSigner: false, isWritable: true },
        { pubkey: poolWsol, isSigner: false, isWritable: true },
        { pubkey: recipientWsol, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendIx(connection, authority, ix);
    console.log("strategy_swap", sig);
  }
  const after = await connection.getTokenAccountBalance(recipientWsol);
  const gained =
    BigInt(after.value.amount) - BigInt(before.value.amount);
  console.log("WSOL gained (lamports)", gained.toString());
  if (gained <= 0n) throw new Error("strategy_swap produced no WSOL out");

  const outPath = path.resolve(here, "../target/deploy/devnet-strategy-e2e.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        programId: PROGRAM_ID.toBase58(),
        vault: vault.toBase58(),
        pool: pool.toBase58(),
        usdcMint: usdcMint.toBase58(),
        note: note.toBase58(),
        commitment: commitment.toString("hex"),
        wsolGained: gained.toString(),
      },
      null,
      2,
    ),
  );
  console.log("PASS — wrote", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
