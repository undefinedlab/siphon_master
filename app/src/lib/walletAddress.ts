import { walletManager } from "@/components/extensions/walletManager";

/** Resolve the connected EVM wallet address from the active wallet session. */
export function resolveWalletAddress(): string | null {
  return (
    walletManager.getPrimaryWallet()?.address ??
    walletManager.getConnectedWallets().find((w) => w.id === "evm")?.address ??
    null
  );
}
