/**
 * Seed ask-side (USDC) liquidity on HjpPx SOL/USDC DLMM so SOL→USDC swaps can quote.
 * Uses ~/.config/solana/id.json (has Circle USDC on Devnet).
 *
 *   node seed-hjp-ask-liquidity.mjs
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

const { Connection, Keypair, PublicKey, sendAndConfirmTransaction } = web3;
const { getAssociatedTokenAddressSync, getAccount } = spl;

const POOL = new PublicKey("HjpPxUVfHe7GWtj1LkQaH3Dyj8Xbi548pQBNzq1v7ADd");
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

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
  console.log("payer", payer.publicKey.toBase58());

  const usdcAta = getAssociatedTokenAddressSync(USDC, payer.publicKey);
  const usdcBal = (await getAccount(connection, usdcAta)).amount;
  console.log("usdc", usdcBal.toString());
  if (usdcBal < 1_000_000n) throw new Error("need at least 1 USDC to seed ask side");

  // Leave 1 USDC dust; deposit the rest as Y-only ask liquidity.
  const depositY = usdcBal > 1_000_000n ? usdcBal - 1_000_000n : usdcBal;
  const pool = await DLMM.create(connection, POOL, { cluster: "devnet" });
  await pool.refetchStates();
  const activeId = pool.lbPair.activeId;
  console.log("activeId", activeId, "binStep", pool.lbPair.binStep);

  // Ask side: bins at/above active (holds Y / USDC; absorbs X / SOL sells).
  const minBinId = activeId;
  const maxBinId = activeId + 69;
  // One bin array covers 70 bins; index = floor(binId / 70).
  const idx0 = Math.floor(minBinId / 70);
  const idx1 = Math.floor(maxBinId / 70);
  const indexes = [];
  for (let i = idx0; i <= idx1; i++) indexes.push(new BN(i));
  console.log("init binArray indexes", indexes.map((b) => b.toString()).join(","));
  const initIxs = await pool.initializeBinArrays(indexes, payer.publicKey);
  if (initIxs.length) {
    const { Transaction } = web3;
    const txInit = new Transaction().add(...initIxs);
    const sig = await sendAndConfirmTransaction(connection, txInit, [payer], { commitment: "confirmed" });
    console.log("binArray tx", sig);
  }

  const position = Keypair.generate();
  console.log("position", position.publicKey.toBase58());
  console.log("depositing Y", depositY.toString(), "bins", minBinId, "..", maxBinId);

  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    totalXAmount: new BN(0),
    totalYAmount: new BN(depositY.toString()),
    strategy: {
      minBinId,
      maxBinId,
      strategyType: StrategyType.Spot,
      singleSidedX: false,
    },
    user: payer.publicKey,
    slippage: 1,
  });
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, position], {
    commitment: "confirmed",
  });
  console.log("liquidity tx", sig);

  await pool.refetchStates();
  const bins = await pool.getBinArrayForSwap(true, 8);
  const q = await pool.swapQuote(new BN("10000000"), true, new BN(100), bins, false);
  console.log(
    JSON.stringify({
      ok: true,
      quote_0_01_sol_out_usdc: q.outAmount.toString(),
      consumed_in: q.consumedInAmount.toString(),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
