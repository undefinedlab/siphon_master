/**
 * Submission readiness check for Solana Devnet FHE + siphon-pool-v1.
 *   node siphon-contracts-v2/solana/scripts/verify-devnet-ready.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";

const here = path.dirname(fileURLToPath(import.meta.url));
const appMods = path.resolve(here, "../../../siphon-app/node_modules");
const require = createRequire(import.meta.url);
const web3 = require(path.join(appMods, "@solana/web3.js/lib/index.cjs.js"));
const spl = require(path.join(appMods, "@solana/spl-token"));

const { Connection, PublicKey } = web3;
const { getAssociatedTokenAddressSync, NATIVE_MINT } = spl;

const PROGRAM = new PublicKey("Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj");
const VAULT = new PublicKey("5WaifRrg4CrGLSbyqVYcjUQystjj5HigMn1mgUWjPa2k");
const POOL = new PublicKey("LXxanxpovDSDdwLTNibZSkqmerQQaLUR789SjnWB8Lg");
const USDC = new PublicKey("DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie");
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const EXECUTOR = (process.env.TRADE_EXECUTOR_URL || "http://127.0.0.1:5020").replace(/\/$/, "");

const checks = [];
function ok(name, detail) {
  checks.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  checks.push({ name, pass: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { timeout: 15000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d) });
        } catch {
          resolve({ status: res.statusCode, body: d });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function main() {
  const c = new Connection(RPC, "confirmed");

  const prog = await c.getAccountInfo(PROGRAM);
  if (prog?.executable) ok("program deployed", PROGRAM.toBase58());
  else fail("program deployed", "missing or not executable");

  const vault = await c.getAccountInfo(VAULT);
  if (vault && vault.owner.equals(PROGRAM)) ok("vault PDA", VAULT.toBase58());
  else fail("vault PDA", "missing/wrong owner");

  const pool = await c.getAccountInfo(POOL);
  if (pool && pool.owner.equals(PROGRAM)) ok("pool PDA", POOL.toBase58());
  else fail("pool PDA", "missing/wrong owner");

  const poolUsdc = getAssociatedTokenAddressSync(USDC, POOL, true);
  const poolWsol = getAssociatedTokenAddressSync(NATIVE_MINT, POOL, true);
  const u = await c.getTokenAccountBalance(poolUsdc);
  const w = await c.getTokenAccountBalance(poolWsol);
  const uAmt = BigInt(u.value.amount);
  const wAmt = BigInt(w.value.amount);
  if (uAmt > 0n && wAmt > 0n) {
    ok("pool liquidity", `${u.value.uiAmountString} USDC / ${w.value.uiAmountString} WSOL`);
  } else {
    fail("pool liquidity", "empty reserves");
  }

  const artifacts = [
    path.resolve(here, "../target/deploy/devnet-bidi-e2e.json"),
    path.resolve(here, "../../../siphon-fhe/trade-executor/instance/devnet-fhe-pool-e2e.json"),
  ];
  for (const p of artifacts) {
    if (fs.existsSync(p)) ok(`artifact ${path.basename(p)}`, p);
    else fail(`artifact ${path.basename(p)}`, "missing — re-run e2e scripts");
  }

  try {
    const h = await getJson(`${EXECUTOR}/health`);
    if (h.status === 200 && h.body?.status === "healthy") ok("executor health", EXECUTOR);
    else fail("executor health", JSON.stringify(h.body));
  } catch (e) {
    fail("executor health", String(e.message || e));
  }

  // FHE engine is optional for Devnet auto-execute path
  try {
    const fhe = await getJson("http://127.0.0.1:5001/health");
    if (fhe.status === 200) ok("FHE engine :5001", "up (full scheduler eval available)");
    else ok("FHE engine :5001", "down — Devnet uses arm+auto-execute / browser fire");
  } catch {
    ok("FHE engine :5001", "down — Devnet uses arm+auto-execute / browser fire (expected)");
  }

  const envApp = path.resolve(here, "../../../siphon-app/.env.local");
  if (fs.existsSync(envApp)) {
    const txt = fs.readFileSync(envApp, "utf8");
    const need = [
      "NEXT_PUBLIC_DEVNET_VAULT_CHAIN_ID=900002",
      "NEXT_PUBLIC_SOLANA_USDC_MINT=DteUanph",
      "NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID=Eip1D6",
      "NEXT_PUBLIC_CLUSTER=devnet",
    ];
    const missing = need.filter((n) => !txt.includes(n.split("=")[0]) || !txt.includes(n.split("=")[1]));
    if (missing.length === 0) ok("app .env.local keys", "900002 + program + mint + cluster");
    else fail("app .env.local keys", missing.join(", "));
  } else fail("app .env.local", "missing");

  const envEx = path.resolve(here, "../../../siphon-fhe/trade-executor/.env.devnet");
  if (fs.existsSync(envEx)) {
    const txt = fs.readFileSync(envEx, "utf8");
    const flags = ["SOLANA_DEVNET_ARM_OPEN=1", "SOLANA_DEVNET_AUTO_EXECUTE=1", "REQUIRE_USER_API_KEY=0"];
    const bad = flags.filter((f) => !txt.includes(f));
    if (bad.length === 0) ok("executor .env.devnet flags", flags.join(", "));
    else fail("executor .env.devnet flags", `missing ${bad.join(", ")}`);
  } else fail("executor .env.devnet", "missing");

  const failed = checks.filter((x) => !x.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exit(1);
  console.log("READY for Devnet submission demo");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
