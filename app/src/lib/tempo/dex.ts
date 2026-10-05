/**
 * Tempo enshrined Stablecoin DEX — quote + exact-in swap (user-signed).
 * Spec: https://tempo.xyz/developers/docs/protocol/exchange/spec
 */
import { ethers, type Eip1193Provider } from "ethers";
import { connectedEvmProvider } from "@/lib/activeEvmProvider";
import {
  TEMPO_MAINNET_ID,
  TEMPO_STABLECOIN_DEX,
  tempoStables,
  tempoRpcUrl,
  type TempoStable,
} from "./tokens";

const DEX_ABI = [
  "function quoteSwapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn) view returns (uint128 amountOut)",
  "function swapExactAmountIn(address tokenIn, address tokenOut, uint128 amountIn, uint128 minAmountOut) returns (uint128 amountOut)",
] as const;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

export type TempoDexQuote = {
  tokenIn: TempoStable;
  tokenOut: TempoStable;
  amountIn: bigint;
  amountOut: bigint;
  chainId: number;
};

function readProvider(chainId: number): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(tempoRpcUrl(chainId), chainId);
}

export async function quoteTempoDexSwap(p: {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  chainId?: number;
}): Promise<TempoDexQuote> {
  const chainId = p.chainId ?? TEMPO_MAINNET_ID;
  const listed = tempoStables(chainId);
  const tokenIn = listed.find((t) => t.address.toLowerCase() === p.tokenIn.toLowerCase());
  const tokenOut = listed.find((t) => t.address.toLowerCase() === p.tokenOut.toLowerCase());
  if (!tokenIn || !tokenOut) throw new Error("Pick two stables that exist on this Tempo network.");
  if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) {
    throw new Error("tokenIn and tokenOut must differ.");
  }
  if (p.amountIn <= 0n) throw new Error("Amount must be positive.");

  const dex = new ethers.Contract(TEMPO_STABLECOIN_DEX, DEX_ABI, readProvider(chainId));
  const amountOut = BigInt(await dex.quoteSwapExactAmountIn(tokenIn.address, tokenOut.address, p.amountIn));
  return { tokenIn, tokenOut, amountIn: p.amountIn, amountOut, chainId };
}

async function ensureChain(eth: Eip1193Provider, chainId: number): Promise<void> {
  const hex = `0x${chainId.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if ((err as { code?: number })?.code !== 4902) throw err;
    const rpc = tempoRpcUrl(chainId);
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chainId === TEMPO_MAINNET_ID ? "Tempo" : "Tempo Moderato",
          nativeCurrency: { name: "PathUSD", symbol: "pathUSD", decimals: 18 },
          rpcUrls: [rpc],
          blockExplorerUrls: ["https://explore.tempo.xyz"],
        },
      ],
    });
  }
}

/** Approve + swapExactAmountIn on Tempo. Returns tx hash. */
export async function swapTempoDexExactIn(p: {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  chainId?: number;
}): Promise<string> {
  const chainId = p.chainId ?? TEMPO_MAINNET_ID;
  const eth = connectedEvmProvider() as Eip1193Provider | null;
  if (!eth) throw new Error("Connect MetaMask / Rainbow first.");
  await ensureChain(eth, chainId);

  const browser = new ethers.BrowserProvider(eth);
  const signer = await browser.getSigner();
  const token = new ethers.Contract(p.tokenIn, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const allowance: bigint = await token.allowance(owner, TEMPO_STABLECOIN_DEX);
  if (allowance < p.amountIn) {
    const txA = await token.approve(TEMPO_STABLECOIN_DEX, ethers.MaxUint256);
    await txA.wait();
  }
  const dex = new ethers.Contract(TEMPO_STABLECOIN_DEX, DEX_ABI, signer);
  const tx = await dex.swapExactAmountIn(p.tokenIn, p.tokenOut, p.amountIn, p.minAmountOut);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}
