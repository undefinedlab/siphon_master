#!/usr/bin/env node
/**
 * RPC load benchmark for siphon-app /api/rpc.
 *
 * Usage:
 *   node scripts/rpc-benchmark.mjs                    # against localhost:3000
 *   node scripts/rpc-benchmark.mjs --base https://... # against deployed app
 *   node scripts/rpc-benchmark.mjs --scenario wallet-balance
 *
 * Scenarios simulate what the browser/ethers stack does — not full React mount.
 */

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : "http://localhost:3000";
const scenarioIdx = args.indexOf("--scenario");
const SCENARIO = scenarioIdx >= 0 ? args[scenarioIdx + 1] : "all";
const chainIdx = args.indexOf("--chain");
const CHAIN_ID = chainIdx >= 0 ? parseInt(args[chainIdx + 1], 10) : 8453;

const ENTRYPOINT = {
  8453: "0xA8AD713eDc27b14AA6057C53745479bc6a7E145A",
  11155111: "0x867e9C195eB85960c390D4a7A64F4e16905D6638",
};
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const GET_VAULT_SELECTOR = "0x0eb9af38"; // getVault(address)
const MERKLE_TREE_SELECTOR = "0xbb7df052"; // merkleTree()
const NULLIFIERS_SELECTOR = "0xd21e82ab"; // nullifiers(uint256)

function padAddr(addr) {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

function encodeGetVault(token) {
  return GET_VAULT_SELECTOR + padAddr(token);
}

function encodeNullifier(hash) {
  const h = BigInt(hash).toString(16);
  return NULLIFIERS_SELECTOR + h.padStart(64, "0");
}

let rpcId = 1;

async function rpc(chainId, method, params, label) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/rpc?chainId=${chainId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: `${BASE}/dapp`,
      "User-Agent": "siphon-rpc-benchmark/1.0",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  let ok = res.ok;
  try {
    const j = JSON.parse(text);
    if (j.error) ok = false;
  } catch {
    ok = false;
  }
  return { label: label ?? method, method, ms, ok, status: res.status };
}

async function resetStats() {
  await fetch(`${BASE}/api/rpc/stats?reset=1`);
}

async function getStats() {
  const res = await fetch(`${BASE}/api/rpc/stats`);
  return res.json();
}

async function fetchIndexerLeaves(chainId, asset) {
  const executor = process.env.TRADE_EXECUTOR_URL || "https://3-81-144-108.sslip.io";
  const t0 = Date.now();
  const res = await fetch(
    `${executor}/vault-index/leaves?chainId=${chainId}&asset=${encodeURIComponent(asset)}`,
  );
  const ms = Date.now() - t0;
  return { ok: res.ok, ms, status: res.status };
}

/** Mirrors zkHandler.resolveVault + indexer path (happy path, 0 local notes). */
async function scenarioWalletBalance(chainId) {
  const entry = ENTRYPOINT[chainId];
  if (!entry) throw new Error(`No entrypoint for chain ${chainId}`);

  const steps = [];

  const idx = await fetchIndexerLeaves(chainId, "ETH");
  steps.push({ label: "indexer: vault-index/leaves ETH", method: "HTTP", ...idx });

  const getVault = await rpc(chainId, "eth_call", [
    { to: entry, data: encodeGetVault(NATIVE) },
    "latest",
  ], "resolveVault: entrypoint.getVault(ETH)");
  steps.push(getVault);

  let vaultAddr = null;
  try {
    const res = await fetch(`${BASE}/api/rpc?chainId=${chainId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9999,
        method: "eth_call",
        params: [{ to: entry, data: encodeGetVault(NATIVE) }, "latest"],
      }),
    });
    const j = await res.json();
    if (j.result) vaultAddr = "0x" + j.result.slice(-40);
  } catch {
    /* ignore */
  }

  if (vaultAddr) {
    const mt = await rpc(
      chainId,
      "eth_call",
      [{ to: vaultAddr, data: MERKLE_TREE_SELECTOR }, "latest"],
      "resolveVault: vault.merkleTree()",
    );
    steps.push(mt);
  }

  // Simulate 2 notes → 2 nullifier checks
  for (let i = 0; i < 2; i++) {
    const fakeHash = (BigInt(i + 1) * 123456789n).toString();
    if (vaultAddr) {
      steps.push(
        await rpc(
          chainId,
          "eth_call",
          [{ to: vaultAddr, data: encodeNullifier(fakeHash) }, "latest"],
          `getSpendableVaultBalance: nullifiers(check #${i + 1})`,
        ),
      );
    }
  }

  return steps;
}

