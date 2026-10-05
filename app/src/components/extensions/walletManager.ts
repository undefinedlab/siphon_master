import { deinit, initializeWithProvider } from '../../lib/nexus';
import { setActiveEvmProvider, type ActiveEvmProvider } from '../../lib/activeEvmProvider';
import { getSelectedChainId, NETWORKS, setSelectedChainId, switchWalletNetwork } from '../../lib/networks';
import { nativeSolanaDashLocked, readStoredHomeChainId, resolveHomeChainOption } from '../../lib/chains/homeChains';

export const WALLET_STORAGE_KEY = 'siphon-connected-wallet';

export interface WalletInfo {
  id: string;
  name: string;
  address: string;
  chain: string;
  connected: boolean;
}

export interface WalletConnectionResult {
  success: boolean;
  wallet?: WalletInfo;
  error?: string;
}

/** EIP-1193 provider shape — satisfied by injected extensions, WalletConnect, and Coinbase Wallet alike. */
export type EthereumLikeProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export type EvmWalletHandoff = {
  address: string;
  name: string;
  accounts?: string[];
  /** The chain the wallet actually reports (wagmi's onConnect payload already has this). */
  chainId?: number;
  /**
   * True for wagmi's silent reconnectOnMount, not a user clicking "Connect Wallet". Interactive
   * steps (wallet_switchEthereumChain) can silently never resolve when they're not the direct
   * result of a user gesture — so on reconnect we sync our own selected chain to whatever the
   * wallet already reports instead of demanding an interactive switch.
   */
  isReconnect?: boolean;
};

const ADOPT_TIMEOUT_MS = 8_000;

