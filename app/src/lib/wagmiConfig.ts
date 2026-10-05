import { connectorsForWallets, darkTheme, type Theme } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { arbitrum, base, baseSepolia, sepolia } from "wagmi/chains";
import type { Chain } from "wagmi/chains";
import { NETWORKS } from "./networks";

/** Tempo Moderato — not in wagmi/chains yet; mirror NETWORKS[42431]. */
const tempoModerato: Chain = {
  id: 42431,
  name: "Tempo Moderato",
  nativeCurrency: { name: "PathUSD", symbol: "pathUSD", decimals: 18 },
  rpcUrls: {
    default: { http: [NETWORKS[42431].rpcUrl] },
  },
  blockExplorers: {
    default: { name: "Tempo Explorer", url: NETWORKS[42431].explorer },
  },
  testnet: true,
};

/** HyperEVM Testnet — mirror NETWORKS[998]. */
const hyperevmTestnet: Chain = {
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: [NETWORKS[998].rpcUrl] },
  },
  blockExplorers: {
    default: { name: "HyperEVM Explorer", url: NETWORKS[998].explorer },
  },
  testnet: true,
};

/** Point each chain's default RPC at Siphon's own proxy (same route MetaMask Connect used). */
function withProxyRpc(chain: Chain): Chain {
  return {
    ...chain,
    rpcUrls: {
      default: { http: [`/api/rpc?chainId=${chain.id}`] },
    },
  };
}

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || "";
const hasWalletConnect = WALLETCONNECT_PROJECT_ID.length > 0;

if (!hasWalletConnect && typeof window !== "undefined") {
  console.warn(
    "[wallet] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set — WalletConnect-based wallets " +
      "(QR/mobile, Rainbow, Trust) are left out of the connect list entirely, since RainbowKit's " +
      "WalletConnect-hybrid connectors otherwise ping Reown Cloud on every page load and fail with " +
      "'Origin not found on Allowlist' for an unregistered id. Installed browser extensions " +
      "(MetaMask, Coinbase Wallet, Rabby, Brave, etc. via EIP-6963) and Coinbase's own connector " +
      "still work fully. Get a free id at https://cloud.walletconnect.com and add it to .env.local " +
      "to enable the rest.",
  );
}

const chains = [
  withProxyRpc(base),
  withProxyRpc(arbitrum),
  withProxyRpc(sepolia),
  withProxyRpc(baseSepolia),
  withProxyRpc(tempoModerato),
  withProxyRpc(hyperevmTestnet),
] as const;

// Only include WalletConnect-hybrid connectors once a real project id is configured — RainbowKit's
// per-wallet connectors (metaMaskWallet, rainbowWallet, etc.) each embed a WalletConnect Core client
// for their mobile/QR fallback, which reaches out to Reown Cloud as soon as the connector is set up
// (on page load, not on click) and errors loudly for a placeholder/unregistered id. `injectedWallet`
// and `coinbaseWallet` are not WalletConnect-based — they stay available either way, and
// `injectedWallet` alone already surfaces every EIP-6963-announced extension (MetaMask, Rabby,
// Brave, etc.), not just one.
const connectors = connectorsForWallets(
  hasWalletConnect
    ? [
        {
          groupName: "Popular",
          wallets: [metaMaskWallet, rainbowWallet, coinbaseWallet, walletConnectWallet],
        },
      ]
    : [
        {
          groupName: "Installed",
          wallets: [injectedWallet, coinbaseWallet],
        },
      ],
  {
    appName: "Siphon",
    projectId: hasWalletConnect ? WALLETCONNECT_PROJECT_ID : "unused-no-walletconnect",
  },
);

export const wagmiConfig = createConfig({
  connectors,
  chains,
  transports: Object.fromEntries(chains.map((c) => [c.id, http()])) as Record<
    (typeof chains)[number]["id"],
    ReturnType<typeof http>
  >,
  ssr: true,
});

/** RainbowKit modal theme matched to Siphon's existing black/white monospace wallet UI (globals.css). */
export const siphonRainbowKitTheme: Theme = darkTheme({
  accentColor: "#ffffff",
  accentColorForeground: "#000000",
  borderRadius: "small",
  fontStack: "system",
  overlayBlur: "small",
});

siphonRainbowKitTheme.colors.modalBackground = "rgba(0, 0, 0, 0.95)";
siphonRainbowKitTheme.colors.modalBorder = "rgba(255, 255, 255, 0.2)";
siphonRainbowKitTheme.colors.profileForeground = "rgba(0, 0, 0, 0.95)";
siphonRainbowKitTheme.colors.actionButtonBorder = "rgba(255, 255, 255, 0.1)";
siphonRainbowKitTheme.colors.actionButtonSecondaryBackground = "rgba(255, 255, 255, 0.05)";
siphonRainbowKitTheme.fonts.body = "var(--font-source-code), monospace";

// Kept for callers that only need chain ids without importing wagmi/viem types.
export const WAGMI_CHAIN_IDS = Object.keys(NETWORKS).map(Number);
