// replaced original nexus handler code with ethers.js implementation
import { ethers, BrowserProvider, Signer, Contract, formatUnits, parseUnits, Eip1193Provider } from 'ethers';
import { getSelectedChainId, getNetwork, getTokens } from './networks';

// --- State Variables ---
let provider: BrowserProvider | null = null;
let signer: Signer | null = null;

// --- ABIs and Token Definitions ---
// Minimal ERC20 ABI for balance_of and transfer
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

// Minimal ERC20 ABI for allowance and approve
const ERC20_ABI_ALLOWANCE = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// Token map is now per-chain (ETH + that chain's USDC), sourced from the network registry.
export function getTokenMap(): { [key: string]: { address: string; decimals: number; symbol: string } } {
  return getTokens();
}
// Back-compat alias for modules/components that import a static TOKEN_MAP — resolves to the
// active chain's tokens at access time via a Proxy.
export const TOKEN_MAP: { [key: string]: { address: string; decimals: number; symbol: string } } =
  new Proxy({}, {
    get: (_t, prop: string) => getTokenMap()[prop],
    ownKeys: () => Reflect.ownKeys(getTokenMap()),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    has: (_t, prop: string) => prop in getTokenMap(),
  }) as { [key: string]: { address: string; decimals: number; symbol: string } };


// --- Exportable Helper Functions ---

export function getProvider(): BrowserProvider | null {
  return provider;
}

export function getSigner(): Signer | null {
  return signer;
}

export function isInitialized(): boolean {
  return !!signer;
}

// --- Core Functions ---

