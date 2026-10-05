/**
 * Fund a Siphon vault chain from another chain: public LI.FI hop into the user's address on the
 * vault chain, then the ordinary deposit. Nothing here touches the vault.
 */
import { ethers, type Eip1193Provider } from "ethers";
import type { Transaction } from "@solana/web3.js";
import { connectedEvmProvider } from "@/lib/activeEvmProvider";
import { getPhantom } from "@/lib/chains/solanaWallet";
import { HUB_CHAIN_ID, type FundSource } from "./hub";

const LIFI = "https://li.quest/v1";
export const BASE_NATIVE = "0x0000000000000000000000000000000000000000";
/** Below this a vault deposit may not cover its own gas (ETH-gas vaults). */
export const MIN_BASE_GAS_WEI = ethers.parseEther("0.0002");
/** The gas top-up hop delivers this much native ETH on the vault chain. */
export const GAS_HOP_WEI = ethers.parseEther("0.0003");

export type LifiQuote = {
  tool: string;
  toolDetails?: { name?: string };
  action: { fromChainId: number; fromAmount: string; fromToken: { address: string } };
  estimate: {
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: string;
    executionDuration?: number;
    feeCosts?: { amountUSD?: string }[];
  };
  transactionRequest: { to?: string; data: string; value?: string; gasLimit?: string };
};

async function lifiGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${LIFI}${path}?${qs}`);
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(body.message || `LI.FI ${path} HTTP ${res.status}`);
  return body;
}

/**
 * Quote `src` → vault chain. Give `fromAmount` (spend exactly this) or `toAmount` (receive exactly
 * this, used for the gas hop). Solana sources send from Phantom; EVM sources from the EVM wallet.
 */
export function lifiFundQuote(p: {
  src: FundSource;
  fromToken: string;
  toToken: string;
  fromAddress: string;
  toAddress: string;
  fromAmount?: bigint;
  toAmount?: bigint;
  /** Vault chain LI.FI lands on (Base or Arbitrum). */
  toChain?: number;
}): Promise<LifiQuote> {
  const common = {
    fromChain: p.src.id,
    toChain: p.toChain ?? HUB_CHAIN_ID,
    fromToken: p.fromToken,
    toToken: p.toToken,
    fromAddress: p.fromAddress,
    toAddress: p.toAddress,
  };
  return p.toAmount != null
    ? lifiGet<LifiQuote>("/quote/toAmount", { ...common, toAmount: p.toAmount.toString() })
    : lifiGet<LifiQuote>("/quote", { ...common, fromAmount: (p.fromAmount ?? 0n).toString() });
}

/** Switch the connected wallet to `chainId`, adding it from LI.FI's MetaMask params if missing. */
async function switchEvmChain(eth: Eip1193Provider, chainId: number): Promise<void> {
  const hex = `0x${chainId.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if ((err as { code?: number })?.code !== 4902) throw err;
    const { chains } = await lifiGet<{ chains: { id: number; metamask?: object }[] }>("/chains", { chainTypes: "EVM" });
    const params = chains.find((c) => c.id === chainId)?.metamask;
    if (!params) throw new Error(`Add chain ${chainId} to your wallet, then retry.`);
    await eth.request({ method: "wallet_addEthereumChain", params: [params] });
  }
}

const ERC20 = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

/** Sign and send the quote's source transaction. Returns the source tx hash / signature. */
export async function sendLifiQuote(
  q: LifiQuote,
  src: FundSource,
  /** Chain to return the wallet to after the hop (vault chain). */
  returnChainId: number = HUB_CHAIN_ID,
): Promise<string> {
  if (src.kind === "solana") {
    const phantom = getPhantom();
    if (!phantom?.signAndSendTransaction) throw new Error("Phantom is needed to send from Solana.");
    const { VersionedTransaction } = await import("@solana/web3.js");
    const bytes = Uint8Array.from(atob(q.transactionRequest.data), (c) => c.charCodeAt(0));
    // Phantom submits on its own network, which must be Solana mainnet — the tx carries a
    // mainnet blockhash, so any other cluster rejects it rather than misrouting funds.
    const tx = VersionedTransaction.deserialize(bytes);
    const { signature } = await phantom.signAndSendTransaction(tx as unknown as Transaction);
    return signature;
  }

  const eth = connectedEvmProvider() as Eip1193Provider | null;
  if (!eth) throw new Error("Connect your EVM wallet first.");
  await switchEvmChain(eth, src.id);
  // The app follows the wallet's chain, so leaving the wallet on the source chain moves the whole
  // dashboard onto that chain's vault. Always come back — on success, failure and rejection alike.
  try {
    return await sendEvmQuote(q, eth);
  } finally {
    await switchEvmChain(eth, returnChainId).catch(() => undefined);
  }
}

async function sendEvmQuote(q: LifiQuote, eth: Eip1193Provider): Promise<string> {
  // Fresh provider: the app's signer is pinned to the vault chain.
  const signer = await new ethers.BrowserProvider(eth).getSigner();
  const from = await signer.getAddress();

  const spender = q.estimate.approvalAddress;
  const token = q.action.fromToken.address;
  if (spender && token.toLowerCase() !== BASE_NATIVE) {
    const erc20 = new ethers.Contract(token, ERC20, signer);
    const need = BigInt(q.action.fromAmount);
    if ((await erc20.allowance(from, spender)) < need) {
      await (await erc20.approve(spender, need)).wait();
    }
  }

  const t = q.transactionRequest;
  const sent = await signer.sendTransaction({
    to: t.to,
    data: t.data,
    value: t.value ? BigInt(t.value) : 0n,
    gasLimit: t.gasLimit ? BigInt(t.gasLimit) : undefined,
  });
  await sent.wait();
  return sent.hash;
}

/** Poll LI.FI until the hop lands on the vault chain. Returns what arrived (base units + token address). */
export async function waitLifiDone(
  txHash: string,
  fromChain: number,
  onStatus?: (s: string) => void,
  toChain: number = HUB_CHAIN_ID,
): Promise<{ amount: string; token: string }> {
  // ponytail: fixed 10s poll, 2h ceiling (slowest verified route is ~18 min).
  const deadline = Date.now() + 2 * 3600_000;
  type Status = {
    status?: string;
    substatus?: string;
    substatusMessage?: string;
    receiving?: { amount?: string; token?: { address?: string } };
  };
  for (;;) {
    // A miss (not indexed yet, network blip) just waits a tick.
    const st = await lifiGet<Status>("/status", { txHash, fromChain, toChain }).catch(() => null);
    if (st?.status === "DONE") {
      if (st.substatus === "REFUNDED") throw new Error("The bridge refunded you on the source chain.");
      return { amount: st.receiving?.amount ?? "0", token: st.receiving?.token?.address ?? "" };
    }
    if (st?.status === "FAILED") throw new Error(st.substatusMessage || "The bridge failed.");
    if (st) onStatus?.(st.substatusMessage || "Bridging…");
    if (Date.now() > deadline) throw new Error("Still bridging after 2h — track it on scan.li.fi.");
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