/** Worst case: on-chain leaf scan fallback (sample — 5 getLogs chunks). */
async function scenarioIndexerFallbackSample(chainId) {
  const entry = ENTRYPOINT[chainId];
  const steps = [];
  steps.push(await rpc(chainId, "eth_blockNumber", [], "fallback: eth_blockNumber"));
  const latestHex = await (async () => {
    const r = await fetch(`${BASE}/api/rpc?chainId=${chainId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    const j = await r.json();
    return parseInt(j.result, 16);
  })();

  const deployBlock = chainId === 8453 ? 50240388 : 11130700;
  const chunk = 2000;
  const sampleChunks = 5;
  let from = Math.max(deployBlock, latestHex - chunk * sampleChunks);

  for (let i = 0; i < sampleChunks; i++) {
    const to = Math.min(from + chunk - 1, latestHex);
    steps.push(
      await rpc(
        chainId,
        "eth_getLogs",
        [
          {
            fromBlock: "0x" + from.toString(16),
            toBlock: "0x" + to.toString(16),
            address: "0x0000000000000000000000000000000000000001",
            topics: [],
          },
        ],
        `fallback sample: eth_getLogs chunk ${i + 1}/${sampleChunks}`,
      ),
    );
    from = to + 1;
  }

  void entry;
  return steps;
}

/** Page-load API traffic that is NOT /api/rpc */
async function scenarioPageApis() {
  const paths = [
    "/api/price?coin=all",
    "/api/coins",
    "/api/fear-greed",
    "/api/market-global",
    "/api/news",
  ];
  const steps = [];
  for (const p of paths) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}${p}`, { headers: { Referer: `${BASE}/dapp` } });
    steps.push({
      label: `widget API: ${p}`,
      method: "HTTP",
      ms: Date.now() - t0,
      ok: res.ok,
      status: res.status,
    });
  }
  return steps;
}

function printSteps(title, steps) {
  console.log(`\n=== ${title} ===`);
  let totalMs = 0;
  for (const s of steps) {
    totalMs += s.ms;
    const flag = s.ok ? "ok" : "FAIL";
    console.log(`  [${flag}] ${s.label} — ${s.ms}ms`);
  }
  console.log(`  subtotal: ${steps.length} calls, ${totalMs}ms wall`);
  return { count: steps.length, totalMs };
}

async function main() {
  console.log(`RPC benchmark → ${BASE} (chain ${CHAIN_ID})`);
  await resetStats();

  const summaries = [];

  if (SCENARIO === "all" || SCENARIO === "page-apis") {
    summaries.push({
      name: "page-apis (widgets, NOT rpc)",
      ...(await scenarioPageApis().then((s) => {
        printSteps("Page widget APIs (no wallet)", s);
        return { count: s.length, totalMs: s.reduce((a, b) => a + b.ms, 0) };
      })),
    });
  }

  if (SCENARIO === "all" || SCENARIO === "wallet-balance") {
    const steps = await scenarioWalletBalance(CHAIN_ID);
    summaries.push({ name: "wallet-balance (indexer + eth_call)", ...printSteps("Wallet vault balance reconcile", steps) });
  }

  if (SCENARIO === "all" || SCENARIO === "indexer-fallback-sample") {
    const steps = await scenarioIndexerFallbackSample(CHAIN_ID);
    summaries.push({
      name: "indexer-fallback-sample (5 getLogs chunks)",
      ...printSteps("Indexer fallback SAMPLE (5 chunks only)", steps),
    });
  }

  const stats = await getStats();
  console.log("\n=== /api/rpc server stats ===");
  console.log(`  totalRequests: ${stats.totalRequests}`);
  console.log(`  avgMs: ${stats.avgMs}`);
  console.log(`  byChainId:`, stats.byChainId);
  console.log("  methods:");
  for (const m of stats.methods ?? []) {
    console.log(`    ${m.method}: ${m.count}x avg ${m.avgMs}ms`);
  }

  console.log("\n=== Load model (from code analysis) ===");
  console.log(`
  COLD /dapp load (no wallet):
    - /api/rpc: 0
    - /api/price, /api/coins, /api/fear-greed, /api/market-global, /api/news (widgets, ~3min poll)
    - StrategyAutoExecutor → trade-executor (5s) — NOT rpc
    - RunsPanel → trade-executor (5s if wallet+strategies) — NOT rpc

  Wallet restored (ConnectButton in Nav):
    - getSpendableVaultBalance once → indexer + 2–4 eth_call (see wallet-balance scenario)
    - repeats every 60s from ConnectButton

  UserDash view (extra):
    - fetchVaultBalances every 60s (duplicate of ConnectButton)
    - wallet balances via MetaMask (NOT /api/rpc)

  Wallet widget on dashboard:
    - WalletPanel loadVaultBalances every 60s (3rd duplicate)

  Indexer down:
    - getOnChainLeaves → eth_blockNumber + eth_getLogs from deployBlock..latest
    - Base deploy block ${ENTRYPOINT[8453] ? "50240388" : "?"} → thousands of /api/rpc calls per scan
`);

  console.log("=== Scenario summary ===");
  for (const s of summaries) {
    console.log(`  ${s.name}: ${s.count} calls, ${s.totalMs}ms`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
