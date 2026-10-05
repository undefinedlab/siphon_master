/**
 * The one EIP-1193 provider the app is allowed to talk to.
 *
 * WHY THIS MODULE EXISTS. `window.ethereum` belongs to whichever extension won the injection
 * race, which is not necessarily the wallet the user connected through. With two wallets
 * installed the two diverge in account AND in chain, and every consequence is silent:
 *
 *   - a compliance fee gets quoted for the foreign wallet's chain and paid from its account, so
 *     real money leaves and the ASP correctly reports it never arrived at the vault it checks;
 *   - `wallet_switchEthereumChain` goes to the foreign wallet, so the dapp flips its selected
 *     chain while the connected wallet stays where it was — the app says Base, the signer says
 *     Sepolia;
 *   - a `chainChanged` listener bound to the foreign wallet makes the dapp follow a network the
 *     user never switched.
 *
 * `walletManager` owns the connected provider, but it lives under `components/` and imports
 * `lib/nexus`, so `lib/networks` cannot import it back without a cycle. This leaf module is the
 * shared cell both sides can reach: walletManager writes it, everything else reads it.
 *
 * The `window.ethereum` fallback is deliberate but narrow — it only applies before anything is
 * connected, which is the one moment no better answer exists (e.g. offering to add a network to
 * a wallet the user has not yet linked).
 */

/** Minimal EIP-1193 surface — matches walletManager's EthereumLikeProvider structurally. */
export type ActiveEvmProvider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

let active: ActiveEvmProvider | null = null;

/** Called by walletManager when a wallet is adopted, and with null when it disconnects. */
export function setActiveEvmProvider(provider: ActiveEvmProvider | null): void {
  active = provider;
}

/** The connected wallet's provider, or null. Prefer this — it never guesses. */
export function connectedEvmProvider(): ActiveEvmProvider | null {
  return active;
}

/**
 * The connected wallet's provider, falling back to `window.ethereum` only when nothing is
 * connected yet. Use this ONLY where a pre-connect provider is genuinely useful; anything that
 * spends money or signs must use {@link connectedEvmProvider} and refuse when it returns null.
 */
export function activeEvmProvider(): ActiveEvmProvider | null {
  if (active) return active;
  if (typeof window === "undefined") return null;
  return (window as Window & { ethereum?: ActiveEvmProvider }).ethereum ?? null;
}
