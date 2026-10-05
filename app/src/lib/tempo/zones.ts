/**
 * Tempo Zones — private TIP-20 ledgers after the public Tempo ramp.
 * Testnet sandbox Zone A/B (Moderato-era). Mainnet zones are permissioned / limited preview.
 * Docs: https://tempo.xyz/developers/docs/protocol/zones
 */
import { ethers, type Eip1193Provider } from "ethers";
import { connectedEvmProvider } from "@/lib/activeEvmProvider";
import { TEMPO_MODERATO_ID, tempoRpcUrl } from "./tokens";

export type TempoZoneSandbox = {
  id: number;
  label: string;
  /** EIP-155 zone chain id = 421700000 + zoneId (mainnet prefix). Sandbox uses 4217000006/7. */
  chainId: number;
  rpcUrl: string;
  portal: string;
  /** Outbox predeploy inside the zone. */
  outbox: string;
};

/** Earlier testnet sandbox zones (connect-to-a-zone docs). */
export const TEMPO_ZONE_SANDBOX: readonly TempoZoneSandbox[] = [
  {
    id: 6,
    label: "Zone A (sandbox)",
    chainId: 4217000006,
    rpcUrl: "https://rpc-zone-a.testnet.tempo.xyz",
    portal: "0x7069DeC4E64Fd07334A0933eDe836C17259c9B23",
    outbox: "0x1c00000000000000000000000000000000000002",
  },
  {
    id: 7,
    label: "Zone B (sandbox)",
    chainId: 4217000007,
    rpcUrl: "https://rpc-zone-b.testnet.tempo.xyz",
    portal: "0x3F5296303400B56271b476F5A0B9cBF74350D6Ac",
    outbox: "0x1c00000000000000000000000000000000000002",
  },
];

const PORTAL_ABI = [
  "function deposit(address token, address to, uint256 amount, bytes memo) payable",
] as const;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

export function zoneById(id: number): TempoZoneSandbox | undefined {
  return TEMPO_ZONE_SANDBOX.find((z) => z.id === id);
}

/**
 * Deposit TIP-20 into a sandbox Zone portal on Moderato public chain.
 * Recipient `to` is the zone-side account (usually the caller's EVM address).
 * Requires ZONE_RPC credentials for private reads after deposit — this only submits the public hop.
 */
export async function depositToTempoZone(p: {
  zoneId: number;
  token: string;
  amount: bigint;
  to: string;
  memo?: string;
}): Promise<string> {
  const zone = zoneById(p.zoneId);
  if (!zone) throw new Error(`Unknown sandbox zone ${p.zoneId}`);
  if (p.amount <= 0n) throw new Error("Amount must be positive.");

  const eth = connectedEvmProvider() as Eip1193Provider | null;
  if (!eth) throw new Error("Connect MetaMask / Rainbow first.");

  // Portal lives on Moderato public chain for the sandbox portals documented today.
  const hex = `0x${TEMPO_MODERATO_ID.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if ((err as { code?: number })?.code !== 4902) throw err;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: "Tempo Moderato",
          nativeCurrency: { name: "PathUSD", symbol: "pathUSD", decimals: 18 },
          rpcUrls: [tempoRpcUrl(TEMPO_MODERATO_ID)],
          blockExplorerUrls: ["https://explore.tempo.xyz"],
        },
      ],
    });
  }

  const browser = new ethers.BrowserProvider(eth);
  const signer = await browser.getSigner();
  const token = new ethers.Contract(p.token, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const allowance: bigint = await token.allowance(owner, zone.portal);
  if (allowance < p.amount) {
    const txA = await token.approve(zone.portal, ethers.MaxUint256);
    await txA.wait();
  }
  const portal = new ethers.Contract(zone.portal, PORTAL_ABI, signer);
  const memo = p.memo ? ethers.toUtf8Bytes(p.memo) : new Uint8Array();
  const tx = await portal.deposit(p.token, p.to, p.amount, memo);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}

export const TEMPO_ZONE_PRODUCT_NOTE =
  "Zones keep balances private from explorers; the Zone operator can still see them. " +
  "Siphon ZK privacy stays on Base — a Zone is an optional hop after the Tempo ramp.";
