'use client';
import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore, type ChangeEvent } from 'react';
import { walletManager, WalletInfo } from '../../extensions/walletManager';
import { appendUserActivity } from '@/lib/userActivityLog';
import './UserDash.css';
import { deposit, withdraw, aggregateDepositScreeningTotals, getPrivateWithdrawCap, type PrivateWithdrawCap } from "../../../lib/handler";
import { TOKEN_MAP, getUnifiedBalances, getProvider, initializeWithProvider, isInitialized, deinit, getSigner, refreshProvider, providerIsOnChain } from '../../../lib/nexus';
import { getSpendableVaultBalance, getFreshLocalCheckingTotals, invalidateLeafCache } from '../../../lib/zkHandler';
import { resolvePendingOutputNotes } from '../../../lib/outputNoteResolver';
import { syncWalletNotesFromServer } from '../../../lib/localNoteStore';
import { buildV3NoteBackup, importV3NoteBackup } from '../../../lib/v3/noteBackupV3';
import ActivityLog from './ActivityLog';
import TrustPanel, { TrustNudge } from './TrustPanel';
import ApiKeysPanel from './ApiKeysPanel';
import { API_KEYS_COMING_SOON } from '../../../lib/apiKeysFlag';
import {
  getNetwork,
  getTokens,
  DEFAULT_CHAIN_ID,
  getSelectedChainId,
  setSelectedChainId,
  ADMIN_ONLY_CHAIN_IDS,
  selectChainAndSwitchWallet,
  installWalletChainSync,
} from '../../../lib/networks';
import { isAdminWallet } from '../../../lib/adminWallet';
import { showAppConfirm, showAppToast } from '../../../lib/appToast';
import { TRUST_TOS_EVENT } from '../../../lib/tosAcceptance';
import { isLevel1TrustComplete, LEVEL1_REQUIRED_MESSAGE } from '../../../lib/trustLevel1';
import { getStoredClientKey, restoreInFlight } from '../../../lib/fhe';
import { quoteWithdrawFee, solveWithdrawForExactReceive, formatFeeAmount, type FeeQuote } from '../../../lib/withdrawFee';
import { ethers } from 'ethers';
import { LEGACY_VAULTS, findLegacyMigrationNotes, migrateLegacyNotes, type LegacyMigrationSummary } from '../../../lib/legacyMigration';
import { isEncKeyCached } from '../../../lib/noteAuth';
import { v3Deployed } from '../../../lib/v3/configV3';
import { depositV3 } from '../../../lib/v3/depositV3';
import { syncV3FromServer, v3NoteKey } from '../../../lib/v3/noteStoreV3';
import { recordDepositOnCursor } from '../../../lib/v3/noteCursorSession';
import { displayAmount, toAmountString } from '@/lib/amountString';
import { withdrawViaV3 } from '../../../lib/v3/spendRouterV3';
import { invalidateStateLeavesCache } from '../../../lib/v3/stateLeavesClient';
import { getV3Balance } from '../../../lib/v3/balanceV3';
// STATIC, not await import(): this is a synchronous localStorage read, and a dynamic import makes
// it wait on a lazy chunk download — which is exactly the lag the optimistic paint exists to remove.
import { getLocalBalance } from '../../../lib/v3/localBalanceV3';
import { screeningTotals, spendableBalances } from '../../../lib/v3/screeningTotals';
import { getScreeningRows, invalidateScreening, refreshScreening, subscribeScreening } from '../../../lib/v3/screeningStore';
import { clearMemberCache } from '../../../lib/v3/aspClientV3';
import { friendlyTxError, ragequit, type DepositScreening } from '../../../lib/handler';
import { parseInsufficientFunds } from '../../../lib/v3/planWithdrawV3';
import { fetchWithdrawCredit, needsTopUp, formatCredit, topUpWithdrawCredit, type WithdrawCredit } from '../../../lib/v3/withdrawCreditV3';
import {
  getFheKeyState,
  getCachedServerKey,
  warmFheKeys,
  retryFheKeyUpload,
  FHE_KEYS_EVENT,
  type FheKeyState,
} from '../../../lib/fheKeyWarmup';
import { getTradeExecutorBaseUrl } from '../../../lib/tradeExecutorClient';
import { getProductChain, useProductChain } from '@/lib/chains/ChainModeContext';
import { isDevnetProduct } from '@/lib/chains/productGates';
import { listHomeChainOptions, nativeSolanaDashLocked, readHomeEdgeChainId, readStoredHomeChainId, resolveHomeChainOption, setNativeSolanaDashLock } from '@/lib/chains/homeChains';
import { bridgeMinUnits, bridgeDest, bridgeQuote, isBridgeVaultChain, isValidDestAddress, minOutFrom, pollBridgeOrder, type BridgeOrder, type BridgeOrderRequest } from '@/lib/bridge/hub';
import { FundFromChain, ReceiveOnFields } from './HubBridge';
import TempoEdgePanel from './TempoEdgePanel';
import { prepareSolanaFundForDeposit } from '@/lib/chains/solanaFundDeposit';
import {
  depositUsdcSolanaDevnet,
  depositWsolSolanaDevnet,
  fetchSolanaDevnetPrivateBalances,
  fetchSolanaDevnetWalletBalances,
  solToLamports,
} from '@/lib/chains/solanaVaultOnchain';
import {
  depositUsdcZk,
  depositWsolZk,
  isSolanaZkMode,
  withdrawZkSolana,
} from '@/lib/chains/solanaVaultZk';
import { sumUnspentPrivateBalancesBySymbol } from '@/lib/chains/solanaNoteStore';
import { formatPhantomNetworkError, getPhantom } from '@/lib/chains/solanaWallet';
import { usdcToBaseUnitsDevnet } from '@/lib/chains/devnetSolBridge';
import { SOLANA_DEVNET_CHAIN_ID } from '@/lib/chains/registry';
import { PublicKey, type Transaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';

function resolveTrustWallet(walletAddress: string | null | undefined): string | null {
  return walletAddress ?? walletManager.getPrimaryWallet()?.address ?? null;
}

type DashPage = 'overview' | 'trust' | 'backup' | 'api-keys';

function SwitchChainIcon() {
  return (
    <svg className="userdash-card-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h13M14 5l3 3-3 3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 16H7M10 13l-3 3 3 3" />
    </svg>
  );
}

function ChainLockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="6" y="11" width="12" height="8.5" rx="1.5" />
      <path strokeLinecap="round" d="M8.5 11V8.2a3.5 3.5 0 0 1 7 0V11" />
    </svg>
  );
}

function InfoTip({
  id,
  text,
  open,
  onToggle,
}: {
  id: string;
  text: string;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <span className="userdash-info">
      <button
        type="button"
        className={`userdash-info-btn userdash-info-btn--letter${open ? ' active' : ''}`}
        aria-label="More info"
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        i
      </button>
      {open ? (
        <span className="userdash-info-pop" role="note">
          {text}
        </span>
      ) : null}
    </span>
  );
}

