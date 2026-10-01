/**
 * Acquire JitoSOL (and optionally jlUSDC) on the local deployer for Meteora seeding.
 *
 *   node bootstrap-share-tokens.mjs              # stake 0.05 SOL → JitoSOL
 *   STAKE_SOL=0.1 node bootstrap-share-tokens.mjs
 *   EARN_USDC=1 node bootstrap-share-tokens.mjs  # also Earn-deposit USDC if held
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
{
  const fsPatch = require("node:fs");
  const p = require.resolve("@solana/spl-stake-pool");
  const src = fsPatch.readFileSync(p, "utf8");
  const main = "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy";
  const dev = "DPoo15wWDqpPJJtS2MUZ49aRxqz5ZaaJCJP4z8bLuib";
  if (src.includes(main)) {
    fsPatch.writeFileSync(p, src.split(main).join(dev));
    delete require.cache[p];
  }
}
const stakePool = require("@solana/spl-stake-pool");

const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = web3;
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} = spl;

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const POOL = new PublicKey(process.env.JITO_STAKE_POOL || "JitoY5pcAxWX6iyP2QdFwTznGb8A99PRCUCVVxB46WZ");
const JITO = new PublicKey(process.env.JITO_SOL_MINT || "J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi");
const USDC = new PublicKey(process.env.SOLANA_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const JL = new PublicKey(process.env.JUPITER_JL_USDC_MINT || "2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu");
const LENDING = new PublicKey(process.env.JUPITER_LEND_PROGRAM || "7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3");
const LIQUIDITY = new PublicKey("5uDkCoM96pwGYhAUucvCzLfm5UcjVRuxz6gH81RnRBmL");
const DEPOSIT_DISC = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]);

function loadKeypair() {
  const raw = (process.env.SOLANA_RELAYER_KEYPAIR || "").trim();
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const u64Le = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const pda = (programId, ...parts) =>
  PublicKey.findProgramAddressSync(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p instanceof PublicKey ? p.toBuffer() : p)),
    programId,
  )[0];

async function bal(connection, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    return (await getAccount(connection, ata)).amount;
  } catch {
    return 0n;
  }
}

async function stakeJito(connection, payer, lamports) {
  const jitoAta = getAssociatedTokenAddressSync(JITO, payer.publicKey);
  const before = await bal(connection, JITO, payer.publicKey);
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, jitoAta, payer.publicKey, JITO),
    ),
    [payer],
    { commitment: "confirmed" },
  );
  const built = await stakePool.depositSol(connection, POOL, payer.publicKey, Number(lamports), jitoAta);
  const tx = new Transaction().add(...built.instructions);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, ...(built.signers || [])], {
    commitment: "confirmed",
  });
  const got = (await bal(connection, JITO, payer.publicKey)) - before;
  console.log("depositSol", sig, "got", got.toString(), "JitoSOL");
  return got;
}

async function earnDeposit(connection, payer, amount) {
  const fTokenMint = pda(LENDING, "f_token_mint", USDC);
  const lending = pda(LENDING, "lending", USDC, fTokenMint);
  const lendingAdmin = pda(LENDING, "lending_admin");
  const liquidity = pda(LIQUIDITY, "liquidity");
  const supplyReserves = pda(LIQUIDITY, "reserve", USDC);
  const supplyPos = pda(LIQUIDITY, "user_supply_position", USDC, lending);
  const rateModel = pda(LIQUIDITY, "rate_model", USDC);
  const vault = getAssociatedTokenAddressSync(USDC, liquidity, true);
  const lendingInfo = await connection.getAccountInfo(lending, "confirmed");
  if (!lendingInfo) throw new Error("Earn lending missing");
  const REWARDS_PROG = new PublicKey("68LHLkpgjAvo6Lgd9FT6KYEX4FWn1911EohSXxHYMFjc");
  const rewardsRateModel = pda(REWARDS_PROG, "lending_rewards_rate_model", USDC);
  const usdcAta = getAssociatedTokenAddressSync(USDC, payer.publicKey);
  const jlAta = getAssociatedTokenAddressSync(JL, payer.publicKey);
  const before = await bal(connection, JL, payer.publicKey);
  const ix = new web3.TransactionInstruction({
    programId: LENDING,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: usdcAta, isSigner: false, isWritable: true },
      { pubkey: jlAta, isSigner: false, isWritable: true },
      { pubkey: USDC, isSigner: false, isWritable: false },
      { pubkey: lendingAdmin, isSigner: false, isWritable: false },
      { pubkey: lending, isSigner: false, isWritable: true },
      { pubkey: fTokenMint, isSigner: false, isWritable: true },
      { pubkey: supplyReserves, isSigner: false, isWritable: true },
      { pubkey: supplyPos, isSigner: false, isWritable: true },
      { pubkey: rateModel, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: liquidity, isSigner: false, isWritable: true },
      { pubkey: LIQUIDITY, isSigner: false, isWritable: true },
      { pubkey: rewardsRateModel, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DEPOSIT_DISC, u64Le(amount)]),
  });
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, jlAta, payer.publicKey, JL),
    ix,
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  const got = (await bal(connection, JL, payer.publicKey)) - before;
  console.log("earn deposit", sig, "got", got.toString(), "jlUSDC");
  return got;
}

async function main() {
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  console.log("payer", payer.publicKey.toBase58());
  const stakeSol = Number(process.env.STAKE_SOL || "0.05");
  const lamports = Math.floor(stakeSol * LAMPORTS_PER_SOL);
  const jitoHave = await bal(connection, JITO, payer.publicKey);
  if (jitoHave < 1_000_000n) {
    console.log("staking", stakeSol, "SOL for JitoSOL…");
    await stakeJito(connection, payer, lamports);
  } else {
    console.log("already have JitoSOL", jitoHave.toString());
  }

  if (process.env.EARN_USDC === "1") {
    const usdcHave = await bal(connection, USDC, payer.publicKey);
    if (usdcHave < 1_000_000n) {
      throw new Error(`Need ≥1 USDC for Earn (have ${usdcHave}). Fund via https://faucet.circle.com then re-run.`);
    }
    const jlHave = await bal(connection, JL, payer.publicKey);
    if (jlHave < 1_000_000n) {
      const amt = usdcHave > 5_000_000n ? 5_000_000n : usdcHave;
      await earnDeposit(connection, payer, amt);
    } else {
      console.log("already have jlUSDC", jlHave.toString());
    }
  }

  console.log("balances", {
    sol: await connection.getBalance(payer.publicKey),
    jito: (await bal(connection, JITO, payer.publicKey)).toString(),
    usdc: (await bal(connection, USDC, payer.publicKey)).toString(),
    jl: (await bal(connection, JL, payer.publicKey)).toString(),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
