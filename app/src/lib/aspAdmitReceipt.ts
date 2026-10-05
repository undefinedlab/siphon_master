/**
 * Pre-admit check: require a successful on-chain receipt with LabelMinted matching
 * the requested label before forwarding ASP_POSTMAN_TOKEN (PROXY-03 / OMEGA-07).
 * Prevents authenticated spam of fake label/txHash and txHash reuse with wrong labels.
 */
import { id, Interface } from "ethers";
import { getServerRpcUrls } from "@/lib/rpcServer";
import { NETWORKS } from "@/lib/networks";
import { v3Config } from "@/lib/v3/configV3";
import { RAGEQUIT_GRACE_SECONDS, withinRagequitGrace } from "@/lib/v3/ragequitGraceV3";

export type AdmitReceiptOk = { ok: true };
export type AdmitReceiptFail = {
  ok: false;
  status: number;
  body: Record<string, string>;
};
export type AdmitReceiptResult = AdmitReceiptOk | AdmitReceiptFail;

type RpcLog = { address?: string; topics?: string[]; data?: string };
type RpcReceipt = {
  status?: string;
  from?: string;
  to?: string;
  blockNumber?: string;
  logs?: RpcLog[];
};
type RpcTransaction = {
  from?: string;
  to?: string;
  input?: string;
};
type RpcBlock = { timestamp?: string };

/** Soft-era / classic Vault.LabelMinted(uint256,uint256,address,uint256) */
const LABEL_MINTED_V1 = id("LabelMinted(uint256,uint256,address,uint256)").toLowerCase();
/** V4 SiphonV4Vault.LabelMinted(address,uint256,uint256,address,uint256) */
const LABEL_MINTED_V4 = id("LabelMinted(address,uint256,uint256,address,uint256)").toLowerCase();
const V3_DEPOSITED_ABI = [
  "event Deposited(address depositor, address indexed token, uint256 amount, uint256 commitment, uint256 depositNonce, uint256 stateRootAfter)",
  "function deposit(address token, uint256 amount, uint256 userSalt, uint256 precommitment)",
  "function depositNative(uint256 userSalt, uint256 precommitment) payable",
] as const;
const V3_DEPOSITED = id(
  "Deposited(address,address,uint256,uint256,uint256,uint256)",
).toLowerCase();
const v3DepositedInterface = new Interface(V3_DEPOSITED_ABI);

export function v3DepositUserSaltMatches(data: string, expectedUserSalt: string): boolean {
  try {
    const parsed = v3DepositedInterface.parseTransaction({ data });
    return (
      (parsed?.name === "deposit" || parsed?.name === "depositNative") &&
      BigInt(parsed.args.userSalt.toString()) === BigInt(expectedUserSalt)
    );
  } catch {
    return false;
  }
}

/** Best-effort same-isolate txHash spend set (OMEGA-07). */
const usedTxHashes = new Map<string, number>();
const USED_TX_TTL_MS = 24 * 60 * 60 * 1000;
const USED_TX_MAX = 4_000;

function sweepExpired(now: number): void {
  for (const [k, ts] of usedTxHashes) {
    if (now - ts > USED_TX_TTL_MS) usedTxHashes.delete(k);
  }
}

/** Has this txHash already been admitted SUCCESSFULLY? Read-only — see commitAdmitTxHash. */
function txHashAlreadyUsed(txHash: string): boolean {
  sweepExpired(Date.now());
  return usedTxHashes.has(txHash.toLowerCase());
}

/**
 * Burn a txHash so it cannot be admitted twice. Call this ONLY after the upstream postman has
 * accepted the admit.
 *
 * Recording it at receipt-check time (as this originally did) spends the hash on the *attempt*
 * rather than on success, so any upstream failure — the ASP confirmation race, a postman timeout,
 * a 502 — left the deposit permanently unadmittable for the 24h TTL. That is unrecoverable for
 * the user: the note exists on-chain but never enters the association set, so it can never be
 * spent. Committing on success keeps OMEGA-07's replay protection while leaving failures retryable.
 */
export function commitAdmitTxHash(txHash: string): void {
  const key = txHash.toLowerCase();
  const now = Date.now();
  sweepExpired(now);
  if (usedTxHashes.size >= USED_TX_MAX) {
    const oldest = usedTxHashes.keys().next().value;
    if (oldest) usedTxHashes.delete(oldest);
  }
  usedTxHashes.set(key, now);
}

/** @internal test helper */
export function _resetAdmitTxHashCache(): void {
  usedTxHashes.clear();
}

async function ethGetTransactionReceipt(
  rpcUrl: string,
  txHash: string,
): Promise<RpcReceipt | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionReceipt",
      params: [txHash],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { result?: RpcReceipt | null; error?: unknown };
  if (json.error || !json.result) return null;
  return json.result;
}

