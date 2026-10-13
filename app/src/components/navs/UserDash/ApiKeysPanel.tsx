'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clearPendingPurchase,
  confirmApiKeyPurchase,
  newDeliveryKey,
  fetchCreditPacks,
  loadPendingPurchase,
  formatUsdcMinor,
  listWalletApiKeys,
  payApiCreditPack,
  savePendingPurchase,
  usdcDollarsToMinor,
  type CreditPack,
  type PendingPurchase,
  type KeySummary,
  type PurchaseResult,
  claimDevnetApiKey,
  DEVNET_API_CHAIN_ID,
  type DevnetKeyResult,
} from '../../../lib/apiKeys';
import { connectPhantom, getPhantom } from '../../../lib/chains/solanaWallet';
import { walletActionError } from '../../../lib/walletRejection';
import { showAppToast } from '../../../lib/appToast';
import { TRUST_TOS_EVENT } from '../../../lib/tosAcceptance';
import { assertLevel1Trust, isLevel1TrustComplete, LEVEL1_REQUIRED_MESSAGE } from '../../../lib/trustLevel1';
import { walletManager } from '../../extensions/walletManager';
import { API_KEYS_COMING_SOON } from '../../../lib/apiKeysFlag';

type Props = {
  chainId: number;
  walletConnected: boolean;
};

const CUSTOM_ID = 'custom';

export default function ApiKeysPanel({ chainId, walletConnected }: Props) {
  // Free Devnet claim + MCP setup stay open even while paid Base/Arb keys are "coming soon".
  // Paid purchase still early-returns above every pack/list/wallet hook so a locked surface
  // makes no network calls and asks for no signatures.
  if (chainId === DEVNET_API_CHAIN_ID) return <ApiKeysDevnet />;
  if (API_KEYS_COMING_SOON) return <ApiKeysComingSoon />;
  if (!API_KEY_CHAINS.has(chainId)) return <ApiKeysWrongChain />;

  return <ApiKeysPanelLive chainId={chainId} walletConnected={walletConnected} />;
}

/** Keys are sold for USDC on the EVM vault chains the gateway serves. */
const API_KEY_CHAINS = new Set([8453, 42161]);

function ApiKeysWrongChain() {
  return (
    <div className="userdash-notes-card userdash-api-card userdash-api-page">
      <div className="userdash-balance-header">
        <span className="userdash-balance-title">SIPHON API</span>
      </div>
      <p className="userdash-api-soon-lead">
        Paid keys ship on Base / Arbitrum (coming soon). Solana Devnet keys are free now — switch
        the dashboard to Devnet for AI-agent setup or a Devnet API key.
      </p>
    </div>
  );
}

