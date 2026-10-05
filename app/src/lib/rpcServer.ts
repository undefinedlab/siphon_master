import { NETWORKS } from './networks';

function uniqueUrls(urls: (string | undefined)[]): string[] {
  return [...new Set(urls.filter((u): u is string => Boolean(u)))];
}

/** Ordered upstream RPC URLs — primary first, then public fallbacks. */
export function getServerRpcUrls(chainId: number): string[] {
  if (chainId === 8453) {
    // Your configured RPC (a paid key) FIRST; reliable public nodes next; free-tier dRPC LAST —
    // its free tier times out even single-block eth_getLogs scans (`code 30`), which stalled
    // Base withdraws. The proxy also demotes drpc for getLogs, but keep it last here regardless.
    return uniqueUrls([
      process.env.BASE_MAINNET_RPC,
      process.env.BASE_RPC_URL,
      NETWORKS[8453].rpcUrl,
      'https://mainnet.base.org',
      'https://1rpc.io/base',
      'https://base.drpc.org',
    ]);
  }
  if (chainId === 42161) {
    return uniqueUrls([
      process.env.ARBITRUM_RPC,
      NETWORKS[42161].rpcUrl,
      'https://arbitrum-one-rpc.publicnode.com',
      'https://1rpc.io/arb',
    ]);
  }
  if (chainId === 84532) {
    return uniqueUrls([
      process.env.BASE_SEPOLIA_RPC,
      process.env.BASE_RPC_URL,
      NETWORKS[84532].rpcUrl,
      'https://sepolia.base.org',
    ]);
  }
  if (chainId === 11155111) {
    // Your configured (keyed) RPC FIRST — it must be archive-capable, because publicnode.com now
    // hard-403s archive eth_getLogs ("Archive requests require a personal token"), which breaks
    // output-note resolution + balance scans. Public nodes follow as fallbacks (fine for
    // non-archive calls; they 403/throttle on archive, so the proxy falls through to the keyed
    // one). ETH_RPC_URL (often Infura free-tier: returns 429 as -32005 inside a 200) is LAST.
    return uniqueUrls([
      process.env.ETH_SEPOLIA_RPC,                        // MUST be archive-capable (Alchemy/Infura paid)
      process.env.ETH_RPC_URL,                            // Infura fallback — archive, but free-tier 429s
      NETWORKS[11155111].rpcUrl,                          // ethereum-sepolia-rpc.publicnode.com (archive-403)
      // drpc.org removed as a fallback: its free tier rejects any batch >3 ("code 31"), and ethers
      // batches up to 10 — so on a primary 429 the fall-through to drpc turns into a hard 500 batch
      // error mid-scan. publicnode above cleanly 403s archive (a miss the client retries) instead of
      // corrupting a batch. Re-add drpc only behind a paid key that lifts the batch cap.
      // rpc.sepolia.org removed: it now returns an Apache 404 for every request, surfacing a
      // confusing SERVER_ERROR to the client on fall-through instead of a clean archive miss.
    ]);
  }
  if (chainId === 42431) {
    return uniqueUrls([
      process.env.TEMPO_MODERATO_RPC,
      NETWORKS[42431].rpcUrl,
      "https://rpc.moderato.tempo.xyz",
    ]);
  }
  if (chainId === 998) {
    return uniqueUrls([
      process.env.HYPEREVM_TESTNET_RPC,
      NETWORKS[998].rpcUrl,
      "https://rpc.hyperliquid-testnet.xyz/evm",
    ]);
  }
  throw new Error(`Unsupported chainId: ${chainId}`);
}

/** @deprecated Use getServerRpcUrls — returns primary only. */
export function getServerRpcUrl(chainId: number): string {
  return getServerRpcUrls(chainId)[0];
}
