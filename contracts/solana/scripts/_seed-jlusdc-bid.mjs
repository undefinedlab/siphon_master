/**
 * Seed SOL (token X) on the bid side so jlUSDC→SOL swaps can quote.
 * Pool: X=SOL, Y=jlUSDC. Selling Y needs X liquidity in bins ≤ active.
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

const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = web3;
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

async function main() {
  const c = new Connection(RPC, "confirmed");
  const payer = loadLocal();
  const relayer = loadRelayer();
  console.log("payer", payer.publicKey.toBase58());

  // Unwrap leftover wSOL from prior seed attempts so we can re-wrap what we need.
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  try {
    const acc = await getAccount(c, wsolAta);
    if (acc.amount > 0n) {
      const sig = await sendAndConfirmTransaction(
        c,
        new Transaction().add(createCloseAccountInstruction(wsolAta, payer.publicKey, payer.publicKey)),
        [payer],
        { commitment: "confirmed" },
      );
      console.log("unwrapped wSOL", acc.amount.toString(), sig);
    }
  } catch {
    /* no ata */
  }

  let sol = await c.getBalance(payer.publicKey);
  let relSol = relayer ? await c.getBalance(relayer.publicKey) : 0;
  console.log("sol", sol, "relayer", relSol);

  // Need ~0.045 position rent + 0.02 SOL seed + fees ≈ 0.07
  const need = 70_000_000;
  if (sol < need && relayer && relSol > 20_000_000) {
    const send = Math.min(need - sol + 2_000_000, relSol - 12_000_000);
    if (send > 1_000_000) {
      const sig = await sendAndConfirmTransaction(
        c,
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: payer.publicKey, lamports: send }),
        ),
        [relayer],
        { commitment: "confirmed" },
      );
      console.log("funded", send, sig);
      sol = await c.getBalance(payer.publicKey);
    }
  }
  if (sol < need) {
    throw new Error(
      `Need ~0.07 SOL on ${payer.publicKey.toBase58()} (have ${(sol / LAMPORTS_PER_SOL).toFixed(4)}). ` +
        `Fund via https://faucet.solana.com then re-run.`,
    );
  }

  const pool = await DLMM.create(c, POOL, { cluster: "devnet" });
  await pool.refetchStates();
  const activeId = pool.lbPair.activeId;
  console.log("activeId", activeId, "X", pool.tokenX.publicKey.toBase58(), "Y", pool.tokenY.publicKey.toBase58());
  if (!pool.tokenX.publicKey.equals(NATIVE_MINT)) {
    throw new Error("expected tokenX=SOL for this seed script");
  }

  // Bid side: bins at/below active (holds X/SOL; absorbs Y/jlUSDC sells).
  const span = Number(process.env.SEED_BIN_SPAN || "8");
  const minBinId = activeId - span;
  const maxBinId = activeId;
  const idx0 = Math.floor(minBinId / 70);
  const idx1 = Math.floor(maxBinId / 70);
  const indexes = [];
  for (let i = idx0; i <= idx1; i++) indexes.push(new BN(i));
  const initIxs = await pool.initializeBinArrays(indexes, payer.publicKey);
  if (initIxs.length) {
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(...initIxs), [payer], {
      commitment: "confirmed",
    });
    console.log("binArrays", sig);
  }

  const solSeed = BigInt(process.env.SEED_SOL_LAMPORTS || "20_000_000".replace(/_/g, ""));
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  await sendAndConfirmTransaction(
    c,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports: Number(solSeed) }),
      createSyncNativeInstruction(ata),
    ),
    [payer],
    { commitment: "confirmed" },
  );
  console.log("wrapped", solSeed.toString());

  const position = Keypair.generate();
  console.log("position", position.publicKey.toBase58(), "bins", minBinId, "..", maxBinId);

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
  const sig = await sendAndConfirmTransaction(c, tx, [payer, position], { commitment: "confirmed" });
  console.log("seeded bid SOL", sig);

  await pool.refetchStates();
  const amt = new BN("197955");
  const bins = await pool.getBinArrayForSwap(false, 8);
  const q = await pool.swapQuote(amt, false, new BN(5000), bins, false);
  console.log(
    JSON.stringify({
      ok: true,
      direction: "jlUSDC→SOL (swapForY=false)",
      in_jlusdc: amt.toString(),
      out_lamports: q.outAmount.toString(),
      fee: q.fee.toString(),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