function ApiInfoTip({
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

/** Devnet: claim key up top, then MCP setup for agents. */
function ApiKeysDevnet() {
  const [key, setKey] = useState<DevnetKeyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState<string | null>(null);
  const toggleInfo = (id: string) => setInfoOpen((cur) => (cur === id ? null : id));

  const onClaim = async () => {
    setBusy(true);
    setError(null);
    try {
      const { address } = await connectPhantom();
      const phantom = getPhantom();
      if (!phantom?.signMessage) throw new Error('This wallet cannot sign messages; use Phantom.');
      setKey(await claimDevnetApiKey(address, async (m) => (await phantom.signMessage!(m, 'utf8')).signature));
    } catch (e) {
      setError(walletActionError(e, 'Could not claim a Devnet key.'));
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key.api_key);
      showAppToast('API key copied', 'success');
    } catch {
      showAppToast('Clipboard copy failed', 'error');
    }
  };

  return (
    <div className="userdash-notes-card userdash-api-card userdash-api-page">
      <div className="userdash-api-cols">
        <section className="userdash-api-col" aria-labelledby="userdash-api-key-claim-title">
          <div className="userdash-balance-header">
            <h2 className="userdash-balance-title" id="userdash-api-key-claim-title">
              Siphon API
            </h2>
            <div className="userdash-api-col-meta">
              <span className="userdash-api-devnet-badge">Devnet · Temporary Free</span>
              <ApiInfoTip
                id="devnet-key"
                open={infoOpen === 'devnet-key'}
                onToggle={toggleInfo}
                text={`One free key per Phantom wallet (chain ${DEVNET_API_CHAIN_ID}). Sign once — no payment. Claiming again replaces the previous key. The key moves nothing by itself; every deposit and withdrawal still needs your wallet.`}
              />
            </div>
          </div>
          <p className="userdash-api-soon-lead">
            Private deposits, payouts, swaps and encrypted limit orders on Solana Devnet — claim a
            Devnet API key for your own scripts.
          </p>
          {key ? (
            <div className="userdash-api-key-slot userdash-api-key-slot--filled">
              <code className="userdash-api-key-slot-value" title={key.api_key}>
                {key.api_key}
              </code>
              <div className="userdash-api-key-slot-actions">
                <button
                  type="button"
                  className="userdash-copy-button"
                  onClick={() => void copyKey()}
                  title="Copy key"
                  aria-label="Copy key"
                >
                  <CopyIcon />
                </button>
                <button
                  type="button"
                  className="userdash-copy-button"
                  onClick={() => void onClaim()}
                  disabled={busy}
                  title="Regenerate Devnet key"
                  aria-label="Regenerate Devnet key"
                >
                  <RestartIcon spin={busy} />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="userdash-api-key-slot userdash-api-key-slot--claim"
              onClick={() => void onClaim()}
              disabled={busy}
            >
              {busy ? 'Waiting for Phantom…' : 'Claim Devnet key'}
            </button>
          )}
          {error && <p className="userdash-api-error">{error}</p>}
        </section>

        <AgentSetup infoOpen={infoOpen} onToggleInfo={toggleInfo} />
      </div>
    </div>
  );
}

/** The npm package the setup commands install. */
const MCP_PACKAGE = 'siphon-mcp';

const AGENTS = {
  claude: {
    label: 'Claude Code',
    command: `claude mcp add siphon --scope user -- npx -y ${MCP_PACKAGE}`,
    after:
      'Start claude and run /mcp to see siphon connected. The starter prompts below are also built in: /mcp__siphon__start, /mcp__siphon__first-private-payment, /mcp__siphon__encrypted-limit-order.',
    config: null as string | null,
  },
  codex: {
    label: 'Codex',
    command: `codex mcp add siphon -- npx -y ${MCP_PACKAGE}`,
    after:
      'Codex gives a server 10 s to start and a tool 60 s to answer; a first install and a first private payment (it downloads the proving circuits once) need longer. Add startup_timeout_sec = 60 and tool_timeout_sec = 300 to the [mcp_servers.siphon] table that command wrote to ~/.codex/config.toml, or skip the command and paste this whole entry. Then run /mcp in codex to check:',
    config: `[mcp_servers.siphon]\ncommand = "npx"\nargs = ["-y", "${MCP_PACKAGE}"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 300`,
  },
} as const;

const STARTER_PROMPTS = [
  'Show my Siphon Devnet wallet and private balance, and tell me how to fund the wallet.',
  'Deposit 0.05 SOL privately into Siphon, wait until it is spendable, then pay 0.02 SOL privately to a brand-new address and show me the explorer link.',
  'Swap 0.02 SOL to USDC privately with Siphon and tell me when the USDC is back in my private balance.',
  'Get the SOL price, then place a private Siphon order selling 0.02 SOL if SOL rises 5% above it, expiring in 24 hours.',
  'List my Siphon orders, claim anything that filled, and cancel the ones still waiting.',
];

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    showAppToast(`${what} copied`, 'success');
  } catch {
    showAppToast('Clipboard copy failed', 'error');
  }
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function RestartIcon({ spin = false }: { spin?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spin ? 'userdash-icon-spin' : undefined}
      aria-hidden
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function CopyableCode({ text, label }: { text: string; label: string }) {
  return (
    <div className="userdash-agent-code-card">
      <pre className="userdash-agent-code">{text}</pre>
      <button
        type="button"
        className="userdash-copy-button userdash-agent-code-copy"
        onClick={() => void copyText(text, label)}
        title={`Copy ${label.toLowerCase()}`}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        <CopyIcon />
      </button>
    </div>
  );
}

/** Claude Code / Codex MCP setup. */
function AgentSetup({
  infoOpen,
  onToggleInfo,
}: {
  infoOpen: string | null;
  onToggleInfo: (id: string) => void;
}) {
  const [agent, setAgent] = useState<keyof typeof AGENTS>('claude');
  const a = AGENTS[agent];
  return (
    <section className="userdash-api-col userdash-agent" aria-labelledby="userdash-agent-title">
      <div className="userdash-agent-header">
        <div className="userdash-balance-header">
          <h2 id="userdash-agent-title" className="userdash-balance-title">
            Use with AI agents
          </h2>
          <ApiInfoTip
            id="agent-setup"
            open={infoOpen === 'agent-setup'}
            onToggle={onToggleInfo}
            text={`${a.after} Siphon MCP runs on your machine: first use mints a Devnet wallet and key locally — note secrets and proofs never leave the host.`}
          />
        </div>
      </div>

      <div className="userdash-agent-tabs" role="tablist" aria-label="Agent">
        {(Object.keys(AGENTS) as (keyof typeof AGENTS)[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={agent === id}
            className={`userdash-agent-tab${agent === id ? ' userdash-agent-tab--active' : ''}`}
            onClick={() => setAgent(id)}
          >
            {AGENTS[id].label}
          </button>
        ))}
      </div>

      <CopyableCode text={a.command} label="Command" />
      {a.config && (
        <>
          <span className="userdash-agent-step-label">Timeouts config</span>
          <CopyableCode text={a.config} label="Config" />
        </>
      )}

      <details className="userdash-agent-prompts-details">
        <summary>Prompt examples</summary>
        <ul className="userdash-agent-prompts">
          {STARTER_PROMPTS.map((text) => (
            <li key={text}>
              <span>{text}</span>
              <button
                type="button"
                className="userdash-copy-button"
                onClick={() => void copyText(text, 'Prompt')}
                title="Copy prompt"
                aria-label="Copy prompt"
              >
                <CopyIcon />
              </button>
            </li>
          ))}
        </ul>
      </details>

      <p className="userdash-notes-description userdash-agent-footnote">
        Devnet only. Fund <code>siphon_wallet</code> from faucet.solana.com. Keep{' '}
        <code>~/.siphon-mcp</code> — it holds the note secrets that spend your private balance.
      </p>
    </section>
  );
}

function ApiKeysComingSoon() {
  return (
    <div className="userdash-notes-card userdash-api-card userdash-api-page">
      <div className="userdash-balance-header">
        <span className="userdash-balance-title">SIPHON API</span>
        <span className="userdash-api-soon-badge">COMING SOON</span>
      </div>
      <p className="userdash-api-soon-lead">
        Programmatic access to Siphon — private swaps, strategies and withdrawals from your own
        code, authenticated with a prepaid API key.
      </p>
      <p className="userdash-api-soon-note">
        Not open yet. Keys are not being sold, and no charge can be made from this page.
      </p>
    </div>
  );
}

function ApiKeysPanelLive({ chainId, walletConnected }: Props) {
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [collector, setCollector] = useState('');
  const [minCustomMinor, setMinCustomMinor] = useState(1_000_000);
  const [keys, setKeys] = useState<KeySummary[]>([]);
  const [selectedPack, setSelectedPack] = useState<string>('starter');
  const [customDollars, setCustomDollars] = useState('10');
  const [busy, setBusy] = useState(false);
  const [freshKey, setFreshKey] = useState<PurchaseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trustEpoch, setTrustEpoch] = useState(0);
  /** A payment that left the wallet but was never credited — see PendingPurchase. */
  const [pending, setPending] = useState<PendingPurchase | null>(null);

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
  }, [walletConnected]);

  const level1Ok = useMemo(
    () => isLevel1TrustComplete(walletManager.getPrimaryWallet()?.address),
    [walletConnected, trustEpoch],
  );


  const customMinor = useMemo(() => {
    try {
      return usdcDollarsToMinor(customDollars);
    } catch {
      return null;
    }
  }, [customDollars]);

  const activePack: CreditPack | null = useMemo(() => {
    if (selectedPack === CUSTOM_ID) {
      if (customMinor == null || customMinor < minCustomMinor) return null;
      return {
        id: CUSTOM_ID,
        label: 'Custom API credit',
        usdc_minor: customMinor,
        plan: 'custom',
      };
    }
    return packs.find((p) => p.id === selectedPack) ?? null;
  }, [selectedPack, packs, customMinor, minCustomMinor]);

  const refresh = useCallback(async () => {
    if (!walletConnected) {
      setKeys([]);
      return;
    }
    try {
      const packRes = await fetchCreditPacks();
      setPacks(packRes.packs);
      setCollector(packRes.collector);
      if (packRes.min_custom_usdc_minor) setMinCustomMinor(packRes.min_custom_usdc_minor);
      if (!selectedPack && packRes.packs[0]) setSelectedPack(packRes.packs[0].id);
      const listed = await listWalletApiKeys(chainId);
      setKeys(listed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [walletConnected, chainId, selectedPack]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A payment can outlive the tab that made it. Surface it as soon as we know the wallet, so the
  // user is never left with USDC gone and nothing to click.
  useEffect(() => {
    const addr = walletManager.getPrimaryWallet()?.address;
    setPending(addr ? loadPendingPurchase(chainId, addr) : null);
  }, [chainId, walletConnected, trustEpoch, freshKey]);

  const onBuy = async () => {
    if (!activePack) return;
    const addr = walletManager.getPrimaryWallet()?.address;
    try {
      // API access needs Level 1 (Terms + KYT) only; Level 2 zkKYC is not a gate.
      assertLevel1Trust(addr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : LEVEL1_REQUIRED_MESSAGE;
      setError(msg);
      showAppToast(msg, 'error');
      return;
    }
    setBusy(true);
    setError(null);
    setFreshKey(null);
    try {
      showAppToast(`Sending ${formatUsdcMinor(activePack.usdc_minor)} USDC from your wallet…`, 'info');
      const { pending: receipt } = await payApiCreditPack(chainId, activePack, collector);
      setPending(receipt);
      await claimPending(receipt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showAppToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Turn a paid receipt into a key. Separate from onBuy precisely so a failed confirm is
   * retryable without paying twice: the USDC is already spent, the hash is on disk, and this is
   * the only step left.
   */
  const claimPending = async (receipt: PendingPurchase) => {
    const addr = walletManager.getPrimaryWallet()?.address;
    // Receipts written before delivery keys existed have none. Mint one and write it back BEFORE
    // the first attempt: the gateway seals the minted key under whatever this claim presents, and
    // a later retry has to present the same one to open it.
    let claim = receipt;
    if (!claim.deliveryKey && addr) {
      claim = { ...claim, deliveryKey: newDeliveryKey() };
      savePendingPurchase(addr, claim);
      setPending(claim);
    }
    showAppToast('Payment sent — waiting for confirmations, then minting your key…', 'info');
    const purchased = await confirmApiKeyPurchase(
      chainId,
      claim.packId,
      claim.txHash,
      claim.packId === CUSTOM_ID ? claim.usdcMinor : undefined,
      {
        idempotencyKey: claim.idempotencyKey,
        deliveryKey: claim.deliveryKey,
        onWait: (n) => {
          if (n === 1) showAppToast('Payment is on-chain — waiting for it to settle…', 'info');
        },
      },
    );
    // Only now is the money actually credited; dropping the receipt any earlier loses the
    // ability to retry.
    if (addr) clearPendingPurchase(chainId, addr);
    setPending(null);
    setFreshKey(purchased);
    showAppToast('API key ready — copy it now; it is only shown once.', 'success');
    await refresh();
  };

  const onResume = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await claimPending(pending);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showAppToast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onDiscardPending = () => {
    const addr = walletManager.getPrimaryWallet()?.address;
    if (addr) clearPendingPurchase(chainId, addr);
    setPending(null);
  };

  const copyKey = async () => {
    if (!freshKey?.api_key) return;
    try {
      await navigator.clipboard.writeText(freshKey.api_key);
      showAppToast('API key copied', 'success');
    } catch {
      showAppToast('Clipboard copy failed', 'error');
    }
  };

  const minCustomDollars = minCustomMinor / 1_000_000;

  return (
    <div className="userdash-notes-card userdash-api-card userdash-api-page">
      <div className="userdash-balance-header">
        <h2 className="userdash-balance-title">Prepaid API credit</h2>
        <span className="userdash-fhe-status userdash-fhe-status--ready">
          {walletConnected ? 'Wallet pay' : 'Connect wallet'}
        </span>
      </div>
      <p className="userdash-notes-description">
        Buy prepaid API credit with a plain USDC transfer from your wallet (not your shielded vault).
        You get an <code>sk_…</code> key for agents/SDK; balance is credited 1:1 with the USDC you send.
      </p>

      {!walletConnected ? (
        <p className="userdash-notes-description">Connect a wallet to purchase or view keys.</p>
      ) : (
        <>
          <div className="userdash-api-packs">
            {packs.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`userdash-api-pack${selectedPack === p.id ? ' userdash-api-pack--active' : ''}`}
                onClick={() => setSelectedPack(p.id)}
                disabled={busy}
              >
                <span className="userdash-api-pack-label">{p.label}</span>
                <span className="userdash-api-pack-amount">{formatUsdcMinor(p.usdc_minor)} USDC</span>
              </button>
            ))}
            <button
              type="button"
              className={`userdash-api-pack userdash-api-pack--custom${selectedPack === CUSTOM_ID ? ' userdash-api-pack--active' : ''}`}
              onClick={() => setSelectedPack(CUSTOM_ID)}
              disabled={busy}
            >
              <span className="userdash-api-pack-label">Custom</span>
              <label className="userdash-api-custom-field" onClick={(e) => e.stopPropagation()}>
                <input
                  type="number"
                  min={minCustomDollars}
                  step="0.01"
                  inputMode="decimal"
                  value={customDollars}
                  onChange={(e) => {
                    setCustomDollars(e.target.value);
                    setSelectedPack(CUSTOM_ID);
                  }}
                  onFocus={() => setSelectedPack(CUSTOM_ID)}
                  disabled={busy}
                  className="userdash-api-custom-input"
                  aria-label="Custom USDC amount"
                />
                <span className="userdash-api-pack-amount">USDC</span>
              </label>
            </button>
          </div>

          {selectedPack === CUSTOM_ID && customMinor != null && customMinor < minCustomMinor && (
            <p className="userdash-api-error">Minimum custom credit is {minCustomDollars} USDC.</p>
          )}

          <div className="userdash-notes-actions">
            <button
              type="button"
              className="userdash-notes-button userdash-notes-button--primary"
              onClick={() => void onBuy()}
              disabled={busy || !activePack || !level1Ok}
              title={!level1Ok ? LEVEL1_REQUIRED_MESSAGE : undefined}
            >
              {busy
                ? 'Processing…'
                : !level1Ok
                  ? 'Complete Level 1 Trust first'
                : activePack
                  ? `Pay ${formatUsdcMinor(activePack.usdc_minor)} USDC & generate key`
                  : 'Pay & generate key'}
            </button>
            <button
              type="button"
              className="userdash-notes-button userdash-notes-button--secondary"
              onClick={() => void refresh()}
              disabled={busy}
            >
              Refresh
            </button>
          </div>

          {freshKey && (
            <div className="userdash-api-fresh">
              <p className="userdash-notes-description">
                New key (copy now — plaintext is not stored again):
              </p>
              <code className="userdash-fhe-key userdash-api-fresh-key">{freshKey.api_key}</code>
              <div className="userdash-notes-actions">
                <button
                  type="button"
                  className="userdash-notes-button userdash-notes-button--secondary"
                  onClick={() => void copyKey()}
                >
                  Copy key
                </button>
              </div>
              <p className="userdash-notes-description">
                Credit: {formatUsdcMinor(freshKey.balance_minor)} USDC · id {freshKey.api_key_id.slice(0, 8)}…
              </p>
            </div>
          )}

          <div className="userdash-api-list">
            <h3 className="userdash-api-list-title">Your keys</h3>
            {keys.length === 0 ? (
              <p className="userdash-notes-description">No keys for this wallet yet.</p>
            ) : (
              keys.map((k) => (
                <div key={k.api_key_id} className="userdash-fhe-row userdash-api-row">
                  <span className="userdash-fhe-label">{k.plan}</span>
                  <code className="userdash-fhe-key">{k.api_key_id}</code>
                  <span className="userdash-fhe-size">
                    {formatUsdcMinor(k.balance_minor)} USDC · {k.status}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* A payment that left the wallet but was never credited. Without this the receipt is
              saved and nobody can act on it, which is the same outcome as losing it. */}
          {pending && (
            <div className="userdash-api-pending">
              <p>
                <strong>{formatUsdcMinor(pending.usdcMinor)} USDC</strong> was sent for API credit
                but the key was never issued. Your payment is safe on-chain — claiming it again
                does not charge you twice.
              </p>
              <p className="userdash-api-pending-tx">
                <code>{pending.txHash}</code>
              </p>
              <div className="userdash-api-pending-actions">
                <button type="button" onClick={onResume} disabled={busy}>
                  {busy ? 'Claiming…' : 'Claim my key'}
                </button>
                <button type="button" onClick={onDiscardPending} disabled={busy}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {error && <p className="userdash-api-error">{error}</p>}
        </>
      )}
      <p className="userdash-notes-description">
        Using Claude Code or Codex? The Siphon MCP server runs on Devnet — switch the dashboard to
        Devnet for the setup commands and starter prompts.
      </p>
    </div>
  );
}
