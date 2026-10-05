#!/usr/bin/env node
/**
 * End-to-end integration verification (read-only + service health).
 * Does NOT submit on-chain txs — needs a wallet for deposit/strategy execution.
 *
 * Usage: node scripts/e2e-verify.mjs [--base http://localhost:3000]
 */

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const APP_BASE = baseIdx >= 0 ? args[baseIdx + 1] : "http://localhost:3000";
const EXECUTOR = process.env.TRADE_EXECUTOR_URL || "https://3-81-144-108.sslip.io";
const EXECUTOR_API_TOKEN = process.env.API_TOKEN || "";
const CHAIN_ID = 8453;

const CONTRACTS = {
  entrypoint: "0xA8AD713eDc27b14AA6057C53745479bc6a7E145A",
  nativeVault: "", // resolved via getVault at runtime
  executor: "0x31c9a52Dc09D5c0e61256cA04156A528ecc63cf9",
};

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const RPC = "https://mainnet.base.org";

const results = [];

function pass(name, detail, ms) {
  results.push({ ok: true, name, detail, ms });
  console.log(`  ✓ ${name} — ${detail}${ms != null ? ` (${ms}ms)` : ""}`);
}

function fail(name, detail, ms) {
  results.push({ ok: false, name, detail, ms });
  console.log(`  ✗ ${name} — ${detail}${ms != null ? ` (${ms}ms)` : ""}`);
}

async function rpcCall(method, params) {
  const t0 = Date.now();
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  const ms = Date.now() - t0;
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return { result: json.result, ms };
}

function encodeGetVault(token) {
  const sel = "0x0eb9af38";
  const addr = token.toLowerCase().replace("0x", "").padStart(64, "0");
  return sel + addr;
}

async function httpCheck(name, url, expectOk = true) {
  const t0 = Date.now();
  try {
    const headers = url.startsWith(EXECUTOR) && EXECUTOR_API_TOKEN
      ? { "X-API-TOKEN": EXECUTOR_API_TOKEN }
      : undefined;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const ms = Date.now() - t0;
    if (expectOk ? res.ok : true) {
      pass(name, `HTTP ${res.status}`, ms);
      return res;
    }
    fail(name, `HTTP ${res.status}`, ms);
    return null;
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err), Date.now() - t0);
    return null;
  }
}

async function httpCheckWalletProtected(name, url) {
  const t0 = Date.now();
  try {
    // User routes deliberately reject server API tokens; only a wallet-signed request may read
    // private strategy/key state. A read-only deployment probe should verify that boundary.
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const ms = Date.now() - t0;
    if (res.status === 401 || res.status === 403) {
      pass(name, `wallet auth enforced (HTTP ${res.status})`, ms);
      return;
    }
    fail(name, `expected wallet-auth rejection, got HTTP ${res.status}`, ms);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err), Date.now() - t0);
  }
}