async function ethGetTransaction(
  rpcUrl: string,
  txHash: string,
): Promise<RpcTransaction | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByHash",
      params: [txHash],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { result?: RpcTransaction | null; error?: unknown };
  if (json.error || !json.result) return null;
  return json.result;
}

async function ethGetBlock(rpcUrl: string, blockNumber: string): Promise<RpcBlock | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: [blockNumber, false],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { result?: RpcBlock | null; error?: unknown };
  if (json.error || !json.result) return null;
  return json.result;
}

/** Escape hatch for emergencies only — never set in production long-term. */
export function admitReceiptCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const skip =
    (env.ASP_ADMIT_SKIP_RECEIPT_CHECK || "").trim().toLowerCase() === "1" ||
    (env.ASP_ADMIT_SKIP_RECEIPT_CHECK || "").trim().toLowerCase() === "true";
  return !skip;
}

/**
 * Extract LabelMinted label from receipt logs (classic + V4 topic layouts).
 */
export function labelMintedInReceipt(logs: RpcLog[] | undefined, expectedLabel: string): boolean {
  if (!logs?.length) return false;
  let want: bigint;
  try {
    want = BigInt(expectedLabel);
  } catch {
    return false;
  }
  for (const log of logs) {
    const topics = (log.topics || []).map((t) => t.toLowerCase());
    if (!topics.length) continue;
    const sig = topics[0];
    if (sig === LABEL_MINTED_V1 && topics.length >= 2) {
      try {
        if (BigInt(topics[1]) === want) return true;
      } catch {
        /* ignore */
      }
    }
    if (sig === LABEL_MINTED_V4 && topics.length >= 3) {
      // topics: [sig, token, label, depositor]
      try {
        if (BigInt(topics[2]) === want) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/**
 * Verify txHash is a successful tx from `depositor` that touched the vault or chain entrypoint
 * and emitted LabelMinted for `label`.
 */
export async function assertAdmitDepositReceipt(args: {
  chainId: number;
  txHash: string;
  depositor: string;
  vault: string;
  label: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AdmitReceiptResult> {
  const env = args.env ?? process.env;
  if (!admitReceiptCheckEnabled(env)) {
    return { ok: true };
  }

  const { chainId, txHash, depositor, vault, label } = args;
  let urls: string[];
  try {
    urls = getServerRpcUrls(chainId);
  } catch {
    return {
      ok: false,
      status: 400,
      body: { error: "unsupported_chain", message: `chainId ${chainId} not configured` },
    };
  }

  let receipt: RpcReceipt | null = null;
  let lastErr: unknown;
  for (const url of urls.slice(0, 3)) {
    try {
      receipt = await ethGetTransactionReceipt(url, txHash);
      if (receipt) break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!receipt) {
    console.warn("[asp-admit] receipt lookup failed", lastErr);
    return {
      ok: false,
      status: 502,
      body: {
        error: "receipt_unavailable",
        message: "Could not verify deposit transaction on-chain — retry shortly",
      },
    };
  }

  const status = (receipt.status || "").toLowerCase();
  if (status !== "0x1" && status !== "1") {
    return {
      ok: false,
      status: 400,
      body: { error: "tx_failed", message: "Deposit transaction did not succeed" },
    };
  }

  const from = (receipt.from || "").toLowerCase();
  if (from !== depositor.toLowerCase()) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "tx_from_mismatch",
        message: "Transaction sender must match depositor",
      },
    };
  }

  const vaultLc = vault.toLowerCase();
  const entrypoint = (NETWORKS[chainId]?.entrypoint || "").toLowerCase();
  const to = (receipt.to || "").toLowerCase();
  const logAddrs = (receipt.logs || []).map((l) => (l.address || "").toLowerCase());
  const touchesProtocol =
    (vaultLc && (to === vaultLc || logAddrs.includes(vaultLc))) ||
    (entrypoint && (to === entrypoint || logAddrs.includes(entrypoint)));

  if (!touchesProtocol) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "tx_not_deposit",
        message: "Transaction does not touch vault or entrypoint",
      },
    };
  }

  if (!labelMintedInReceipt(receipt.logs, label)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "label_not_minted",
        message: "Receipt has no LabelMinted event for the requested label",
      },
    };
  }

  if (txHashAlreadyUsed(txHash)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "tx_already_admitted",
        message: "This deposit transaction was already used for admit",
      },
    };
  }

  return { ok: true };
}

/**
 * Verify the deposit backing a browser-requested pre-admit exit ticket.
 *
 * Unlike the legacy admit proxy, v3 does not emit the private label. It emits the commitment and
 * nonce, while `/set/revoke` independently derives the label from the transaction's userSalt.
 * This edge therefore binds the privileged postman call to the authenticated sender, configured
 * kernel, successful receipt, and exact note commitment; the ASP performs the label derivation.
 */
