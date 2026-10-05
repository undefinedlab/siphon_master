export type OpportunityKind = "Stake" | "LP" | "Save" | "Cash" | "Borrow" | "Bridge" | "Vault" | "Earn";
export type OpportunityCategory = "yield" | "save" | "invest";

export type OpportunityCard = {
  id: string;
  kind: OpportunityKind;
  category: OpportunityCategory;
  headline: string;
  context: string;
  metric: string;
  metricLabel?: string;
};

const ALL: OpportunityCard[] = [
  { id: "y1", kind: "Stake", category: "yield", headline: "ETH liquid staking", context: "Lido · Ethereum", metric: "3.2%", metricLabel: "APY" },
  { id: "y2", kind: "LP", category: "yield", headline: "ETH/USDC pool", context: "Uniswap · Base", metric: "8.4%", metricLabel: "APY" },
  { id: "y3", kind: "Vault", category: "yield", headline: "USDC vault", context: "Morpho · Arbitrum", metric: "5.1%", metricLabel: "APY" },
  { id: "y4", kind: "Earn", category: "yield", headline: "Restaking basket", context: "EigenLayer", metric: "4.6%", metricLabel: "APY" },
  { id: "s1", kind: "Save", category: "save", headline: "USDC savings", context: "Aave · Optimism", metric: "4.2%", metricLabel: "APY" },
  { id: "s2", kind: "Cash", category: "save", headline: "Stable yield", context: "Maker · Ethereum", metric: "3.8%", metricLabel: "APY" },
  { id: "i1", kind: "Borrow", category: "invest", headline: "ETH collateral line", context: "Compound · Base", metric: "6.1%", metricLabel: "APR" },
  { id: "i2", kind: "Bridge", category: "invest", headline: "Cross-chain arb", context: "Squid · Multi", metric: "12bp", metricLabel: "Spread" },
];

export function opportunitiesByCategory(category: OpportunityCategory): OpportunityCard[] {
  return ALL.filter((o) => o.category === category);
}
