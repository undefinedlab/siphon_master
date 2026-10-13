/**
 * Make Devnet jlUSDC↔SOL Meteora pool quotable for pipeline hop (jlUSDC→SOL).
 *
 * Needs ~0.25 SOL on ~/.config/solana/id.json (bin-array rent ≈0.052 each + seed).
 * Fund: https://faucet.solana.com → F6zdhuEKdWymqk4bLW8KAAooy6yEjwWQX3XKuXpZqPsq
 *
 *   node seed-jlusdc-sol-liquidity.mjs
 *   # or with Railway relayer env for optional SOL top-up:
 *   railway run -s siphon-fhe-sol -- node seed-jlusdc-sol-liquidity.mjs
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm").default || require("@meteora-ag/dlmm");
const { StrategyType } = require("@meteora-ag/dlmm");
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const BN = require("bn.js");

const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } =
  web3;
const {
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} = spl;

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const POOL = new PublicKey(process.env.METEORA_JLUSDC_SOL_POOL || "5fMCqmsc1iGJFLtvQJxrWb4zEENLo9U8EVo97KKktJCE");
const MIN_SOL = 0.2 * LAMPORTS_PER_SOL;

function loadLocal() {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))),
  );
}

async function sendTx(c, tx, signers) {
  return sendAndConfirmTransaction(c, tx, signers, { commitment: "confirmed" });
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  const payer = loadLocal();
  console.log("payer", payer.publicKey.toBase58());

  // Unwrap wSOL
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  try {
    const acc = await getAccount(c, wsolAta);
    if (acc.amount > 0n) {
      await sendTx(c, new Transaction().add(createCloseAccountInstruction(wsolAta, payer.publicKey, payer.publicKey)), [
        payer,
      ]);
      console.log("unwrapped wSOL", acc.amount.toString());
    }
  } catch {
    /* none */
  }

  let sol = await c.getBalance(payer.publicKey);
  console.log("sol", sol / LAMPORTS_PER_SOL);
  if (sol < MIN_SOL) {
    throw new Error(
      `Need ≥0.2 SOL (have ${(sol / LAMPORTS_PER_SOL).toFixed(4)}). ` +
        `Airdrop to ${payer.publicKey.toBase58()} at https://faucet.solana.com then re-run.`,
    );
  }

  const pool = await DLMM.create(c, POOL, { cluster: "devnet" });
  await pool.refetchStates();
  const activeId = pool.lbPair.activeId;
  console.log("activeId", activeId, "X=SOL Y=jlUSDC");

  // Init bin arrays around active — sell-Y walks neighboring arrays.
  const center = Math.floor(activeId / 70);
  const indexes = [];
  for (let i = center - 2; i <= center + 2; i++) indexes.push(new BN(i));
  const initIxs = await pool.initializeBinArrays(indexes, payer.publicKey);
  console.log("binArray ixs", initIxs.length, "indexes", indexes.map((b) => b.toString()).join(","));
  for (let i = 0; i < initIxs.length; i += 2) {
    const slice = initIxs.slice(i, i + 2);
    console.log("binArray tx", await sendTx(c, new Transaction().add(...slice), [payer]));
  }

  // Bid-side SOL (bins ≤ active) so jlUSDC→SOL quotes.
  const span = Number(process.env.SEED_BIN_SPAN || "6");
  const minBinId = activeId - span;
  const maxBinId = activeId;
  sol = await c.getBalance(payer.publicKey);
  const solSeed = BigInt(
    Math.min(
      Number(process.env.SEED_SOL_LAMPORTS || 30_000_000),
      Math.max(5_000_000, sol - 50_000_000), // leave rent headroom for position
    ),
  );
  if (solSeed < 5_000_000n) {
    throw new Error(`Not enough SOL left for seed after bin arrays (have ${sol / LAMPORTS_PER_SOL})`);
  }

  await sendTx(
    c,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta, payer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wsolAta, lamports: Number(solSeed) }),
      createSyncNativeInstruction(wsolAta),
    ),
    [payer],
  );
  console.log("wrapped", solSeed.toString());

  const position = Keypair.generate();
  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: payer.publicKey,
    totalXAmount: new BN(solSeed.toString()),
    totalYAmount: new BN(0),
    strategy: {
      minBinId,
      maxBinId,
      strategyType: StrategyType.Spot,
      singleSidedX: true,
    },
    slippage: 1,
  });
  console.log("position", position.publicKey.toBase58());
  console.log("seeded", await sendTx(c, tx, [payer, position]));

  await pool.refetchStates();
  const amt = new BN("197955");
  const bins = await pool.getBinArrayForSwap(false, 8);
  const q = await pool.swapQuote(amt, false, new BN(5000), bins, false);
  console.log(
    JSON.stringify({
      ok: true,
      direction: "jlUSDC→SOL",
      in_jlusdc: amt.toString(),
      out_lamports: q.outAmount.toString(),
      fee: q.fee.toString(),
      pool: POOL.toBase58(),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