// Initialize the ethers provider and signer from a browser wallet
export async function initializeWithProvider(eip1193Provider: Eip1193Provider, force = false) {
  if (!eip1193Provider) {
    throw new Error('No EIP-1193 provider (e.g., MetaMask) found'); 
  }
  if (!force && isInitialized()) return;

  try {
    // Null out module state BEFORE destroy so any in-flight calls see "not initialized"
    // rather than crashing with UNSUPPORTED_OPERATION on the destroyed provider.
    provider = null;
    signer = null;

    const chainId = getSelectedChainId();
    const network = ethers.Network.from(chainId);
    const newProvider = new ethers.BrowserProvider(eip1193Provider, network, { staticNetwork: true });
    newProvider.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('network changed') || (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'NETWORK_ERROR')) {
        return;
      }
      console.warn('[ethers]', msg);
    });
    provider = newProvider;

    // getSigner() is NOT passive. ethers' BrowserProvider.getSigner() fires eth_requestAccounts
    // whenever the provider reports no authorised account (see ethers provider-browser.js), and
    // that is a wallet approval popup. Most callers here are background paths — session restore,
    // balance refresh, retry loops — so the popup surfaces with no user gesture at all, from a
    // background tab, for whichever extension currently owns the provider. Probe eth_accounts,
    // which is silent, and refuse rather than prompt. Prompting is only ever legitimate inside a
    // user-initiated connect flow, which the wallet connector owns.
    const authorised = await eip1193Provider.request({ method: 'eth_accounts' })
      .catch(() => []) as string[] | undefined;
    if (!authorised?.length) {
      provider = null;
      throw new Error('Wallet is not connected — connect a wallet before initialising the signer.');
    }

    // The probe above is NOT enough on its own. `provider.getSigner()` re-asks for the account
    // list through ethers' own `send()` (BrowserProvider.hasSigner), and when a wallet shim
    // answers that differently from the raw `request()` we just made, ethers falls straight
    // through to `eth_requestAccounts` — the popup the probe exists to avoid. With more than one
    // wallet installed that request can land on an extension the user never picked, which
    // auto-denies it (`code: 4001, cause: "rejectAllApprovals"`) and fails the whole connect.
    //
    // Build the signer directly for the address the probe already authorised. This is what
    // getSigner() does once hasSigner() passes, minus the second account lookup.
    const account = ethers.getAddress(authorised[0]);
    try {
      signer = new ethers.JsonRpcSigner(provider, account);
    } catch (signerErr) {
      if (_isSwitchingNetwork(signerErr)) {
        await new Promise(r => setTimeout(r, 300));
        signer = new ethers.JsonRpcSigner(provider, account);
      } else {
        throw signerErr;
      }
    }
    console.log("Ethers initialized with signer:", await signer.getAddress());

    // Recover any deposit temp hints left from a page refresh between mining and writeNote.
    import('./localNoteStore').then(m => m.recoverPendingHints(signer!)).catch(e =>
      console.warn('[recovery] recoverPendingHints failed (best-effort):', e)
    );

    // Re-hydrate the user's notes from the server on connect so a fresh device / cleared cache
    // restores spendable notes. Use fetchCommitments — which reads Supabase directly when the
    // NEXT_PUBLIC_SUPABASE_* env is set on the client and OTHERWISE FALLS BACK to the trade-executor
    // — so this works regardless of whether that client env is configured. (The old code used the
    // raw Supabase endpoint only, so it silently no-op'd when that env was absent → funds looked
    // gone after a cache clear even though the server had them.)
    const _signer = signer!;
    (async () => {
      const { fetchCommitments } = await import('./commitmentStore');
      const { writeNote } = await import('./localNoteStore');
      const { getSelectedChainId } = await import('./networks');
      const chainId = getSelectedChainId();

      const commits = await fetchCommitments(_signer);

      // Only re-hydrate notes that are actually leaves in the CURRENT vault. Notes deposited to a
      // superseded entrypoint (e.g. 0xE0bbD38d) re-hydrate as unspendable "ghosts" and clutter the
      // balance — skip them so the wallet shows a clean, spendable slate. Filtered notes stay on the
      // server, so this is non-destructive (they'd return if the vault ever recognised them).
      const { getLeafSet } = await import('./zkHandler');
      const { getTokens } = await import('./networks');
      const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
      const leafSets = new Map<string, Set<string> | null>();
      const leafSetFor = async (symbol: string, cid: number): Promise<Set<string> | null> => {
        const k = `${cid}:${symbol.toUpperCase()}`;
        if (leafSets.has(k)) return leafSets.get(k) ?? null;
        const addr = symbol.toUpperCase() === 'ETH' ? NATIVE : getTokens(cid)[symbol.toUpperCase()]?.address;
        let set: Set<string> | null = null;
        try { if (addr) set = await getLeafSet(addr, cid); } catch { set = null; }
        leafSets.set(k, set);
        return set;
      };

      let synced = 0;
      let skippedGhost = 0;
      for (const c of commits) {
        try {
          if (c.spent === 'true') continue;
          const d = c.decrypted;
          if (!d.commitment || !d.nullifier || !d.secret) continue;
          const cid = d.chainId ?? chainId;
          // Skip old-vault / dust notes — only filter when the leaf scan actually succeeded
          // (non-null with entries) so a flaky scan can never drop a genuine current-vault note.
          const set = await leafSetFor(c.asset, cid);
          if (set && set.size > 0 && !set.has(String(d.commitment))) { skippedGhost++; continue; }
          const noteKey = `${cid}-${c.asset}-${d.commitment}`;
          const existing = localStorage.getItem(noteKey);
          const readable = existing
            ? (() => { try { return !!JSON.parse(existing).nullifier_enc; } catch { return false; } })()
            : false;
          if (readable) continue; // already spendable locally
          await writeNote(noteKey, {
            nullifier:     d.nullifier,
            secret:        d.secret,
            commitment:    d.commitment,
            precommitment: d.precommitment,
            nullifierHash: d.nullifierHash,
            amount:        d.amount,
            spent:         false,
          }, _signer);
          synced++;
        } catch { /* skip rows that fail to decrypt */ }
      }
      console.log(`[sync] Re-hydrated ${synced} spendable note(s), skipped ${skippedGhost} old-vault/dust (of ${commits.length} server commitments)`);

      // Also rebuild any pending vault-output notes (TWAP/grid swap outputs) from the server.
      try {
        const { resolvePendingOutputNotes } = await import('./outputNoteResolver');
        const n = await resolvePendingOutputNotes(_signer);
        if (n > 0) console.log(`[sync] Recovered ${n} pending output note(s)`);
      } catch (e) { console.warn('[sync] output-note recovery failed:', e); }
    })().catch(e => console.warn('[sync] server note re-hydration failed:', e));
  } catch (error) {
    provider = null;
    signer = null;
    if (_isSwitchingNetwork(error)) {
      console.warn("[nexus] provider init deferred — wallet is switching networks");
      return;
    }
    console.error("Failed to initialize ethers provider:", error);
    throw error;
  }
}

