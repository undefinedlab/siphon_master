/**
 * Vault → any-chain bridge via the trade executor + LI.FI.
 *
 * The user proves an ordinary WITHDRAW paid to the executor (the quote's `payee`) and posts it to
 * /bridgeWithdraw with a bridge order. The executor relays the spend, bridges exactly what the
 * receipt paid it through LI.FI, or refunds it on the vault chain when no route meets `min_out`.
 * Executor limits: source asset USDC only, at least 1 USDC.
 *
 * Vault hubs (where a Siphon note lives and can payout): Base + Arbitrum. Bridged homes
 * (Ethereum, Tempo, Solana mainnet, Hyperliquid) use the Base vault.
 */
import { PublicKey } from "@solana/web3.js";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";

/** Canonical Base hub (bridged homes + default fund destination). */
export const HUB_CHAIN_ID = 8453;
/** Vault chains that can withdraw-to-any-chain via LI.FI. */
export const BRIDGE_VAULT_CHAIN_IDS: readonly number[] = [8453, 42161];

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const BRIDGE_MIN_USDC_UNITS = 1_000_000n;
export const SOLANA_LIFI_ID = 1151111081099710;
export const ZCASH_LIFI_ID = 20000000000005;
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function isBridgeVaultChain(chainId: number | null | undefined): boolean {
  return chainId != null && BRIDGE_VAULT_CHAIN_IDS.includes(chainId);
}

/** USDC address on a vault chain (for fund-in / LI.FI toToken). */
export function vaultUsdc(chainId: number): string {
  if (chainId === 42161) return ARBITRUM_USDC;
  return BASE_USDC;
}

export function vaultLabel(chainId: number): string {
  if (chainId === 42161) return "Arbitrum";
  return "Base";
}

export type DestKind = "evm" | "solana" | "zcash";

export type BridgeDest = {
  /** LI.FI chain id. */
  id: number;
  label: string;
  kind: DestKind;
  /** What LI.FI delivers there — a symbol or a token address. */
  toToken: string;
  eta: string;
  /** Smallest amount with a route, in USDC, when it is above the general 1 USDC floor. */
  minUsdc?: number;
};

