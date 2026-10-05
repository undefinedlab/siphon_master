/**
 * Execute a vault↔vault Bridge block on Run:
 *   prepare → withdraw note to the executor (/bridgeWithdraw) → it hops via Li.Fi → deposit on
 *   dest → cursor finalize.
 *
 * Channel: vault ↔ vault USDC (Base ↔ Arbitrum) via the executor + LI.FI.
 */
import type { Signer } from "ethers";
import { getNetwork, getTokens, selectChainAndSwitchWallet } from "@/lib/networks";
import { bridgeQuote, bridgeStatusText, isBridgeVaultChain, minOutFrom, pollBridgeOrder } from "@/lib/bridge/hub";
import { depositV3 } from "@/lib/v3/depositV3";
import { withdrawViaV3 } from "@/lib/v3/spendRouterV3";
import { peekActiveNoteCursor } from "@/lib/v3/noteCursorSession";
import {
  finalizeVaultBridgeOnCursor,
  prepareVaultBridgeLeg,
  resolveBridgeVaultChainId,
} from "@/lib/v3/vaultBridgeLeg";
import { v3NoteKey } from "@/lib/v3/noteStoreV3";
import { v3Deployed } from "@/lib/v3/configV3";

export type ExecuteVaultBridgeParams = {
  fromChain: string | number;
  toChain: string | number;
  symbol: string;
  /** Human amount override; defaults to active note value (base units → human via decimals). */
  amountHuman?: string | null;
  signer: Signer;
  /** User wallet that receives the bridged assets then deposits. */
  recipient: string;
  onStatus?: (message: string) => void;
};

export type ExecuteVaultBridgeResult = {
  ok: true;
  fromChainId: number;
  toChainId: number;
  symbol: string;
  withdrawTxHash: string;
  bridgeSrcTx?: string;
  bridgeDestTx?: string;
  depositTxHash: string;
  destCommitment: string;
  receivedWei: string;
};

function tokenAddressForWithdraw(chainId: number, symbol: string): string {
  const sym = symbol.toUpperCase();
  const tokens = getTokens(chainId);
  if (sym === "USDC") return tokens.USDC.address;
  // ETH vault notes are WETH-backed; withdraw the WETH ERC-20.
  const weth = getNetwork(chainId).weth;
  if (!weth) throw new Error(`No WETH configured for chain ${chainId}`);
  return weth;
}

function tokenAddressForDeposit(chainId: number, symbol: string): string {
  return tokenAddressForWithdraw(chainId, symbol);
}

function amountBaseUnits(symbol: string, chainId: number, human?: string | null): bigint {
  const active = peekActiveNoteCursor();
  if (active && (!human || !human.trim())) {
    return BigInt(active.value);
  }
  const raw = (human || "").trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error("Bridge needs a valid amount (or an active note).");
  }
  const decimals = symbol.toUpperCase() === "USDC" ? 6 : 18;
  const [whole, frac = ""] = raw.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded);
}

/**
 * Full vault bridge leg. Caller must have deposited on the source vault first (cursor active).
 */
export async function executeVaultBridgeLeg(
  params: ExecuteVaultBridgeParams,
): Promise<ExecuteVaultBridgeResult> {
  const status = params.onStatus ?? (() => undefined);
  const prepared = prepareVaultBridgeLeg({
    fromChain: params.fromChain,
    toChain: params.toChain,
    symbol: params.symbol,
  });
  if (!prepared.ok) throw new Error(prepared.error);

  const { fromChainId, toChainId, symbol } = prepared;
  if (!v3Deployed(fromChainId)) {
    throw new Error(`v3 vault not deployed on source chain ${fromChainId}`);
  }
  if (!v3Deployed(toChainId)) {
    throw new Error(`v3 vault not deployed on destination chain ${toChainId}`);
  }

  const amount = amountBaseUnits(symbol, fromChainId, params.amountHuman);
  if (amount <= 0n) throw new Error("Bridge amount must be positive.");

  const recipient = params.recipient.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    throw new Error("Connect an EVM wallet to receive the bridged funds.");
  }

  // The executor bridges only what a withdraw proof paid it (/bridgeWithdraw), USDC from a vault hub.
  if (!isBridgeVaultChain(fromChainId) || !isBridgeVaultChain(toChainId) || symbol !== "USDC") {
    throw new Error("Vault bridge runs Base ↔ Arbitrum USDC only.");
  }
  const order = {
    to_chain_id: toChainId,
    to_address: recipient,
    to_token: "USDC",
    amount: amount.toString(),
    min_out: "1",
    refund_address: recipient,
  };
  const quote = await bridgeQuote(order, fromChainId);

  status(`Withdrawing ${symbol} from ${prepared.fromLabel} vault to bridge…`);
  const withdraw = await withdrawViaV3({
    chainId: fromChainId,
    token: tokenAddressForWithdraw(fromChainId, symbol),
    symbol,
    amount,
    recipient: quote.payee,
    signer: params.signer,
    screenToken: "",
    bridge: { ...order, min_out: minOutFrom(quote.toAmountMin) },
  });
  if (!withdraw.bridgeOrderId) throw new Error("Executor returned no bridge order id.");

  status(`Bridging ${symbol} ${prepared.fromLabel} → ${prepared.toLabel} via Li.Fi…`);
  let last = "";
  const done = await pollBridgeOrder(withdraw.bridgeOrderId, (o) => {
    const text = bridgeStatusText(o);
    if (text !== last) status((last = text));
  }, 10_000, fromChainId);
  if (done.status !== "DONE") {
    throw new Error(`Vault bridge did not complete: ${bridgeStatusText(done)}.`);
  }

  const receivedWei = BigInt(done.amount_out || "0");
  if (receivedWei <= 0n) {
    throw new Error("Bridge completed but received amount is unknown — check Li.Fi status.");
  }

  status(`Switching wallet to ${prepared.toLabel} for vault deposit…`);
  const switched = await selectChainAndSwitchWallet(toChainId, recipient);
  if (!switched.ok) {
    throw new Error(switched.error || `Could not switch wallet to ${prepared.toLabel}`);
  }

  status(`Depositing ${symbol} into ${prepared.toLabel} vault…`);
  const deposit = await depositV3({
    chainId: toChainId,
    token: tokenAddressForDeposit(toChainId, symbol),
    amount: receivedWei,
    signer: params.signer,
    cursorMode: "none",
  });

  finalizeVaultBridgeOnCursor({
    toChainId,
    symbol,
    commitment: deposit.commitment,
    value: receivedWei,
    txHash: deposit.txHash,
    noteKey: v3NoteKey(toChainId, symbol, deposit.commitment),
  });

  status(`Bridge complete — note now on ${prepared.toLabel}.`);
  return {
    ok: true,
    fromChainId,
    toChainId,
    symbol,
    withdrawTxHash: withdraw.txHash,
    bridgeSrcTx: done.bridge_tx ?? undefined,
    bridgeDestTx: done.dest_tx ?? undefined,
    depositTxHash: deposit.txHash,
    destCommitment: deposit.commitment,
    receivedWei: receivedWei.toString(),
  };
}

/** Resolve builder node chain labels to numeric ids (throws if invalid). */
export function requireBridgeChainIds(from: string | null | undefined, to: string | null | undefined): {
  fromChainId: number;
  toChainId: number;
} {
  const fromChainId = resolveBridgeVaultChainId(from);
  const toChainId = resolveBridgeVaultChainId(to);
  if (fromChainId == null || toChainId == null) {
    throw new Error("Bridge node needs From and To vaults (Arbitrum / Base).");
  }
  return { fromChainId, toChainId };
}