export async function assertV3ExitTicketReceipt(args: {
  chainId: number;
  txHash: string;
  depositor: string;
  vault: string;
  commitment: string;
  userSalt: string;
}): Promise<AdmitReceiptResult> {
  const cfg = v3Config(args.chainId);
  if (!cfg || cfg.vaultKernel.toLowerCase() !== args.vault.toLowerCase()) {
    return {
      ok: false,
      status: 400,
      body: { error: "wrong_vault", message: "vault is not the configured v3 kernel" },
    };
  }

  let urls: string[];
  try {
    urls = getServerRpcUrls(args.chainId);
  } catch {
    return {
      ok: false,
      status: 400,
      body: { error: "unsupported_chain", message: `chainId ${args.chainId} not configured` },
    };
  }

  let receipt: RpcReceipt | null = null;
  let receiptRpcUrl = "";
  for (const url of urls.slice(0, 3)) {
    try {
      receipt = await ethGetTransactionReceipt(url, args.txHash);
      if (receipt) {
        receiptRpcUrl = url;
        break;
      }
    } catch {
      /* try the next configured RPC */
    }
  }
  if (!receipt) {
    return {
      ok: false,
      status: 502,
      body: {
        error: "receipt_unavailable",
        message: "Could not verify deposit transaction on-chain — retry shortly",
      },
    };
  }
  const status = (receipt.status || "").toLowerCase();
  if (status !== "0x1" && status !== "1") {
    return {
      ok: false,
      status: 400,
      body: { error: "tx_failed", message: "Deposit transaction did not succeed" },
    };
  }
  if ((receipt.from || "").toLowerCase() !== args.depositor.toLowerCase()) {
    return {
      ok: false,
      status: 403,
      body: { error: "tx_from_mismatch", message: "Transaction sender must match depositor" },
    };
  }
  if ((receipt.to || "").toLowerCase() !== args.vault.toLowerCase()) {
    return {
      ok: false,
      status: 400,
      body: { error: "tx_not_deposit", message: "Transaction was not sent to the v3 kernel" },
    };
  }

  const matched = (receipt.logs || []).some((log) => {
    if ((log.address || "").toLowerCase() !== args.vault.toLowerCase()) return false;
    if ((log.topics?.[0] || "").toLowerCase() !== V3_DEPOSITED) return false;
    try {
      const parsed = v3DepositedInterface.parseLog({
        topics: log.topics || [],
        data: log.data || "0x",
      });
      return (
        parsed?.name === "Deposited" &&
        String(parsed.args.depositor).toLowerCase() === args.depositor.toLowerCase() &&
        BigInt(parsed.args.commitment.toString()) === BigInt(args.commitment)
      );
    } catch {
      return false;
    }
  });
  if (!matched) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "commitment_not_deposited",
        message: "Receipt has no matching v3 Deposited event",
      },
    };
  }

  let depositBlock: RpcBlock | null = null;
  if (receipt.blockNumber) {
    const blockUrls = Array.from(new Set([receiptRpcUrl, ...urls.slice(0, 3)])).filter(Boolean);
    for (const url of blockUrls) {
      try {
        depositBlock = await ethGetBlock(url, receipt.blockNumber);
        if (depositBlock) break;
      } catch {
        /* try the next configured RPC */
      }
    }
  }
  if (!depositBlock?.timestamp) {
    return {
      ok: false,
      status: 502,
      body: {
        error: "deposit_block_unavailable",
        message: "Could not verify the ragequit grace period — retry shortly",
      },
    };
  }
  const depositTimestamp = Number(BigInt(depositBlock.timestamp));
  const currentTimestamp = Math.floor(Date.now() / 1_000);
  if (!withinRagequitGrace(depositTimestamp, currentTimestamp)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "ragequit_grace_expired",
        message: `The ${RAGEQUIT_GRACE_SECONDS / 60}-minute ragequit grace period has expired. Use private withdrawal instead.`,
      },
    };
  }

  let transaction: RpcTransaction | null = null;
  for (const url of urls.slice(0, 3)) {
    try {
      transaction = await ethGetTransaction(url, args.txHash);
      if (transaction) break;
    } catch {
      /* try the next configured RPC */
    }
  }
  if (!transaction) {
    return {
      ok: false,
      status: 502,
      body: {
        error: "transaction_unavailable",
        message: "Could not verify deposit calldata on-chain — retry shortly",
      },
    };
  }

  if (!v3DepositUserSaltMatches(transaction.input || "0x", args.userSalt)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "user_salt_mismatch",
        message: "Submitted userSalt does not match the deposit transaction",
      },
    };
  }
  return { ok: true };
}
