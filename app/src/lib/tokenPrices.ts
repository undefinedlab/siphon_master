/** Shared live ETH/USD for builder canvas estimates (updated by ethPriceStore). */

let liveEthUsd: number | null = null;

export function setLiveEthUsd(price: number | null): void {
  liveEthUsd = price != null && price > 0 ? price : null;
}

export function getLiveEthUsd(): number {
  return liveEthUsd ?? 3200;
}

export function getTokenPrices(): Record<string, number> {
  const eth = getLiveEthUsd();
  return {
    SOL: 192,
    USDC: 1,
    USDT: 1,
    WBTC: 45000,
    XMR: 120,
    ETH: eth,
  };
}