/** Re-create the provider/signer after the wallet switches chains. */
/**
 * True when the live provider is already on `chainId` — so callers can skip a rebuild.
 *
 * refreshProvider() calls deinit(), and deinit() calls provider.destroy(), which CANCELS EVERY
 * REQUEST IN FLIGHT on it. A background balance refresh therefore killed the `personal_sign` a
 * withdrawal was waiting on, surfacing as "provider destroyed; cancelled request" AFTER the user
 * had already approved everything. Rebuild only when the chain actually moved.
 *
 * Returns false when the provider is missing or the chain cannot be read — the caller then
 * rebuilds, which is the old behaviour and the safe direction to be wrong in.
 */
export async function providerIsOnChain(chainId: number): Promise<boolean> {
  try {
    if (!provider) return false;
    const net = await provider.getNetwork();
    return Number(net.chainId) === Number(chainId);
  } catch {
    return false;
  }
}

export async function refreshProvider(eip1193Provider: Eip1193Provider) {
  await deinit();
  await initializeWithProvider(eip1193Provider, true);
}

// Deinitialize the provider and signer.
export async function deinit() {
  const stale = provider;
  provider = null;
  signer = null;
  try { stale?.destroy?.(); } catch { /* ignore */ }
  console.log("Ethers de-initialized.");
}

// --- ERC20 Allowance Functions ---

export async function getTokenAllowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
  if (!provider) {
    throw new Error('Ethers provider not initialized.');
  }
  const tokenContract = new Contract(tokenAddress, ERC20_ABI_ALLOWANCE, provider);
  return tokenContract.allowance(owner, spender);
}

export async function approveToken(tokenAddress: string, spender: string, amount: bigint): Promise<ethers.TransactionResponse> {
  if (!signer) {
    throw new Error('Ethers signer not initialized.');
  }
  const tokenContract = new Contract(tokenAddress, ERC20_ABI_ALLOWANCE, signer);
  return tokenContract.approve(spender, amount);
}

function _isSwitchingNetwork(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  return /network changed|provider destroyed|unsupported_operation|cancelled request/i.test(msg);
}

// Gets ETH and ERC20 balances for the connected wallet on the active network
export async function getUnifiedBalances(chainId?: number) {
  if (!signer || !provider) {
    // Silently return null during network switch — provider is being rebuilt.
    return null;
  }

  const targetChainId = chainId ?? getSelectedChainId();
  let walletNetwork;
  try {
    walletNetwork = await provider.getNetwork();
  } catch (err) {
    if (_isSwitchingNetwork(err)) return null;
    throw err;
  }
  if (Number(walletNetwork.chainId) !== targetChainId) {
    return [];
  }

  let address: string;
  try {
    address = await signer.getAddress();
  } catch (err) {
    if (_isSwitchingNetwork(err)) return null;
    throw err;
  }
  const balancePromises = [];

  // 1. Fetch Native ETH Balance
  balancePromises.push(
    provider.getBalance(address).then((balance) => ({
      symbol: 'ETH',
      balance: formatUnits(balance, 18),
      decimals: 18,
      balanceRaw: balance,
    })).catch((err: unknown) => {
      if (_isSwitchingNetwork(err)) return null;
      console.warn(`Could not fetch ETH balance: ${err instanceof Error ? err.message : err}`);
      return null;
    }),
  );

  // 2. Fetch ERC20 Balances (from TOKEN_MAP, -> skip ETH)
  for (const tokenSymbol in TOKEN_MAP) {
    if (tokenSymbol === 'ETH') continue;
    
    const tokenInfo = TOKEN_MAP[tokenSymbol];
    const tokenContract = new Contract(tokenInfo.address, ERC20_ABI, provider);
    
    balancePromises.push(
      tokenContract.balanceOf(address).then(balance => ({
        symbol: tokenInfo.symbol,
        balance: formatUnits(balance, tokenInfo.decimals),
        decimals: tokenInfo.decimals,
        balanceRaw: balance
      })).catch(err => {
        if (_isSwitchingNetwork(err)) return null;
        console.warn(`Could not fetch balance for ${tokenSymbol}: ${err instanceof Error ? err.message : err}`);
        return null;
      })
    );
  }

  // 3. Resolve all promises and format the output
  const results = (await Promise.all(balancePromises)).filter(b => b !== null); // Filter out any failed fetches

  // 4. Format to match the UnifiedBalances structure
  const unifiedBalances = results.map(bal => ({
    symbol: bal.symbol,
    balance: bal.balance,
    decimals: bal.decimals,
    // Breakdown reflects the active network (Eth Sepolia / Base Sepolia)
    breakdown: [
      {
        balance: bal.balance,
        chain: {
          id: targetChainId,
          logo: '',
          name: getNetwork(targetChainId).name
        },

        contractAddress: getTokenMap()[bal.symbol]?.address as `0x${string}`
      }
    ]
  }));

  return unifiedBalances;
}

