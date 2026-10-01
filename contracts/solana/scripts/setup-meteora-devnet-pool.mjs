/**
 * Find or create a Meteora DLMM pool on Solana Devnet, seed liquidity, write env.
 *
 *   PAIR=usdc-sol|jlusdc-sol|jitosol-sol  (default usdc-sol)
 *   METEORA_SKIP_SEED=1                  create/find only
 *
 *   cd siphon-contracts-v2/solana/scripts && npm install && node setup-meteora-devnet-pool.mjs
 *
 * No indexed jlUSDC/JitoSOL pools exist on Devnet — this creates Siphon's own.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
} = web3;
const {
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  getMint,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
} = spl;

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const USDC = new PublicKey(
  process.env.SOLANA_USDC_MINT ||
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT ||
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
const JL_USDC = new PublicKey(
  process.env.JUPITER_JL_USDC_MINT ||
    process.env.NEXT_PUBLIC_JUPITER_JL_USDC_MINT ||
    "2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu",
);
const JITO_SOL = new PublicKey(
  process.env.JITO_SOL_MINT ||
    process.env.NEXT_PUBLIC_JITO_SOL_MINT ||
    "J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi",
);
const PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const API = "https://dlmm.dev.metdev.io";
const OPT = { cluster: "devnet" };
const SOL_USD = Number(process.env.METEORA_SOL_USD || "150");

const PAIR = String(process.env.PAIR || "usdc-sol").toLowerCase().replace(/_/g, "-");

function resolvePair() {
  if (PAIR === "jlusdc-sol" || PAIR === "jl-usdc-sol") {
    return {
      name: "jlusdc-sol",
      mintA: JL_USDC,
      mintB: NATIVE_MINT,
      envKey: "METEORA_JLUSDC_SOL_POOL",
      humanPrice: SOL_USD, // approx jl≈USDC; price vs SOL
      quoteIsSol: true,
    };
  }
  if (PAIR === "jitosol-sol" || PAIR === "jito-sol") {
    return {
      name: "jitosol-sol",
      mintA: JITO_SOL,
      mintB: NATIVE_MINT,
      envKey: "METEORA_JITOSOL_SOL_POOL",
      humanPrice: 1.0, // ~1:1 liquid stake
      quoteIsSol: true,
    };
  }
  return {
    name: "usdc-sol",
    mintA: USDC,
    mintB: NATIVE_MINT,
    envKey: "METEORA_POOL",
    humanPrice: SOL_USD,
    quoteIsSol: true,
  };
}

function loadKeypair() {
  const raw = (process.env.SOLANA_RELAYER_KEYPAIR || "").trim();
  if (raw.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function sortMints(a, b) {
  const cmp = Buffer.compare(a.toBuffer(), b.toBuffer());
  return cmp < 0 ? [a, b] : [b, a];
}

async function findViaApi(a, b) {
  const url = `${API}/pools?page=1&page_size=100&query=${a}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json();
  const rows = Array.isArray(body) ? body : body.data || body.pools || body.items || [];
  const want = new Set([a, b]);
  for (const row of rows) {
    const x = row.token_x?.address || row.token_x || row.mint_x || row.tokenX;
    const y = row.token_y?.address || row.token_y || row.mint_y || row.tokenY;
    const addr = row.address || row.lb_pair || row.pool_address || row.pubkey;
    if (x && y && addr && want.has(String(x)) && want.has(String(y))) return String(addr);
  }
  return null;
}

function pickPreset(presets) {
  const list = presets.presetParameter2 || [];
  const preferred = list.find((p) => p.account.binStep === 25)
    || list.find((p) => p.account.binStep === 20)
    || list.find((p) => p.account.binStep === 80)
    || list.find((p) => p.account.binStep >= 10 && p.account.binStep <= 100)
    || list[0];
  if (!preferred) throw new Error("No Meteora PresetParameter2 on Devnet.");
  return preferred;
}

function writeEnv(pair, pool) {
  const dir = path.resolve(here, "../target/deploy");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `devnet-meteora-${pair.name}.env`);
  const body = [
    `${pair.envKey}=${pool}`,
    `METEORA_PROGRAM_ID=${PROGRAM}`,
    `METEORA_PAIR=${pair.name}`,
    `METEORA_MINT_A=${pair.mintA.toBase58()}`,
    `METEORA_MINT_B=${pair.mintB.toBase58()}`,
    "",
  ].join("\n");
  fs.writeFileSync(file, body);
  // Also append/update into the combined env when primary USDC pool.
  const combined = path.join(dir, "devnet-meteora.env");
  let existing = fs.existsSync(combined) ? fs.readFileSync(combined, "utf8") : "";
  const line = `${pair.envKey}=${pool}`;
  if (existing.includes(`${pair.envKey}=`)) {
    existing = existing.replace(new RegExp(`${pair.envKey}=.*`), line);
  } else {
    existing = existing.trimEnd() + (existing ? "\n" : "") + line + "\n";
  }
  fs.writeFileSync(combined, existing);
  console.log("wrote", file, "and updated", combined);
}

async function tokenAmount(connection, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  try {
    const acc = await getAccount(connection, ata);
    return { ata, amount: acc.amount };
  } catch {
    return { ata, amount: 0n };
  }
}

async function seed(connection, payer, poolPk) {
  const pool = await DLMM.create(connection, poolPk, OPT);
  const active = await pool.getActiveBin();
  const position = Keypair.generate();
  // Narrow bin range keeps position rent small on faucet-limited Devnet wallets.
  const binSpan = Number(process.env.SEED_BIN_SPAN || "2");
  const minBinId = active.binId - binSpan;
  const maxBinId = active.binId + binSpan;
  const xMint = pool.tokenX.publicKey;
  const yMint = pool.tokenY.publicKey;
  const xIsSol = xMint.equals(NATIVE_MINT);
  const yIsSol = yMint.equals(NATIVE_MINT);
  // Smaller seeds for share tokens (jl/Jito) — deployer may hold little SOL on Devnet.
  // Override with SEED_SOL_LAMPORTS / SEED_TOKEN_AMOUNT when faucet-limited.
  const shareish = xMint.equals(JL_USDC) || yMint.equals(JL_USDC)
    || xMint.equals(JITO_SOL) || yMint.equals(JITO_SOL);
  const solSeed = BigInt(process.env.SEED_SOL_LAMPORTS || (shareish ? "5_000_000" : "50_000_000").replace(/_/g, ""));
  const tokSeed = BigInt(process.env.SEED_TOKEN_AMOUNT || (shareish ? "500_000" : "5_000_000").replace(/_/g, ""));
  const xAmt = xIsSol ? solSeed : tokSeed;
  const yAmt = yIsSol ? solSeed : tokSeed;

  const xBal = await tokenAmount(connection, xMint, payer.publicKey);
  const yBal = await tokenAmount(connection, yMint, payer.publicKey);
  const pre = [];
  if (xIsSol && xBal.amount < xAmt) {
    pre.push(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, xBal.ata, payer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: xBal.ata, lamports: Number(xAmt) }),
      createSyncNativeInstruction(xBal.ata),
    );
  }
  if (yIsSol && yBal.amount < yAmt) {
    pre.push(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, yBal.ata, payer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: yBal.ata, lamports: Number(yAmt) }),
      createSyncNativeInstruction(yBal.ata),
    );
  }
  if (pre.length) {
    await sendAndConfirmTransaction(connection, new Transaction().add(...pre), [payer]);
  }
  const xAfter = xIsSol ? xAmt : (await tokenAmount(connection, xMint, payer.publicKey)).amount;
  const yAfter = yIsSol ? yAmt : (await tokenAmount(connection, yMint, payer.publicKey)).amount;
  if (xAfter < xAmt || yAfter < yAmt) {
    throw new Error(
      `Not enough pool-token balance to seed (need ${xAmt} of ${xMint.toBase58()} and ${yAmt} of ${yMint.toBase58()}). ` +
        "For jlUSDC: Earn-deposit USDC first. For JitoSOL: depositSol into the Jito stake pool. Then re-run.",
    );
  }

  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: payer.publicKey,
    totalXAmount: new BN(xAmt.toString()),
    totalYAmount: new BN(yAmt.toString()),
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
  });
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, position]);
  console.log("seeded", sig);
}

async function main() {
  const pair = resolvePair();
  const payer = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const [tokenX, tokenY] = sortMints(pair.mintA, pair.mintB);
  console.log("pair", pair.name);
  console.log("payer", payer.publicKey.toBase58());
  console.log("tokenX", tokenX.toBase58(), "tokenY", tokenY.toBase58());

  let pool = (process.env[pair.envKey] || process.env.METEORA_POOL || "").trim();
  if (!pool) {
    try {
      pool = (await findViaApi(pair.mintA.toBase58(), pair.mintB.toBase58())) || "";
      if (pool) console.log("reusing API pool", pool);
    } catch (err) {
      console.warn("dev API lookup failed:", err instanceof Error ? err.message : err);
    }
  }

  if (!pool) {
    const presets = await DLMM.getAllPresetParameters(connection, OPT);
    const preset = pickPreset(presets);
    const binStep = preset.account.binStep;
    const existing = await DLMM.getPairPubkeyIfExists(
      connection,
      tokenX,
      tokenY,
      new BN(binStep),
      new BN(preset.account.baseFactor),
      new BN(preset.account.baseFeePowerFactor),
      preset.account.concreteFunctionType,
      preset.account.collectFeeMode,
      OPT,
    );
    if (existing) {
      pool = existing.toBase58();
      console.log("reusing on-chain pool", pool);
    } else {
      const mintX = await getMint(connection, tokenX);
      const mintY = await getMint(connection, tokenY);
      // human = price of tokenX in tokenY units (approx).
      let human = pair.humanPrice;
      if (tokenX.equals(NATIVE_MINT)) human = 1 / pair.humanPrice;
      else if (tokenY.equals(NATIVE_MINT) && pair.name === "usdc-sol") {
        human = tokenX.equals(USDC) ? 1 / SOL_USD : SOL_USD;
      } else if (tokenY.equals(NATIVE_MINT) && pair.name === "jlusdc-sol") {
        human = tokenX.equals(JL_USDC) ? 1 / SOL_USD : SOL_USD;
      } else if (tokenY.equals(NATIVE_MINT) && pair.name === "jitosol-sol") {
        human = 1;
      }
      const lamportPrice = DLMM.getPricePerLamport(mintX.decimals, mintY.decimals, human);
      const activeId = new BN(DLMM.getBinIdFromPrice(lamportPrice, binStep, false));
      console.log("creating pool", { binStep, activeId: activeId.toString(), human });
      const tx = await DLMM.createLbPair2(
        connection,
        payer.publicKey,
        tokenX,
        tokenY,
        preset.publicKey,
        activeId,
        OPT,
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
      console.log("createLbPair2", sig);
      const created = await DLMM.getPairPubkeyIfExists(
        connection,
        tokenX,
        tokenY,
        new BN(binStep),
        new BN(preset.account.baseFactor),
        new BN(preset.account.baseFeePowerFactor),
        preset.account.concreteFunctionType,
        preset.account.collectFeeMode,
        OPT,
      );
      if (!created) throw new Error("Pool transaction confirmed but getPairPubkeyIfExists returned null.");
      pool = created.toBase58();
    }
  }

  writeEnv(pair, pool);
  if (process.env.METEORA_SKIP_SEED === "1") {
    console.log(pair.envKey, pool);
    return;
  }
  await seed(connection, payer, new PublicKey(pool));
  console.log(pair.envKey, pool);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
