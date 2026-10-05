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
        API keys are bought with USDC on Base or Arbitrum, or free on Solana Devnet. Switch the
        dashboard to Mainnet and pick one of those vaults, or to Devnet, to get a key.
      </p>
    </div>
  );
}

/** Free Devnet key: no payment, one per Solana wallet, signed with Phantom. */
function ApiKeysDevnet() {
  const [key, setKey] = useState<DevnetKeyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <div className="userdash-balance-header">
        <h2 className="userdash-balance-title">Siphon API · Devnet</h2>
        <span className="userdash-fhe-status userdash-fhe-status--ready">Free</span>
      </div>
      <p className="userdash-notes-description">
        A free API key for Solana Devnet (chain {DEVNET_API_CHAIN_ID}): private deposits, swaps,
        strategies and withdrawals from your own code. One Phantom signature, no payment.
      </p>
      <p className="userdash-notes-description">
        One key per wallet: claiming again replaces your previous key, so a lost key is never a
        lockout. The key moves nothing on its own; every deposit and withdrawal still needs your wallet.
      </p>
      <div className="userdash-notes-actions">
        <button
          type="button"
          className="userdash-notes-button userdash-notes-button--primary"
          onClick={() => void onClaim()}
          disabled={busy}
        >
          {busy ? 'Waiting for Phantom…' : key ? 'Replace with a new key' : 'Claim free Devnet key'}
        </button>
      </div>

      {key && (
        <div className="userdash-api-fresh">
          <p className="userdash-notes-description">
            New key (copy now — plaintext is not stored again):
          </p>
          <code className="userdash-fhe-key userdash-api-fresh-key">{key.api_key}</code>
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
            Send it as <code>Authorization: Bearer …</code> to{' '}
            <code>https://api-gateway-production-41e4.up.railway.app/v1</code>{' '}
            with <code>chain_id {DEVNET_API_CHAIN_ID}</code> · id {key.api_key_id.slice(0, 8)}…
            {key.revoked_previous > 0 ? ' · your previous Devnet key no longer works' : ''}
          </p>
        </div>
      )}
      {error && <p className="userdash-api-error">{error}</p>}
      <AgentSetup />
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

/** Claude Code / Codex setup for the Siphon MCP, plus prompts to start with. Devnet only. */
function AgentSetup() {
  const [agent, setAgent] = useState<keyof typeof AGENTS>('claude');
  const a = AGENTS[agent];
  return (
    <div className="userdash-agent">
      <h3 className="userdash-api-list-title">Use with AI agents</h3>
      <p className="userdash-notes-description">
        The Siphon MCP server gives Claude Code or Codex private deposits, payouts, swaps and
        encrypted limit orders on Devnet. It runs on your machine: it makes its own Devnet wallet
        and free key on first use, and note secrets and proofs never leave it.
      </p>
      <div className="userdash-fee-modes" role="tablist">
        {(Object.keys(AGENTS) as (keyof typeof AGENTS)[]).map((id) => (
          <span
            key={id}
            role="tab"
            tabIndex={0}
            aria-selected={agent === id}
            className={`userdash-fee-mode${agent === id ? ' active' : ''}`}
            onClick={() => setAgent(id)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setAgent(id)}
          >
            {AGENTS[id].label}
          </span>
        ))}
      </div>
      <pre className="userdash-agent-code">{a.command}</pre>
      <button type="button" className="userdash-link-button userdash-agent-copy" onClick={() => void copyText(a.command, 'Command')}>
        Copy command
      </button>
      <p className="userdash-notes-description">{a.after}</p>
      {a.config && (
        <>
          <pre className="userdash-agent-code">{a.config}</pre>
          <button type="button" className="userdash-link-button userdash-agent-copy" onClick={() => void copyText(a.config!, 'Config')}>
            Copy config
          </button>
        </>
      )}

      <h3 className="userdash-api-list-title">Prompts to start with</h3>
      <ul className="userdash-agent-prompts">
        {STARTER_PROMPTS.map((text) => (
          <li key={text}>
            <span>{text}</span>
            <button type="button" className="userdash-link-button userdash-agent-copy" onClick={() => void copyText(text, 'Prompt')}>
              Copy
            </button>
          </li>
        ))}
      </ul>
      <p className="userdash-notes-description">
        Devnet test tokens only. Fund the wallet the server prints (siphon_wallet) from faucet.solana.com,
        and keep ~/.siphon-mcp: it holds the note secrets that spend your private balance.
      </p>
    </div>
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
