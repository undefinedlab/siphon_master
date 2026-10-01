/**
 * Devnet E2E: ZK deposit → Groth16 spend package → createStrategy → executor
 * submits the spend and swaps on Meteora DLMM.
 *
 * Requires the trade-executor on TRADE_EXECUTOR_URL (default http://127.0.0.1:5020)
 * with SOLANA_DEVNET_ARM_OPEN=1, METEORA_POOL set, and the same relayer keypair
 * this script proves the spend to (default ~/.config/solana/id.json).
 *
 *   cd siphon-contracts-v2/solana/scripts
 *   node e2e-devnet-zk-meteora.mjs
 *
 * The withdraw harness deposits WSOL, publishes compliance roots, and writes a
 * proof. This script does not submit the spend itself.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { Connection, Keypair, PublicKey } = web3;
const { getAssociatedTokenAddressSync, getAccount } = spl;

const here = path.dirname(fileURLToPath(import.meta.url));
const EXECUTOR = (process.env.TRADE_EXECUTOR_URL || "http://127.0.0.1:5020").replace(/\/$/, "");
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const USDC = new PublicKey(
  process.env.SOLANA_USDC_MINT ||
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT ||
    "DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie",
);

function loadKeypair() {
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function meteoraPool() {
  if (process.env.METEORA_POOL) return process.env.METEORA_POOL.trim();
  const envFile = path.resolve(here, "../target/deploy/devnet-meteora.env");
  if (!fs.existsSync(envFile)) {
    throw new Error("METEORA_POOL unset. Run setup-meteora-devnet-pool.mjs first.");
  }
  const line = fs.readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => l.startsWith("METEORA_POOL="));
  const pool = line?.slice("METEORA_POOL=".length).trim();
  if (!pool) throw new Error(`no METEORA_POOL in ${envFile}`);
  return pool;
}

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: here,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} exited ${code}`));
    });
  });
}

async function tokenBalance(connection, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  try {
    return (await getAccount(connection, ata)).amount;
  } catch {
    return 0n;
  }
}

async function post(pathname, body, headers) {
  const res = await fetch(`${EXECUTOR}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  return { status: res.status, json };
}

async function main() {
  const payer = loadKeypair();
  const user = payer.publicKey.toBase58();
  const pool = meteoraPool();
  const connection = new Connection(RPC, "confirmed");
  const usdcBefore = await tokenBalance(connection, USDC, payer.publicKey);
  const pkgPath = path.resolve(here, "../target/deploy/devnet-zk-meteora-package.json");

  if (process.env.REUSE_SPEND_PACKAGE === "1" && fs.existsSync(pkgPath)) {
    console.log("reusing spend package", pkgPath);
  } else {
    console.log("proving ZK spend to", user);
    // The zkey on disk is the dev-beacon set. The live vault was on the ceremony VK, and that
    // proving key is not in the repo, so this run installs the matching withdraw1 VK first.
    await runNode(path.join(here, "e2e-devnet-zk-withdraw.mjs"), {
      ZK_SPEND_PACKAGE_OUT: pkgPath,
      ZK_SPEND_RECIPIENT: user,
      ALLOW_DEVBEACON_VK: "1",
    });
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.meteora_pool = pool;
  pkg.solana_usdc_mint = USDC.toBase58();
  pkg.solana_mint = pkg.mint;

  const headers = { "X-Solana-Address": user };
  const keyUp = await post(
    "/uploadServerKey",
    { user_id: user, server_key: "00".repeat(32), canary: "00" },
    headers,
  );
  if (keyUp.status >= 400 && !String(keyUp.json?.error || "").toLowerCase().includes("already")) {
    console.log("uploadServerKey", keyUp.status, keyUp.json);
  }

  const created = await post(
    "/createStrategy",
    {
      user_id: user,
      strategy_type: "LIMIT_BUY",
      asset_in: "SOL",
      asset_out: "USDC",
      amount: Number(pkg.amount_base_units) / 1e9,
      recipient_address: user,
      from_chain: "900002",
      to_chain: "900002",
      encrypted_upper_bound: "00",
      encrypted_lower_bound: "00",
      solana_side: "sell_wsol",
      solana_mint: pkg.mint,
      solana_usdc_mint: USDC.toBase58(),
      zkp_data: pkg,
    },
    headers,
  );
  console.log("createStrategy", created.status, created.json);
  if (created.status >= 400) throw new Error(`createStrategy failed: ${JSON.stringify(created.json)}`);

  let exec = created.json.auto_execute;
  if (!exec || exec.status !== "EXECUTED") {
    const sid = created.json.strategy_id;
    exec = (await post("/executeStrategy", { strategy_id: sid, user_id: user }, headers)).json;
    console.log("executeStrategy", exec);
  }
  if (exec?.code === "NEEDS_REPROOF" || exec?.status === "NEEDS_REPROOF") {
    throw new Error("NEEDS_REPROOF — state root moved between prove and submit. Re-run.");
  }
  if (exec?.status !== "EXECUTED" && exec?.status !== "success") {
    throw new Error(`executor did not settle: ${JSON.stringify(exec)}`);
  }

  const usdcAfter = await tokenBalance(connection, USDC, payer.publicKey);
  console.log("USDC", usdcBefore.toString(), "→", usdcAfter.toString());
  if (usdcAfter <= usdcBefore) {
    throw new Error("recipient USDC balance did not increase");
  }
  const outPath = path.resolve(here, "../target/deploy/devnet-zk-meteora-e2e.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify({
      user,
      pool,
      strategy_id: created.json.strategy_id,
      spend_sig: exec.spend_sig || exec.tx_hash,
      swap_sig: exec.swap_sig,
      usdcBefore: usdcBefore.toString(),
      usdcAfter: usdcAfter.toString(),
    }, null, 2),
  );
  console.log("wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
