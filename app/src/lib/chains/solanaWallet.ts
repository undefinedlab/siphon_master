import { Connection, PublicKey, type Transaction } from "@solana/web3.js";
import { SOLANA_RPC } from "@/components/extensions/constants";
import { CHAINS, SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";

export type SolanaWalletSession = {
  address: string;
  publicKey: PublicKey;
  chainNumericId: number;
  cluster: string;
};

export type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string; toBytes(): Uint8Array };
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string; toBytes(): Uint8Array } }>;
  disconnect: () => Promise<void>;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  signAndSendTransaction?: (tx: Transaction) => Promise<{ signature: string }>;
  /** ed25519 is deterministic, so this doubles as the note-store enc-key source (solanaNoteStore). */
  signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>;
  request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  off?: (event: string, handler: (...args: unknown[]) => void) => void;
};

/** Phantom cannot switch itself — Testnet Mode is a wallet setting. */
export const PHANTOM_DEVNET_HINT =
  "In Phantom: Settings → Developer Settings → turn on Testnet Mode → choose Solana Devnet. Mainnet SOL does not fund this vault.";

export function formatPhantomNetworkError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (
    /network disabled|active networks|disabled this network|testnet mode|unknown network/i.test(msg)
  ) {
    return `Phantom has Solana Devnet disabled. ${PHANTOM_DEVNET_HINT}`;
  }
  return msg || "Phantom connection failed.";
}

export function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: PhantomProvider; phantom?: { solana?: PhantomProvider } };
  return w.solana?.isPhantom ? w.solana : w.phantom?.solana ?? null;
}

export function getSolanaConnection(): Connection {
  return new Connection(SOLANA_RPC, "confirmed");
}

export function solanaVaultChain() {
  const cluster = (process.env.NEXT_PUBLIC_CLUSTER || "devnet").toLowerCase();
  return cluster === "mainnet-beta" || cluster === "mainnet"
    ? CHAINS["solana-mainnet"]
    : CHAINS["solana-devnet"];
}

/** Connect Phantom without touching the EVM/RainbowKit path. */
export async function connectPhantom(): Promise<SolanaWalletSession> {
  const phantom = getPhantom();
  if (!phantom) {
    throw new Error("Phantom wallet not found. Install Phantom to use Solana.");
  }
  // Best-effort: ask Phantom for Devnet when the product cluster is Devnet. Phantom still
  // requires Testnet Mode in its own settings — a disabled network surfaces as its own UI.
  const cluster = (process.env.NEXT_PUBLIC_CLUSTER || "devnet").toLowerCase();
  if (cluster === "devnet" && typeof phantom.request === "function") {
    try {
      await phantom.request({ method: "wallet_changeNetwork", params: { network: "devnet" } });
    } catch (e) {
      const rewritten = formatPhantomNetworkError(e);
      if (rewritten !== (e instanceof Error ? e.message : String(e ?? ""))) {
        throw new Error(rewritten);
      }
      /* Older Phantom builds ignore this method — connect still works; signing uses our Devnet RPC. */
    }
  }
  let res: { publicKey: { toString(): string; toBytes(): Uint8Array } };
  try {
    res = await phantom.connect();
  } catch (e) {
    throw new Error(formatPhantomNetworkError(e));
  }
  const address = res.publicKey.toString();
  const chain = solanaVaultChain();
  return {
    address,
    publicKey: new PublicKey(address),
    chainNumericId: chain?.numericId ?? SOLANA_DEVNET_CHAIN_ID,
    cluster,
  };
}

/** Restore a previously approved Phantom session without opening a wallet prompt. */
export async function restoreTrustedPhantom(): Promise<SolanaWalletSession | null> {
  const phantom = getPhantom();
  if (!phantom) return null;
  try {
    const res = await phantom.connect({ onlyIfTrusted: true });
    const address = res.publicKey.toString();
    const chain = solanaVaultChain();
    return {
      address,
      publicKey: new PublicKey(address),
      chainNumericId: chain?.numericId ?? SOLANA_DEVNET_CHAIN_ID,
      cluster: (process.env.NEXT_PUBLIC_CLUSTER || "devnet").toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function subscribePhantom(
  onAccountChanged: (address: string | null) => void,
  onDisconnect: () => void,
): () => void {
  const phantom = getPhantom();
  if (!phantom?.on) return () => undefined;
  const accountHandler = (...args: unknown[]) => {
    const value = args[0] as { toString?: () => string } | null | undefined;
    onAccountChanged(value?.toString?.() ?? null);
  };
  const disconnectHandler = () => onDisconnect();
  phantom.on("accountChanged", accountHandler);
  phantom.on("disconnect", disconnectHandler);
  return () => {
    phantom.off?.("accountChanged", accountHandler);
    phantom.off?.("disconnect", disconnectHandler);
  };
}

export async function disconnectPhantom(): Promise<void> {
  const phantom = getPhantom();
  await phantom?.disconnect?.();
}

export function isPhantomAvailable(): boolean {
  return !!getPhantom();
}
