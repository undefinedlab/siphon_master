import { SiphonClient } from "./client";
import {
  assessStrategyArming,
  armForceAllowed,
  getAnonymitySet,
  getRecentVaultSwaps,
  getUniswapPoolDepth,
} from "./graph";
import * as readline from "readline";

const baseUrl = process.env.SIPHON_BASE_URL || "http://localhost:8000";

function resolveApiKey(): string {
  const fromEnv = (process.env.SIPHON_API_KEY || "").trim();
  if (fromEnv) return fromEnv;

  const allowTest =
    process.env.SIPHON_ALLOW_TEST_KEY === "1" ||
    process.env.SIPHON_ALLOW_TEST_KEY === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    typeof process.env.BUN_TEST !== "undefined";

  if (allowTest) {
    return "sk_test_123";
  }

  throw new Error(
    "SIPHON_API_KEY is required. Set a real sk_… key, or SIPHON_ALLOW_TEST_KEY=1 for local/test only.",
  );
}

const apiKey = resolveApiKey();
const privateKey = process.env.SIPHON_PRIVATE_KEY;

const client = new SiphonClient({ baseUrl, apiKey, privateKey });

const tools = [
  {
    name: "listNotes",
    description: "List the spendable notes and balances for the configured wallet on a specific chain.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number", description: "Chain ID (e.g. 11155111 for Sepolia)" },
      },
      required: ["chainId"],
    },
  },
  {
    name: "listStrategyFunctions",
    description: "Discover the catalog of confidential strategy types and their parameter schemas.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "validateStrategy",
    description: "Dry-run validate a strategy (semantic + crypto checks); free and unmetered.",
    inputSchema: {
      type: "object",
      properties: { strategyData: { type: "object" } },
      required: ["strategyData"],
    },
  },
  {
    name: "createDeposit",
    description: "Create a deposit intent. Returns note material (to save) and transaction calldata.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        asset: { type: "string", description: "USDC or ETH" },
        amount: { type: "string", description: "Amount in decimal string" },
        precommitment: { type: "string", description: "Precommitment Poseidon hash" },
      },
      required: ["chainId", "asset", "amount", "precommitment"],
    },
  },
  {
    name: "confirmDeposit",
    description: "Confirm a completed on-chain deposit transaction hash.",
    inputSchema: {
      type: "object",
      properties: {
        depositId: { type: "string" },
        txHash: { type: "string" },
        chainId: { type: "number" },
      },
      required: ["depositId", "txHash", "chainId"],
    },
  },
  {
    name: "createWithdrawal",
    description: "Create a withdrawal intent using a ZK proof.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        asset: { type: "string" },
        recipient: { type: "string" },
        amount: { type: "string" },
        proof: {
          type: "object",
          properties: {
            stateRoot: { type: "string" },
            nullifierHashes: { type: "array", items: { type: "string" } },
            changeCommitment: { type: "string" },
            pA: { type: "array", items: { type: "string" } },
            pB: { type: "array", items: { type: "array", items: { type: "string" } } },
            pC: { type: "array", items: { type: "string" } },
          },
          required: ["stateRoot", "nullifierHashes", "changeCommitment", "pA", "pB", "pC"],
        },
      },
      required: ["chainId", "asset", "recipient", "amount", "proof"],
    },
  },
  {
    name: "confirmWithdrawal",
    description: "Confirm a completed on-chain withdrawal transaction hash.",
    inputSchema: {
      type: "object",
      properties: {
        withdrawalId: { type: "string" },
        txHash: { type: "string" },
        chainId: { type: "number" },
      },
      required: ["withdrawalId", "txHash", "chainId"],
    },
  },
  {
    name: "createStrategy",
    description:
      "Arm a confidential trade strategy on the executor. Prefetches vault-index anonymity; blocks when fail-closed or empty. force=true only works if GRAPH_ARM_FORCE_ALLOWED is set on the MCP host.",
    inputSchema: {
      type: "object",
      properties: {
        strategyData: { type: "object", description: "Configured strategy payload" },
        chainId: { type: "number" },
        force: {
          type: "boolean",
          description:
            "Override vault-index arming gate only when GRAPH_ARM_FORCE_ALLOWED=true on the server",
        },
      },
      required: ["strategyData", "chainId"],
    },
  },
  {
    name: "listStrategies",
    description: "List strategies armed or executed by the wallet.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
      },
      required: ["chainId"],
    },
  },
  {
    name: "getStrategy",
    description: "Get detail or results of a specific strategy.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: { type: "string" },
        chainId: { type: "number" },
      },
      required: ["strategyId", "chainId"],
    },
  },
  {
    name: "abortStrategy",
    description: "Abort an armed, unfired strategy.",
    inputSchema: {
      type: "object",
      properties: {
        strategyId: { type: "string" },
        chainId: { type: "number" },
      },
      required: ["strategyId", "chainId"],
    },
  },
  {
    name: "getAccountUsage",
    description: "Get usage statistics and granted credit balance.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "getFeeQuote",
    description: "Get fee quote parameters.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "listCreditPacks",
    description: "List USDC credit packs and the collector address for API-key purchase.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "listApiKeys",
    description: "List API keys owned by the signed wallet (no plaintext secrets).",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number", description: "Chain ID used for wallet auth headers" },
      },
      required: ["chainId"],
    },
  },
  {
    name: "purchaseApiKey",
    description: "After paying USDC on-chain, mint an API key and credit prepaid balance 1:1.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        packId: { type: "string", description: "starter | growth | scale | custom" },
        txHash: { type: "string", description: "0x… payment tx hash" },
        usdcMinor: { type: "number", description: "Required when packId is custom (USDC * 1e6)" },
      },
      required: ["chainId", "packId", "txHash"],
    },
  },
  {
    name: "getAnonymitySet",
    description:
      "Live vault anonymity-set size from trade-executor /vault-index (Ponder). Cite privacyMetric (prefer depositCount) before recommending private strategies.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number", description: "8453 Base or 11155111 Sepolia" },
        asset: { type: "string", description: "ETH or USDC" },
      },
      required: ["chainId", "asset"],
    },
  },
  {
    name: "getRecentVaultSwaps",
    description:
      "Recent Vault.Swapped settles from trade-executor /vault-index (Ponder). Use to report settle activity.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        limit: { type: "number", description: "Max rows (default 10)" },
      },
      required: ["chainId"],
    },
  },
  {
    name: "getUniswapPoolDepth",
    description:
      "Deprecated: Uniswap pool depth via The Graph is not used. Returns an empty stub.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number", description: "Must be 8453 for live Uniswap Graph" },
        tokenIn: { type: "string", description: "ETH or USDC" },
        tokenOut: { type: "string", description: "ETH or USDC" },
      },
      required: ["chainId", "tokenIn", "tokenOut"],
    },
  },
  {
    name: "assessStrategyArming",
    description:
      "Combine vault-index anonymity (Ponder REST) before arming. Returns shouldBlock/shouldWarn and human reasons — call before createStrategy.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        fromAsset: { type: "string" },
        toAsset: { type: "string" },
        includeSwap: { type: "boolean" },
      },
      required: ["chainId", "fromAsset"],
    },
  },
];

