/**
 * Close the previous narrow Spot position (reclaim rent), then seed SOL-only bid
 * liquidity so jlUSDC→SOL (swapForY=false) can quote.
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
// Position created by _fund-and-seed-jlusdc.mjs (Spot both sides).
const OLD_POS = new PublicKey(process.env.OLD_POSITION || "4xitsh1h3zLT2owuRVzqfDmDJYiB2BwcSTCEfhaoKGSp");

function loadLocal() {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))),
  );
}
function loadRelayer() {
  const raw = (process.env.SOLANA_RELAYER_KEYPAIR || "").trim();
  if (!raw.startsWith("[")) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function sendAll(c, tx, signers) {
  return sendAndConfirmTransaction(c, tx, signers, { commitment: "confirmed" });
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  const payer = loadLocal();
  const relayer = loadRelayer();
  console.log("payer", payer.publicKey.toBase58());

  // Unwrap wSOL dust.
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  try {
    const acc = await getAccount(c, wsolAta);
    if (acc.amount > 0n) {
      console.log("unwrapping wSOL", acc.amount.toString());
      await sendAll(c, new Transaction().add(createCloseAccountInstruction(wsolAta, payer.publicKey, payer.publicKey)), [
        payer,
      ]);
    }
  } catch {
    /* none */
  }

  const pool = await DLMM.create(c, POOL, { cluster: "devnet" });
  await pool.refetchStates();

  // Close old position if it still exists and we own it.
  try {
    const posInfo = await c.getAccountInfo(OLD_POS);
    if (posInfo) {
      console.log("closing old position", OLD_POS.toBase58());
      // removeAllLiquidity + closePosition via SDK helpers
      const userPositions = await pool.getPositionsByUserAndLbPair(payer.publicKey);
      const mine = (userPositions?.userPositions || []).find((p) =>
        p.publicKey.equals(OLD_POS),
      );
      if (mine) {
        const removeTxs = await pool.removeLiquidity({
          user: payer.publicKey,
          position: OLD_POS,
          fromBinId: mine.positionData.lowerBinId,
          toBinId: mine.positionData.upperBinId,
          bps: new BN(10_000),
          shouldClaimAndClose: true,
        });
        for (const tx of Array.isArray(removeTxs) ? removeTxs : [removeTxs]) {
          const sig = await sendAll(c, tx, [payer]);
          console.log("remove/close", sig);
        }
      } else {
        console.log("old position not owned by payer / already closed");
      }
    } else {
      console.log("old position account missing (already closed)");
    }
  } catch (e) {
    console.warn("close old position:", e?.message || e);
  }

  // Sweep leftover relayer SOL (keep 0.01 for executor gas).
  if (relayer) {
    const relSol = await c.getBalance(relayer.publicKey);
    const keep = 10_000_000;
    if (relSol > keep + 1_000_000) {
      const send = relSol - keep;
      const sig = await sendAll(
        c,
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: payer.publicKey, lamports: send }),
        ),
        [relayer],
      );
      console.log("swept relayer SOL", send, sig);
    }
  }

  const sol = await c.getBalance(payer.publicKey);
  console.log("sol after reclaim", sol, `(${(sol / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);

  await pool.refetchStates();
  const activeId = pool.lbPair.activeId;
  console.log("activeId", activeId);

  // Bid: bins ≤ active, X-only (SOL).
  const span = Number(process.env.SEED_BIN_SPAN || "4");
  const minBinId = activeId - span;
  const maxBinId = activeId;
  const idx0 = Math.floor(minBinId / 70);
  const idx1 = Math.floor(maxBinId / 70);
  const indexes = [];
  for (let i = idx0; i <= idx1; i++) indexes.push(new BN(i));
  const initIxs = await pool.initializeBinArrays(indexes, payer.publicKey);
  if (initIxs.length) {
    console.log("binArrays", await sendAll(c, new Transaction().add(...initIxs), [payer]));
  }

  // Leave ~0.002 for fees; rest of free SOL (minus rent buffer) into the pool.
  // Position rent ≈ 0.03–0.04; use conservative seed.
  const rentBuffer = 45_000_000;
  const feeBuffer = 3_000_000;
  const avail = (await c.getBalance(payer.publicKey)) - rentBuffer - feeBuffer;
  const solSeed = BigInt(Math.max(2_000_000, Math.min(Number(process.env.SEED_SOL_LAMPORTS || avail), avail)));
  if (solSeed < 2_000_000n) {
    throw new Error(
      `Still short on SOL after reclaim (have ${(await c.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL}). ` +
        `Please airdrop ≥0.1 SOL to ${payer.publicKey.toBase58()} via https://faucet.solana.com`,
    );
  }

  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  await sendAll(
    c,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports: Number(solSeed) }),
      createSyncNativeInstruction(ata),
    ),
    [payer],
  );
  console.log("wrapped", solSeed.toString());

  const position = Keypair.generate();
  console.log("new position", position.publicKey.toBase58(), "bins", minBinId, "..", maxBinId);

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
  console.log("seeded", await sendAll(c, tx, [payer, position]));

  await pool.refetchStates();
  const amt = new BN("197955");
  try {
    const bins = await pool.getBinArrayForSwap(false, 8);
    const q = await pool.swapQuote(amt, false, new BN(5000), bins, false);
    console.log(
      JSON.stringify({
        ok: true,
        direction: "jlUSDC→SOL",
        in: amt.toString(),
        out_lamports: q.outAmount.toString(),
        fee: q.fee.toString(),
      }),
    );
  } catch (e) {
    console.error("quote FAILED", e?.message || e);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
