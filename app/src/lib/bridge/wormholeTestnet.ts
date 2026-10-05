/**
 * Wormhole Testnet bridge — Solana Devnet ↔ EVM testnets (Sepolia, Arb Sepolia, HyperEVM, …).
 *
 * Kept separate from LI.FI `hub.ts` (mainnet vault payouts). Use this for hackathon / Devnet
 * funding between Siphon Sol Devnet and EVM testnet homes.
 *
 * Sol ↔ EVM is **manual** TokenBridge (initiate → wait guardians → redeem). EVM ↔ EVM testnets
 * can use AutomaticTokenBridge when both sides support a relayer.
 *
 * Docs: https://wormhole.com/docs/products/token-bridge/get-started/
 */
import {
  amount,
  wormhole,
  Wormhole,
  type Chain,
  type Signer,
  type TokenId,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";

/** Siphon UI / networks.ts ids. */
export const WORMHOLE_SOL_DEVNET_UI_ID = 900_002;
export const WORMHOLE_SEPOLIA_CHAIN_ID = 11155111;
/** Base Sepolia — Wormhole Automatic routes often use this for EVM↔EVM demos. */
export const WORMHOLE_BASE_SEPOLIA_CHAIN_ID = 84532;
/** Arbitrum Sepolia. */
export const WORMHOLE_ARB_SEPOLIA_CHAIN_ID = 421614;
/** HyperEVM Testnet (Siphon Hyperliquid testnet home). */
export const WORMHOLE_HYPEREVM_TESTNET_CHAIN_ID = 998;
/** Tempo Moderato — Wormhole Testnet nativeChainId 42431 (guardian chainId 68). */
export const WORMHOLE_TEMPO_MODERATO_CHAIN_ID = 42431;

/**
 * Tempo is in the Wormhole SDK (Core + executor) but **Token Bridge / WTT is not deployed**
 * yet (`contracts.tokenBridge` missing). Cannot run Sol↔Tempo or Sepolia↔Tempo WTT until
 * Wormhole ships a Token Bridge on Moderato. Queries/Core already watch Tempo.
 */
export const WORMHOLE_TEMPO_TOKEN_BRIDGE_READY = false;

/** Chains we treat as Token-Bridge-ready on Wormhole Testnet (verified via SDK inventory). */
const TB_READY: ReadonlySet<Chain> = new Set([
  "Solana",
  "Sepolia",
  "BaseSepolia",
  "ArbitrumSepolia",
  "HyperEVM",
]);

export type WormholeTestnetRouteId =
  | "sol-devnet→sepolia"
  | "sepolia→sol-devnet"
  | "sol-devnet→arb-sepolia"
  | "arb-sepolia→sol-devnet"
  | "sol-devnet→hyperevm"
  | "hyperevm→sol-devnet"
  | "sepolia→base-sepolia"
  | "base-sepolia→sepolia"
  | "sepolia→arb-sepolia"
  | "arb-sepolia→sepolia";

export type WormholeTestnetRoute = {
  id: WormholeTestnetRouteId;
  label: string;
  /** Wormhole SDK chain names. */
  from: Chain;
  to: Chain;
  /** Manual TokenBridge (Sol involved) vs AutomaticTokenBridge (EVM↔EVM). */
  mode: "TokenBridge" | "AutomaticTokenBridge";
  eta: string;
  note: string;
};

const MANUAL_SOL_NOTE =
  "Manual redeem after Guardian attestation. Tokens arrive as Wormhole-wrapped.";

/** Supported Devnet/testnet routes we expose in product. */
export const WORMHOLE_TESTNET_ROUTES: readonly WormholeTestnetRoute[] = [
  {
    id: "sol-devnet→sepolia",
    label: "Solana Devnet → ETH Sepolia",
    from: "Solana",
    to: "Sepolia",
    mode: "TokenBridge",
    eta: "~5–15 min",
    note: MANUAL_SOL_NOTE,
  },
  {
    id: "sepolia→sol-devnet",
    label: "ETH Sepolia → Solana Devnet",
    from: "Sepolia",
    to: "Solana",
    mode: "TokenBridge",
    eta: "~5–15 min",
    note: MANUAL_SOL_NOTE,
  },
  {
    id: "sol-devnet→arb-sepolia",
    label: "Solana Devnet → Arbitrum Sepolia",
    from: "Solana",
    to: "ArbitrumSepolia",
    mode: "TokenBridge",
    eta: "~5–15 min",
    note: MANUAL_SOL_NOTE,
  },
  {
    id: "arb-sepolia→sol-devnet",
    label: "Arbitrum Sepolia → Solana Devnet",
    from: "ArbitrumSepolia",
    to: "Solana",
    mode: "TokenBridge",
    eta: "~5–15 min",
    note: MANUAL_SOL_NOTE,
  },
  {
    id: "sol-devnet→hyperevm",
    label: "Solana Devnet → HyperEVM Testnet",
    from: "Solana",
    to: "HyperEVM",
    mode: "TokenBridge",
    eta: "~5–15 min",
    note: MANUAL_SOL_NOTE,
  },
  {
    id: "hyperevm→sol-devnet",
    label: "HyperEVM Testnet → Solana Devnet",
    from: "HyperEVM",
    to: "Solana",
    mode: "TokenBridge",
    eta: "~5–15 min",
    note: MANUAL_SOL_NOTE,
  },
  {
    id: "sepolia→base-sepolia",
    label: "Sepolia → Base Sepolia",
    from: "Sepolia",
    to: "BaseSepolia",
    mode: "AutomaticTokenBridge",
    eta: "~2–5 min",
    note: "Relayer completes redeem when AutomaticTokenBridge is available.",
  },
  {
    id: "base-sepolia→sepolia",
    label: "Base Sepolia → Sepolia",
    from: "BaseSepolia",
    to: "Sepolia",
    mode: "AutomaticTokenBridge",
    eta: "~2–5 min",
    note: "Relayer completes redeem when AutomaticTokenBridge is available.",
  },
  {
    id: "sepolia→arb-sepolia",
    label: "Sepolia → Arbitrum Sepolia",
    from: "Sepolia",
    to: "ArbitrumSepolia",
    mode: "AutomaticTokenBridge",
    eta: "~2–5 min",
    note: "Relayer completes redeem when AutomaticTokenBridge is available.",
  },
  {
    id: "arb-sepolia→sepolia",
    label: "Arbitrum Sepolia → Sepolia",
    from: "ArbitrumSepolia",
    to: "Sepolia",
    mode: "AutomaticTokenBridge",
    eta: "~2–5 min",
    note: "Relayer completes redeem when AutomaticTokenBridge is available.",
  },
];

export function wormholeTestnetRoute(id: WormholeTestnetRouteId): WormholeTestnetRoute | undefined {
  return WORMHOLE_TESTNET_ROUTES.find((r) => r.id === id);
}

/** Map Siphon numeric chain id → Wormhole chain name (testnet only). */
export function wormholeChainForSiphonId(chainId: number): Chain | null {
  if (chainId === WORMHOLE_SOL_DEVNET_UI_ID) return "Solana";
  if (chainId === WORMHOLE_SEPOLIA_CHAIN_ID) return "Sepolia";
  if (chainId === WORMHOLE_BASE_SEPOLIA_CHAIN_ID) return "BaseSepolia";
  if (chainId === WORMHOLE_ARB_SEPOLIA_CHAIN_ID) return "ArbitrumSepolia";
  if (chainId === WORMHOLE_HYPEREVM_TESTNET_CHAIN_ID) return "HyperEVM";
  if (chainId === WORMHOLE_TEMPO_MODERATO_CHAIN_ID) return "Tempo";
  return null;
}

/** True when Wormhole Token Bridge (WTT) can move assets on this Wormhole chain name. */
export function wormholeTokenBridgeReady(chain: Chain): boolean {
  if (chain === "Tempo") return WORMHOLE_TEMPO_TOKEN_BRIDGE_READY;
  return TB_READY.has(chain);
}

/**
 * Planned Tempo routes — not executable until `WORMHOLE_TEMPO_TOKEN_BRIDGE_READY`.
 * Keep listed so UI can show "coming soon" without inventing a second bridge stack.
 */
export const WORMHOLE_TEMPO_ROUTES_PLANNED = [
  {
    id: "sol-devnet→tempo",
    label: "Solana Devnet → Tempo Moderato",
    from: "Solana" as const,
    to: "Tempo" as const,
    blockedReason: "Wormhole Token Bridge not deployed on Tempo testnet yet (Core only).",
  },
  {
    id: "sepolia→tempo",
    label: "ETH Sepolia → Tempo Moderato",
    from: "Sepolia" as const,
    to: "Tempo" as const,
    blockedReason: "Wormhole Token Bridge not deployed on Tempo testnet yet (Core only).",
  },
  {
    id: "tempo→sepolia",
    label: "Tempo Moderato → ETH Sepolia",
    from: "Tempo" as const,
    to: "Sepolia" as const,
    blockedReason: "Wormhole Token Bridge not deployed on Tempo testnet yet (Core only).",
  },
] as const;

export type WormholeTestnetClient = Awaited<ReturnType<typeof createWormholeTestnetClient>>;

/** Lazy SDK bootstrap — Solana + EVM platforms on Wormhole Testnet. */
export async function createWormholeTestnetClient() {
  return wormhole("Testnet", [solana, evm]);
}

export type WormholeTransferInput = {
  routeId: WormholeTestnetRouteId;
  /** Human amount, e.g. "0.1". */
  amountHuman: string;
  /**
   * Token to move. `"native"` = SOL on Solana / ETH on Sepolia.
   * Or a mint / ERC-20 address on the source chain.
   */
  token?: "native" | string;
  sourceSigner: Signer;
  destinationSigner: Signer;
  /** Attestation wait (manual routes). Default 10 minutes. */
  attestationTimeoutMs?: number;
};

export type WormholeTransferResult = {
  route: WormholeTestnetRoute;
  sourceTxids: string[];
  destinationTxids: string[];
  token: TokenId;
  amountRaw: bigint;
};

function tokenIdFor(route: WormholeTestnetRoute, token: "native" | string): TokenId {
  if (token === "native") return Wormhole.tokenId(route.from, "native");
  return Wormhole.tokenId(route.from, token);
}

/**
 * Run a Wormhole Testnet transfer end-to-end.
 * Manual routes wait for attestation then redeem; automatic routes only initiate.
 */
export async function runWormholeTestnetTransfer(
  input: WormholeTransferInput,
): Promise<WormholeTransferResult> {
  const route = wormholeTestnetRoute(input.routeId);
  if (!route) throw new Error(`Unknown Wormhole testnet route: ${input.routeId}`);
  if (!wormholeTokenBridgeReady(route.from) || !wormholeTokenBridgeReady(route.to)) {
    throw new Error(
      `Wormhole Token Bridge not ready for ${route.from} → ${route.to}`,
    );
  }

  const wh = await createWormholeTestnetClient();

  const token = tokenIdFor(route, input.token ?? "native");
  const decimals = Number(await wh.getDecimals(token.chain, token.address));
  const amountRaw = amount.units(amount.parse(input.amountHuman, decimals));

  const sourceAddress = Wormhole.chainAddress(route.from, input.sourceSigner.address());
  const destAddress = Wormhole.chainAddress(route.to, input.destinationSigner.address());

  if (route.mode === "AutomaticTokenBridge") {
    const nativeGas = amount.units(amount.parse("0.0", 6));
    // Wormhole SDK types omit the AutomaticTokenBridge overload.
    const xfer = await (
      wh as unknown as {
        tokenTransfer: (
          ...args: [
            typeof token,
            typeof amountRaw,
            typeof sourceAddress,
            typeof destAddress,
            string,
            typeof nativeGas,
          ]
        ) => ReturnType<typeof wh.tokenTransfer>;
      }
    ).tokenTransfer(token, amountRaw, sourceAddress, destAddress, "AutomaticTokenBridge", nativeGas);
    const sourceTxids = await xfer.initiateTransfer(input.sourceSigner);
    return {
      route,
      sourceTxids: sourceTxids.map(String),
      destinationTxids: [],
      token,
      amountRaw,
    };
  }

  // Sol ↔ EVM: manual TokenBridge
  const xfer = await wh.tokenTransfer(
    token,
    amountRaw,
    sourceAddress,
    destAddress,
    "TokenBridge",
    undefined,
  );

  const sourceTxids = await xfer.initiateTransfer(input.sourceSigner);
  const timeout = input.attestationTimeoutMs ?? 10 * 60 * 1000;
  await xfer.fetchAttestation(timeout);
  const destinationTxids = await xfer.completeTransfer(input.destinationSigner);

  return {
    route,
    sourceTxids: sourceTxids.map(String),
    destinationTxids: destinationTxids.map(String),
    token,
    amountRaw,
  };
}

/** Explorer link for a Wormhole Testnet transfer (source tx). */
export function wormholeTestnetScanUrl(txid: string): string {
  return `https://wormholescan.io/#/tx/${txid}?network=Testnet`;
}

/** Whether Siphon should offer Wormhole instead of LI.FI for this pair. */
export function preferWormholeTestnetBridge(
  fromChainId: number,
  toChainId: number,
): boolean {
  const from = wormholeChainForSiphonId(fromChainId);
  const to = wormholeChainForSiphonId(toChainId);
  if (!from || !to || from === to) return false;
  if (!wormholeTokenBridgeReady(from) || !wormholeTokenBridgeReady(to)) return false;
  return WORMHOLE_TESTNET_ROUTES.some((r) => r.from === from && r.to === to);
}
