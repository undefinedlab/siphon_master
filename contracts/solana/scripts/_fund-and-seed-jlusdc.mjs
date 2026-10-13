/**
 * Fund local deployer from relayer if needed, then seed jlUSDC/SOL Meteora pool.
 * Uses SOLANA_RELAYER_KEYPAIR (env) + ~/.config/solana/id.json (jlUSDC holder).
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const dlmmMod = require("@meteora-ag/dlmm");
const DLMM = dlmmMod.default || dlmmMod;
const { StrategyType } = dlmmMod;
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const BN = require("bn.js");

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = web3;
const {
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
} = spl;

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const POOL = new PublicKey(
  process.env.METEORA_JLUSDC_SOL_POOL || "5fMCqmsc1iGJFLtvQJxrWb4zEENLo9U8EVo97KKktJCE",
);
const JL = new PublicKey(
  process.env.JUPITER_JL_USDC_MINT || "2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu",
);
const OPT = { cluster: "devnet" };

function loadLocal() {
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function loadRelayer() {
  const raw = (process.env.SOLANA_RELAYER_KEYPAIR || "").trim();
  if (!raw.startsWith("[")) throw new Error("SOLANA_RELAYER_KEYPAIR required");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function tokBal(c, mint, owner) {
  try {
    return (await getAccount(c, getAssociatedTokenAddressSync(mint, owner))).amount;
  } catch {
    return 0n;
  }
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  const local = loadLocal();
  const relayer = loadRelayer();
  console.log("local", local.publicKey.toBase58());
  console.log("relayer", relayer.publicKey.toBase58());
  console.log("pool", POOL.toBase58());

  let localSol = await c.getBalance(local.publicKey);
  let relayerSol = await c.getBalance(relayer.publicKey);
  let jlLocal = await tokBal(c, JL, local.publicKey);
  console.log("before", { localSol, relayerSol, jlLocal: jlLocal.toString() });

  // Position rent for narrow bins ≈0.04 SOL + wrap + fees. Leave ≥0.02 on relayer.
  const needSol = Number(process.env.NEED_LOCAL_SOL_LAMPORTS || 55_000_000);
  const relayerFloor = Number(process.env.RELAYER_SOL_FLOOR || 15_000_000);
  if (localSol < needSol) {
    const send = Math.min(needSol - localSol + 5_000_000, Math.max(0, relayerSol - relayerFloor));
    if (send < 5_000_000) {
      throw new Error(
        `Need ~${(needSol / LAMPORTS_PER_SOL).toFixed(3)} SOL on local (have ${(localSol / LAMPORTS_PER_SOL).toFixed(4)}) and relayer cannot spare enough ` +
          `(have ${(relayerSol / LAMPORTS_PER_SOL).toFixed(4)}). Please fund ${local.publicKey.toBase58()} with Devnet SOL from https://faucet.solana.com`,
      );
    }
    const sig = await sendAndConfirmTransaction(
      c,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: relayer.publicKey,
          toPubkey: local.publicKey,
          lamports: send,
        }),
      ),
      [relayer],
      { commitment: "confirmed" },
    );
    console.log("funded local SOL", send, sig);
    localSol = await c.getBalance(local.publicKey);
  }

  if (jlLocal < 500_000n) {
    throw new Error(
      `Need ≥0.5 jlUSDC on local (have ${jlLocal}). Earn-deposit USDC first or fund ${local.publicKey.toBase58()}.`,
    );
  }

  const payer = local;
  const pool = await DLMM.create(c, POOL, OPT);
  await pool.refetchStates();
  const activeId = pool.lbPair.activeId;
  const binStep = pool.lbPair.binStep;
  console.log("activeId", activeId, "binStep", binStep);
  console.log("tokenX", pool.tokenX.publicKey.toBase58(), "tokenY", pool.tokenY.publicKey.toBase58());

  // Wide enough for small swaps; init bin arrays first (quote fails if arrays missing).
  // Narrow span keeps position rent small on faucet-limited wallets (≈0.04 SOL).
  const binSpan = Number(process.env.SEED_BIN_SPAN || "2");
  const minBinId = activeId - binSpan;
  const maxBinId = activeId + binSpan;
  const idx0 = Math.floor(minBinId / 70);
  const idx1 = Math.floor(maxBinId / 70);
  const indexes = [];
  for (let i = idx0; i <= idx1; i++) indexes.push(new BN(i));
  console.log("init binArrays", indexes.map((b) => b.toString()).join(","));
  const initIxs = await pool.initializeBinArrays(indexes, payer.publicKey);
  if (initIxs.length) {
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(...initIxs), [payer], {
      commitment: "confirmed",
    });
    console.log("binArray tx", sig);
  }

  // Seed both sides: SOL for jlUSDC→SOL sells; jlUSDC for the reverse.
  const solSeed = BigInt(process.env.SEED_SOL_LAMPORTS || "15_000_000".replace(/_/g, ""));
  const tokSeed = BigInt(process.env.SEED_TOKEN_AMOUNT || "2_000_000".replace(/_/g, ""));
  const xMint = pool.tokenX.publicKey;
  const yMint = pool.tokenY.publicKey;
  const xIsSol = xMint.equals(NATIVE_MINT);
  const yIsSol = yMint.equals(NATIVE_MINT);
  const xAmt = xIsSol ? solSeed : tokSeed;
  const yAmt = yIsSol ? solSeed : tokSeed;

  const xAta = getAssociatedTokenAddressSync(xMint, payer.publicKey);
  const yAta = getAssociatedTokenAddressSync(yMint, payer.publicKey);
  const pre = [];
  if (xIsSol) {
    pre.push(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, xAta, payer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: xAta, lamports: Number(xAmt) }),
      createSyncNativeInstruction(xAta),
    );
  }
  if (yIsSol) {
    pre.push(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, yAta, payer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: yAta, lamports: Number(yAmt) }),
      createSyncNativeInstruction(yAta),
    );
  }
  if (pre.length) {
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(...pre), [payer], {
      commitment: "confirmed",
    });
    console.log("wrapped SOL", sig);
  }

  const xHave = xIsSol ? xAmt : await tokBal(c, xMint, payer.publicKey);
  const yHave = yIsSol ? yAmt : await tokBal(c, yMint, payer.publicKey);
  if (xHave < xAmt || yHave < yAmt) {
    throw new Error(`balance short: need X=${xAmt} (have ${xHave}) Y=${yAmt} (have ${yHave})`);
  }

  const position = Keypair.generate();
  console.log("position", position.publicKey.toBase58());
  console.log("deposit X", xAmt.toString(), "Y", yAmt.toString(), "bins", minBinId, "..", maxBinId);

  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: payer.publicKey,
    totalXAmount: new BN(xAmt.toString()),
    totalYAmount: new BN(yAmt.toString()),
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
  });
  const sig = await sendAndConfirmTransaction(c, tx, [payer, position], { commitment: "confirmed" });
  console.log("seeded", sig);

  // Prove the swap can quote (~0.2 jlUSDC sell like the stuck pipeline).
  await pool.refetchStates();
  const bins = await pool.getBinArrayForSwap(true /* swapForY: sell X */);
  try {
    const q = await pool.swapQuote(new BN("200000"), true, new BN(100), bins, false);
    console.log("quote ok outAmount", q.outAmount?.toString?.() || q.outAmount, "fee", q.fee?.toString?.());
  } catch (e) {
    console.error("quote still failing:", e?.message || e);
    // try swapForY false in case mint order is inverted for our sell
    try {
      const bins2 = await pool.getBinArrayForSwap(false);
      const q2 = await pool.swapQuote(new BN("200000"), false, new BN(100), bins2, false);
      console.log("quote alt ok outAmount", q2.outAmount?.toString?.() || q2.outAmount);
    } catch (e2) {
      console.error("quote alt also failing:", e2?.message || e2);
      throw e;
    }
  }

  console.log("DONE METEORA_JLUSDC_SOL_POOL", POOL.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