const ICON_EXPORT = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
const ICON_IMPORT = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
const ICON_CLIENT_KEY = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);
const ICON_SERVER_KEY = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);
const ICON_KEY = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />
  </svg>
);
const ICON_BUSY = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="userdash-icon-spin">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);
const ICON_CHECK = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function KeysPlusNotes({
  tipIdPrefix,
  openTip,
  toggleTip,
  isNotesBusy,
  onExportNotes,
  onImportNotes,
  importInputId,
  fheState,
  fheClientKey,
  fheServerKey,
  fheCopied,
  onCopyFheKey,
  onGenerateKeys,
}: {
  tipIdPrefix: string;
  openTip: string | null;
  toggleTip: (id: string) => void;
  isNotesBusy: boolean;
  onExportNotes: () => void;
  onImportNotes: (e: ChangeEvent<HTMLInputElement>) => void;
  importInputId: string;
  fheState: FheKeyState;
  fheClientKey: { preview: string; bytes: number } | null;
  fheServerKey: { preview: string; bytes: number } | null;
  fheCopied: 'client' | 'server' | null;
  onCopyFheKey: (which: 'client' | 'server') => void;
  onGenerateKeys: () => void;
}) {
  const notesTip = `${tipIdPrefix}-notes`;
  const fheTip = `${tipIdPrefix}-fhe`;
  const keysReady = Boolean(fheClientKey && fheServerKey);
  const showGenerate = !keysReady && (fheState.stage === 'idle' || fheState.stage === 'error');
  const fheStatus =
    fheState.stage === 'generating' ? 'Generating…'
      : fheState.stage === 'deriving' ? 'Deriving…'
      : fheState.stage === 'uploading' ? 'Sync'
      : fheState.stage === 'error' ? 'Unavailable'
      : keysReady ? 'Ready'
      : 'Pending';

  return (
    <div className="userdash-keysplusnotes">
      <div className="userdash-notes-card userdash-keysplusnotes-block">
        <div className="userdash-balance-header">
          <h2 className="userdash-balance-title">Private Notes</h2>
          <InfoTip
            id={notesTip}
            open={openTip === notesTip}
            onToggle={toggleTip}
            text="Export or import encrypted ZK deposit receipts tied to your wallet. Use this to back up notes or restore them on another device."
          />
        </div>
        <div className="userdash-notes-actions userdash-keysplusnotes-actions">
          <button
            type="button"
            className="userdash-notes-button userdash-notes-button--compact userdash-notes-button--primary"
            onClick={onExportNotes}
            disabled={isNotesBusy}
            title={isNotesBusy ? 'Working…' : 'Export notes'}
          >
            {isNotesBusy ? ICON_BUSY : ICON_EXPORT}
            <span>Export</span>
          </button>
          <input
            type="file"
            accept=".json"
            onChange={onImportNotes}
            className="userdash-notes-file-input"
            id={importInputId}
            disabled={isNotesBusy}
          />
          <label
            htmlFor={importInputId}
            className={`userdash-notes-button userdash-notes-button--compact userdash-notes-button--secondary${isNotesBusy ? ' userdash-notes-button--disabled' : ''}`}
            title={isNotesBusy ? 'Working…' : 'Import notes'}
          >
            {ICON_IMPORT}
            <span>Import</span>
          </label>
        </div>
      </div>

      <div className="userdash-notes-card userdash-fhe-card userdash-keysplusnotes-block">
        <div className="userdash-balance-header">
          <h2 className="userdash-balance-title">FHE Keys</h2>
          <span className="userdash-header-end">
            <span className={`userdash-fhe-status userdash-fhe-status--${fheState.stage}`}>
              {fheStatus}
            </span>
            <InfoTip
              id={fheTip}
              open={openTip === fheTip}
              onToggle={toggleTip}
              text="Generated on wallet connect. Client key stays on this device; server key enables private order execution."
            />
          </span>
        </div>
        <div className="userdash-notes-actions userdash-keysplusnotes-actions">
          <button
            type="button"
            className={`userdash-notes-button userdash-notes-button--compact userdash-notes-button--secondary userdash-fhe-action${fheCopied === 'client' ? ' userdash-fhe-action--copied' : ''}`}
            onClick={() => onCopyFheKey('client')}
            disabled={!fheClientKey}
            title={fheCopied === 'client' ? 'Copied client key' : 'Copy client key'}
          >
            {fheCopied === 'client' ? ICON_CHECK : ICON_CLIENT_KEY}
            <span>{fheCopied === 'client' ? 'Copied' : 'Client'}</span>
          </button>
          <button
            type="button"
            className={`userdash-notes-button userdash-notes-button--compact userdash-notes-button--secondary userdash-fhe-action${fheCopied === 'server' ? ' userdash-fhe-action--copied' : ''}`}
            onClick={() => onCopyFheKey('server')}
            disabled={!fheServerKey}
            title={fheCopied === 'server' ? 'Copied server key' : 'Copy server key'}
          >
            {fheCopied === 'server' ? ICON_CHECK : ICON_SERVER_KEY}
            <span>{fheCopied === 'server' ? 'Copied' : 'Server'}</span>
          </button>
          {showGenerate ? (
            <button
              type="button"
              className="userdash-notes-button userdash-notes-button--compact userdash-notes-button--primary"
              onClick={onGenerateKeys}
              title="Generate keys now"
            >
              {ICON_KEY}
              <span>Generate</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function subscribeMobileLayout(onChange: () => void) {
  const mq = window.matchMedia('(max-width: 720px)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getMobileLayoutSnapshot() {
  return window.matchMedia('(max-width: 720px)').matches;
}

function useMobileLayout() {
  return useSyncExternalStore(subscribeMobileLayout, getMobileLayoutSnapshot, () => false);
}

interface UnifiedBalance {
  symbol: string;
  balance: string;
  decimals: number;
}

interface UserDashProps {
  isLoaded?: boolean;
  walletConnected: boolean;
}

type BalanceSplit = {
  deposited: Record<string, number>;
  checking: Record<string, number>;
  flagged: Record<string, number>;
  ts: number;
};

function isPrivateBalanceToken(symbol: string, solanaMode: boolean): boolean {
  return solanaMode
    ? symbol === 'SOL' || symbol === 'USDC' || symbol === 'jlUSDC' || symbol === 'JitoSOL'
    : symbol === 'ETH' || symbol === 'USDC';
}

function privateBalanceSort(a: string, b: string, solanaMode: boolean): number {
  const primary = solanaMode ? 'SOL' : 'ETH';
  if (a === primary) return -1;
  if (b === primary) return 1;
  if (a === 'USDC' && b === 'jlUSDC') return -1;
  if (a === 'jlUSDC' && b === 'USDC') return 1;
  if (a === 'SOL' && b === 'JitoSOL') return -1;
  if (a === 'JitoSOL' && b === 'SOL') return 1;
  return 0;
}

/**
 * The persisted balance-split cache is GONE on purpose.
 *
 * It was painted as chain-VERIFIED before any network call, and carried forward whenever a symbol
 * landed in `skipped`, so one bad write became permanent: a pre-fix build wrote 1.979 ETH for a
 * generation whose vault has only ever received 0.057 ETH in total, and no later correct scan could
 * dislodge it. A remembered number that outranks the chain is worse than no number — "verifying"
 * is honest, a stale balance is not.
 *
 * The legacy sessionStorage key was worse still: it was keyed by chainId ONLY, so it transplanted
 * one wallet's figure onto the next wallet connected in the same tab.
 */
const BALANCE_CACHE_PURGED = 'siphon-balance-split-purged-v1';
function purgeLegacyBalanceCache(): void {
  if (typeof window === 'undefined') return;
  try {
    if (localStorage.getItem(BALANCE_CACHE_PURGED)) return;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('siphon-balance-split-v')) localStorage.removeItem(k);
    }
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith('siphon-balance-split-v')) sessionStorage.removeItem(k);
    }
    localStorage.setItem(BALANCE_CACHE_PURGED, '1');
  } catch { /* quota / disabled storage */ }
}

function overlayFreshChecking(split: BalanceSplit, chainId: number): BalanceSplit {
  if (typeof window === 'undefined') return split;
  const fresh = getFreshLocalCheckingTotals(chainId);
  const deposited = { ...split.deposited };
  const checking = { ...split.checking };
  for (const sym of ['ETH', 'USDC']) {
    const amt = fresh[sym] ?? 0;
    if (amt <= 0) continue;
    // In-flight / just-mined deposits: surface them in the PENDING row only.
    // Deliberately does not subtract from deposited any more: `deposited` is now sourced solely
    // from the on-chain reconcile, and clawing an already-admitted note back out of it is what made
    // the two rows permanently disagree.
    // ponytail: a note admitted before FRESH_MS elapses can appear in both rows for the remainder
    // of the window. Harmless (deposited stays authoritative and the guard reads neither), and the
    // exact fix needs per-note leaf membership in this component.
    checking[sym] = Math.max(checking[sym] ?? 0, amt);
  }
  return { ...split, deposited, checking };
}

export default function UserDash({ isLoaded = true, walletConnected }: UserDashProps) {
  const {
    chain: productChain,
    isSolana,
    setChainId: setProductChainId,
    solanaSession,
    connectSolana,
  } = useProductChain();
  const isDevnetEnv = isDevnetProduct(productChain);
  const isMainnetEnv = !isDevnetEnv;
  const mainnetLocked = isSolana && !listHomeChainOptions().some((option) => option.id === 'solana-mainnet');
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [walletBalances, setWalletBalances] = useState<UnifiedBalance[] | null>(null);
  const [siphonVaultBalances, setSiphonVaultBalances] = useState<{ [token: string]: number } | null>(null);
  const [siphonCheckingBalances, setSiphonCheckingBalances] = useState<{ [token: string]: number }>({});
  const [siphonFlaggedBalances, setSiphonFlaggedBalances] = useState<{ [token: string]: number }>({});
  // Per-note ASP screening from the shared store (loadV3Notes + statusByLabelV3), which
  // asks the ASP for real admitted/revoked membership. This REPLACES the old age heuristic as the
  // source of the In Review figure: that one scanned the `siphon-note-` prefix, so it matched no
  // v3 note at all (they are keyed `siphon-v3note-`) and In Review never rendered on Base — a
  // fresh deposit went straight into the headline balance and read as instantly admitted.
  const [screenRows, setScreenRows] = useState<DepositScreening[]>([]);
  const [rqBusyKey, setRqBusyKey] = useState<string | null>(null);
  // Notes whose Supabase backup FAILED and are queued for retry (backup:'pending'). Surfaced so the
  // user knows a note isn't durably backed up yet; clears when the retry queue / up-sync confirms it.
  const [pendingBackups, setPendingBackups] = useState<number>(0);
  // true = balance confirmed against the chain; false = shown from encrypted backup because RPC
  // couldn't verify.
  //
  // Kept SEPARATE from localRead below, because they answer different questions and conflating
  // them is what made an empty wallet say "Checking for notes…" forever: balanceVerified is about
  // the CHAIN, localRead is about whether we have looked at all.
  const [balanceVerified, setBalanceVerified] = useState<boolean>(true);
  /** The local note read completed — an empty result is then a real "no notes", not "still looking". */
  const [localRead, setLocalRead] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState(false);
  // Transient status label shown on the action button during multi-step flows (e.g. the
  // "Consolidating notes…" phase of a fragmented withdrawal). null = use the default label.
  const [withdrawStatus, setWithdrawStatus] = useState<string | null>(null);
  const [isDepositMode, setIsDepositMode] = useState(true);
  const [openTip, setOpenTip] = useState<string | null>(null);
  const [isNotesBusy, setIsNotesBusy] = useState(false);
  const [isMigrationBusy, setIsMigrationBusy] = useState(false);
  const [migrationStatus, setMigrationStatus] = useState<string | null>(null);
  const [legacySummary, setLegacySummary] = useState<LegacyMigrationSummary | null>(null);
  const [isVaultRefreshing, setIsVaultRefreshing] = useState(false);
  const vaultBalanceGen = useRef(0);
  /**
   * Live mirror of what the balance card is currently showing.
   *
   * A ref, not the state value: fetchVaultBalances is a useCallback whose deps deliberately exclude
   * the balances (adding them would rebuild the callback on every paint and restart the polling
   * effect), so reading the state directly inside it would see whatever was current when the
   * callback was built. The guard in applySplit needs the CURRENT figure to decide whether an
   * empty reconcile would erase a real one.
   */
  const shownFundsRef = useRef<{ deposited: Record<string, number>; checking: Record<string, number> }>({
    deposited: {},
    checking: {},
  });
  const walletBalanceGen = useRef(0);
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false);
  const [activeChainId, setActiveChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [switchingChain, setSwitchingChain] = useState(false);
  const [dashPage, setDashPage] = useState<DashPage>('overview');
  const isMobileLayout = useMobileLayout();
  // Bumps when Trust L1 changes so we re-read localStorage (never cache level1Ok in state).
  const [trustEpoch, setTrustEpoch] = useState(0);
  // Withdrawal fee: "send" = amount is what leaves the pool (recipient gets amount − fee);
  // "receive" = amount is what the recipient should get (pool deducts amount + fee).
  const [withdrawMode, setWithdrawMode] = useState<'send' | 'receive'>('send');
  const [feeQuote, setFeeQuote] = useState<FeeQuote | null>(null);
  // Relay fee (v3): the kernel has no fee module, so the relayer charges from a prepaid balance.
  // null = unknown/unreachable, which must read as "no fee shown" and never block the exit.
  const [withdrawCredit, setWithdrawCredit] = useState<WithdrawCredit | null>(null);
  const [toppingUp, setToppingUp] = useState(false);
  const [feeQuoting, setFeeQuoting] = useState(false);
  const [withdrawCap, setWithdrawCap] = useState<PrivateWithdrawCap | null>(null);
  const activeNetwork = getNetwork(activeChainId);
  // Bridge vaults (Base, Arbitrum): a withdraw can land on another chain (LI.FI via the executor).
  // null = this vault's own chain, i.e. a plain withdraw.
  const [receiveOn, setReceiveOn] = useState<number | null>(null);
  const [bridgeOrder, setBridgeOrder] = useState<BridgeOrder | null>(null);
  const [homeEdge, setHomeEdge] = useState<number | null>(null);
  const onHub = isBridgeVaultChain(activeChainId) && !isSolana;
  const isAdmin = isAdminWallet(wallet?.address);
  const toggleTip = (id: string) => setOpenTip((cur) => (cur === id ? null : id));

  useEffect(() => {
    if (!openTip) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node | null;
      const el = target instanceof Element ? target : target?.parentElement;
      if (el?.closest('.userdash-info')) return;
      setOpenTip(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [openTip]);

  useEffect(() => {
    const bump = () => setTrustEpoch((n) => n + 1);
    window.addEventListener(TRUST_TOS_EVENT, bump);
    window.addEventListener('walletConnected', bump);
    window.addEventListener('walletDisconnected', bump);
    return () => {
      window.removeEventListener(TRUST_TOS_EVENT, bump);
      window.removeEventListener('walletConnected', bump);
      window.removeEventListener('walletDisconnected', bump);
    };
  }, []);

  useEffect(() => {
    if (!isMobileLayout && dashPage === 'backup') setDashPage('overview');
  }, [isMobileLayout, dashPage]);

  // Re-read L1 from localStorage whenever wallet / chain / Trust accept / tab changes (KYT is per chain).
  const level1Ok = useMemo(
    () => isLevel1TrustComplete(resolveTrustWallet(wallet?.address)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the inputs are localStorage; these are the triggers
    [wallet?.address, trustEpoch, dashPage, activeChainId],
  );

  // Anti-stranding: chain selection persists in localStorage, so a non-admin whose stored chain is
  // admin-only (e.g. switched wallets, or was previously admin) would load onto a hidden chain with
  // no toggle to leave. Force them back to the default when that happens.
  useEffect(() => {
    if (wallet?.address && !isAdmin && ADMIN_ONLY_CHAIN_IDS.includes(activeChainId)) {
      handleSelectChain(DEFAULT_CHAIN_ID);
    }
  }, [isAdmin, activeChainId, wallet?.address]);
  // FHE keys (generated at wallet connect by TeeClientKeySync → warmFheKeys). Only truncated
  // previews + sizes are held in state — never the full ~23MB server key string.
  const [fheState, setFheState] = useState<FheKeyState>(() => getFheKeyState());
  const [fheClientKey, setFheClientKey] = useState<{ preview: string; bytes: number } | null>(null);
  const [fheServerKey, setFheServerKey] = useState<{ preview: string; bytes: number } | null>(null);
  const [fheRetryBusy, setFheRetryBusy] = useState(false);
  const [fheCopied, setFheCopied] = useState<'client' | 'server' | null>(null);
  const fheCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const executorBaseUrl = getTradeExecutorBaseUrl();

  useEffect(() => {
    const addr = wallet?.address;
    if (!addr) { setFheClientKey(null); setFheServerKey(null); return; }
    let cancelled = false;
    const trunc = (k: string) => `${k.slice(0, 26)}…${k.slice(-12)}`;
    const refresh = async () => {
      setFheState(getFheKeyState());
      const ck = getStoredClientKey(addr);
      if (!cancelled) setFheClientKey(ck ? { preview: trunc(ck), bytes: Math.floor(ck.length / 2) } : null);
      const sk = await getCachedServerKey(addr).catch(() => null);
      if (!cancelled) setFheServerKey(sk ? { preview: trunc(sk), bytes: Math.floor(sk.length / 2) } : null);
      // Client key present but no server key = the connect-time warmup never ran (it waits on the
      // onboarding guide and gives up after 10 min). Deriving the server key needs no signature,
      // so finish it here instead of leaving the card on "Not generated yet" with no button.
      if (!cancelled && ck && !sk && getFheKeyState().stage === 'idle') {
        void warmFheKeys(addr).catch(() => {});
      }
    };
    void refresh();
    const onKeys = () => { void refresh(); };
    window.addEventListener(FHE_KEYS_EVENT, onKeys);
    return () => { cancelled = true; window.removeEventListener(FHE_KEYS_EVENT, onKeys); };
  }, [wallet?.address]);

  const handleRetryFheUpload = useCallback(async () => {
    if (!wallet?.address) return;
    setFheRetryBusy(true);
    try {
      await retryFheKeyUpload(wallet.address);
      showAppToast('FHE server key uploaded to executor', 'success');
    } catch (e) {
      showAppToast(
        `Executor upload failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        'error',
      );
    } finally {
      setFheRetryBusy(false);
    }
  }, [wallet?.address]);

  const flashFheCopied = useCallback((which: 'client' | 'server') => {
    if (fheCopiedTimer.current) clearTimeout(fheCopiedTimer.current);
    setFheCopied(which);
    fheCopiedTimer.current = setTimeout(() => {
      setFheCopied(null);
      fheCopiedTimer.current = null;
    }, 1400);
  }, []);

  const copyFheKey = useCallback(async (which: 'client' | 'server') => {
    if (!wallet?.address) return;
    if (which === 'client' && !getStoredClientKey(wallet.address)) {
      await restoreInFlight(wallet.address);
    }
    const val = which === 'client'
      ? getStoredClientKey(wallet.address)
      : await getCachedServerKey(wallet.address).catch(() => null);
    if (!val) { showAppToast('Key not generated yet', 'error'); return; }
    try {
      await navigator.clipboard.writeText(val);
      flashFheCopied(which);
    } catch {
      showAppToast('Clipboard copy failed', 'error');
    }
  }, [wallet?.address, flashFheCopied]);

  // Silent old-vault scan once this tab already has the encryption key (no extra wallet popup).
  // The recovery card only mounts when spendable legacy notes exist.
  useEffect(() => {
    if (!LEGACY_VAULTS[activeChainId] || !wallet?.address) {
      setLegacySummary(null);
      return;
    }
    let cancelled = false;
    let started = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tryScan = async () => {
      if (cancelled || started) return;
      // OFF by default. The scan reads the LEGACY entrypoint (LEGACY_VAULTS — 0x5433995f on Base,
      // 0xE5126A49 on Sepolia), which is not in rpcContractAllowlist, so every call 403s
      // `rpc_target_forbidden` and the 2s interval reports it forever. It feeds only the migration
      // card (`legacySummary`), never the private balance, so disabling it costs nothing here —
      // and re-enabling it needs those two addresses allowlisted first, or it just fails again.
      if (process.env.NEXT_PUBLIC_ENABLE_LEGACY_MIGRATION_SCAN !== 'true') return;
      if (!isEncKeyCached(wallet.address) || !isInitialized()) return;
      const signer = getSigner();
      if (!signer) return;
      started = true;
      if (timer) { clearInterval(timer); timer = undefined; }
      try {
        const summary = await findLegacyMigrationNotes(signer, activeChainId);
        if (!cancelled) setLegacySummary(summary);
      } catch (error) {
        console.warn('[migration] auto-scan failed:', error);
        if (!cancelled) setLegacySummary({ notes: [], totals: {} });
      }
    };
    void tryScan();
    timer = setInterval(() => { void tryScan(); }, 2000);
    window.addEventListener(FHE_KEYS_EVENT, tryScan);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener(FHE_KEYS_EVENT, tryScan);
    };
  }, [wallet?.address, activeChainId]);

  useEffect(() => {
    installWalletChainSync();
    const home = resolveHomeChainOption(readStoredHomeChainId());
    // Open the dashboard on the chain they just picked. A stored Base id (MetaMask's chain) used
    // to win here, so a Solana Devnet home painted as Base mainnet until Devnet was clicked.
    if (home?.productChainId === "solana-devnet" || nativeSolanaDashLocked()) {
      setProductChainId("solana-devnet");
      setSelectedChainId(SOLANA_DEVNET_CHAIN_ID);
      setActiveChainId(SOLANA_DEVNET_CHAIN_ID);
    } else {
      setActiveChainId(getSelectedChainId());
    }
    const onChain = (e: Event) => {
      const id = (e as CustomEvent<{ chainId: number }>).detail?.chainId;
      if (!id) return;
      if (
        (nativeSolanaDashLocked() || getProductChain().id === "solana-devnet") &&
        id !== SOLANA_DEVNET_CHAIN_ID
      ) {
        return;
      }
      setActiveChainId(id);
    };
    const onHome = () => {
      const next = resolveHomeChainOption(readStoredHomeChainId());
      if (next?.productChainId !== "solana-devnet") return;
      setProductChainId("solana-devnet");
      setSelectedChainId(SOLANA_DEVNET_CHAIN_ID);
      setActiveChainId(SOLANA_DEVNET_CHAIN_ID);
    };
    window.addEventListener('siphon:chainChanged', onChain);
    window.addEventListener('siphon:walletChainChanged', onChain);
    window.addEventListener('siphon:networkReady', onChain);
    window.addEventListener('siphon:homeChainChanged', onHome);
    return () => {
      window.removeEventListener('siphon:chainChanged', onChain);
      window.removeEventListener('siphon:walletChainChanged', onChain);
      window.removeEventListener('siphon:networkReady', onChain);
      window.removeEventListener('siphon:homeChainChanged', onHome);
    };
  }, [setProductChainId]);

  const fetchWalletBalances = useCallback(async (
    chainId: number,
    opts?: { refreshProvider?: boolean },
  ) => {
    const gen = ++walletBalanceGen.current;
    const stillCurrent = () => walletBalanceGen.current === gen;

    setWalletBalanceLoading(true);
    try {
      // Solana Devnet: read Phantom SOL + Siphon test USDC (not EVM ERC-20s).
      if (chainId === SOLANA_DEVNET_CHAIN_ID) {
        const owner =
          walletManager.getConnectedWallets().find((w) => w.id === 'solana')?.address ||
          null;
        if (!owner) {
          if (stillCurrent()) setWalletBalances([]);
          return;
        }
        const balances = await fetchSolanaDevnetWalletBalances(owner);
        if (stillCurrent()) setWalletBalances(balances);
        return;
      }

      const evmProvider = walletManager.getEvmProvider();
      if (evmProvider) {
        try {
          // refreshProvider() destroys the outgoing provider, and destroy() cancels every request
          // in flight on it. This effect re-runs on any wallet/chain state change, so a background
          // balance refresh was killing the `personal_sign` a withdrawal was waiting on —
          // surfacing as "provider destroyed; cancelled request" after the user had already
          // approved everything. Rebuild only when the chain actually moved.
          //
          // Compare against the `chainId` being fetched, NOT `activeChainId`: this callback has no
          // deps, so `activeChainId` here is frozen at the mount-time default (Base). On any other
          // chain that made every call destroy and rebuild a provider that was already correct;
          // the three calls a chain switch fires then raced each other's rebuild, read null, and
          // left the previous chain's balances on screen under the new chain's badge.
          if (!isInitialized()) {
            await initializeWithProvider(evmProvider);
          } else if (opts?.refreshProvider && !(await providerIsOnChain(chainId))) {
            await refreshProvider(evmProvider);
          }
        } catch (e) {
          const msg = String((e as { message?: string })?.message ?? e ?? '');
          if (!/provider destroyed|unsupported_operation|cancelled request/i.test(msg)) {
            console.warn('[wallet-balance] provider refresh failed:', e);
          }
          if (!isInitialized()) {
            try { await initializeWithProvider(evmProvider); } catch { /* ignore */ }
          }
        }
      }

      for (let attempt = 0; attempt < 10; attempt++) {
        if (!stillCurrent()) return;

        const balances = await getUnifiedBalances(chainId);
        if (balances === null) break;

        if (balances.length > 0) {
          setWalletBalances(balances);
          return;
        }

        // Empty array — wallet on wrong chain (transient during switch) or genuinely zero.
        const prov = getProvider();
        if (prov) {
          try {
            const net = await prov.getNetwork();
            if (Number(net.chainId) === chainId) {
              setWalletBalances(balances);
              return;
            }
          } catch { /* retry */ }
        }

        if (attempt < 9) {
          // Wait out a transient wrong-chain read. Deliberately does NOT re-initialise the wallet
          // provider: this loop runs unattended, including in a background tab, and re-initialising
          // here is what fired an unsolicited wallet approval popup up to nine times in a row.
          await new Promise((r) => setTimeout(r, 200 + attempt * 150));
          continue;
        }

        setWalletBalances(balances);
        return;
      }
    } catch (e) {
      console.error('Error fetching wallet balances:', e);
    } finally {
      if (stillCurrent()) setWalletBalanceLoading(false);
    }
  }, []);

  const handleSelectChain = useCallback(async (id: number) => {
    if (switchingChain) return;
    setSwitchingChain(true);
    // Switching chains genuinely invalidates the figure — clear the guard's memory too, or an
    // empty-but-correct balance on the new chain would be suppressed as if it were an ASP blip.
    shownFundsRef.current = { deposited: {}, checking: {} };
    setSiphonVaultBalances(null);
    // Same for the public balance: if the new chain's read fails, show "loading", never the old
    // chain's numbers — a user topped up against a Base balance that Arbitrum did not have.
    setWalletBalances(null);
    setWalletBalanceLoading(true);
    try {
      const result = await selectChainAndSwitchWallet(id, wallet?.address);
      setActiveChainId(result.chainId);
      if (result.ok) {
        if (id === 8453) setProductChainId("base");
        if (id === 42161) setProductChainId("arbitrum");
        if (id === 11155111) setProductChainId("sepolia");
      }
      if (result.ok && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('siphon:networkReady', { detail: { chainId: result.chainId } }));
        await fetchWalletBalances(result.chainId, { refreshProvider: true });
      } else if (!result.ok) {
        showAppToast(`Could not switch network: ${result.error}`, 'error');
        setWalletBalanceLoading(false);
      }
    } finally {
      setSwitchingChain(false);
    }
  }, [switchingChain, wallet?.address, fetchWalletBalances, setProductChainId]);

  const handleSelectSolanaDevnet = useCallback(async () => {
    setProductChainId("solana-devnet");
    setTransactionInput((prev) => ({ ...prev, token: "USDC" }));
    setActiveChainId(SOLANA_DEVNET_CHAIN_ID);
    setSelectedChainId(SOLANA_DEVNET_CHAIN_ID);
    // Native Solana custody: Devnet needs Phantom. Ask for it here rather than leaving the cards on
    // "Switch wallet to Solana Devnet" — the wallet effect adopts the session once it exists.
    if (solanaSession?.address) return;
    try {
      const session = await connectSolana();
      walletManager.adoptSolanaWallet({ address: session.address, name: 'Phantom' });
      showAppToast('Phantom connected · Solana Devnet', 'success');
    } catch (e) {
      showAppToast(
        formatPhantomNetworkError(e) || 'Connect Phantom to use Solana Devnet.',
        'error',
      );
    }
  }, [setProductChainId, solanaSession?.address, connectSolana]);

  // Mainnet = the home chain's vault. Every mainnet home is an EVM wallet (Solana is a bridged Base
  // home), so leaving Devnet drops the Phantom identity the Devnet toggle adopted and puts the EVM
  // wallet back in charge — reconnecting it through the home's own flow when it is not connected.
  const handleSelectMainnet = useCallback(() => {
    // Native Solana Devnet has no mainnet product. The button stays visible, locked.
    if (isSolana && !listHomeChainOptions().some((option) => option.id === 'solana-mainnet')) return;
    const home = resolveHomeChainOption(readStoredHomeChainId());
    const target = home?.kind === 'evm' ? home : resolveHomeChainOption('base');
    if (!target?.productChainId || target.numericId == null) return;
    walletManager.disconnectWallet('solana');
    if (!walletManager.getWallet('evm')) {
      // Leaving Devnet to connect the EVM wallet. Release the lock or MetaMask's chain is ignored
      // and the dashboard stays on Solana Devnet.
      setNativeSolanaDashLock(false);
      setProductChainId(target.productChainId);
      window.dispatchEvent(new Event('triggerWalletConnection'));
      return;
    }
    window.dispatchEvent(new Event('walletConnected'));
    void handleSelectChain(target.numericId);
  }, [isSolana, setProductChainId, handleSelectChain]);

  const fetchVaultBalances = useCallback(async (options?: { syncServerNotes?: boolean; skipOnChainCheck?: boolean }) => {
    const gen = ++vaultBalanceGen.current;
    const chainId = activeChainId;
    const walletAddr = wallet?.address ?? null;
    const stillCurrent = () => vaultBalanceGen.current === gen;

    /** True when every bucket of a split is empty — i.e. it locates no funds at all. */
    const splitIsEmpty = (s: BalanceSplit): boolean =>
      !Object.values(s.deposited).some((v) => v > 0) &&
      !Object.values(s.checking).some((v) => v > 0) &&
      !Object.values(s.flagged).some((v) => v > 0);

    const applySplit = (split: BalanceSplit, verified: boolean, overlayFresh: boolean, local = false) => {
      if (!stillCurrent()) return;
      const shown = overlayFresh ? overlayFreshChecking(split, chainId) : split;

      // An ALL-EMPTY split must never replace a balance we have already painted from real notes.
      //
      // The reconcile classifies every note through the ASP (noteStatusV3.classifyNotesV3), and an
      // unreachable/slow ASP is not an error there: fetchComplianceRoots swallows the failure and
      // statusByLabelV3 returns no entry, so `byLabel.get(label) ?? "UNKNOWN"` buckets EVERY note
      // as unknown and `deposited` comes back {}. Applied verbatim that reads as "No funds
      // detected" — the balance flicked 0.02 -> no funds -> 0.02 on every refresh, and a real ASP
      // outage would have shown a confident empty balance instead of a stale-but-correct one.
      //
      // The optimistic paint above is a plain localStorage sum with no network dependency, so when
      // it found notes it is the better answer. Keep it and leave `verified` alone: the card is
      // still showing an unverified figure, which is exactly what that flag is for.
      //
      // That argument only covers the RECONCILE. The local read (`local`) is the thing being
      // trusted here, so when IT comes back empty the notes really are gone — spent notes are
      // excluded from it. Guarding that too meant a full withdrawal could never reach zero: the
      // card kept showing 0.026573 USDC that was already in the user's wallet, and a second
      // CONFIRM failed with "no spendable notes found".
      const prev = shownFundsRef.current;
      const haveShownFunds =
        Object.values(prev.deposited).some((v) => v > 0) ||
        Object.values(prev.checking).some((v) => v > 0);
      if (!local && haveShownFunds && splitIsEmpty(shown)) return;

      shownFundsRef.current = { deposited: shown.deposited, checking: shown.checking };
      setSiphonVaultBalances(shown.deposited);
      setSiphonCheckingBalances(shown.checking);
      setSiphonFlaggedBalances(shown.flagged);
      setBalanceVerified(verified);
    };

    // OPTIMISTIC PAINT from the notes we already hold.
    //
    // This used to blank the card and set verified=false, so every refresh replaced a real number
    // with a "verifying on-chain, network busy" message until the reconcile finished — and left it there
    // permanently if the reconcile threw. That conflates "cannot verify" with "do not know the
    // amount". We always know the amount: it is the sum of local notes, and those notes plus the
    // server backup are the ONLY places a spendable note can exist.
    //
    // Zero network calls, so it cannot fail because a third party is down. The reconcile below
    // still runs and still owns `verified`; it refines this figure rather than gating it.
    purgeLegacyBalanceCache();
    {
      let painted = false;
      try {
        // No signer needed: `value` is plaintext on the note row, so this reads localStorage and
        // returns. Requiring a signer here meant waiting on the enc-key WALLET SIGNATURE before
        // the first paint, which is what left the card on "Checking for notes…".
        if (v3Deployed(chainId)) {
          const local = getLocalBalance(chainId, walletAddr);
          // ZERO NOTES IS AN ANSWER, not a reason to keep saying "checking".
          //
          // This branch used to require noteCount > 0, so an empty store fell through to the
          // `painted = false` fallback below — which applies an empty split with verified=false,
          // and empty + unverified is exactly the branch that renders "Checking for notes…".
          // With genuinely no notes the reconcile is then the only thing that can clear it, so a
          // slow or failing reconcile left the card "checking" forever, in the one case where we
          // had already looked and knew the answer.
          //
          // A local read that SUCCEEDS and finds nothing is a real result. Paint it. The server
          // sync still runs and still adds anything only the backup knows about — on a fresh
          // browser that means a brief "no balance" before notes appear, which is honest, and
          // better than a permanent "checking" on a wallet that really is empty.
          {
            const deposited: Record<string, number> = {};
            for (const [sym, minor] of Object.entries(local.bySymbol)) {
              // Format with the TOKEN's own precision. Rendering raw minor units as a balance is
              // the regression at line ~536: 0.024238 USDC once displayed as "24238.000000".
              const dec = getTokens(chainId)[sym]?.decimals ?? (sym === 'ETH' ? 18 : 6);
              deposited[sym] = Number(ethers.formatUnits(minor, dec));
            }
            // verified=false: the reconcile below still owns that flag. It no longer gates the
            // DISPLAY though — `deposited` may legitimately be empty, and empty-and-painted is a
            // different thing from empty-and-still-looking.
            applySplit({ deposited, checking: {}, flagged: {}, ts: Date.now() }, false, false, true);
            setLocalRead(true);
            painted = true;
          }
        }
      } catch {
        /* optimistic only — never block the real reconcile */
      }
      // Solana Devnet: skip blanking the card — notes are fetched below; clearing here wiped
      // the post-deposit optimistic balance before the RPC scan finished.
      if (!painted && chainId !== SOLANA_DEVNET_CHAIN_ID) {
        applySplit({ deposited: {}, checking: {}, flagged: {}, ts: 0 }, false, true);
      }
    }

    // Finalize any vault-mode swap outputs whose on-chain deposit has landed so they count
    // toward the vault balance below. No signer → localStorage-only (avoids a wallet popup).
    // Scoped to the ACTIVE chain: another chain's stale pending notes (dead RPC, rate limits)
    // must never stall this chain's balance behind "Updating…".
    const hasPending = typeof localStorage !== 'undefined' &&
      Object.keys(localStorage).some((k) => k.startsWith(`siphon-pending-output-${chainId}-`));
    if (hasPending) {
      let resolveSigner: ReturnType<typeof getSigner> = null;
      if (wallet && isInitialized()) {
        const s = getSigner();
        if (s) {
          if (options?.syncServerNotes) {
            resolveSigner = s;
          } else {
            try {
              if (isEncKeyCached(await s.getAddress())) resolveSigner = s;
            } catch { /* ignore */ }
          }
        }
      }
      try {
        await Promise.race([
          resolvePendingOutputNotes(resolveSigner, chainId),
          new Promise((res) => setTimeout(res, 15_000)),
        ]);
      } catch { /* best-effort */ }
      if (!stillCurrent()) return;
    }

    // Cold start / hard reload: sync encrypted notes from server once the enc-key is ready.
    // Manual refresh always syncs; initial load syncs when the key is already cached so we
    // don't undercount notes that only live on the server after logout/login.
    const shouldSync =
      options?.syncServerNotes === true ||
      (options?.syncServerNotes !== false &&
        !!walletAddr &&
        isInitialized() &&
        isEncKeyCached(walletAddr));
    if (shouldSync && wallet && isInitialized()) {
      try {
        const s = getSigner();
        if (s) {
          // BEFORE the sync, not after: a deposit that mined but whose note was never written
          // (crash / closed tab between tx.wait and saveV3Note) exists only as a pre-tx stash.
          // Recovering it first means the note is present for this sync and its balance refresh,
          // rather than invisible until the next one.
          if (v3Deployed(chainId)) {
            try {
              const { recoverPendingDeposits } = await import('../../../lib/v3/recoverPendingDepositV3');
              const rec = await recoverPendingDeposits(chainId, s);
              if (rec.recovered > 0) {
                console.log(`[deposit] recovered ${rec.recovered} note(s) from an interrupted deposit`);
                showAppToast(
                  `Recovered ${rec.recovered} note(s) from an interrupted deposit`,
                  'success',
                );
              }
            } catch {
              /* best-effort: never block the sync on recovery */
            }
          }
          // The shared backup table contains two incompatible note generations. v3 rows bind
          // assetId into Poseidon3 and belong in `siphon-v3note-`; the legacy sync rebuilds a
          // Poseidon2 leaf and rejects every one as corrupt. Route each chain to its own sync.
          if (v3Deployed(chainId)) await syncV3FromServer(s, chainId);
          else await syncWalletNotesFromServer(s);
        }
      } catch {
        /* server notes optional */
      }
      if (!stillCurrent()) return;
    }
    // Refresh the backup-pending indicator after the sync (which drains the retry queue + up-syncs).
    try {
      const { countPendingBackups } = await import('../../../lib/localNoteStore');
      if (stillCurrent()) setPendingBackups(countPendingBackups(chainId));
    } catch { /* non-blocking */ }
    // Solana Devnet: private balance = sum of encrypted local notes (not EVM v3 notes, and not
    // the trade executor). This runs even on the light refresh — skipOnChainCheck only skips the
    // EVM RPC scan below, and skipping this too left a deposit invisible until the wallet object
    // changed.
    if (chainId === SOLANA_DEVNET_CHAIN_ID) {
      const solOwner =
        solanaSession?.address ??
        walletManager.getConnectedWallets().find((w) => w.id === 'solana')?.address ??
        (wallet?.id === 'solana' ? wallet.address : null);
      // An EVM address is not a note owner. Painting {} here is what showed "No funds detected"
      // for a Phantom deposit while MetaMask was the wallet the dashboard had adopted.
      if (!solOwner || solOwner.startsWith('0x')) return;
      try {
        // Fired Devnet orders return their output as a note: add it (and give unfired orders'
        // inputs back) before summing. No network call unless this wallet has armed orders.
        if (!options?.skipOnChainCheck && isSolanaZkMode()) {
          const { resolveSolanaDevnetOrders } = await import('@/lib/chains/solanaDevnetStrategy');
          await resolveSolanaDevnetOrders(solOwner).catch((e) => console.warn('[devnet] resolve:', e));
        }
        // ZK program: the vault keeps no plaintext note PDAs — private balance is the sum of the
        // encrypted local notes. The legacy PDA scan only applies to the FHE program.
        // When leaves are available, drop orphans (prior-program notes rewritten under this tag)
        // so the card matches what withdraw can actually spend.
        if (isSolanaZkMode() && !options?.skipOnChainCheck) {
          try {
            const { fetchZkStateLeavesFromIndexer } = await import('@/lib/chains/solanaVaultZk');
            const {
              loadSolanaNotes,
              deleteSolanaNotesNotInLeaves,
              isSpendableSolanaNote,
            } = await import('@/lib/chains/solanaNoteStore');
            const leaves = await fetchZkStateLeavesFromIndexer();
            const local = (await loadSolanaNotes(solOwner)).filter(isSpendableSolanaNote);
            deleteSolanaNotesNotInLeaves(local, leaves);
          } catch (e) {
            console.warn('[solana-balance] leaf prune skipped:', e);
          }
        }
        const { deposited } = isSolanaZkMode()
          ? { deposited: await sumUnspentPrivateBalancesBySymbol(solOwner) }
          : await fetchSolanaDevnetPrivateBalances(solOwner);
        if (!stillCurrent()) return;
        // local=true: this sum IS the spendable store. Without it, applySplit's empty-split
        // guard kept a stale USDC figure after notes were spent — CONFIRM then died on
        // planWithdraw: no spendable notes for asset <mint field>.
        applySplit({ deposited, checking: {}, flagged: {}, ts: Date.now() }, true, false, true);
        setLocalRead(true);
      } catch (e) {
        console.warn('[solana-balance] note scan failed:', e);
        if (stillCurrent()) setBalanceVerified(false);
      }
      return;
    }

    if (options?.skipOnChainCheck) return;

    // Without an enc-key we cannot decrypt labels → ASP split undercounts. Skip the write
    // so a hard-reload doesn't persist "1" over a real "2" sitting in local notes.
    if (walletAddr && !isEncKeyCached(walletAddr)) {
      setBalanceVerified(false);
      return;
    }

    try {
      if (v3Deployed(chainId)) {
        const signer = getSigner();
        if (signer) {
          try {
            // A strategy leg's proceeds are minted on-chain at fire time, so they only become a
            // spendable note once the leaf is indexed. Promote any that landed before reading the
            // balance, or a filled order stays invisible until some later refresh happens to run.
            // No-ops without a network call when nothing is staged.
            try {
              const { resolveV3OutputNotes } = await import('../../../lib/v3/outputNoteResolverV3');
              const n = await resolveV3OutputNotes(chainId, signer);
              if (n > 0) console.log(`[v3-output] resolved ${n} strategy output note(s)`);
            } catch (e) {
              // Never block the balance on this: the notes are safe on-chain and in the stash.
              console.warn('[v3-output] resolve failed:', e);
            }
            const v3Bal = await getV3Balance(chainId, signer);
            if (!stillCurrent()) return;
            const split: BalanceSplit = {
              deposited: v3Bal.deposited,
              checking: v3Bal.checking,
              flagged: v3Bal.flagged,
              ts: v3Bal.ts,
            };
            applySplit(split, true, false);
            console.log('[v3-balance] Private:', v3Bal.deposited, 'In Review:', v3Bal.checking, 'Flagged:', v3Bal.flagged);
            return;
          } catch (e) {
            // NEVER fall through to the v2 scan on a v3 chain. That scan reconciles against the
            // LEGACY vault (a different contract entirely — 0xBf30FcEa… on Base, which holds none
            // of these notes) and classifies what it finds in its own units. On Base it turned a
            // 0.024238 USDC balance into "24238.000000 USDC in review": raw minor units, from the
            // wrong deployment, overwriting the correct v3 figure that had already been applied.
            //
            // An unknown balance must read as unknown — it must NOT fall through to the v2 scan
            // and invent a number from the wrong deployment. balanceVerified=false now only downgrades
            // the confidence badge; the optimistic paint above still shows the real local total.
            console.warn('[v3-balance] failed — reporting unverified rather than scanning v2:', e);
            setBalanceVerified(false);
            return;
          }
        }
        // Same reasoning without a signer: the v3 balance needs one to decrypt notes, and no
        // answer is better than the legacy vault's answer.
        setBalanceVerified(false);
        return;
      }

      const reconciled = await Promise.race([
        getSpendableVaultBalance(chainId, TOKEN_MAP),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('balance scan timeout')), 12_000),
        ),
      ]);
      if (!stillCurrent()) return;

      const skipped = new Set(reconciled.skipped ?? []);
      const deposited: Record<string, number> = {};
      const checking: Record<string, number> = {};
      const flagged: Record<string, number> = {};
      for (const sym of ['ETH', 'USDC']) {
        // Unreconcilable symbol: report NOTHING and let the card say "verifying". Carrying a
        // remembered figure forward is exactly how one bad write became permanent.
        if (skipped.has(sym)) continue;
        if ((reconciled.details[sym] ?? 0) > 0) deposited[sym] = reconciled.details[sym];
        if ((reconciled.checking[sym] ?? 0) > 0) checking[sym] = reconciled.checking[sym];
        if ((reconciled.flagged[sym] ?? 0) > 0) flagged[sym] = reconciled.flagged[sym];
      }
      let split: BalanceSplit = { deposited, checking, flagged, ts: Date.now() };

      // Align checking/flagged with Activity Log — only ASP-pending notes show as checking.
      try {
        const liveScreen = await aggregateDepositScreeningTotals();
        for (const sym of ['ETH', 'USDC'] as const) {
          if (skipped.has(sym)) continue;
          const chk = liveScreen.checking[sym] ?? 0;
          const flg = liveScreen.flagged[sym] ?? 0;
          if (chk > 0) checking[sym] = chk;
          else delete checking[sym];
          if (flg > 0) flagged[sym] = flg;
          else delete flagged[sym];
          // On-chain reconcile is authoritative here. `skipped` above already diverted any symbol
          // whose scan was unreliable, so reaching this line means the scan SUCCEEDED and
          // reconciled.details[sym] is a verified spendable total for the CURRENT vault.
          //
          // This used to be Math.max(localTotal - chk - flg, fromRecon), which let stale
          // localStorage notes outvote the chain. Every retired generation (v1–v4) shares
          // chainId 11155111, so getLocalVaultNoteTotals sums notes belonging to dead vaults —
          // reporting 2.106 ETH while the entire live v5 ETH vault held 0.021 ETH.
          // Fresh deposits are not lost by dropping the local max: they surface via `checking`
          // and overlayFreshChecking until the scan sees them.
          const dep = reconciled.details[sym] ?? 0;
          if (dep > 0) deposited[sym] = dep;
          else delete deposited[sym];
        }
        split = { deposited, checking, flagged, ts: Date.now() };
      } catch (e) {
        console.warn('[balance] screening totals unavailable — using reconcile split:', e);
      }

      applySplit(split, skipped.size === 0, false);
      console.log(
        `Private balance (${skipped.size === 0 ? 'on-chain reconciled' : 'partial — unverified: ' + [...skipped].join(',') }):`,
        deposited, 'checking:', checking, 'flagged:', flagged,
      );
    } catch (e) {
      // Report the failure, not a guess. getLocalVaultNoteTotals is generation-blind (every
      // retired vault shares the chain id), so the old fallback here was the other route by which
      // dead-vault notes reached the card.
      console.warn('[balance] on-chain reconcile unavailable — showing unverified:', e);
      if (!stillCurrent()) return;
      setBalanceVerified(false);
    }
  }, [activeChainId, wallet, solanaSession?.address]);

  // Relay fee (v3 only). The kernel has no fee module, so the relayer charges a prepaid balance;
  // read it so the panel can show the price and offer a top-up BEFORE the user builds a proof and
  // gets a 402 back from a withdrawal they already paid gas to prove.
  //
  // Deliberately never throws and never blocks: fetchWithdrawCredit returns null when the relayer
  // is unreachable or charges nothing, and null renders no fee at all. The exit is not gated on
  // this — spend() is permissionless — so an unknown fee must not disable the button.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeChainId || !v3Deployed(activeChainId) || !wallet?.address) {
        setWithdrawCredit(null);
        return;
      }
      const signer = getSigner();
      if (!signer) return;
      const c = await fetchWithdrawCredit(activeChainId, signer);
      if (!cancelled) setWithdrawCredit(c);
    })();
    return () => { cancelled = true; };
  }, [activeChainId, wallet?.address]);

  /** Buy enough credit for several withdrawals at once — see withdrawCreditV3 on why top-ups
   *  are deliberately infrequent rather than one payment per exit. */
  const handleTopUpCredit = useCallback(async () => {
    if (!activeChainId || !withdrawCredit) return;
    const signer = getSigner();
    if (!signer) { showAppToast('Connect a wallet to top up', 'error'); return; }
    setToppingUp(true);
    try {
      const amount = withdrawCredit.feeWei * 20n; // ~20 withdrawals per top-up
      const balance = await topUpWithdrawCredit(activeChainId, signer, amount);
      setWithdrawCredit({ ...withdrawCredit, balanceWei: balance });
      void fetchWalletBalances(activeChainId); // the top-up left the public wallet
      showAppToast(`Withdrawal credit topped up — balance ${formatCredit(balance, withdrawCredit.decimals)} USDC`, 'success');
    } catch (e) {
      // A wallet/ethers error carries the whole calldata in `.message`; our own errors (plain
      // Error, no code) are already worded and may name a tx hash that must not be truncated.
      const err = e as { code?: unknown; shortMessage?: string; message?: string };
      showAppToast(
        err.code || err.shortMessage ? friendlyTxError(e) : err.message || 'Top-up failed',
        'error',
      );
    } finally {
      setToppingUp(false);
    }
  }, [activeChainId, withdrawCredit, fetchWalletBalances]);

  // Manual refresh: bust the cached leaf scan first so a just-landed deposit is picked up
  // immediately instead of waiting out the cache TTL / 60s poll.
  const refreshVaultBalances = useCallback(async () => {
    setIsVaultRefreshing(true);
    try {
      invalidateLeafCache();
      await fetchVaultBalances({ syncServerNotes: true });
    } finally {
      setIsVaultRefreshing(false);
    }
  }, [fetchVaultBalances]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const kick = () => {
      if (cancelled) return;
      void fetchVaultBalances({ syncServerNotes: true });
    };

    // SYNCHRONOUS first paint, before any async work starts.
    //
    // fetchVaultBalances is async, so even though its optimistic paint is the first thing it does,
    // React does not commit that state until the microtask runs — and anything the browser is busy
    // with on mount pushes it further out. The balance is a localStorage read and an addition; it
    // should be on screen in the same frame the dashboard renders, not after a round of async
    // scheduling. This does exactly that, and fetchVaultBalances then refines it as before.
    try {
      if (v3Deployed(activeChainId)) {
        const local = getLocalBalance(activeChainId, wallet?.address);
        const deposited: Record<string, number> = {};
        for (const [sym, minor] of Object.entries(local.bySymbol)) {
          const dec = getTokens(activeChainId)[sym]?.decimals ?? (sym === 'ETH' ? 18 : 6);
          deposited[sym] = Number(ethers.formatUnits(minor, dec));
        }
        shownFundsRef.current = { deposited, checking: shownFundsRef.current.checking };
        setSiphonVaultBalances(deposited);
        setLocalRead(true);
      }
    } catch {
      /* first paint is best-effort — fetchVaultBalances below is the real path */
    }

    kick();

    const solOwner =
      activeChainId === SOLANA_DEVNET_CHAIN_ID
        ? (solanaSession?.address ?? (wallet?.id === 'solana' ? wallet.address : null))
        : null;
    const addr = activeChainId === SOLANA_DEVNET_CHAIN_ID ? solOwner : wallet?.address ?? null;
    // Solana notes unlock with Phantom's enc-key, which does not go through the EVM provider.
    // Waiting on isInitialized() meant a deposited balance never repainted after that sign.
    if (addr && !isEncKeyCached(addr)) {
      timer = setInterval(() => {
        if (cancelled) return;
        const ready = activeChainId === SOLANA_DEVNET_CHAIN_ID
          ? isEncKeyCached(addr)
          : isEncKeyCached(addr) && isInitialized();
        if (ready) {
          if (timer) clearInterval(timer);
          timer = undefined;
          kick();
        }
      }, 800);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, activeChainId, solanaSession?.address]);

  useEffect(() => {
    const interval = setInterval(() => fetchVaultBalances({ skipOnChainCheck: true }), 60_000);
    return () => clearInterval(interval);
  }, [fetchVaultBalances]);

  // Real ASP membership, from the SHARED screening store. Deliberately not a poll of its own:
  // listDepositScreening costs one /api/asp-set/member request per note, that endpoint allows 30
  // per minute per IP, and a second independent 8s poller alongside the Activity Log's put a
  // 5-note wallet at ~75/min. The limiter answered 429, every 429 became `null`, and null means
  // "say nothing" — so the screening list came back empty and the In Review row and its ragequit
  // button vanished on exactly the wallets that needed them.
  useEffect(() => {
    if (!wallet?.address) { setScreenRows([]); return; }
    const sync = () => setScreenRows(getScreeningRows());
    const unsubscribe = subscribeScreening(sync);
    sync();
    return unsubscribe;
  }, [wallet?.address, activeChainId]);

  // Pending (ASP has not admitted) and flagged (revoked) totals per token, from real membership.
  const screenTotals = useMemo(() => screeningTotals(screenRows), [screenRows]);

  // Ragequit one in-review or flagged note from the balance card, so the escape hatch is in front
  // during the pre-admission window rather than buried in the Activity Log.
  const handleBalanceRagequit = useCallback(async (row: DepositScreening) => {
    if (rqBusyKey) return;
    const ok = await showAppConfirm({
      title: 'Ragequit this deposit?',
      message:
        `Returns ${row.amount} ${row.token} to the depositing wallet. This exit is PUBLIC on-chain ` +
        `and linked to you — it is the one operation that gives up privacy. Your other deposits ` +
        `stay private. Waiting for admission instead keeps it private and usually takes 1-3 minutes.`,
      confirmLabel: 'Ragequit',
    });
    if (!ok) return;
    setRqBusyKey(row.noteKey);
    try {
      const res = await ragequit(row.token, row.noteKey);
      if (res.success) {
        showAppToast(`Ragequit sent ${row.amount} ${row.token} back to your wallet`, 'success');
        setScreenRows((rows) => rows.filter((r) => r.noteKey !== row.noteKey));
        clearMemberCache();
        invalidateScreening();
        void refreshScreening({ force: true }).then(() => setScreenRows(getScreeningRows()));
        void fetchVaultBalances({ syncServerNotes: true });
      } else {
        showAppToast(`Ragequit failed: ${res.error}`, 'error');
      }
    } catch (e) {
      showAppToast(`Ragequit failed: ${e instanceof Error ? e.message : 'Unknown error'}`, 'error');
    } finally {
      setRqBusyKey(null);
    }
  }, [rqBusyKey, fetchVaultBalances]);

  useEffect(() => {
    const onInvalidate = () => { void fetchVaultBalances({ syncServerNotes: true }); };
    window.addEventListener('siphon:vaultBalanceInvalidate', onInvalidate);
    return () => window.removeEventListener('siphon:vaultBalanceInvalidate', onInvalidate);
  }, [fetchVaultBalances]);

  // Public wallet balances — refresh on wallet/chain change; retry while provider catches up.
  useEffect(() => {
    if (!wallet) {
      setWalletBalances(null);
      setWalletBalanceLoading(false);
      return;
    }
    void fetchWalletBalances(activeChainId, { refreshProvider: true });
  }, [wallet, activeChainId, fetchWalletBalances]);

  useEffect(() => {
    if (!wallet) return;
    const onNetwork = (e: Event) => {
      const id = (e as CustomEvent<{ chainId: number }>).detail?.chainId;
      if (id) void fetchWalletBalances(id, { refreshProvider: true });
    };
    window.addEventListener('siphon:networkReady', onNetwork);
    window.addEventListener('siphon:walletChainChanged', onNetwork);
    return () => {
      window.removeEventListener('siphon:networkReady', onNetwork);
      window.removeEventListener('siphon:walletChainChanged', onNetwork);
    };
  }, [wallet, fetchWalletBalances]);

  useEffect(() => {
    if (!wallet) return;
    const interval = setInterval(() => {
      void fetchWalletBalances(activeChainId);
    }, 120_000);
    return () => clearInterval(interval);
  }, [wallet, activeChainId, fetchWalletBalances]);

  const [transactionInput, setTransactionInput] = useState({
    token: "ETH",
    amount: "",
    recipient: ""
  });

  // The Solana menu offers only SOL/USDC; an EVM-default "ETH" left here showed as USDC while Max
  // and Confirm read ETH ("No vault balance for this token", a withdraw logged as ETH).
  useEffect(() => {
    if (isSolana && transactionInput.token !== 'SOL' && transactionInput.token !== 'USDC') {
      setTransactionInput((prev) => ({ ...prev, token: 'USDC' }));
    }
  }, [isSolana, transactionInput.token]);

  // A bridged home chain (Ethereum, Tempo, Hyperliquid, Zcash) runs on the Base vault, and its
  // edge is where withdrawals land by default. Re-read on wallet change: the picker writes it
  // just before connecting.
  const handleReceiveOn = useCallback((id: number | null) => {
    setReceiveOn(id);
    const d = bridgeDest(id);
    const addr = !d || d.kind === 'evm' ? wallet?.address : d.kind === 'solana' ? solanaSession?.address : '';
    setTransactionInput((prev) => ({ ...prev, recipient: addr ?? '', ...(d ? { token: 'USDC' } : {}) }));
  }, [wallet?.address, solanaSession?.address]);

  // Re-read when either wallet changes: the picker writes the edge just before connecting, and a
  // Solana edge's default recipient is the Phantom address, which can arrive after the EVM wallet.
  useEffect(() => {
    const edge = readHomeEdgeChainId();
    setHomeEdge(edge);
    // Same-chain "receive on" is a plain withdraw — don't treat the vault as a LI.FI dest.
    handleReceiveOn(edge != null && edge === activeChainId ? null : edge);
  }, [handleReceiveOn, activeChainId]);

  const handleFundArrived = useCallback(async (amount: string) => {
    // Stay on the vault chain that just received the hop (Base or Arbitrum).
    if (isBridgeVaultChain(activeChainId)) {
      await handleSelectChain(activeChainId);
    }
    setIsDepositMode(true);
    setTransactionInput((prev) => ({ ...prev, token: 'USDC', amount }));
    const where = activeNetwork?.name ?? 'the vault chain';
    showAppToast(`${amount} USDC arrived on ${where} — press Confirm to deposit it privately.`, 'success');
  }, [handleSelectChain, activeChainId, activeNetwork?.name]);

  /** Fill amount from wallet (deposit) or vault (withdraw). Leave a tiny ETH gas buffer on deposit. */
  const handleMaxAmount = useCallback(() => {
    const token = transactionInput.token;
    const format = (n: number) => {
      if (!Number.isFinite(n) || n <= 0) return "0";
      // TRUNCATE, never toFixed. Rounding up here filled MAX with more than the balance —
      // a vault holding 8.1e-7 ETH offered 0.000001, which then failed as an over-withdrawal.
      const decimals = token === "USDC" ? 6 : token === "SOL" ? 9 : 18;
      return toAmountString(n, decimals);
    };

    if (isDepositMode) {
      const bal = walletBalances?.find((b) => b.symbol === token);
      if (!bal) {
        showAppToast("Wallet balance unavailable", "error");
        return;
      }
      let n = parseFloat(bal.balance);
      if (!Number.isFinite(n)) n = 0;
      if (token === "ETH") n = Math.max(0, n - 0.001);
      // Leave rent + wrap + deposit fees when wrapping native SOL → WSOL.
      if (token === "SOL") n = Math.max(0, n - 0.05);
      setTransactionInput((prev) => ({ ...prev, amount: format(n) }));
      return;
    }

    const vaultAmt = siphonVaultBalances?.[token] ?? 0;
    if (!(vaultAmt > 0)) {
      const checkingAmt = siphonCheckingBalances[token] ?? 0;
      const flaggedAmt = siphonFlaggedBalances[token] ?? 0;
      if (checkingAmt > 0) {
        showAppToast(`${checkingAmt} ${token} is in review — awaiting ASP admission, private withdraw can't use it yet.`, "error");
        return;
      }
      if (flaggedAmt > 0) {
        showAppToast(`${flaggedAmt} ${token} is flagged — recover that deposit from Activity.`, "error");
        return;
      }
      // An unverified balance is not a zero balance. The card shows the local total regardless,
      // so claiming "no vault balance" here contradicts what is on screen and reads as funds lost.
      showAppToast(
        balanceVerified
          ? "No vault balance for this token"
          : "Still verifying your balance on-chain — try Max again in a moment.",
        "error",
      );
      return;
    }

    // EXACT SEND: the field is the gross spent from the pool, so the whole balance is spendable.
    if (withdrawMode === "send") {
      setTransactionInput((prev) => ({ ...prev, amount: format(vaultAmt) }));
      return;
    }

    // EXACT RECEIVE: the field is what the RECIPIENT gets, so Max is the balance minus the fee.
    // Filling the full balance here produced a gross of balance + fee, which always exceeds the
    // pool — Max proposed an amount that could never succeed, and the failure surfaced later as a
    // balance error rather than as "that is more than you have".
    const decimals = token === "ETH" ? 18 : 6;
    void (async () => {
      try {
        const q = await quoteWithdrawFee(token, ethers.parseUnits(format(vaultAmt), decimals), 1, activeChainId);
        if (q.feeExceedsAmount || q.recipientReceivesWei <= 0n) {
          showAppToast(
            `The ${token} withdrawal fee is more than your ${vaultAmt} ${token} balance, so there is nothing to receive. Deposit more, or use Exact Send.`,
            "error",
          );
          return;
        }
        setTransactionInput((prev) => ({
          ...prev,
          amount: ethers.formatUnits(q.recipientReceivesWei, decimals).replace(/\.?0+$/, "") || "0",
        }));
      } catch {
        // Fee unknown (the RPC did not answer). Filling the full balance here is the same mistake
        // one level up: in EXACT RECEIVE that grosses up to balance + fee, which can never be
        // covered, so Max would propose an amount guaranteed to fail. Leave the field alone and
        // say why — an unknown fee cannot produce a known maximum.
        showAppToast(
          `Couldn't read the ${token} withdrawal fee, so there's no exact maximum to fill. Try again, or use Exact Send.`,
          "error",
        );
      }
    })();
  }, [isDepositMode, transactionInput.token, walletBalances, siphonVaultBalances, siphonCheckingBalances, siphonFlaggedBalances, withdrawMode, balanceVerified, activeChainId]);

  // Live fee quote (withdraw only). Debounced; reads the on-chain fee config for the token's vault.
  useEffect(() => {
    // The quote reads the EVM vault's fee config; the Solana vault has none, so on Devnet it always
    // threw and showed "Couldn't estimate the withdrawal fee" on every withdraw.
    if (isDepositMode || isSolana) { setFeeQuote(null); return; }
    const amtStr = transactionInput.amount;
    const token = transactionInput.token;
    if (!amtStr || Number(amtStr) <= 0) { setFeeQuote(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        setFeeQuoting(true);
        const decimals = token === 'ETH' ? 18 : 6;
        const amtWei = ethers.parseUnits(amtStr, decimals);
        const q = withdrawMode === 'send'
          ? await quoteWithdrawFee(token, amtWei, 1, activeChainId)
          : await solveWithdrawForExactReceive(token, amtWei, 1, activeChainId);
        if (!cancelled) setFeeQuote(q);
      } catch {
        if (!cancelled) setFeeQuote(null);
      } finally {
        if (!cancelled) setFeeQuoting(false);
      }
    }, 400);
    // Release the spinner on cleanup too. The finally below is gated on !cancelled (correct, so a
    // stale quote can't overwrite a newer one), which means a superseded in-flight run never
    // clears feeQuoting — leaving "Estimating fee…" stuck forever the moment the amount changes
    // mid-quote. The next run re-arms it after the debounce.
    return () => { cancelled = true; clearTimeout(t); setFeeQuoting(false); };
  }, [isDepositMode, isSolana, withdrawMode, transactionInput.amount, transactionInput.token, activeChainId]);

  // Per-label withdraw cap (Hard ASP: one deposit association per private withdraw).
  useEffect(() => {
    if (isDepositMode || !wallet?.address) {
      setWithdrawCap(null);
      return;
    }
    let cancelled = false;
    void getPrivateWithdrawCap(transactionInput.token)
      .then((cap) => { if (!cancelled) setWithdrawCap(cap); })
      .catch(() => { if (!cancelled) setWithdrawCap(null); });
    return () => { cancelled = true; };
  }, [isDepositMode, transactionInput.token, wallet?.address, activeChainId, siphonVaultBalances]);

  useEffect(() => {
    const checkWalletAndFetchBalances = async () => {
      try {
        const restored = await walletManager.restorePersistedSession();
        // Phantom is an identity only on Devnet. On mainnet it is the Solana funding/receiving wallet
        // (solanaSession) and must never be adopted: adopting persists it as the primary wallet and
        // fires walletConnected, and while the EVM wallet is still reconnecting the dashboard would
        // key FHE, notes and auth to the Solana address.
        const solanaWallet = !isDevnetEnv
          ? null
          : walletManager.getConnectedWallets().find((w) => w.id === 'solana') ??
            (solanaSession?.address
              ? walletManager.adoptSolanaWallet({ address: solanaSession.address }).wallet ?? null
              : null);
        const evmWallet =
          restored?.id === 'evm'
            ? restored
            : walletManager.getConnectedWallets().find((w) => w.id === 'evm') ?? null;

        const nextWallet = isDevnetEnv ? (solanaWallet ?? evmWallet) : evmWallet;

        if (nextWallet) {
          // Guard against reference churn: restorePersistedSession()/getConnectedWallets() return a
          // FRESH object every call, so setWallet(…) with the SAME address still changes the
          // reference → fetchVaultBalances (dep [wallet]) gets a new identity → the balance-fetch
          // effects re-run → constant refetch (the card never settles on a confirmed balance).
          // Only replace the wallet object when something meaningful actually changed.
          setWallet(prev =>
            prev &&
            prev.address === nextWallet.address &&
            prev.id === nextWallet.id &&
            prev.chain === nextWallet.chain &&
            prev.connected === nextWallet.connected
              ? prev
              : nextWallet,
          );
          // The recipient default is owned by the Receive-on effect (handleReceiveOn), which re-runs on
          // every wallet change — setting it here too raced it and put the 0x address into a Solana
          // "Receive on" field.

          if (isDevnetEnv) {
            setActiveChainId(SOLANA_DEVNET_CHAIN_ID);
            setSelectedChainId(SOLANA_DEVNET_CHAIN_ID);
          } else {
            // Ensure ethers is initialized before fetching balances
            const evmProvider = walletManager.getEvmProvider();
            if (!isInitialized() && evmProvider) {
              try {
                await initializeWithProvider(evmProvider);
              } catch (error) {
                console.error('Failed to initialize ethers:', error);
              }
            }
          }
        } else {
          setWallet(null);
        }
      } catch (error) {
        console.error('Error fetching wallet data:', error);
      }
    };

    checkWalletAndFetchBalances();
    
    // Listen for wallet connection/disconnection events
    const handleWalletConnected = () => {
      checkWalletAndFetchBalances();
    };

    const handleWalletDisconnected = () => {
      setWallet(null);
      setWalletBalances(null);
      setWalletBalanceLoading(false);
    };

    window.addEventListener('walletConnected', handleWalletConnected);
    window.addEventListener('walletDisconnected', handleWalletDisconnected);

    return () => {
      window.removeEventListener('walletConnected', handleWalletConnected);
      window.removeEventListener('walletDisconnected', handleWalletDisconnected);
    };
  }, [isDevnetEnv, solanaSession?.address]);

  const formatAddress = (address: string) => {
    if (address.length <= 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const handleLogout = () => {
    if (wallet) {
      console.log(`Disconnecting ${wallet.id} wallet...`);
      walletManager.disconnectWallet(wallet.id);
      setWallet(null);
      window.dispatchEvent(new Event('walletDisconnected'));
      if (wallet.id !== 'solana') deinit();
      walletManager.clearPersistedWallet();
      // Navigate back to discover view
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('userdash-view-change', { detail: 'blueprint' }));
        window.dispatchEvent(new CustomEvent('pro-view-mode-change', { detail: 'blueprint' }));
      }
    }
  };

  const handleConfirm = async () => {
    if (isProcessing) return;

    // Devnet Solana path only needs Phantom; mainnet still needs the EVM signer for Arb vault.
    const solanaReady = isDevnetEnv && (!!solanaSession?.address || wallet?.id === 'solana');
    if (!wallet || (!isInitialized() && !solanaReady)) {
      showAppToast(
        isDevnetEnv ? 'Please connect Phantom first' : 'Please connect wallet first',
        'error',
      );
      return;
    }

    // Validate inputs
    if (!transactionInput.amount || parseFloat(transactionInput.amount) <= 0) {
      showAppToast('Please enter a valid amount', 'error');
      return;
    }
    if (!transactionInput.token) {
      showAppToast('Please select a token', 'error');
      return;
    }
    if (!isDepositMode && !transactionInput.recipient) {
      showAppToast('Please enter a recipient address', 'error');
      return;
    }

    if (isDepositMode && !isLevel1TrustComplete(resolveTrustWallet(wallet.address))) {
      showAppToast(LEVEL1_REQUIRED_MESSAGE, 'error');
      setDashPage('trust');
      return;
    }

    setIsProcessing(true);

    try {
      if (isDepositMode) {
        let depositChainId = activeChainId;

        // Solana product modes: Deposit owns funding (Devnet = native vault; Mainnet = Li.Fi → Arb).
        if (isSolana) {
          // The Devnet select shows USDC for anything but SOL (e.g. an ETH pick carried over from Base).
          const tokenSym = transactionInput.token.toUpperCase() === 'SOL' ? 'SOL' : 'USDC';
          const solDevnetOk = isDevnetEnv && (tokenSym === 'USDC' || tokenSym === 'SOL');
          const solMainnetOk = !isDevnetEnv && tokenSym === 'USDC';
          if (!solDevnetOk && !solMainnetOk) {
            showAppToast(
              isDevnetEnv
                ? 'Solana Devnet deposits accept USDC or SOL.'
                : 'Solana deposits are USDC only.',
              'error',
            );
            setIsProcessing(false);
            return;
          }
          let solOwner = solanaSession?.address;
          if (!solOwner) {
            try {
              const session = await connectSolana();
              solOwner = session.address;
            } catch (error) {
              showAppToast(
                error instanceof Error ? error.message : 'Connect Phantom to fund from Solana.',
                'error',
              );
              setIsProcessing(false);
              return;
            }
          }

          if (isDevnetEnv) {
            const phantom = getPhantom();
            if (!phantom?.publicKey || !phantom.signTransaction) {
              showAppToast('Phantom must support signTransaction for Solana Devnet deposits.', 'error');
              setIsProcessing(false);
              return;
            }
            const phantomSigner = {
              publicKey: {
                toBytes: () => new PublicKey(solOwner!).toBytes(),
                toString: () => solOwner!,
              },
              signTransaction: (tx: Transaction) => phantom.signTransaction!(tx),
              signAndSendTransaction: phantom.signAndSendTransaction
                ? (tx: Transaction) => phantom.signAndSendTransaction!(tx)
                : undefined,
            };
            const depositSol = tokenSym === 'SOL';
            showAppToast(
              depositSol
                ? 'Depositing SOL into Siphon Solana Devnet vault…'
                : 'Depositing USDC into Siphon Solana Devnet vault…',
              'info',
            );
            const amountBase = depositSol
              ? solToLamports(transactionInput.amount)
              : usdcToBaseUnitsDevnet(transactionInput.amount);
            // ZK vault is the product path; the FHE deposit functions stay exported for archaeology.
            const zkMode = isSolanaZkMode();
            const native = zkMode
              ? depositSol
                ? await depositWsolZk({ phantom: phantomSigner, lamports: amountBase })
                : await depositUsdcZk({ phantom: phantomSigner, amountBaseUnits: amountBase })
              : depositSol
                ? await depositWsolSolanaDevnet({
                    phantom: phantomSigner,
                    lamports: amountBase,
                  })
                : await depositUsdcSolanaDevnet({
                    phantom: phantomSigner,
                    amountBaseUnits: amountBase,
                  });
            try {
              appendUserActivity(solOwner!, {
                kind: 'deposit',
                chainId: SOLANA_DEVNET_CHAIN_ID,
                token: tokenSym,
                amount: transactionInput.amount,
                txHash: native.signature,
                status: 'confirmed',
                label: `Solana Devnet deposit ${transactionInput.amount} ${tokenSym}`,
                noteKey: `solana-devnet-${native.commitmentHex}`,
              });
            } catch { /* activity log best-effort */ }
            recordDepositOnCursor({
              chainId: SOLANA_DEVNET_CHAIN_ID,
              symbol: tokenSym,
              commitment: native.commitmentHex,
              value: amountBase,
              txHash: native.signature,
              noteKey: `solana-devnet-${native.commitmentHex}`,
            });
            showAppToast(
              zkMode
                ? `Deposited ${transactionInput.amount} ${tokenSym} into the ZK vault (${native.signature.slice(0, 8)}…). Private balance updates from your encrypted notes.`
                : `Deposited ${transactionInput.amount} ${tokenSym} on Solana Devnet (${native.signature.slice(0, 8)}…). Run a strategy in Builder to swap.`,
              'success',
            );

            const depAmt = Number(transactionInput.amount);
            if (Number.isFinite(depAmt) && depAmt > 0) {
              setSiphonVaultBalances((prev) => ({
                ...(prev ?? {}),
                [tokenSym]: (prev?.[tokenSym] ?? 0) + depAmt,
              }));
              setBalanceVerified(false);
            }

            setTransactionInput((prev) => ({ ...prev, amount: '' }));
            setIsProcessing(false);
            void fetchWalletBalances(SOLANA_DEVNET_CHAIN_ID);
            void fetchVaultBalances();
            return;
          }

          const usdcBal = walletBalances?.find((b) => b.symbol === 'USDC');
          const need = Number(transactionInput.amount);
          const have = usdcBal ? Number(usdcBal.balance ?? 0) : 0;
          const evmAlreadyFunded =
            Number.isFinite(have) && Number.isFinite(need) && have + 1e-9 >= need;

          showAppToast(
            evmAlreadyFunded
              ? 'Depositing USDC into Arbitrum vault…'
              : 'Opening Solana → Arbitrum USDC bridge…',
            'info',
          );

          const prelude = await prepareSolanaFundForDeposit({
            chain: productChain,
            amount: transactionInput.amount,
            solanaOwner: solOwner,
            recipient: wallet.address,
            evmAlreadyFunded,
          });
          depositChainId = prelude.custodyChainId;
          setActiveChainId(prelude.custodyChainId);

          if (prelude.kind === 'bridge_pending' || prelude.kind === 'native_solana') {
            showAppToast(prelude.message, 'info');
            setIsProcessing(false);
            return;
          }
          if (prelude.message) showAppToast(prelude.message, 'success');
        }

        if (v3Deployed(depositChainId)) {
          console.log('Depositing to Siphon Vault (v3)');
          const signer = getSigner();
          if (!signer) {
            showAppToast('Wallet not connected', 'error');
            setIsProcessing(false);
            return;
          }
          const tokens = getTokens(depositChainId);
          const tokenSymbol = transactionInput.token.toUpperCase();
          const tokenConfig = tokens[tokenSymbol];
          const tokenAddress = tokenConfig?.address || transactionInput.token;
          const decimals = tokenConfig?.decimals ?? (tokenSymbol === 'ETH' ? 18 : 6);
          const amountWei = ethers.parseUnits(transactionInput.amount, decimals);

          const result = await depositV3({
            chainId: depositChainId,
            token: tokenAddress,
            amount: amountWei,
            signer,
          });

          // Only the legacy handler.ts deposit/withdraw wrote to the activity log, so on every
          // v3 chain (Base, Sepolia) a successful deposit never appeared in Activity Log at all.
          // Best-effort: a logging failure must never surface as a failed deposit.
          try {
            appendUserActivity(wallet?.address ?? await signer.getAddress(), {
              kind: "deposit",
              chainId: depositChainId,
              token: tokenSymbol,
              amount: transactionInput.amount,
              txHash: result.txHash,
              status: "in checking",
              label: `Deposit ${transactionInput.amount} ${tokenSymbol}`,
              // Screening rows and a later ragequit are both keyed by this, so tagging it here is
              // what lets a recovery collapse into the deposit row instead of orphaning a new one.
              noteKey: v3NoteKey(depositChainId, tokenSymbol, result.commitment),
            });
          } catch { /* activity log is best-effort */ }

          showAppToast(`Deposited ${transactionInput.amount} ${transactionInput.token} (v3)`, 'success');
          setTransactionInput(prev => ({...prev, amount: ""}));
          invalidateLeafCache();
          await refreshVaultBalances();
        } else {
          console.log('Depositing to Siphon Vault (v2)');
          const result = await deposit(transactionInput.token, transactionInput.amount);

          if (result.success) {
            showAppToast(`Deposited ${transactionInput.amount} ${transactionInput.token}`, 'success');
            setTransactionInput(prev => ({...prev, amount: ""}));
            invalidateLeafCache();
            await refreshVaultBalances();
          } else {
            showAppToast(`Deposit failed: ${result.error}`, 'error');
          }
        }
      } else {
        // Solana Devnet ZK vault: commit publics → spend, paid straight to the recipient pubkey.
        if (isSolana && isDevnetEnv && isSolanaZkMode()) {
          // The Devnet select shows USDC for anything but SOL (e.g. an ETH pick carried over from Base).
          const tokenSym = transactionInput.token.toUpperCase() === 'SOL' ? 'SOL' : 'USDC';
          const phantom = getPhantom();
          const solOwner = solanaSession?.address ?? phantom?.publicKey?.toString();
          if (!phantom?.publicKey || !phantom.signTransaction || !solOwner) {
            showAppToast('Connect Phantom (with signTransaction) to withdraw on Solana Devnet.', 'error');
            setIsProcessing(false);
            return;
          }
          const phantomSigner = {
            publicKey: {
              toBytes: () => new PublicKey(solOwner).toBytes(),
              toString: () => solOwner,
            },
            signTransaction: (tx: Transaction) => phantom.signTransaction!(tx),
            signAndSendTransaction: phantom.signAndSendTransaction
              ? (tx: Transaction) => phantom.signAndSendTransaction!(tx)
              : undefined,
          };
          const amountBase = tokenSym === 'SOL'
            ? solToLamports(transactionInput.amount)
            : usdcToBaseUnitsDevnet(transactionInput.amount);
          showAppToast('Proving Solana ZK withdrawal…', 'info');
          const res = await withdrawZkSolana({
            phantom: phantomSigner,
            mint: tokenSym === 'SOL' ? NATIVE_MINT : undefined,
            amountBaseUnits: amountBase,
            recipient: transactionInput.recipient,
            onStatus: (m) => setWithdrawStatus(m),
          });
          setWithdrawStatus(null);
          try {
            appendUserActivity(solOwner, {
              kind: 'withdraw',
              chainId: SOLANA_DEVNET_CHAIN_ID,
              token: tokenSym,
              amount: transactionInput.amount,
              txHash: res.spendSignature,
              status: 'confirmed',
              label: `Solana Devnet withdraw ${transactionInput.amount} ${tokenSym}`,
            });
          } catch { /* activity log best-effort */ }
          showAppToast(
            `Withdrew ${transactionInput.amount} ${tokenSym} (${res.spendSignature.slice(0, 8)}…)`,
            'success',
          );
          setTransactionInput((prev) => ({ ...prev, amount: '' }));
          setIsProcessing(false);
          void fetchWalletBalances(SOLANA_DEVNET_CHAIN_ID);
          void fetchVaultBalances();
          return;
        }
        const token = transactionInput.token;
        const decimals = token === 'ETH' ? 18 : 6;
        let withdrawnValueStr = transactionInput.amount;
        if (feeQuote && feeQuote.feeWei > 0n) {
          if (feeQuote.belowMinimum) {
            showAppToast('Amount is below the minimum withdrawal — merge smaller notes first.', 'error');
            setIsProcessing(false);
            return;
          }
          if (feeQuote.feeExceedsAmount) {
            showAppToast('The withdrawal fee exceeds this amount. Withdraw a larger amount.', 'error');
            setIsProcessing(false);
            return;
          }
          withdrawnValueStr = ethers.formatUnits(feeQuote.withdrawnValueWei, decimals);
        }

        // The GROSS has to fit the balance, and nothing above checks that. `feeExceedsAmount` is
        // `gross <= fee`, which is a different question and passes comfortably here; the per-label
        // `withdrawCap` is about ASP association, not funds, and is null whenever its RPC read
        // fails. So an EXACT RECEIVE of the full balance solved to balance + fee and sailed through
        // to planWithdraw, which rejected it as "insufficient funds — have 24238, need 54239 of
        // asset 7490717508934632905…" — true, in minor units, naming an asset id, from four frames
        // deep. Say it in the units the user typed instead.
        const availableHuman = siphonVaultBalances?.[token] ?? 0;
        if (availableHuman > 0) {
          const grossWei = ethers.parseUnits(withdrawnValueStr, decimals);
          // String() on a JS number goes exponential below 1e-6 ("8.1e-7"), which parseUnits
          // rejects outright — that is the `invalid FixedNumber string value` this threw.
          const availableWei = ethers.parseUnits(toAmountString(availableHuman, decimals), decimals);
          if (grossWei > availableWei) {
            const feeHuman = feeQuote
              ? ethers.formatUnits(feeQuote.feeWei, decimals)
              : null;
            showAppToast(
              feeHuman && feeQuote && feeQuote.feeWei > 0n
                ? `Not enough ${token}: this needs ${withdrawnValueStr} (${transactionInput.amount} to you plus ${feeHuman} fee) but your vault holds ${displayAmount(availableHuman)}.`
                : `Not enough ${token}: this needs ${withdrawnValueStr} but your vault holds ${displayAmount(availableHuman)}.`,
              'error',
            );
            setIsProcessing(false);
            return;
          }
        }

        if (withdrawCap) {
          const withdrawWei = ethers.parseUnits(withdrawnValueStr, decimals);
          const maxWei = ethers.parseUnits(withdrawCap.maxSingleWithdraw, decimals);
          if (withdrawWei > maxWei) {
            showAppToast(
              `Amount exceeds spendable balance (${withdrawCap.maxSingleWithdraw} ${token}).`,
              'error',
            );
            setIsProcessing(false);
            return;
          }
        }

        if (v3Deployed(activeChainId)) {
          console.log('Withdrawing from Siphon Vault (v3)');
          const signer = getSigner();
          if (!signer) {
            showAppToast('Wallet not connected', 'error');
            setIsProcessing(false);
            return;
          }
          const tokens = getTokens(activeChainId);
          const tokenSymbol = transactionInput.token.toUpperCase();
          const tokenConfig = tokens[tokenSymbol];
          const tokenAddress = tokenConfig?.address || transactionInput.token;
          const amountWei = ethers.parseUnits(withdrawnValueStr, decimals);

          // Check the relay credit BEFORE proving. The shortfall is knowable up front, and a
          // withdraw proof is tens of seconds of CPU — failing afterwards with 402 spends all of
          // that to learn something we could have said immediately. Re-read rather than trusting
          // the panel's state: it is fetched on chain/wallet change and a top-up in another tab,
          // or a debit from a previous withdrawal, would leave it stale.
          //
          // Deliberately does NOT block when the credit state is unknown (null): the relayer may
          // be unreachable or charging nothing, and the exit must not depend on this lane —
          // spend() is permissionless. Only a KNOWN shortfall stops here.
          const creditNow = await fetchWithdrawCredit(activeChainId, signer);
          if (needsTopUp(creditNow) && creditNow) {
            setWithdrawCredit(creditNow);
            showAppToast(
              `Relay fee ${formatCredit(creditNow.feeWei, creditNow.decimals)} USDC is unpaid — ` +
                // A bridge proof pays the executor: self-submitting it would hand the executor the
                // funds with no order to bridge them, so that escape hatch is only for same-chain.
                (onHub && bridgeDest(receiveOn)
                  ? 'top up your credit first.'
                  : 'top up your credit first, or submit the proof yourself (that path costs only gas).'),
              'error',
            );
            setIsProcessing(false);
            return;
          }

          // Withdraw to another chain: the proof pays the executor (the quote's payee), which
          // bridges exactly what arrived — or refunds it on the vault chain if no route meets min_out.
          const dest = onHub ? bridgeDest(receiveOn) : undefined;
          let recipient = transactionInput.recipient;
          let bridge: BridgeOrderRequest | undefined;
          if (dest) {
            if (tokenSymbol !== 'USDC') throw new Error(`Only USDC can be sent to ${dest.label}.`);
            const minUnits = bridgeMinUnits(dest);
            if (amountWei < minUnits) throw new Error(`Sending to ${dest.label} needs at least ${Number(minUnits) / 1e6} USDC.`);
            if (!isValidDestAddress(dest.kind, recipient)) throw new Error(`That is not a valid ${dest.label} address.`);
            bridge = {
              to_chain_id: dest.id,
              to_address: recipient.trim(),
              to_token: dest.toToken,
              amount: amountWei.toString(),
              min_out: "1",
              refund_address: await signer.getAddress(),
            };
            const q = await bridgeQuote(bridge, activeChainId);
            bridge.min_out = minOutFrom(q.toAmountMin);
            recipient = q.payee;
            setBridgeOrder(null);
          }

          const result = await withdrawViaV3({
            chainId: activeChainId,
            token: tokenAddress,
            symbol: tokenSymbol,
            amount: amountWei,
            recipient,
            signer,
            screenToken: "",
            bridge,
          });

          if (result.bridgeOrderId) {
            void pollBridgeOrder(result.bridgeOrderId, setBridgeOrder, 10_000, activeChainId).catch(() => undefined);
          }

          try {
            appendUserActivity(wallet?.address ?? await signer.getAddress(), {
              kind: "withdraw",
              chainId: activeChainId,
              token: tokenSymbol,
              amount: transactionInput.amount,
              txHash: result.txHash,
              status: "confirmed",
              label: `Withdraw ${transactionInput.amount} ${tokenSymbol}${dest ? ` → ${dest.label}` : ''}`,
            });
          } catch { /* activity log is best-effort */ }

          showAppToast(
            dest
              ? `Withdrew ${transactionInput.amount} USDC — bridging to ${dest.label}`
              : `Withdrew ${transactionInput.amount} ${transactionInput.token} (v3)`,
            'success',
          );
          setTransactionInput(prev => ({...prev, amount: ""}));
          setFeeQuote(null);
          invalidateLeafCache();
          invalidateStateLeavesCache(activeChainId);
          // The withdrawal changed two more figures on this page: the public wallet received the
          // funds and the relayer debited its fee. Neither refreshed until the 2-minute poll.
          void fetchWalletBalances(activeChainId);
          void fetchWithdrawCredit(activeChainId, signer).then((c) => { if (c) setWithdrawCredit(c); });
          await refreshVaultBalances();
        } else {
          console.log('Withdrawing from Siphon Vault (v2)');
          const result = await withdraw(token, withdrawnValueStr, transactionInput.recipient, setWithdrawStatus);
          setWithdrawStatus(null);

          if (result.success) {
            const received = feeQuote && feeQuote.feeWei > 0n
              ? `${formatFeeAmount(feeQuote.recipientReceivesWei, token, activeChainId)} ${token} (after fee)`
              : `${transactionInput.amount} ${token}`;
            showAppToast(`Withdrew — recipient receives ${received}`, 'success');
            setTransactionInput(prev => ({...prev, amount: ""}));
            setFeeQuote(null);
            invalidateLeafCache();
            invalidateStateLeavesCache(activeChainId);
            await refreshVaultBalances();
          } else {
            showAppToast(`Withdraw failed: ${result.error}`, 'error');
          }
        }
      }
    } catch (error: unknown) {
      console.error('Transaction failed:', error);
      const raw = error instanceof Error ? error.message : 'Unknown error';
      // The pre-submit gross-vs-balance check is gated on a KNOWN balance and opts out silently
      // whenever refreshVaultBalances has reset state to {} mid-flight — which is precisely when
      // the card is still unconfirmed. The planner's raw minor-unit throw is then what the
      // user sees. Widening the guard to block on an unverified balance would fire on every
      // refresh, so make the backstop readable instead: the same fact, in the units they typed.
      const short = parseInsufficientFunds(raw);
      const sym = transactionInput.token;
      const dec = sym === 'ETH' ? 18 : 6;
      showAppToast(
        short
          ? `Not enough ${sym}: this withdrawal needs ${ethers.formatUnits(short.need, dec)} ${sym} ` +
            `(the amount plus the fee) but your private balance is ` +
            `${ethers.formatUnits(short.have, dec)} ${sym}. Deposit more, or withdraw less.`
          : `Transaction failed: ${raw}`,
        'error',
      );
    }

    setWithdrawStatus(null);
    setIsProcessing(false);
  };

  const handleExportNotes = async () => {
    const signer = getSigner();
    if (!signer) {
      showAppToast('Please connect wallet first', 'error');
      return;
    }
    setIsNotesBusy(true);
    try {
      const { file, filename, noteCount, unreadable } = await buildV3NoteBackup(activeChainId, signer);
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      // An unreadable row means a note exists that this backup does NOT contain; saying "backed up"
      // without that caveat is how a user discovers the gap only when they try to restore.
      showAppToast(
        unreadable > 0
          ? `Backed up ${noteCount} note(s) — ${unreadable} could not be read and are NOT in this file`
          : `Backed up ${noteCount} note(s)`,
        unreadable > 0 ? 'info' : 'success',
      );
    } catch (error) {
      console.error('Failed to export notes:', error);
      showAppToast(error instanceof Error ? error.message : 'Failed to export notes', 'error');
    } finally {
      setIsNotesBusy(false);
    }
  };

  const handleImportNotes = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const signer = getSigner();
    if (!signer) {
      showAppToast('Please connect wallet first', 'error');
      return;
    }
    setIsNotesBusy(true);
    try {
      const text = await file.text();
      const r = await importV3NoteBackup(activeChainId, signer, text);
      // Report every bucket. A bare "imported N" hides the case that matters: notes the file held
      // but this browser refused, which is exactly when the user needs to know something is wrong.
      const notes: string[] = [];
      if (r.skippedDuplicate) notes.push(`${r.skippedDuplicate} already present`);
      if (r.restoredSpent) notes.push(`${r.restoredSpent} already spent on-chain`);
      // Not an error and not lost — these belong to a previous vault deployment and are waiting on
      // migration. Saying nothing would read as "my notes vanished".
      if (r.skippedForeignVault) notes.push(`${r.skippedForeignVault} from an older vault (needs migration)`);
      if (r.failed) notes.push(`${r.failed} failed`);
      showAppToast(
        `Restored ${r.imported} note(s)${notes.length ? ` — ${notes.join(', ')}` : ''}`,
        r.failed > 0 ? 'info' : 'success',
      );
      if (r.imported > 0) {
        invalidateLeafCache();
        await refreshVaultBalances();
      }
    } catch (error) {
      console.error('Failed to import notes:', error);
      showAppToast(error instanceof Error ? error.message : 'Failed to import notes', 'error');
    } finally {
      setIsNotesBusy(false);
      e.target.value = '';
    }
  };

  const handleLegacyMigration = async () => {
    if (isMigrationBusy) return;
    const signer = getSigner();
    if (!signer) {
      showAppToast('Please connect wallet first', 'error');
      return;
    }
    if (!isLevel1TrustComplete(resolveTrustWallet(wallet?.address))) {
      showAppToast(LEVEL1_REQUIRED_MESSAGE, 'error');
      setDashPage('trust');
      return;
    }
    setIsMigrationBusy(true);
    try {
      const summary = await findLegacyMigrationNotes(signer, activeChainId, setMigrationStatus);
      setLegacySummary(summary);
      if (summary.notes.length === 0) return;
      const amountText = Object.entries(summary.totals)
        .map(([asset, amount]) => `${amount.toFixed(6)} ${asset}`)
        .join(' + ');
      const approved = window.confirm(
        `Migrate ${amountText} from the old vault?\n\n` +
        'The old withdrawal and new deposit are separate confirmed transactions. ' +
        'Your wallet address will be visible in both, so this recovery migration is linkable on-chain. ' +
        'If the new deposit fails, the withdrawn funds remain safely in your wallet.',
      );
      if (!approved) return;
      const result = await migrateLegacyNotes(summary.notes, signer, activeChainId, setMigrationStatus);
      invalidateLeafCache();
      await refreshVaultBalances();
      if (result.walletOnly.length > 0) {
        const held = result.walletOnly.map((item) => `${item.amount} ${item.asset}`).join(', ');
        showAppToast(`Old-vault withdrawal succeeded. ${held} remains in your wallet; deposit it normally to finish.`, 'error');
      }
      if (result.pendingAdmission.length > 0) {
        const pending = result.pendingAdmission.map((item) => `${item.amount} ${item.asset}`).join(', ');
        showAppToast(
          `${pending} reached the R2 vault, but ASP admission/root publication is pending. ` +
          'Do not retry the migration; retry admission or use rejected-note recovery.',
          'error',
        );
      }
      if (result.failed.length > 0) {
        const detail = result.failed
          .map((item) => `${item.amount} ${item.asset} — ${item.reason}`)
          .join(' ');
        showAppToast(
          result.migrated.length > 0
            ? `Migrated ${result.migrated.length} note(s). ${result.failed.length} could not be migrated: ${detail}`
            : `Could not migrate ${result.failed.length} note(s): ${detail}`,
          'error',
        );
      }
      if (
        result.walletOnly.length === 0 &&
        result.pendingAdmission.length === 0 &&
        result.failed.length === 0
      ) {
        showAppToast(`Migrated ${result.migrated.length} old-vault note(s) into the new private vault`, 'success');
      }
      // Re-scan rather than blanking the card: anything that failed is still sitting in the old
      // vault, and clearing unconditionally would hide funds the user still owns.
      try {
        setLegacySummary(await findLegacyMigrationNotes(signer, activeChainId));
      } catch (rescanError) {
        console.warn('[migration] post-migration rescan failed:', rescanError);
        setLegacySummary({ notes: [], totals: {} });
      }
    } catch (error) {
      console.error('[migration] failed:', error);
      showAppToast(`Migration stopped: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setMigrationStatus(null);
      setIsMigrationBusy(false);
    }
  };

  if (!wallet) {
    return (
      <div className={`userdash-view ${isLoaded ? 'loaded' : ''}`}>
        <div className="userdash-content-wrapper">
          <div className="userdash-empty-state">
            <h2>No Wallet Connected</h2>
            <p>
              Connect Wallet and pick your home chain — Solana, Arbitrum, Base, or a testnet (ETH, Tempo, Hyperliquid).
              Deposit will use that vault automatically.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`userdash-view ${isLoaded ? 'loaded' : ''}`}>
      <div className="userdash-content-wrapper">
        <div className="userdash-header">
          <div className="userdash-header-top">
            <h1 className="userdash-title">
              {dashPage === 'trust'
                ? 'Trust'
                : dashPage === 'backup'
                  ? 'Backup'
                  : dashPage === 'api-keys'
                    ? 'API Keys'
                    : 'User Dashboard'}
            </h1>
            <div className="userdash-header-actions">
              <div className="userdash-chain-toggle" role="group" aria-label="Network">
                <span className={`userdash-chain-slot${mainnetLocked ? ' userdash-chain-slot--locked' : ''}`}>
                  <button
                    type="button"
                    className={`strategy-modal-category-badge ${isMainnetEnv ? 'active' : 'inactive'}`}
                    onClick={handleSelectMainnet}
                    disabled={switchingChain || mainnetLocked}
                    aria-disabled={mainnetLocked}
                    title={mainnetLocked ? 'Solana has no mainnet' : "Mainnet — your home chain's vault"}
                  >
                    Mainnet
                  </button>
                  {mainnetLocked ? (
                    <span className="userdash-chain-lock" aria-hidden="true">
                      <ChainLockIcon />
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className={`strategy-modal-category-badge ${isDevnetEnv ? 'active' : 'inactive'}`}
                  onClick={() => void handleSelectSolanaDevnet()}
                  disabled={switchingChain}
                  title="Devnet — Siphon native Solana vault"
                >
                  Devnet
                </button>
                <button
                  type="button"
                  className="strategy-modal-category-badge inactive userdash-chain-switch"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      window.dispatchEvent(new Event('siphon:changeHomeChain'));
                    }
                  }}
                  title="Switch chain"
                  aria-label="Switch chain"
                >
                  <SwitchChainIcon />
                </button>
              </div>
              <button
                className="userdash-logout-button"
                onClick={handleLogout}
                title="Disconnect wallet"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Logout
              </button>
            </div>
          </div>
          <div className="userdash-page-toggle" role="group" aria-label="Dashboard page">
            <button
              type="button"
              className={`userdash-network-btn${dashPage === 'overview' ? ' active' : ''}`}
              onClick={() => setDashPage('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              className={`userdash-network-btn${dashPage === 'trust' ? ' active' : ''}`}
              onClick={() => setDashPage('trust')}
            >
              Trust
            </button>
            {isMobileLayout ? (
              <button
                type="button"
                className={`userdash-network-btn${dashPage === 'backup' ? ' active' : ''}`}
                onClick={() => setDashPage('backup')}
              >
                Backup
              </button>
            ) : null}
            {/* API tab is always open: Devnet claims a free key; paid Base/Arb still shows
                Coming Soon inside the panel when API_KEYS_COMING_SOON is set. */}
            <button
              type="button"
              className={`userdash-network-btn${dashPage === 'api-keys' ? ' active' : ''}${
                API_KEYS_COMING_SOON && !isDevnetEnv ? ' userdash-network-btn--soon' : ''
              }`}
              onClick={() => setDashPage('api-keys')}
              title={
                isDevnetEnv
                  ? 'Claim a free Solana Devnet API key'
                  : API_KEYS_COMING_SOON
                    ? 'Paid keys coming soon — switch to Devnet for a free key'
                    : 'Siphon API keys'
              }
            >
              API
              {API_KEYS_COMING_SOON && !isDevnetEnv ? (
                <span className="userdash-soon-tag">Soon</span>
              ) : null}
            </button>
          </div>
        </div>

        {dashPage === 'overview' && (
          <TrustNudge
            wallet={wallet?.address || null}
            onOpenTrust={() => setDashPage('trust')}
          />
        )}


        {dashPage === 'trust' ? (
          <TrustPanel wallet={wallet?.address || null} />
        ) : dashPage === 'api-keys' ? (
          <ApiKeysPanel
            chainId={activeChainId}
            walletConnected={walletConnected && !!wallet}
          />
        ) : dashPage === 'backup' ? (
          <div className="userdash-backup-page">
            <div className="userdash-side-stack userdash-side-stack--backup">
              <KeysPlusNotes
                tipIdPrefix="backup"
                openTip={openTip}
                toggleTip={toggleTip}
                isNotesBusy={isNotesBusy}
                onExportNotes={handleExportNotes}
                onImportNotes={handleImportNotes}
                importInputId="userdash-import-notes-backup"
                fheState={fheState}
                fheClientKey={fheClientKey}
                fheServerKey={fheServerKey}
                fheCopied={fheCopied}
                onCopyFheKey={(which) => void copyFheKey(which)}
                onGenerateKeys={() => { if (wallet?.address) void warmFheKeys(wallet.address).catch(() => {}); }}
              />
            </div>
          </div>
        ) : (
        <>
        <div className="userdash-balances">
          <div className="userdash-balance-card">
            <div className="userdash-balance-header">
              <h2 className="userdash-balance-title">Wallet Balance</h2>
              <span className="userdash-balance-network">{activeNetwork.badgeLabel}</span>
            </div>
            <div className="userdash-balance-content-multi">
              {walletBalances === null || walletBalanceLoading || switchingChain ? (
                <div className="userdash-balance-loading">Loading...</div>
              ) : walletBalances.length > 0 ? (
                walletBalances
                  .filter((bal) =>
                    isSolana
                      ? bal.symbol === 'SOL' || bal.symbol === 'USDC'
                      : bal.symbol === 'ETH' || bal.symbol === 'USDC',
                  )
                  .sort((a, b) => {
                    if (isSolana) {
                      if (a.symbol === 'SOL') return -1;
                      if (b.symbol === 'SOL') return 1;
                      return 0;
                    }
                    if (a.symbol === 'ETH') return -1;
                    if (b.symbol === 'ETH') return 1;
                    return 0;
                  })
                  .map((bal, index) => (
                    <div key={index} className="userdash-balance-item-multi">
                      <div className="userdash-balance-amount">
                        {displayAmount(bal.balance)}
                      </div>
                      <div className="userdash-balance-currency">{bal.symbol}</div>
                    </div>
                  ))
              ) : (
                <div className="userdash-balance-loading">Switch wallet to {activeNetwork.name}</div>
              )}
            </div>
            <div className="userdash-address userdash-address--in-card">
              <span className="userdash-address-label">Address</span>
              <span className="userdash-address-value">{formatAddress(wallet.address)}</span>
              <button
                className="userdash-copy-button"
                onClick={() => {
                  navigator.clipboard.writeText(wallet.address);
                  showAppToast('Address copied to clipboard', 'success');
                }}
                title="Copy address"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
          
          </div>

          <div className="userdash-balance-card">
            <div className="userdash-balance-header">
              <h2 className="userdash-balance-title">Private Balance</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={refreshVaultBalances}
                  disabled={isVaultRefreshing}
                  title="Refresh private balance"
                  aria-label="Refresh private balance"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: isVaultRefreshing ? 'default' : 'pointer',
                    opacity: isVaultRefreshing ? 0.5 : 0.8,
                    fontSize: 13,
                    padding: 0,
                    lineHeight: 1,
                    display: 'inline-flex',
                  }}
                >
                  <span style={{ display: 'inline-block', animation: isVaultRefreshing ? 'spin 0.8s linear infinite' : 'none' }}>↻</span>
                </button>
                {pendingBackups > 0 && (
                  <span
                    className="userdash-backup-badge"
                    title={`${pendingBackups} note(s) failed their cloud backup and are retrying. Your funds are safe locally; keep this tab open so the backup can complete.`}
                  >
                    ⟳ backing up {pendingBackups}
                  </span>
                )}
                <span className="userdash-balance-network">{activeNetwork.badgeLabel}</span>
              </div>
            </div>
            <div className="userdash-balance-content-multi">
              {/* Show the balance whenever we HAVE one — even mid-refresh — so a slow/hung RPC scan
                  can never hide a known balance behind a permanent "Updating…". The ↻ spinner in the
                  header already signals that a refresh is in flight. "Updating…" only shows when we
                  genuinely have nothing to display yet. */}
              {(() => {
                // The headline is SPENDABLE balance, so subtract what the ASP has not admitted.
                // The reconcile counts every leaf the wallet owns regardless of membership, which
                // is why a just-mined deposit used to appear instantly spendable — and then the
                // arming path, which skips unadmitted notes, disagreed with the number on screen.
                // Only subtract from a token we positively screened; an unreachable ASP leaves
                // screenRows empty and the headline unchanged rather than reading as a loss.
                //
                // `screenTotals.checking` now excludes ADMITTED notes still inside their ragequit
                // window (those are `.grace`). Subtracting those too is what made a 2.99 USDC
                // balance render as "0.01 USDC / 2.98 in review" for five minutes after every
                // swap: a swap mints a change note, the change note starts a fresh window, and the
                // change is the bulk of the balance. It was admitted and spendable the whole time.
                const pendingByToken = screenTotals.checking;
                const privateRows = siphonVaultBalances
                  ? Object.entries(spendableBalances(siphonVaultBalances, pendingByToken))
                      .filter(([symbol, amount]) => isPrivateBalanceToken(symbol, isSolana) && amount > 0)
                      .sort(([a], [b]) => privateBalanceSort(a, b, isSolana))
                  : [];
                const checkingRows = Object.entries(
                  Object.keys(screenTotals.checking).length > 0 ? screenTotals.checking : siphonCheckingBalances,
                )
                  .filter(([symbol, amount]) => isPrivateBalanceToken(symbol, isSolana) && amount > 0)
                  .sort(([a], [b]) => privateBalanceSort(a, b, isSolana));
                // Admitted, spendable, ragequit still open. Shown so the exit stays one click away,
                // but never subtracted from the headline above.
                const graceRows = Object.entries(screenTotals.grace)
                  .filter(([symbol, amount]) => isPrivateBalanceToken(symbol, isSolana) && amount > 0)
                  .sort(([a], [b]) => privateBalanceSort(a, b, isSolana));
                const flaggedRows = Object.entries(
                  Object.keys(screenTotals.flagged).length > 0 ? screenTotals.flagged : siphonFlaggedBalances,
                )
                  .filter(([symbol, amount]) => isPrivateBalanceToken(symbol, isSolana) && amount > 0)
                  .sort(([a], [b]) => privateBalanceSort(a, b, isSolana));
                // Render recoverable notes individually so each button carries the exact note key.
                // A checking note first obtains a deposit-bound ASP exit ticket; a flagged note
                // already has one and goes directly through the same revoked ragequit branch.
                const flaggedNotes = screenRows.filter((r) => r.phase === 'flagged');
                const checkingNotes = screenRows.filter((r) => r.phase === 'checking' && !r.admitted);
                const graceNotes = screenRows.filter((r) => r.phase === 'checking' && r.admitted);
                if (privateRows.length > 0 || checkingRows.length > 0 || graceRows.length > 0 || flaggedRows.length > 0) {
                  return (
                    <>
                      {/* Private balance — ASP-admitted (spendable, private) only; shown big and first. */}
                      {privateRows.length > 0 ? (
                        privateRows.map(([tokenSymbol, amount]) => (
                          <div key={`p-${tokenSymbol}`} className="userdash-balance-item-multi">
                            <div className="userdash-balance-amount">{displayAmount(amount)}</div>
                            <div className="userdash-balance-currency">{tokenSymbol}</div>
                          </div>
                        ))
                      ) : (
                        <div className="userdash-balance-item-multi userdash-balance-item-empty">
                          {/* "No private balance" directly above a card showing 0.01 ETH in review
                              reads as "your funds are gone" — the exact failure this balance work
                              exists to remove. Funds held in another bucket are still the user's
                              funds; only their SPENDABILITY differs, so say which it is. */}
                          <div className="userdash-balance-amount userdash-balance-amount--empty">
                            {checkingRows.length > 0
                              ? 'Nothing spendable yet'
                              : flaggedRows.length > 0 || graceRows.length > 0
                                ? 'Nothing privately spendable'
                                : 'No private balance'}
                          </div>
                        </div>
                      )}

                      {/* Secondary balances — small, below the private figure. Each only when non-empty. */}
                      {(flaggedRows.length > 0 || checkingRows.length > 0 || graceRows.length > 0) && (
                        <div className="userdash-secondary-balances">
                          {flaggedRows.length > 0 && (
                            <div className="userdash-secondary-balance-group userdash-secondary-balance-group--flagged">
                              <div className="userdash-secondary-balance-title">Flagged Balance</div>
                              {flaggedNotes.length > 0
                                ? flaggedNotes.map((r) => (
                                    <div key={`f-${r.noteKey}`} className="userdash-secondary-balance-row">
                                      <span className="userdash-secondary-balance-amount userdash-secondary-balance-amount--flagged">{r.amount}</span>
                                      <span className="userdash-secondary-balance-currency">{r.token}</span>
                                      <button
                                        type="button"
                                        className="userdash-review-ragequit"
                                        disabled={!!rqBusyKey}
                                        title="Ragequit — return this flagged deposit to your wallet, publicly"
                                        onClick={() => void handleBalanceRagequit(r)}
                                      >
                                        {rqBusyKey === r.noteKey ? 'Exiting…' : 'Ragequit'}
                                      </button>
                                    </div>
                                  ))
                                : flaggedRows.map(([tokenSymbol, amount]) => (
                                    <div key={`f-${tokenSymbol}`} className="userdash-secondary-balance-row">
                                      <span className="userdash-secondary-balance-amount userdash-secondary-balance-amount--flagged">{displayAmount(amount)}</span>
                                      <span className="userdash-secondary-balance-currency">{tokenSymbol}</span>
                                    </div>
                                  ))}
                            </div>
                          )}
                          {checkingRows.length > 0 && (
                            <div className="userdash-secondary-balance-group userdash-secondary-balance-group--review">
                              <div className="userdash-secondary-balance-title">In Review</div>
                              {checkingNotes.length > 0
                                ? checkingNotes.map((r) => (
                                    <div key={`c-${r.noteKey}`} className="userdash-secondary-balance-row">
                                      <span className="userdash-secondary-balance-amount userdash-secondary-balance-amount--review">{r.amount}</span>
                                      <span className="userdash-secondary-balance-currency">{r.token}</span>
                                      <button
                                        type="button"
                                        className="userdash-review-ragequit"
                                        disabled={!!rqBusyKey}
                                        title="Ragequit before admission — return this deposit publicly"
                                        onClick={() => void handleBalanceRagequit(r)}
                                      >
                                        {rqBusyKey === r.noteKey ? 'Preparing exit…' : 'Ragequit'}
                                      </button>
                                    </div>
                                  ))
                                : checkingRows.map(([tokenSymbol, amount]) => (
                                    <div key={`c-${tokenSymbol}`} className="userdash-secondary-balance-row">
                                      <span className="userdash-secondary-balance-amount userdash-secondary-balance-amount--review">{displayAmount(amount)}</span>
                                      <span className="userdash-secondary-balance-currency">{tokenSymbol}</span>
                                    </div>
                                  ))}
                              <div className="userdash-secondary-balance-hint">Awaiting ASP admission — not spendable yet. Public ragequit stays available for five minutes after deposit.</div>
                            </div>
                          )}
                          {graceRows.length > 0 && (
                            <div className="userdash-secondary-balance-group userdash-secondary-balance-group--review">
                              {/* Counted in the headline above — this group is an ESCAPE HATCH, not a
                                  deduction. Labelling it "In Review" is what made an admitted balance
                                  read as withheld. */}
                              <div className="userdash-secondary-balance-title">Exit window open</div>
                              {graceNotes.length > 0
                                ? graceNotes.map((r) => (
                                    <div key={`g-${r.noteKey}`} className="userdash-secondary-balance-row">
                                      <span className="userdash-secondary-balance-amount userdash-secondary-balance-amount--review">{r.amount}</span>
                                      <span className="userdash-secondary-balance-currency">{r.token}</span>
                                      <button
                                        type="button"
                                        className="userdash-review-ragequit"
                                        disabled={!!rqBusyKey}
                                        title="Ragequit — return this deposit to your wallet publicly, while the window is open"
                                        onClick={() => void handleBalanceRagequit(r)}
                                      >
                                        {rqBusyKey === r.noteKey ? 'Preparing exit…' : 'Ragequit'}
                                      </button>
                                    </div>
                                  ))
                                : graceRows.map(([tokenSymbol, amount]) => (
                                    <div key={`g-${tokenSymbol}`} className="userdash-secondary-balance-row">
                                      <span className="userdash-secondary-balance-amount userdash-secondary-balance-amount--review">{displayAmount(amount)}</span>
                                      <span className="userdash-secondary-balance-currency">{tokenSymbol}</span>
                                    </div>
                                  ))}
                              <div className="userdash-secondary-balance-hint">Already spendable and included above. You can still exit publicly for five minutes after deposit.</div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  );
                }
                if (isVaultRefreshing) {
                  return <div className="userdash-balance-loading" style={{ opacity: 0.6, fontStyle: 'italic' }}>Updating...</div>;
                }
                // Reaching here means every bucket is empty. `balanceVerified` distinguishes
                // "confirmed you have nothing" from "we have not confirmed yet" — but neither is
                // allowed to replace a NUMBER, because by this point there is no number to show.
                // "Checking" only while we genuinely have not read local storage yet. Once that
                // read has completed, an empty result IS the answer — saying "checking" forever on
                // an empty wallet is the bug this replaced.
                if (!localRead && !balanceVerified) {
                  return (
                    <div className="userdash-balance-loading" style={{ opacity: 0.6, fontStyle: 'italic' }}>
                      Checking for notes…
                    </div>
                  );
                }
                return <div className="userdash-balance-loading">No funds detected</div>;
              })()}
            </div>
            <div className="userdash-balance-description">
              {Object.values(siphonFlaggedBalances).some((n) => n > 0)
                ? `Flagged funds are not private — recover them from Activity. Private balance is ASP-admitted.`
                : Object.values(siphonCheckingBalances).some((n) => n > 0)
                  ? `Private balance is ASP-admitted and privately withdrawable. In-review deposits are awaiting ASP admission.`
                  : `Your private vault balance on ${activeNetwork.name}`}
            </div>
          </div>

          <div className="userdash-balance-card userdash-balance-card--action">
            <div className="userdash-balance-header">
              <h2 className="userdash-balance-title">
                <span 
                  className={`userdash-mode-toggle ${isDepositMode ? 'active' : ''}`}
                  onClick={() => setIsDepositMode(true)}
                >
                  Deposit
                </span>
                {' / '}
                <span 
                  className={`userdash-mode-toggle ${!isDepositMode ? 'active' : ''}`}
                  onClick={() => setIsDepositMode(false)}
                >
                  Withdraw
                </span>
              </h2>
              {isDepositMode && isSolana ? (
                <InfoTip
                  id="deposit-help"
                  open={openTip === 'deposit-help'}
                  onToggle={toggleTip}
                  text={
                    isDevnetEnv
                      ? 'Deposit SOL or Siphon test USDC into the Solana vault only — no swap here. SOL is wrapped to WSOL inside the same transaction (the on-chain vault uses SPL tokens). Swaps run when you arm a strategy in Builder.'
                      : 'Deposit bridges Solana USDC → Arbitrum, then vaults it. If the bridge is still open, confirm in Phantom and press Confirm again.'
                  }
                />
              ) : null}
            </div>
            <div className="userdash-transaction-content">
              <div className="userdash-input-group">
                <div className="userdash-amount-field">
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="Amount"
                    value={transactionInput.amount}
                    onChange={(e) => {
                      setTransactionInput(prev => ({...prev, amount: e.target.value}));
                    }}
                    className="userdash-input userdash-input--amount"
                  />
                  <button
                    type="button"
                    className="userdash-max-button"
                    onClick={handleMaxAmount}
                    disabled={isProcessing}
                    title={isDepositMode ? 'Use max wallet balance' : 'Use max vault balance'}
                  >
                    Max
                  </button>
                </div>
                <select
                  value={
                    isSolana
                      ? (transactionInput.token === 'SOL' || transactionInput.token === 'USDC'
                          ? transactionInput.token
                          : 'USDC')
                      : transactionInput.token
                  }
                  onChange={(e) => {
                    setTransactionInput(prev => ({...prev, token: e.target.value}));
                  }}
                  className="userdash-select"
                  disabled={isSolana && !isDevnetEnv}
                >
                  {(isSolana && isDevnetEnv
                    ? ['SOL', 'USDC']
                    : isSolana
                      ? ['USDC']
                      : Object.keys(TOKEN_MAP).filter(
                          (tokenSymbol) => tokenSymbol === 'ETH' || tokenSymbol === 'USDC',
                        )
                  ).map((tokenSymbol) => (
                      <option key={tokenSymbol} value={tokenSymbol} style={{ fontSize: '0.8em' }}>
                        {tokenSymbol}
                      </option>
                    ))}
                </select>
              </div>
              {!isDepositMode && onHub && (
                <ReceiveOnFields
                  vaultLabel={activeNetwork.name}
                  vaultChainId={activeChainId}
                  receiveOn={receiveOn}
                  onReceiveOn={handleReceiveOn}
                  amount={transactionInput.amount}
                  recipient={transactionInput.recipient}
                  refundAddress={wallet.address}
                  order={bridgeOrder}
                />
              )}
              {!isDepositMode && (
                <div className="userdash-input-group">
                  <input
                    type="text"
                    placeholder={onHub && bridgeDest(receiveOn) ? `${bridgeDest(receiveOn)!.label} address` : "Recipient Address"}
                    value={transactionInput.recipient}
                    onChange={(e) => {
                      setTransactionInput(prev => ({...prev, recipient: e.target.value}));
                    }}
                    className="userdash-input"
                  />
                </div>
              )}
              {/* A dormant fee module (enabled=false on-chain) quotes feeWei=0, which used to render
                  nothing at all — indistinguishable from "fee estimation is broken". Say so instead. */}
              {/* Wording depends on whether a relay fee is also shown. Saying "No withdrawal fee"
                  directly above "Relay fee 0.05 USDC" reads as a contradiction even though both are
                  true — this line is the ON-CHAIN quote (v3 kernel has no fee module) and the relay
                  fee comes from prepaid credit, not from the withdrawal. State what the recipient
                  gets and where the fee is NOT taken from, instead of asserting there is no fee. */}
              {!isDepositMode && feeQuote && feeQuote.feeWei === 0n && !feeQuoting && (
                <div className="userdash-fee-quoting">
                  {withdrawCredit?.enabled && withdrawCredit.feeWei > 0n ? (
                    <>
                      Recipient receives{' '}
                      {formatFeeAmount(feeQuote.recipientReceivesWei, transactionInput.token, activeChainId)}{' '}
                      {transactionInput.token} in full — nothing is deducted from the withdrawal.
                    </>
                  ) : (
                    <>
                      No withdrawal fee — recipient receives{' '}
                      {formatFeeAmount(feeQuote.recipientReceivesWei, transactionInput.token, activeChainId)}{' '}
                      {transactionInput.token}
                    </>
                  )}
                </div>
              )}
              {/* Relay fee (v3). Rendered SEPARATELY from the on-chain fee quote above, because it
                  does not come out of the withdrawal — the recipient still receives the full
                  amount and this is debited from a prepaid balance. Folding it into the quote
                  would misstate what the recipient gets, which is the bug that panel already
                  carries scars from. Shown only when the relayer actually charges. */}
              {!isDepositMode && withdrawCredit?.enabled && withdrawCredit.feeWei > 0n && (
                <div className="userdash-fee-quoting">
                  Relay fee {formatCredit(withdrawCredit.feeWei, withdrawCredit.decimals)} USDC
                  {', paid from your credit ('}
                  {formatCredit(withdrawCredit.balanceWei, withdrawCredit.decimals)} USDC{')'}
                  {needsTopUp(withdrawCredit) && (
                    <>
                      {' — '}
                      <button
                        type="button"
                        onClick={handleTopUpCredit}
                        disabled={toppingUp}
                        className="userdash-link-button"
                      >
                        {toppingUp ? 'Topping up…' : 'Top up'}
                      </button>
                      <div style={{ marginTop: 4, opacity: 0.75 }}>
                        This pays the relayer to submit for you. You can always withdraw without it
                        by submitting the proof yourself — that path costs only gas.
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* feeQuote === null means the quote THREW — the RPC did not answer. Both branches
                  above are gated on a non-null quote, so this used to render nothing and the whole
                  fee box silently disappeared, which reads as "this withdrawal is free" right next
                  to an enabled Confirm. An unknown fee has to look unknown. */}
              {!isDepositMode && !isSolana && !feeQuote && !feeQuoting && Number(transactionInput.amount) > 0 && (
                <div className="userdash-fee-quoting">
                  Couldn&apos;t estimate the withdrawal fee — the network didn&apos;t respond. The
                  amount you receive may be lower than shown; retry in a moment.
                </div>
              )}
              {!isDepositMode && feeQuote && feeQuote.feeWei > 0n && (
                <div className="userdash-fee-panel">
                  <div className="userdash-fee-modes">
                    <span
                      className={`userdash-fee-mode ${withdrawMode === 'send' ? 'active' : ''}`}
                      onClick={() => setWithdrawMode('send')}
                      title="Amount you enter is deducted from your balance; recipient gets amount minus fee"
                    >
                      Exact send
                    </span>
                    <span
                      className={`userdash-fee-mode ${withdrawMode === 'receive' ? 'active' : ''}`}
                      onClick={() => setWithdrawMode('receive')}
                      title="Amount you enter is what the recipient receives; fee is added on top"
                    >
                      Exact receive
                    </span>
                  </div>
                  {feeQuote.belowMinimum ? (
                    <div className="userdash-fee-warn">Below minimum withdrawal — merge smaller notes first.</div>
                  ) : feeQuote.feeExceedsAmount ? (
                    <div className="userdash-fee-warn">Cost to withdraw exceeds the amount — withdraw more.</div>
                  ) : (
                    <div className="userdash-fee-breakdown">
                      <div className="userdash-fee-row">
                        <span>Withdraw amount</span>
                        <span>{formatFeeAmount(feeQuote.withdrawnValueWei, transactionInput.token, activeChainId)} {transactionInput.token}</span>
                      </div>
                      <div className="userdash-fee-row userdash-fee-sub">
                        <span>Protocol fee</span>
                        <span>− {formatFeeAmount(feeQuote.marginWei, transactionInput.token, activeChainId)} {transactionInput.token}</span>
                      </div>
                      <div className="userdash-fee-row userdash-fee-sub">
                        <span>Network / gas</span>
                        <span>− {formatFeeAmount(feeQuote.gasReimburseWei, transactionInput.token, activeChainId)} {transactionInput.token}</span>
                      </div>
                      <div className="userdash-fee-row userdash-fee-total">
                        <span>Recipient receives</span>
                        <span>{formatFeeAmount(feeQuote.recipientReceivesWei, transactionInput.token, activeChainId)} {transactionInput.token}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {!isDepositMode && feeQuoting && (
                <div className="userdash-fee-quoting">Estimating fee…</div>
              )}
              {isDepositMode && !isSolana && (
                <FundFromChain
                  onHub={onHub}
                  vaultChainId={activeChainId}
                  evmAddress={wallet.address}
                  solanaAddress={solanaSession?.address ?? null}
                  edge={homeEdge}
                  onArrived={(amount) => void handleFundArrived(amount)}
                />
              )}
              {(homeEdge === 4217 || receiveOn === 4217) && !isSolana && (
                <TempoEdgePanel evmAddress={wallet?.address} />
              )}
            </div>
            <button
              className="userdash-confirm-button"
              onClick={() => {
                if (isDepositMode && !level1Ok) {
                  setDashPage('trust');
                  return;
                }
                void handleConfirm();
              }}
              disabled={isProcessing}
              title={isDepositMode && !level1Ok ? LEVEL1_REQUIRED_MESSAGE : undefined}
            >
              {isProcessing ? (
                withdrawStatus ?? (isDepositMode ? 'Depositing...' : 'Withdrawing...')
              ) : isDepositMode && !level1Ok ? (
                'Level 1 Trust required'
              ) : isDepositMode && isSolana ? (
                isDevnetEnv
                  ? `Deposit ${transactionInput.token === 'SOL' ? 'SOL' : 'USDC'} (Solana vault)`
                  : 'Deposit USDC (Solana → Arb)'
              ) : (
                'Confirm'
              )}
            </button>
          </div>
        </div>

        <div className="userdash-bottom-row">
          <div className="userdash-activity-card">
            <div className="userdash-balance-header">
              <h2 className="userdash-balance-title">Activity Log</h2>
            </div>
            <p className="userdash-activity-description">
              Deposits, withdrawals, and strategy runs for your wallet.
            </p>
            <ActivityLog
              walletAddress={
                isDevnetEnv
                  ? (solanaSession?.address ??
                    walletManager.getConnectedWallets().find((w) => w.id === 'solana')?.address ??
                    wallet.address)
                  : wallet.address
              }
              chainId={activeChainId}
            />
          </div>

          <div className="userdash-side-stack">
            {Boolean(LEGACY_VAULTS[activeChainId]) && legacySummary && legacySummary.notes.length > 0 && (
              <div className="userdash-notes-card userdash-migration-card">
                <div className="userdash-balance-header">
                  <h2 className="userdash-balance-title">Old Vault Recovery</h2>
                </div>
                <p className="userdash-notes-description">
                  {Object.entries(legacySummary.totals)
                    .map(([asset, amount]) => `${amount.toFixed(6)} ${asset}`)
                    .join(' + ')} still in the pre-ASP vault. Withdraw and re-deposit into the
                  current vault. This recovery path is linkable on-chain.
                </p>
                <div className="userdash-notes-actions">
                  <button
                    type="button"
                    className="userdash-notes-button userdash-notes-button--primary userdash-migration-button"
                    onClick={() => void handleLegacyMigration()}
                    disabled={isMigrationBusy || isProcessing}
                  >
                    {isMigrationBusy ? (migrationStatus ?? 'Checking old vault…') : 'Migrate old funds'}
                  </button>
                </div>
              </div>
            )}

            <div className="userdash-overview-backup">
              <KeysPlusNotes
                tipIdPrefix="overview"
                openTip={openTip}
                toggleTip={toggleTip}
                isNotesBusy={isNotesBusy}
                onExportNotes={handleExportNotes}
                onImportNotes={handleImportNotes}
                importInputId="userdash-import-notes"
                fheState={fheState}
                fheClientKey={fheClientKey}
                fheServerKey={fheServerKey}
                fheCopied={fheCopied}
                onCopyFheKey={(which) => void copyFheKey(which)}
                onGenerateKeys={() => { if (wallet?.address) void warmFheKeys(wallet.address).catch(() => {}); }}
              />
            </div>
          </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
