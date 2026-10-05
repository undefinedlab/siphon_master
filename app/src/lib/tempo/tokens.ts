/**
 * Tempo TIP-20 stables (mainnet 4217 + Moderato 42431 share predeploy addresses where noted).
 * No ETH/SOL/WBTC — stables (and EURC) only.
 */

export const TEMPO_MAINNET_ID = 4217;
export const TEMPO_MODERATO_ID = 42431;

/** Enshrined Stablecoin DEX (same address mainnet + Moderato). */
export const TEMPO_STABLECOIN_DEX = "0xdec0000000000000000000000000000000000000";

export type TempoStable = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  /** Networks the token exists on — the TIP-20 predeploys differ between mainnet and Moderato. */
  chains: readonly number[];
};

/** Curated set for the DEX UI. Every pair on one network quotes on the enshrined DEX
 *  (tempoEdge.check.ts asserts it live); filter with tempoStables(chainId). */
export const TEMPO_STABLES: readonly TempoStable[] = [
  {
    symbol: "pathUSD",
    name: "PathUSD",
    address: "0x20c0000000000000000000000000000000000000",
    decimals: 6,
    chains: [TEMPO_MAINNET_ID, TEMPO_MODERATO_ID],
  },
  {
    symbol: "USDC.e",
    name: "Bridged USDC (Stargate)",
    // Mainnet LI.FI dest / fund token (hub.ts). Moderato verified list uses a different USDC.e.
    address: "0x20C000000000000000000000b9537d11c60E8b50",
    decimals: 6,
    chains: [TEMPO_MAINNET_ID],
  },
  {
    symbol: "alphaUSD",
    name: "AlphaUSD",
    address: "0x20c0000000000000000000000000000000000001",
    decimals: 6,
    chains: [TEMPO_MODERATO_ID],
  },
  {
    symbol: "betaUSD",
    name: "BetaUSD",
    address: "0x20c0000000000000000000000000000000000002",
    decimals: 6,
    chains: [TEMPO_MODERATO_ID],
  },
  {
    symbol: "thetaUSD",
    name: "ThetaUSD",
    address: "0x20c0000000000000000000000000000000000003",
    decimals: 6,
    chains: [TEMPO_MODERATO_ID],
  },
  {
    symbol: "OUSD",
    name: "OpenUSD",
    address: "0x20c0000000000000000000006a37da5c996874be",
    decimals: 6,
    chains: [TEMPO_MAINNET_ID, TEMPO_MODERATO_ID],
  },
];

/** The stables that exist on `chainId` (mainnet 4217 or Moderato 42431). */
export function tempoStables(chainId: number): TempoStable[] {
  return TEMPO_STABLES.filter((t) => t.chains.includes(chainId));
}

export function tempoStableBySymbol(symbol: string): TempoStable | undefined {
  const s = symbol.trim().toLowerCase();
  return TEMPO_STABLES.find(
    (t) => t.symbol.toLowerCase() === s || t.symbol.replace(".", "").toLowerCase() === s.replace(".", ""),
  );
}

export function tempoRpcUrl(chainId: number = TEMPO_MAINNET_ID): string {
  if (chainId === TEMPO_MODERATO_ID) return "https://rpc.moderato.tempo.xyz";
  return "https://rpc.tempo.xyz";
}

export function tempoExplorerTx(chainId: number, hash: string): string {
  const base = "https://explore.tempo.xyz";
  return `${base}/tx/${hash}`;
}