/** Withdraw destinations (USDC from any vault hub). Filter with bridgeDestsFrom(vaultChainId). */
export const BRIDGE_DESTS: readonly BridgeDest[] = [
  { id: 8453, label: "Base", kind: "evm", toToken: "USDC", eta: "~1 min" },
  { id: 1, label: "Ethereum", kind: "evm", toToken: "USDC", eta: "~3 min" },
  { id: 42161, label: "Arbitrum", kind: "evm", toToken: "USDC", eta: "~1 min" },
  { id: 999, label: "HyperEVM", kind: "evm", toToken: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", eta: "~2 min" },
  { id: 1337, label: "Hyperliquid", kind: "evm", toToken: "USDC", eta: "~18 min" },
  // Tempo is stables-only (TIP-20). LI.FI delivers USDC.e — not ETH/SOL. No Siphon vault on Tempo.
  { id: 4217, label: "Tempo", kind: "evm", toToken: "0x20C000000000000000000000b9537d11c60E8b50", eta: "~2 min" },
  { id: SOLANA_LIFI_ID, label: "Solana", kind: "solana", toToken: SOLANA_USDC_MINT, eta: "~2 min" },
  // NEAR Intents has no Zcash route below ~8 USDC (measured 2026-10-07: 5 fails, 8 quotes).
  { id: ZCASH_LIFI_ID, label: "Zcash", kind: "zcash", toToken: "ZEC", eta: "~20 min", minUsdc: 10 },
];

export function bridgeDest(id: number | null | undefined): BridgeDest | undefined {
  return BRIDGE_DESTS.find((d) => d.id === id);
}

/** Destinations reachable from a vault chain (excludes the vault itself). */
export function bridgeDestsFrom(vaultChainId: number): readonly BridgeDest[] {
  return BRIDGE_DESTS.filter((d) => d.id !== vaultChainId);
}

/** Select/menu label: Zcash → ZEC; Tempo → USDC.e (stables-only edge). */
export function bridgeDestOptionLabel(d: BridgeDest): string {
  if (d.kind === "zcash") return `${d.label} (as ZEC)`;
  if (d.id === 4217) return `${d.label} (as USDC.e)`;
  return d.label;
}

/** Canvas node title for a withdraw dest label ("Zcash" → "Withdraw to Zcash (as ZEC)"). */
export function withdrawNodeTitle(chainLabel: string | null | undefined): string {
  if (!chainLabel) return "Withdraw";
  const dest = BRIDGE_DESTS.find((d) => d.label === chainLabel);
  return `Withdraw to ${dest ? bridgeDestOptionLabel(dest) : chainLabel}`;
}

/** Short builder-card note when the withdraw dest is Zcash. */
export function zcashWithdrawDisclaimer(d: BridgeDest | null | undefined): string | null {
  if (!d || d.kind !== "zcash") return null;
  const min = d.minUsdc ?? 10;
  return `Arrives as ZEC via LI.FI (~${d.eta.replace(/^~\s*/, "")}). Min ~$${min}. Paste a t1/t3 or u1 address (not zs1).`;
}

/** Short note when the withdraw dest is Tempo (stables on/off-ramp only). */
export function tempoWithdrawDisclaimer(d: BridgeDest | null | undefined): string | null {
  if (!d || d.id !== 4217) return null;
  return (
    `Arrives as USDC.e on Tempo (~${d.eta.replace(/^~\s*/, "")}). ` +
    `Stables only — no ETH/SOL vault. Optional next: Stablecoin DEX or a Tempo Zone. ` +
    `Siphon privacy stays on your vault (Base or Arbitrum).`
  );
}

/** Builder/dash hint under Receive on / Withdraw — Zcash or Tempo when relevant. */
export function bridgeDestDisclaimer(d: BridgeDest | null | undefined): string | null {
  return zcashWithdrawDisclaimer(d) ?? tempoWithdrawDisclaimer(d);
}

/** Minimum send to `dest`, in USDC base units. */
export function bridgeMinUnits(dest: BridgeDest): bigint {
  const own = BigInt(dest.minUsdc ?? 0) * 1_000_000n;
  return own > BRIDGE_MIN_USDC_UNITS ? own : BRIDGE_MIN_USDC_UNITS;
}

export type FundSource = {
  /** LI.FI chain id (also the EVM chain id for EVM sources). */
  id: number;
  label: string;
  kind: "evm" | "solana";
  usdc: string;
  /** What the optional vault-native gas hop spends. Tempo has no native coin, so USDC.e. */
  gasToken: string;
};

const NATIVE = "0x0000000000000000000000000000000000000000";

/** Chains LI.FI quotes into a vault USDC. HyperCore (1337) and Zcash cannot be sources. */
export const FUND_SOURCES: readonly FundSource[] = [
  { id: 8453, label: "Base", kind: "evm", usdc: BASE_USDC, gasToken: NATIVE },
  { id: 1, label: "Ethereum", kind: "evm", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", gasToken: NATIVE },
  { id: 42161, label: "Arbitrum", kind: "evm", usdc: ARBITRUM_USDC, gasToken: NATIVE },
  { id: 999, label: "HyperEVM", kind: "evm", usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", gasToken: NATIVE },
  { id: 4217, label: "Tempo", kind: "evm", usdc: "0x20C000000000000000000000b9537d11c60E8b50", gasToken: "0x20C000000000000000000000b9537d11c60E8b50" },
  { id: SOLANA_LIFI_ID, label: "Solana", kind: "solana", usdc: SOLANA_USDC_MINT, gasToken: "11111111111111111111111111111111" },
];

/** Default funding source for a home chain's edge: HyperCore funds via HyperEVM, Zcash cannot fund. */
export function fundSourceForEdge(edge: number | null | undefined): number {
  if (edge === 1337) return 999;
  return FUND_SOURCES.some((s) => s.id === edge) ? (edge as number) : 42161;
}

/** Fund sources into a vault (excludes the vault chain itself as a useless same-chain hop). */
export function fundSourcesInto(vaultChainId: number): readonly FundSource[] {
  return FUND_SOURCES.filter((s) => s.id !== vaultChainId);
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
// ponytail: shape-only Zcash check (t1/t3 base58 length, u1 bech32m); the executor verifies the
// t-address checksum and LI.FI's quote is the authority on unified addresses.
const ZEC_T_RE = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;
const ZEC_U_RE = /^u1[02-9ac-hj-np-z]{60,}$/;

export function isValidDestAddress(kind: DestKind, addr: string): boolean {
  const a = addr.trim();
  if (kind === "evm") return EVM_RE.test(a);
  if (kind === "zcash") return ZEC_T_RE.test(a) || ZEC_U_RE.test(a);
  try {
    new PublicKey(a); // throws unless base58 that decodes to exactly 32 bytes
    return true;
  } catch {
    return false;
  }
}

/** The slippage bound sent on submit: 98% of the route's own minimum, floored. */
export function minOutFrom(toAmountMin: string | number | bigint): string {
  return ((BigInt(toAmountMin) * 98n) / 100n).toString();
}

export type BridgeOrderRequest = {
  to_chain_id: number;
  to_address: string;
  to_token: string;
  /** USDC base units (6 dp) being withdrawn. */
  amount: string;
  /** Destination-token base units. */
  min_out: string;
  /** User's EVM address on the vault chain, used only if the hop fails. */
  refund_address: string;
  /** Quote from an ETH note instead (a strategy payout); `amount` is then wei. */
  from_token?: "ETH";
};

/** A strategy's payout, sent with createStrategy: the executor bridges the fired leg's proceeds. */
export type StrategyPayout = {
  to_chain_id: number;
  to_address: string;
  to_token: string;
  refund_address: string;
  slippage_bps: number;
};

/** Where a builder "Withdraw to <label>" pays out, or null to keep the output private in the vault. */
export function payoutDestFor(vaultChainId: number, label: string | null | undefined): BridgeDest | null {
  if (!isBridgeVaultChain(vaultChainId) || !label) return null;
  const l = label === "Arbitrum One" ? "Arbitrum" : label; // NETWORKS[42161].name, from presets
  const dest = bridgeDestsFrom(vaultChainId).find((d) => d.label === l) ?? null;
  return dest;
}

/** What a payout delivers at `dest` for a strategy whose output is `assetOut`, or null if no route.
 *  USDC everywhere (ZEC on Zcash); ETH only where LI.FI delivers native ETH. */
export function payoutToken(dest: BridgeDest, assetOut: string): string | null {
  const out = assetOut.toUpperCase();
  if (dest.kind === "zcash") return dest.toToken;
  if (out === "USDC") return dest.toToken;
  if (out === "ETH" && (dest.id === 1 || dest.id === 42161)) return "ETH";
  return null;
}

export type BridgeQuote = {
  payee: string;
  tool: string;
  toAmount: string;
  toAmountMin: string;
  durationSec: number;
  feeUsd: number;
  toToken: { address: string; symbol: string; decimals: number };
};

export type BridgeOrderStatus =
  | "RELAYING" | "RECEIVED" | "BRIDGING" | "SENT" | "DONE"
  | "REFUND_DUE" | "REFUNDING" | "REFUNDED" | "FAILED" | "REVIEW";

export type BridgeOrder = {
  id: string;
  status: BridgeOrderStatus;
  amount_in?: string | null;
  to_chain_id: string;
  to_address: string;
  bridge_tx?: string | null;
  tool?: string | null;
  dest_tx?: string | null;
  amount_out?: string | null;
  refund_tx?: string | null;
  error?: string | null;
};

export const BRIDGE_TERMINAL: ReadonlySet<BridgeOrderStatus> = new Set(["DONE", "REFUNDED", "FAILED", "REVIEW"]);

const STATUS_TEXT: Record<BridgeOrderStatus, string> = {
  RELAYING: "Withdrawing from the vault…",
  RECEIVED: "Withdrawn — starting the bridge…",
  BRIDGING: "Bridging…",
  SENT: "On its way",
  DONE: "Delivered",
  REFUND_DUE: "No route at your price — refunding on the vault chain…",
  REFUNDING: "Refunding on the vault chain…",
  REFUNDED: "Refunded to your wallet on the vault chain",
  FAILED: "Failed",
  REVIEW: "An operator is checking this transfer",
};

export function bridgeStatusText(o: Pick<BridgeOrder, "status" | "error">): string {
  const base = STATUS_TEXT[o.status] ?? o.status;
  return o.status === "FAILED" && o.error ? `${base}: ${o.error}` : base;
}

export function lifiScanUrl(txHash: string): string {
  return `https://scan.li.fi/tx/${txHash}`;
}

function executorUrl(path: string, vaultChainId: number = HUB_CHAIN_ID): string {
  return `${getTradeExecutorBaseUrl(vaultChainId).replace(/\/$/, "")}${path}`;
}

/** Price a hop and learn the payee the withdraw proof must pay. Throws the executor's message. */
export async function bridgeQuote(
  order: BridgeOrderRequest,
  vaultChainId: number = HUB_CHAIN_ID,
): Promise<BridgeQuote> {
  if (!isBridgeVaultChain(vaultChainId)) {
    throw new Error(`Bridge payouts run from Base or Arbitrum vaults (not chain ${vaultChainId}).`);
  }
  const res = await fetch(executorUrl("/bridgeQuote", vaultChainId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain_id: vaultChainId, bridge: order }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<BridgeQuote> & { error?: string };
  if (!res.ok || !body.payee) throw new Error(body.error || `bridge quote failed (HTTP ${res.status})`);
  return body as BridgeQuote;
}

export async function fetchBridgeOrder(
  id: string,
  vaultChainId: number = HUB_CHAIN_ID,
): Promise<BridgeOrder> {
  const res = await fetch(executorUrl(`/bridgeOrders/${encodeURIComponent(id)}`, vaultChainId));
  if (!res.ok) throw new Error(`bridge order HTTP ${res.status}`);
  return (await res.json()) as BridgeOrder;
}

/** Poll until the order is terminal, reporting every read. Transient errors just wait a tick. */
export async function pollBridgeOrder(
  id: string,
  onUpdate: (o: BridgeOrder) => void,
  everyMs = 10_000,
  vaultChainId: number = HUB_CHAIN_ID,
): Promise<BridgeOrder> {
  // ponytail: fixed interval with a 4h ceiling (executor gives up on LI.FI at 3h → REVIEW).
  const deadline = Date.now() + 4 * 3600_000;
  for (;;) {
    try {
      const o = await fetchBridgeOrder(id, vaultChainId);
      onUpdate(o);
      if (BRIDGE_TERMINAL.has(o.status)) return o;
    } catch {
      /* executor blip — keep polling */
    }
    if (Date.now() > deadline) throw new Error("Stopped watching the bridge order — check it later.");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
