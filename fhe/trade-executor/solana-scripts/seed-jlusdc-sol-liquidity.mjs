/**
 * Seed SOL (token X) liquidity on jlUSDC/SOL DLMM so jlUSDC→SOL swaps can quote.
 * Uses ~/.config/solana/id.json (or SEED_KEYPAIR).
 *
 *   node seed-jlusdc-sol-liquidity.mjs [lamports]
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm").default || require("@meteora-ag/dlmm");
const { StrategyType } = require("@meteora-ag/dlmm");
const web3 = require("@solana/web3.js");
const BN = require("bn.js");

const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = web3;

const POOL = new PublicKey(
  process.env.METEORA_JLUSDC_SOL_POOL || "5fMCqmsc1iGJFLtvQJxrWb4zEENLo9U8EVo97KKktJCE",
);
const JLUSDC = new PublicKey("2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu");

function loadKp() {
  const raw = process.env.SEED_KEYPAIR || "";
  if (raw.trim().startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const p = raw || path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const payer = loadKp();
  const want = BigInt(process.argv[2] || String(50_000_000)); // 0.05 SOL default — enough for tiny hops
  console.log("payer", payer.publicKey.toBase58());

  const bal = BigInt(await connection.getBalance(payer.publicKey, "confirmed"));
  console.log("lamports", bal.toString());
  if (bal < want + 20_000_000n) throw new Error(`need ~${want} + fees lamports, have ${bal}`);

  const pool = await DLMM.create(connection, POOL, { cluster: "devnet" });
  await pool.refetchStates();
  const tokenX = pool.tokenX.publicKey;
  const tokenY = pool.tokenY.publicKey;
  console.log("tokenX", tokenX.toBase58(), "tokenY", tokenY.toBase58(), "activeId", pool.lbPair.activeId);
  if (!tokenY.equals(JLUSDC)) throw new Error("unexpected pool tokenY (expected jlUSDC)");

  // Selling Y (jlUSDC) for X (SOL) uses bins at/below active that hold X.
  const activeId = pool.lbPair.activeId;
  const minBinId = activeId - 69;
  const maxBinId = activeId;
  const idx0 = Math.floor(minBinId / 70);
  const idx1 = Math.floor(maxBinId / 70);
  const indexes = [];
  for (let i = idx0; i <= idx1; i++) indexes.push(new BN(i));
  console.log("init binArray indexes", indexes.map((b) => b.toString()).join(","), "bins", minBinId, "..", maxBinId);
  const initIxs = await pool.initializeBinArrays(indexes, payer.publicKey);
  if (initIxs.length) {
    const { Transaction } = web3;
    const txInit = new Transaction().add(...initIxs);
    const sig = await sendAndConfirmTransaction(connection, txInit, [payer], { commitment: "confirmed" });
    console.log("binArray tx", sig);
  }

  const position = Keypair.generate();
  console.log("position", position.publicKey.toBase58(), "depositing X lamports", want.toString());

  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    totalXAmount: new BN(want.toString()),
    totalYAmount: new BN(0),
    strategy: {
      minBinId,
      maxBinId,
      strategyType: StrategyType.Spot,
      singleSidedX: true,
    },
    user: payer.publicKey,
    slippage: 1,
  });
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, position], {
    commitment: "confirmed",
  });
  console.log("liquidity tx", sig);

  await pool.refetchStates();
  const bins = await pool.getBinArrayForSwap(false, 8);
  for (const amount of ["1000", "10000", "247444"]) {
    try {
      const q = await pool.swapQuote(new BN(amount), false, new BN(100), bins, false);
      console.log(
        JSON.stringify({
          amountIn: amount,
          ok: true,
          out_lamports: q.outAmount.toString(),
          consumed: q.consumedInAmount.toString(),
        }),
      );
    } catch (e) {
      console.log(JSON.stringify({ amountIn: amount, ok: false, error: String(e?.message || e) }));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