function inferArmAssets(strategyData: Record<string, unknown>): {
  fromAsset: string;
  toAsset: string | null;
  includeSwap: boolean;
} {
  const from =
    String(
      strategyData.asset ||
        strategyData.fromAsset ||
        strategyData.coin ||
        strategyData.tokenIn ||
        "ETH",
    ).toUpperCase() || "ETH";
  const toRaw =
    strategyData.toAsset || strategyData.toCoin || strategyData.tokenOut || null;
  const to = toRaw != null ? String(toRaw).toUpperCase() : null;
  const includeSwap =
    strategyData.includeSwap === true ||
    (to != null && to !== from) ||
    strategyData.action === "swap";
  return { fromAsset: from, toAsset: to, includeSwap };
}

async function handleToolCall(name: string, args: any): Promise<any> {
  switch (name) {
    case "listNotes":
      return await client.notes.list(args.chainId);
    case "listStrategyFunctions":
      return await client.strategies.functions();
    case "validateStrategy":
      return await client.strategies.validate(args.strategyData);
    case "createDeposit":
      return await client.deposits.create(args.chainId, args.asset, args.amount, args.precommitment);
    case "confirmDeposit":
      return await client.deposits.confirm(args.depositId, args.txHash, args.chainId);
    case "createWithdrawal":
      return await client.withdrawals.create(
        args.chainId,
        args.asset,
        args.recipient,
        args.amount,
        args.proof,
      );
    case "confirmWithdrawal":
      return await client.withdrawals.confirm(args.withdrawalId, args.txHash, args.chainId);
    case "createStrategy": {
      const wantForce = args.force === true;
      const force = wantForce && armForceAllowed();
      const inferred = inferArmAssets(args.strategyData || {});
      const assessment = await assessStrategyArming({
        chainId: args.chainId,
        fromAsset: inferred.fromAsset,
        toAsset: inferred.toAsset,
        includeSwap: inferred.includeSwap,
      });
      if (assessment.shouldBlock && !force) {
        return {
          armed: false,
          blocked: true,
          assessment,
          forceIgnored: wantForce && !armForceAllowed(),
          message: wantForce && !armForceAllowed()
            ? "Refused to arm: vault-index gate blocked and force overrides are disabled (set GRAPH_ARM_FORCE_ALLOWED=true to enable)."
            : "Refused to arm: vault-index anonymity gate blocked this strategy (anonymity missing or empty).",
        };
      }
      if (force && assessment.shouldBlock) {
        console.error(
          "[siphon-mcp] createStrategy force override used despite shouldBlock",
          JSON.stringify({
            chainId: args.chainId,
            reasons: assessment.reasons,
          }),
        );
      }
      const created = await client.strategies.create(args.strategyData, args.chainId);
      return {
        ...created,
        assessment,
        warned: assessment.shouldWarn,
        forced: Boolean(force && assessment.shouldBlock),
      };
    }
    case "listStrategies":
      return await client.strategies.list(args.chainId);
    case "getStrategy":
      return await client.strategies.get(args.strategyId, args.chainId);
    case "abortStrategy":
      return await client.strategies.abort(args.strategyId, args.chainId);
    case "getAccountUsage":
      return await client.account.usage();
    case "getFeeQuote":
      return await client.fees.quote();
    case "listCreditPacks":
      return await client.keys.packs();
    case "listApiKeys":
      return await client.keys.list(args.chainId);
    case "purchaseApiKey":
      return await client.keys.purchase(args.chainId, args.packId, args.txHash, {
        usdcMinor: args.usdcMinor,
      });
    case "getAnonymitySet":
      return await getAnonymitySet(args.chainId, args.asset);
    case "getRecentVaultSwaps":
      return await getRecentVaultSwaps(args.chainId, args.limit ?? 10);
    case "getUniswapPoolDepth":
      return await getUniswapPoolDepth(args.chainId, args.tokenIn, args.tokenOut);
    case "assessStrategyArming":
      return await assessStrategyArming({
        chainId: args.chainId,
        fromAsset: args.fromAsset,
        toAsset: args.toAsset ?? null,
        includeSwap: args.includeSwap,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    const { method, id } = request;

    if (method === "tools/list") {
      console.log(JSON.stringify({ jsonrpc: "2.0", result: { tools }, id }));
    } else if (method === "tools/call") {
      const { name, arguments: args } = request.params || {};
      try {
        const result = await handleToolCall(name, args);
        console.log(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            },
            id,
          }),
        );
      } catch (err: any) {
        console.error(`Error executing tool ${name}:`, err);
        console.log(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err.message || "Internal error" },
            id,
          }),
        );
      }
    } else if (method === "initialize") {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "siphon-mcp-server", version: "1.1.0" },
          },
          id,
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32601, message: `Method not found: ${method}` },
          id,
        }),
      );
    }
  } catch (err) {
    console.error("Failed to parse request line:", err);
  }
});
