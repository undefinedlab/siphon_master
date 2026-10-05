/** Server-safe ETH/USD fetch with 60s in-process cache. */

let cache: { price: number; at: number } | null = null;
const CACHE_MS = 60_000;

export async function fetchEthUsdPrice(): Promise<number | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.price;
  }

  const apiKey = process.env.COINGECKO_API_KEY?.trim();
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      {
        headers: {
          Accept: "application/json",
          ...(apiKey ? { "x-cg-demo-api-key": apiKey } : {}),
        },
        next: { revalidate: 60 },
      }
    );
    if (!response.ok) return cache?.price ?? null;
    const data = (await response.json()) as { ethereum?: { usd?: number } };
    const price = data.ethereum?.usd;
    if (typeof price === "number" && price > 0) {
      cache = { price, at: Date.now() };
      return price;
    }
  } catch {
    /* use stale cache if any */
  }

  return cache?.price ?? null;
}

export type MarketPricesUsd = {
  ETH: number | null;
  USDC: number;
  updatedAt: string | null;
};

export async function resolveMarketPricesUsd(
  clientPrices?: Partial<{ ETH: number | null; USDC: number }> | null
): Promise<MarketPricesUsd> {
  const clientEth =
    clientPrices?.ETH != null && clientPrices.ETH > 0 ? clientPrices.ETH : null;
  const eth = clientEth ?? (await fetchEthUsdPrice());
  return {
    ETH: eth,
    USDC: clientPrices?.USDC ?? 1,
    updatedAt: eth != null ? new Date().toISOString() : null,
  };
}