async function main() {
  console.log("\n═══════════════════════════════════════════════════");
  console.log("  SIPHON E2E VERIFICATION (read-only)");
  console.log(`  App: ${APP_BASE}  |  Executor: ${EXECUTOR}  |  Chain: Base ${CHAIN_ID}`);
  console.log("═══════════════════════════════════════════════════\n");

  // ── 1. Indexer (leaves for balance / withdraw proofs) ──
  console.log("1. INDEXER (trade-executor /vault-index)");
  const healthRes = await httpCheck(
    "vault-index/health",
    `${EXECUTOR}/vault-index/health`,
  );
  let leafCount = 0;
  let ethLeaves = 0;
  if (healthRes) {
    const h = await healthRes.json();
    leafCount = h.leafCount ?? 0;
    console.log(`     → leafCount=${leafCount}, ok=${h.ok}`);
  }

  const leavesRes = await httpCheck(
    "vault-index/leaves ETH",
    `${EXECUTOR}/vault-index/leaves?chainId=${CHAIN_ID}&asset=ETH`,
  );
  if (leavesRes) {
    const data = await leavesRes.json();
    ethLeaves = data.count ?? data.leaves?.length ?? 0;
    console.log(`     → ETH leaves on-chain (indexed): ${ethLeaves}`);
  }

  const leavesUsdcRes = await httpCheck(
    "vault-index/leaves USDC",
    `${EXECUTOR}/vault-index/leaves?chainId=${CHAIN_ID}&asset=USDC`,
  );
  if (leavesUsdcRes) {
    const data = await leavesUsdcRes.json();
    console.log(`     → USDC leaves (indexed): ${data.count ?? data.leaves?.length ?? 0}`);
  }

  // ── 2. Direct chain RPC (browser path after optimization) ──
  console.log("\n2. CHAIN RPC (direct — browser read path)");
  try {
    const { result: blockHex, ms } = await rpcCall("eth_blockNumber", []);
    const block = parseInt(blockHex, 16);
    pass("eth_blockNumber", `block ${block.toLocaleString()}`, ms);
  } catch (e) {
    fail("eth_blockNumber", String(e));
  }

  try {
    const { result, ms } = await rpcCall("eth_call", [
      { to: CONTRACTS.entrypoint, data: encodeGetVault(NATIVE) },
      "latest",
    ]);
    const vaultFromChain = "0x" + result.slice(-40);
    CONTRACTS.nativeVault = vaultFromChain;
    pass("entrypoint.getVault(ETH)", vaultFromChain, ms);
  } catch (e) {
    fail("entrypoint.getVault(ETH)", String(e));
  }

  try {
    const sel = "0xbb7df052"; // merkleTree()
    const vault = CONTRACTS.nativeVault;
    if (!vault) throw new Error("vault not resolved");
    const { result, ms } = await rpcCall("eth_call", [
      { to: vault, data: sel },
      "latest",
    ]);
    const merkle = "0x" + result.slice(-40);
    pass("nativeVault.merkleTree()", merkle, ms);
  } catch (e) {
    fail("nativeVault.merkleTree()", String(e));
  }

  // ── 3. App APIs (page load widgets) ──
  console.log("\n3. APP APIs (Vercel / local — NOT chain RPC)");
  for (const path of [
    "/api/price?coin=all",
    "/api/coins",
    "/api/fear-greed",
    "/api/market-global",
    "/api/news",
  ]) {
    await httpCheck(`app ${path.split("?")[0]}`, `${APP_BASE}${path}`);
  }

  // ── 4. Trade executor (strategies — post-deposit flow) ──
  console.log("\n4. TRADE EXECUTOR (strategy lifecycle)");
  await httpCheckWalletProtected(
    "GET /strategies/{executor}",
    `${EXECUTOR}/strategies/${CONTRACTS.executor}`,
  );

  const routes = [
    "/hasServerKey/0x31c9a52Dc09D5c0e61256cA04156A528ecc63cf9",
  ];
  for (const r of routes) {
    await httpCheckWalletProtected(`GET ${r}`, `${EXECUTOR}${r}`);
  }

  // ── 5. Simulated balance reconcile call budget ──
  console.log("\n5. BALANCE RECONCILE BUDGET (per poll, wallet connected)");
  const notesAssumed = 2;
  const rpcPerPoll = 2 + notesAssumed; // getVault + merkleTree + nullifiers
  const indexerPerPoll = 1; // leaves (cached 5 min)
  const pollsPerHour = 3600 / 120; // vaultBalanceStore 120s
  console.log(`     Indexer HTTP:  ~${indexerPerPoll} per refresh (${pollsPerHour}/hr max when cache cold)`);
  console.log(`     Direct RPC:    ~${rpcPerPoll} eth_call per refresh (${rpcPerPoll * pollsPerHour}/hr worst case)`);
  console.log(`     Vercel /api/rpc: 0 (unless NEXT_PUBLIC_RPC_PROXY=1)`);
  console.log(`     getLogs scan:  0 in production (indexer has ${ethLeaves} ETH leaves)`);

  // ── 6. Deposit → strategy flow checklist ──
  console.log("\n6. USER FLOW CHECKLIST (what needs a real wallet)");
  const checklist = [
    ["Deposit ETH/USDC", "Wallet signs entrypoint.deposit() → LeafInserted event → indexer picks up"],
    ["Balance shows in Nav", `indexer leaves + ${rpcPerPoll} eth_call, poll every 120s`],
    ["Build + arm strategy", "FHE encrypt → POST /createStrategy → status ARMED"],
    ["Auto-executor / TEE", "processArmedStrategies polls executor every 5s"],
    ["Execution result", "status EXECUTED + tx_hash on strategy record"],
    ["Withdraw", "generateZKData uses indexer leaves + eth_call nullifiers"],
  ];
  for (const [step, note] of checklist) {
    console.log(`     • ${step}: ${note}`);
  }

  // ── Summary ──
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok).length;
  console.log("\n═══════════════════════════════════════════════════");
  console.log(`  RESULT: ${ok} passed, ${bad} failed (${results.length} checks)`);
  if (bad === 0) {
    console.log("  Backend + indexer + chain reads: OK for E2E");
    console.log("  On-chain deposit/strategy: requires MetaMask + funded wallet");
  } else {
    console.log("  Fix failures above before expecting E2E to work");
    process.exit(1);
  }
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
