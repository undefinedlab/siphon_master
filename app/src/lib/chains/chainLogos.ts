export type ChainLogoId =
  | 'solana'
  | 'arbitrum'
  | 'base'
  | 'ethereum'
  | 'zcash'
  | 'tempo'
  | 'hyperliquid';

export type ChainLogoAsset = {
  src: string;
  alt: string;
};

/** Official / Trust Wallet / chain-brand assets under `public/chains/`. */
export const CHAIN_LOGO: Record<ChainLogoId, ChainLogoAsset> = {
  solana: { src: '/chains/solana.png', alt: 'Solana' },
  arbitrum: { src: '/chains/arbitrum.png', alt: 'Arbitrum' },
  base: { src: '/chains/base.png', alt: 'Base' },
  ethereum: { src: '/chains/ethereum.png', alt: 'Ethereum' },
  zcash: { src: '/chains/zcash.png', alt: 'Zcash' },
  tempo: { src: '/chains/tempo.jpg', alt: 'Tempo' },
  hyperliquid: { src: '/chains/hyperliquid.svg', alt: 'Hyperliquid' },
};

export function chainLogoIdForHomeChainId(homeChainId: string): ChainLogoId {
  if (homeChainId.startsWith('solana')) return 'solana';
  if (homeChainId === 'arbitrum') return 'arbitrum';
  if (homeChainId === 'base') return 'base';
  if (homeChainId === 'sepolia' || homeChainId === 'ethereum') return 'ethereum';
  if (homeChainId === 'zcash') return 'zcash';
  if (homeChainId === 'tempo' || homeChainId === 'tempo-moderato') return 'tempo';
  if (homeChainId === 'hyperliquid' || homeChainId === 'hyperevm-testnet') return 'hyperliquid';
  return 'hyperliquid';
}