/**
 * An interactive step here (most notably wallet_switchEthereumChain) can, on some wallets/browsers,
 * simply never resolve when it's not the direct result of a user gesture — e.g. during wagmi's
 * silent reconnectOnMount, rather than a click on "Connect Wallet". Without a bound, that leaves
 * wagmi believing isConnected=true (RainbowKit then refuses to open the connect modal at all)
 * while walletManager never finishes adopting the wallet — a permanent stuck state with no way for
 * the user to recover except clearing storage. This guarantees adoption always settles.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type WalletSignerLifecycle = {
  initialize: typeof initializeWithProvider;
  deinitialize: typeof deinit;
};

const defaultSignerLifecycle: WalletSignerLifecycle = {
  initialize: initializeWithProvider,
  deinitialize: deinit,
};

export class WalletManager {
  private connectedWallets: Map<string, WalletInfo> = new Map();
  private restorePromise: Promise<WalletInfo | null> | null = null;
  private providersWithListeners = new WeakSet<object>();
  private currentEvmProvider: object | null = null;
  private accountChangeGeneration = 0;
  private signerRefreshQueue: Promise<void> = Promise.resolve();
  private sessionGeneration = 0;
  private evmConnectionPromise: Promise<WalletConnectionResult> | null = null;
  private evmDisconnectTrigger: (() => Promise<void>) | null = null;

  constructor(private readonly signerLifecycle: WalletSignerLifecycle = defaultSignerLifecycle) {
    if (typeof window !== 'undefined') {
      this.bindProviderListeners();
    }
  }

  private bindProviderListeners(provider?: EthereumLikeProvider): void {
    if (typeof window === 'undefined') return;
    const ethereum = provider ?? (window as Window & { ethereum?: EthereumLikeProvider }).ethereum;
    if (!ethereum?.on) return;
    if (this.currentEvmProvider !== ethereum) this.accountChangeGeneration++;
    this.currentEvmProvider = ethereum;
    setActiveEvmProvider(ethereum as ActiveEvmProvider);
    if (this.providersWithListeners.has(ethereum)) return;
    this.providersWithListeners.add(ethereum);

    ethereum.on('accountsChanged', (accounts: unknown) => {
      if (this.currentEvmProvider !== ethereum) return;
      const list = Array.isArray(accounts) ? (accounts as string[]) : [];
      if (list.length === 0) {
        this.sessionGeneration++;
        const generation = ++this.accountChangeGeneration;
        this.connectedWallets.delete('evm');
        if (this.getConnectedWallets().length === 0) this.clearPersistedWallet();
        this.signerRefreshQueue = this.signerRefreshQueue.catch(() => undefined).then(() => (
          generation === this.accountChangeGeneration
            ? this.signerLifecycle.deinitialize()
            : undefined
        ));
        window.dispatchEvent(new Event('walletDisconnected'));
        return;
      }

      const evm = this.connectedWallets.get('evm');
      // Wallets commonly emit the newly-approved account before the connect handshake resolves.
      // During initial setup there is no published wallet to update; the connection flow rereads
      // eth_accounts before publication, so this expected event must not invalidate that flow.
      if (!evm) return;
      this.sessionGeneration++;
      const generation = ++this.accountChangeGeneration;

      const nextAddress = list[0];
      if (nextAddress.toLowerCase() === evm.address.toLowerCase()) return;

      // BrowserProvider captures its signer. Refresh it before publishing the new address so the UI
      // can never show account B while transactions still sign through account A.
      this.signerRefreshQueue = this.signerRefreshQueue.catch(() => undefined).then(async () => {
        if (this.currentEvmProvider !== ethereum || generation !== this.accountChangeGeneration) return;
        try {
          await this.signerLifecycle.initialize(ethereum as Parameters<typeof initializeWithProvider>[0], true);
          if (this.currentEvmProvider !== ethereum || generation !== this.accountChangeGeneration) return;
          const updated: WalletInfo = { ...evm, address: nextAddress };
          this.connectedWallets.set('evm', updated);
          this.persistWallet(updated);
          window.dispatchEvent(new Event('walletConnected'));
        } catch {
          if (this.currentEvmProvider !== ethereum || generation !== this.accountChangeGeneration) return;
          this.connectedWallets.delete('evm');
          if (this.getConnectedWallets().length === 0) this.clearPersistedWallet();
          await this.signerLifecycle.deinitialize();
          window.dispatchEvent(new Event('walletDisconnected'));
        }
      });
    });

    ethereum.on('chainChanged', (hex: unknown) => {
      if (this.currentEvmProvider !== ethereum) return;
      const id = typeof hex === 'string' ? parseInt(hex, 16) : Number(hex);
      // Solana Devnet home: MetaMask reporting Base must not become the dashboard chain.
      if (!nativeSolanaDashLocked() && NETWORKS[id]) setSelectedChainId(id);
      // Initial connection initializes explicitly after its requested switch. Once connected, all
      // chain/account signer changes share this queue so they cannot race Nexus module state.
      if (!this.connectedWallets.has('evm')) return;
      this.signerRefreshQueue = this.signerRefreshQueue.catch(() => undefined).then(async () => {
        if (this.currentEvmProvider !== ethereum) return;
        await this.signerLifecycle.initialize(
          ethereum as Parameters<typeof initializeWithProvider>[0],
          true,
        );
      });
    });

    ethereum.on('disconnect', () => {
      if (this.currentEvmProvider !== ethereum) return;
      const generation = ++this.accountChangeGeneration;
      this.sessionGeneration++;
      this.currentEvmProvider = null;
      setActiveEvmProvider(null);
      this.connectedWallets.delete('evm');
      if (this.getConnectedWallets().length === 0) this.clearPersistedWallet();
      this.signerRefreshQueue = this.signerRefreshQueue.catch(() => undefined).then(() => (
        generation === this.accountChangeGeneration
          ? this.signerLifecycle.deinitialize()
          : undefined
      ));
      window.dispatchEvent(new Event('walletDisconnected'));
    });
  }

  loadStoredWallet(): WalletInfo | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(WALLET_STORAGE_KEY);
      if (!raw) return null;
      const wallet = JSON.parse(raw) as WalletInfo;
      return wallet?.address ? wallet : null;
    } catch {
      return null;
    }
  }

  persistWallet(wallet: WalletInfo): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(wallet));
  }

  clearPersistedWallet(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(WALLET_STORAGE_KEY);
  }

  clearSession(): void {
    const wallets = this.getConnectedWallets();
    for (const wallet of wallets) {
      this.disconnectWallet(wallet.id);
    }
    this.clearPersistedWallet();
  }

  /** Restore in-memory session from the browser wallet + localStorage after reload. */
  async restorePersistedSession(): Promise<WalletInfo | null> {
    // Only COALESCE concurrent in-flight calls (e.g. several components restoring on mount) — do NOT
    // cache the result. Clearing on settle means a later call after an accountsChanged event re-reads
    // eth_accounts and picks up the new active account, instead of returning the first-load address
    // forever (the "ADDRESS label stuck on the old account after switching in MetaMask" bug).
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = this.doRestorePersistedSession();
    void this.restorePromise.finally(() => { this.restorePromise = null; });
    return this.restorePromise;
  }

  private async doRestorePersistedSession(): Promise<WalletInfo | null> {
    if (typeof window === 'undefined') return null;

    const stored = this.loadStoredWallet();
    if (!stored) {
      this.connectedWallets.clear();
      return null;
    }

    if (stored.id === 'evm') {
      // Wagmi owns EVM reconnection (its own persisted connector state, restored on mount by
      // WagmiProvider). EvmWalletBridge calls adoptEvmWallet() once that reconnect resolves, which
      // re-populates connectedWallets and fires 'walletConnected'. Until then, report whatever is
      // already tracked this session rather than racing wagmi's async restore here.
      return this.connectedWallets.get('evm') ?? null;
    }

    if (stored.id === 'solana' && stored.address) {
      // Adopted this session (the Devnet toggle) — keep it.
      const live = this.connectedWallets.get('solana');
      if (live) return live;
      // Cold reload: Phantom is the identity only on a native Solana home (Devnet). On mainnet the
      // vault is an EVM wallet on Base, and restoring Phantom as primary would key notes, strategies
      // and auth to an address the executor cannot verify — so drop it and let the EVM reconnect win.
      if (resolveHomeChainOption(readStoredHomeChainId())?.kind !== 'solana') {
        this.clearPersistedWallet();
        return null;
      }
      this.connectedWallets.set('solana', { ...stored, connected: true });
      return this.connectedWallets.get('solana') ?? null;
    }

    // Other wallet types: only restore if already tracked this session.
    return this.connectedWallets.get(stored.id) ?? null;
  }

  /**
   * The EVM provider the user actually connected through (the wagmi/RainbowKit connector's own
   * provider), or null when nothing is connected.
   *
   * Read this instead of window.ethereum, ALWAYS. Multi-chain extensions (Phantom especially)
   * overwrite that global, so reading it hands the app whichever extension won the injection race
   * rather than the wallet the user picked. Worse, ethers' BrowserProvider.getSigner() fires
   * eth_requestAccounts when the provider has no authorised account, so merely *reading* the wrong
   * global pops an approval dialog for a wallet the user never chose — from a background tab, with
   * no user gesture. Returning null here is the correct outcome, not a reason to fall back.
   */
  getEvmProvider(): EthereumLikeProvider | null {
    return (this.currentEvmProvider as EthereumLikeProvider | null) ?? null;
  }

  hasActiveSession(): boolean {
    return this.connectedWallets.size > 0;
  }

  /** Let the RainbowKit/wagmi connect flow tell us to disconnect the active EVM connector. */
  registerEvmDisconnector(trigger: (() => Promise<void>) | null): void {
    this.evmDisconnectTrigger = trigger;
  }

  /**
   * Adopt an EVM wallet a RainbowKit/wagmi connector already negotiated approval for.
   * Uses the connector's provider directly for listener + signer setup. Where the browser permits
   * it, the provider is also exposed as window.ethereum for legacy consumers; some injected-wallet
   * browsers intentionally expose window.ethereum as a getter-only property, so adoption must not
   * depend on replacing that global.
   */
  adoptEvmWallet(eth: EthereumLikeProvider, info: EvmWalletHandoff): Promise<WalletConnectionResult> {
    if (this.evmConnectionPromise) return this.evmConnectionPromise;
    const connecting = withTimeout(
      this.adoptEvmWalletOnce(eth, info),
      ADOPT_TIMEOUT_MS,
      'Wallet adoption timed out — a wallet prompt may be stuck. Please retry.',
    ).catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect wallet',
    }));
    const guarded = connecting.finally(() => {
      if (this.evmConnectionPromise === guarded) this.evmConnectionPromise = null;
    });
    this.evmConnectionPromise = guarded;
    return guarded;
  }

  private async adoptEvmWalletOnce(
    eth: EthereumLikeProvider,
    info: EvmWalletHandoff,
  ): Promise<WalletConnectionResult> {
    const connectionGeneration = ++this.sessionGeneration;
    try {
      // Best-effort ONLY. Reflect.set reports `false` instead of throwing for a plain
      // non-writable window.ethereum, but several extensions install an accessor whose setter
      // calls Object.defineProperty and throws "Cannot redefine property: ethereum" — common
      // when more than one wallet is installed and they race to claim the global. That throw
      // used to abort adoption entirely, so a user with two wallets could not connect at all.
      // The connector provider is authoritative below; the global is a legacy courtesy.
      try {
        Reflect.set(window, 'ethereum', eth);
      } catch {
        /* another extension owns the global — irrelevant to this connection */
      }
      this.bindProviderListeners(eth);
      const connectionIsCurrent = () => (
        this.sessionGeneration === connectionGeneration && this.currentEvmProvider === eth
      );

      // The connector's own connect() already completed wallet approval and returned the
      // session accounts — re-requesting them (eth_requestAccounts) is redundant and, on some
      // mobile/WalletConnect transports, can leave a second approval sheet open indefinitely.
      const accounts = info.accounts ?? (await eth.request({ method: 'eth_requestAccounts' }) as string[]);
      if (!connectionIsCurrent()) throw new Error('Wallet connection changed while connecting. Please retry.');
      if (accounts.length === 0) {
        return { success: false, error: 'No accounts found' };
      }

      // On a silent reconnect (wagmi's reconnectOnMount, not a user clicking "Connect Wallet"),
      // never request an interactive chain switch — outside a user gesture, some wallets just
      // never resolve wallet_switchEthereumChain, which used to leave wagmi stuck believing
      // isConnected=true forever with no way for the app to recover. Just adopt whatever chain
      // the wallet already reports instead of demanding it match ours.
      //
      // Solana home chain (900002): never switch MetaMask — custody is Phantom.
      const targetChain = getSelectedChainId();
      if (nativeSolanaDashLocked() || targetChain === 900_002) {
        if (!nativeSolanaDashLocked()) setSelectedChainId(900_002);
      } else if (info.isReconnect && info.chainId !== undefined && NETWORKS[info.chainId]) {
        setSelectedChainId(info.chainId);
      } else {
        try {
          await switchWalletNetwork(eth, targetChain);
          if (!connectionIsCurrent()) throw new Error('Wallet connection changed while connecting. Please retry.');
        } catch (switchError: unknown) {
          const errorMessage = switchError instanceof Error ? switchError.message : 'Failed to switch network';
          throw new Error(errorMessage);
        }
      }

      const signerSetup = this.signerRefreshQueue.catch(() => undefined).then(async () => {
        if (!connectionIsCurrent()) throw new Error('Wallet connection changed while connecting. Please retry.');
        await this.signerLifecycle.initialize(eth, true);
        if (!connectionIsCurrent()) throw new Error('Wallet connection changed while connecting. Please retry.');
      });
      this.signerRefreshQueue = signerSetup;
      await signerSetup;

      const finalAccounts = await eth.request({ method: 'eth_accounts' }) as string[];
      if (!connectionIsCurrent() || !finalAccounts.length) {
        throw new Error('Wallet connection changed while connecting. Please retry.');
      }
      const address = finalAccounts[0] ?? info.address;
      const wallet: WalletInfo = {
        id: 'evm',
        name: info.name,
        address,
        chain: 'EVM',
        connected: true
      };

      // A deliberate connect is fresh consent: if this wallet previously declined any signature
      // we stopped asking, and reconnecting is how the user asks us to ask again.
      void import('@/lib/walletSignatureGate')
        .then((m) => m.clearSignatureDeclines(address))
        .catch(() => undefined);

      this.connectedWallets.set('evm', wallet);
      this.persistWallet(wallet);
      return { success: true, wallet };
    } catch (error: unknown) {
      this.accountChangeGeneration++;
      const current = (window as Window & { ethereum?: unknown }).ethereum;
      // Same guard as the set above: deleting a non-configurable global throws in strict mode,
      // and throwing HERE would replace the real failure with a misleading one.
      if (current === eth) {
        try {
          delete (window as Window & { ethereum?: unknown }).ethereum;
        } catch {
          /* not ours to remove */
        }
      }
      if (this.currentEvmProvider === eth) {
        this.currentEvmProvider = null;
        setActiveEvmProvider(null);
      }
      const cleanup = this.signerRefreshQueue.catch(() => undefined).then(() => (
        this.signerLifecycle.deinitialize()
      ));
      this.signerRefreshQueue = cleanup;
      await cleanup;
      return { success: false, error: error instanceof Error ? error.message : 'Failed to connect wallet' };
    }
  }

  async connectBitcoin(): Promise<WalletConnectionResult> {
    try {
      // Check if a Bitcoin wallet is available (e.g., Xverse, Unisat, etc.)
      const bitcoinWallet = (window as Window & { unisat?: unknown })?.unisat;
      if (!bitcoinWallet) {
        return { success: false, error: 'Bitcoin wallet not detected. Please install a Bitcoin wallet like Unisat or Xverse.' };
      }

      const accounts = await (bitcoinWallet as { requestAccounts: () => Promise<string[]> }).requestAccounts();
      if (accounts.length === 0) {
        return { success: false, error: 'No Bitcoin accounts found' };
      }

      const address = accounts[0];
      const wallet: WalletInfo = {
        id: 'bitcoin',
        name: 'Bitcoin',
        address,
        chain: 'Bitcoin',
        connected: true
      };

      this.connectedWallets.set('bitcoin', wallet);
      return { success: true, wallet };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to connect Bitcoin wallet' };
    }
  }

  async connectMonero(): Promise<WalletConnectionResult> {
    try {
      // Monero wallet connection would typically require a different approach
      // For now, we'll simulate a connection
      const address = 'Monero address would be generated here';
      
      const wallet: WalletInfo = {
        id: 'xmr',
        name: 'Monero',
        address,
        chain: 'Monero',
        connected: true
      };

      this.connectedWallets.set('xmr', wallet);
      return { success: true, wallet };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to connect Monero wallet' };
    }
  }

  /** Register Phantom / Solana as the primary session (Devnet product path). */
  adoptSolanaWallet(info: { address: string; name?: string }): WalletConnectionResult {
    const wallet: WalletInfo = {
      id: 'solana',
      name: info.name || 'Phantom',
      address: info.address,
      chain: 'Solana',
      connected: true,
    };
    this.connectedWallets.set('solana', wallet);
    this.persistWallet(wallet);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('walletConnected'));
    }
    return { success: true, wallet };
  }

  async connectWallet(walletId: string): Promise<WalletConnectionResult> {
    switch (walletId) {
      // 'evm' is connected via RainbowKit's modal (see ConnectButton) → adoptEvmWallet(), not here.
      case 'bitcoin':
        return this.connectBitcoin();
      case 'xmr':
        return this.connectMonero();
      default:
        return { success: false, error: 'Unknown wallet type' };
    }
  }

  disconnectWallet(walletId: string): void {
    if (walletId === 'solana') {
      this.connectedWallets.delete('solana');
      if (this.getConnectedWallets().length === 0) this.clearPersistedWallet();
      return;
    }
    if (walletId === 'evm') {
      this.sessionGeneration++;
      this.accountChangeGeneration++;
      const provider = (window as Window & { ethereum?: unknown }).ethereum;
      // Best-effort, like the set: a non-configurable global throws on delete in strict mode.
      if (provider === this.currentEvmProvider) {
        try {
          delete (window as Window & { ethereum?: unknown }).ethereum;
        } catch {
          /* another extension owns the global */
        }
      }
      this.currentEvmProvider = null;
      setActiveEvmProvider(null);
      this.signerRefreshQueue = this.signerRefreshQueue.catch(() => undefined).then(() => (
        this.signerLifecycle.deinitialize()
      ));
      // Best-effort: tell wagmi's connector to actually disconnect too, so its own state doesn't
      // silently drift out of sync with ours (e.g. reconnecting on next reload). Fire-and-forget —
      // this cleanup must never block on a wallet/relay that isn't responding.
      void this.evmDisconnectTrigger?.().catch((error) => {
        console.error('Error disconnecting EVM wallet connector:', error);
      });
    }
    this.connectedWallets.delete(walletId);
    if (this.getConnectedWallets().length === 0) {
      this.clearPersistedWallet();
    }
  }

  getConnectedWallets(): WalletInfo[] {
    return Array.from(this.connectedWallets.values());
  }

  getWallet(walletId: string): WalletInfo | undefined {
    return this.connectedWallets.get(walletId);
  }

  isWalletConnected(walletId: string): boolean {
    return this.connectedWallets.has(walletId);
  }

  getPrimaryWallet(): WalletInfo | undefined {
    // Return the first connected wallet as primary
    return this.getConnectedWallets()[0];
  }
}

export const walletManager = new WalletManager();

/** @see WalletManager.getEvmProvider — never fall back to window.ethereum. */
export function getEvmProvider(): EthereumLikeProvider | null {
  return walletManager.getEvmProvider();
}