// Transfers ETH or an ERC20 token on the same chain (Sepolia).

export async function transferTokens(tokenSymbol: string, amount: string, recipient: string) {
  console.log('transferTokens called with:', { tokenSymbol, amount, recipient });
  if (!signer) {
    console.error('SDK not initialized');
    return { success: false, error: 'Wallet not connected' };
  }

  try {
    const tokenInfo = TOKEN_MAP[tokenSymbol.toUpperCase()];
    if (!tokenInfo) {
      throw new Error(`Token not supported: ${tokenSymbol}`);
    }

    const parsedAmount = parseUnits(amount, tokenInfo.decimals);
    let tx;

    if (tokenSymbol.toUpperCase() === 'ETH') {
      // Native ETH transfer
      tx = await signer.sendTransaction({
        to: recipient,
        value: parsedAmount
      });
    } else {
      // ERC20 token transfer
      const tokenContract = new Contract(tokenInfo.address, ERC20_ABI, signer);
      tx = await tokenContract.transfer(recipient, parsedAmount);
    }

    console.log('Transaction sent:', tx.hash);
    await tx.wait(); // Wait for transaction to be mined
    console.log('Transaction confirmed:', tx.hash);

    return { success: true, transactionHash: tx.hash };

  } catch (error: unknown) {
    console.error('Transfer failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Transfer transaction failed'
    };
  }
}

export function getSiphonVaultTotalBalance(chainId: number, tokenMap: { [key: string]: { decimals: number } }): { totalBalance: number; details: { [token: string]: number } } {
  let totalBalance = 0;
  const details: { [token: string]: number } = {};

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;

    // Expected key format: `${chainId}-${tokenSymbol}-${commitment}`
    if (key.startsWith(`${chainId}-`)) {
      try {
        const parts = key.split('-');
        if (parts.length < 3) continue; // Not a valid siphon deposit key

        const tokenSymbol = parts[1];
        const data = JSON.parse(localStorage.getItem(key) || '{}');

        if (data && data.amount && !data.spent) {
          const tokenInfo = tokenMap[tokenSymbol.toUpperCase()];
          if (tokenInfo) {
            const amountInUnits = parseFloat(ethers.formatUnits(BigInt(ethers.parseUnits(data.amount, tokenInfo.decimals).toString()), tokenInfo.decimals));
            totalBalance += amountInUnits;
            details[tokenSymbol] = (details[tokenSymbol] || 0) + amountInUnits;
          } else {
            console.warn(`Token info not found for symbol: ${tokenSymbol}`);
          }
        }
      } catch (e) {
        console.warn(`Failed to parse local storage item with key ${key}:`, e);
      }
    }
  }

  return { totalBalance, details };
}