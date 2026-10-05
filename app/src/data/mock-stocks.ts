export type MockStock = {
  symbol: string;
  price: number;
  changeDay: number;
  sparkUp: boolean;
};

export const mockStocks: MockStock[] = [
  { symbol: "NVDA", price: 892.4, changeDay: 1.82, sparkUp: true },
  { symbol: "MSFT", price: 428.1, changeDay: -0.34, sparkUp: false },
  { symbol: "AAPL", price: 198.6, changeDay: 0.55, sparkUp: true },
  { symbol: "META", price: 512.3, changeDay: 2.1, sparkUp: true },
  { symbol: "GOOGL", price: 178.2, changeDay: -0.8, sparkUp: false },
  { symbol: "AMZN", price: 198.4, changeDay: 0.9, sparkUp: true },
];

export function top4StocksByCap(stocks: MockStock[]) {
  return stocks.slice(0, 4);
}

export function top4StockMovers(stocks: MockStock[]) {
  return [...stocks].sort((a, b) => Math.abs(b.changeDay) - Math.abs(a.changeDay)).slice(0, 4);
}

export function top4TechStocks(stocks: MockStock[]) {
  const tech = new Set(["NVDA", "MSFT", "META", "AAPL", "GOOGL", "AMZN"]);
  return stocks.filter((s) => tech.has(s.symbol)).slice(0, 4);
}
