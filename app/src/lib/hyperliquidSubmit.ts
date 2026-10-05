/**
 * Private Hyperliquid perp submission — rails behind PrivatePerps.
 *
 * A perp is a v5 payout order: the margin note is sealed to the enclave as a WITHDRAW to the
 * executor (buildV3Single with `payee`), and when the FHE trigger fires the executor's payout worker
 * carries margin to the executor's Hyperliquid account, where hyperliquid_watcher opens the
 * position. On close (take profit, stop loss, margin guard or the Close button) the position's own
 * margin + PnL − fees is paid to `exitTo` — the wallet's own address on Hyperliquid by default.
 *
 * Funding rails:
 *   Base (8453) + HL mainnet     → LI.FI to HyperCore (1337)
 *   HyperEVM Testnet (998) + HL testnet → CoreDepositWallet on 998 (Option A)
 *
 * The executor builds the funding destination itself (hyperliquid_client.prepare_strategy); the one
 * sent here only has to match it for the quote that names the payee.
 */
import { ethers } from "ethers";
import { getSelectedChainId, getTokens, getZkWithdrawRecipient } from "./networks";
import { getSigner } from "./nexus";
import { getTradeExecutorBaseUrl } from "./tradeExecutorClient";
import { bridgeQuote } from "./bridge/hub";
import { collectArmingFee } from "./multiLegBuilder";
import { createExecutorSubmitV3 } from "./v3/executorSubmitV3";
import { v3StrategiesLive } from "./v3/configV3";
import {
  submitEncryptedStrategy,
  type SubmitCallbacks,
  type SubmitResult,
} from "./strategySubmit";

/** Base vault → LI.FI → HyperCore mainnet. */
export const PERPS_VAULT_BASE = 8453;
/** HyperEVM Testnet vault → CoreDeposit → HyperCore testnet (Option A). */
export const PERPS_VAULT_HYPEREVM_TESTNET = 998;
export const PERPS_VAULT_CHAIN_IDS = [PERPS_VAULT_BASE, PERPS_VAULT_HYPEREVM_TESTNET] as const;
/** LI.FI's id for HyperCore, where the margin lands and (by default) the payout goes. */
export const HYPERLIQUID_CHAIN_ID = 1337;
const FUNDING_SLIPPAGE_BPS = 100;

export type HlSide = "LONG" | "SHORT";

export interface HyperliquidTrigger {
  mode: "now" | "threshold";
  direction?: "above" | "below";
  /** USD mark threshold when mode === "threshold". */
  priceUsd?: number;
}

export interface HyperliquidConfig {
  enabled: boolean;
  network: "mainnet" | "testnet";
  account?: string;
  min_notional_usd: number;
  payout_chains: number[];
  withdraw_fee_usd: number;
  max_leverage?: Record<string, number>;
}

export interface HyperliquidPerpParams {
  coin: string;
  side: HlSide;
  /** USDC margin taken from the vault on the selected home chain. */
  marginUsd: number;
  leverage?: number;
  takeProfitPx?: number;
  stopLossPx?: number;
  trigger: HyperliquidTrigger;
  /** Where the closed position is paid: HyperCore (default) or Arbitrum, to this wallet by default. */
  exitTo?: { to_chain_id: number; to_address: string };
  cb?: SubmitCallbacks & { onProof?: () => void; onLog?: (m: string) => void };
}

export function isPerpsVaultChain(chainId: number): boolean {
  return (PERPS_VAULT_CHAIN_IDS as readonly number[]).includes(chainId);
}

/** Option A: HyperEVM Testnet vault funds Hyperliquid testnet via CoreDeposit. */
export function isHyperevmTestnetPerps(chainId: number): boolean {
  return chainId === PERPS_VAULT_HYPEREVM_TESTNET;
}

export async function fetchHyperliquidConfig(
  coins: string[] = [],
  vaultChainId: number = PERPS_VAULT_BASE,
): Promise<HyperliquidConfig> {
  const base = getTradeExecutorBaseUrl(vaultChainId).replace(/\/$/, "");
  const qs = coins.length ? `?coins=${encodeURIComponent(coins.join(","))}` : "";
  const res = await fetch(`${base}/hyperliquid/config${qs}`);
  const body = (await res.json().catch(() => ({}))) as HyperliquidConfig & { error?: string };
  if (!res.ok) throw new Error(body.error || `Hyperliquid config HTTP ${res.status}`);
  return body;
}

export async function submitHyperliquidPerp(params: HyperliquidPerpParams): Promise<SubmitResult> {
  const { coin, side, marginUsd, leverage = 1, takeProfitPx, stopLossPx, trigger, cb } = params;
  const log = (m: string) => cb?.onLog?.(m);
  try {
    const chainId = getSelectedChainId();
    if (!isPerpsVaultChain(chainId) || !v3StrategiesLive(chainId)) {
      return {
        success: false,
        error:
          "Private perps fund from Base (mainnet) or HyperEVM Testnet — switch home chain and retry.",
      };
    }
    const symbol = coin.trim().toUpperCase();
    if (!symbol) return { success: false, error: "Pick a market (e.g. BTC)." };
    if (!(marginUsd > 0)) return { success: false, error: "Enter a positive USDC margin." };

    const signer = getSigner();
    if (!signer) return { success: false, error: "Connect your wallet first." };
    const wallet = (await signer.getAddress()).toLowerCase();

    const cfg = await fetchHyperliquidConfig([symbol], chainId);
    if (!cfg.enabled || !cfg.account) return { success: false, error: "Private perps are not live yet." };
    const wantTestnet = isHyperevmTestnetPerps(chainId);
    if (wantTestnet && cfg.network !== "testnet") {
      return {
        success: false,
        error: "HyperEVM Testnet vault needs an executor with HYPERLIQUID_TESTNET=1.",
      };
    }
    if (!wantTestnet && cfg.network !== "mainnet") {
      return {
        success: false,
        error: "The executor is on Hyperliquid testnet — use HyperEVM Testnet home, or a mainnet executor.",
      };
    }
    const cap = cfg.max_leverage?.[symbol];
    if (!cap) return { success: false, error: `Hyperliquid has no cross-margin ${symbol} perp.` };
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > cap) {
      return { success: false, error: `Leverage on ${symbol} must be 1–${cap}.` };
    }
    if (marginUsd * leverage < cfg.min_notional_usd) {
      return {
        success: false,
        error: `Position size (margin × leverage) must be at least $${cfg.min_notional_usd}.`,
      };
    }

    const usdc = getTokens(chainId).USDC;
    const amountStr = marginUsd.toFixed(6).replace(/\.?0+$/, "");
    const funding = {
      to_chain_id: HYPERLIQUID_CHAIN_ID,
      to_address: cfg.account,
      to_token: "USDC",
      refund_address: wallet,
      slippage_bps: FUNDING_SLIPPAGE_BPS,
    };

    let payee: string;
    if (wantTestnet) {
      // Option A: no LI.FI — vault withdraw pays the 998 executor; CoreDeposit credits HyperCore.
      try {
        payee = getZkWithdrawRecipient(chainId);
      } catch {
        return {
          success: false,
          error: "Set NEXT_PUBLIC_HYPEREVM_TESTNET_EXECUTOR_ADDRESS for HyperEVM Testnet perps.",
        };
      }
      if (!payee) {
        return {
          success: false,
          error: "Set NEXT_PUBLIC_HYPEREVM_TESTNET_EXECUTOR_ADDRESS for HyperEVM Testnet perps.",
        };
      }
      log("Pricing CoreDeposit margin hop to Hyperliquid testnet…");
      if (marginUsd * leverage < 10) {
        return {
          success: false,
          error: "Position size must be at least $10 notional on Hyperliquid.",
        };
      }
    } else {
      log("Pricing the margin's route to Hyperliquid…");
      const q = await bridgeQuote(
        { ...funding, amount: ethers.parseUnits(amountStr, 6).toString(), min_out: "1" },
        chainId,
      );
      payee = q.payee;
      const landed = Number(q.toAmountMin) / 10 ** q.toToken.decimals;
      if (landed * leverage < 10) {
        return {
          success: false,
          error: `After the bridge fee (~$${q.feeUsd}) this is under Hyperliquid's $10 minimum — add margin.`,
        };
      }
    }

    // Entry trigger on the USD mark. "now" → below a huge bound so the first FHE cycle fires.
    const dir: "above" | "below" =
      trigger.mode === "now" ? "below" : (trigger.direction ?? (side === "LONG" ? "below" : "above"));
    const threshold = trigger.mode === "now" ? 1e15 : Math.max(0, trigger.priceUsd ?? 0);
    const windowHours = trigger.mode === "now" ? 1 : 24;

    cb?.onProof?.();
    log("Sealing the margin note to the enclave…");
    const { buildV3Single } = await import("./v3/strategyOrchestrateV3");
    const single = await buildV3Single({
      chainId,
      signer,
      screenToken: "",
      inToken: { address: usdc.address, symbol: "USDC", decimals: 6 },
      outToken: { address: usdc.address, symbol: "USDC", decimals: 6 },
      amountStr,
      windowHours,
      payee,
      submit: createExecutorSubmitV3(signer),
      log,
    });

    log("Arming fee…");
    const fee = await collectArmingFee(chainId, windowHours);

    return await submitEncryptedStrategy(
      {
        user_id: wallet,
        strategy_type: "HYPERLIQUID",
        side: side === "LONG" ? "buy" : "sell",
        asset_in: "USDC",
        asset_out: symbol,
        amount: marginUsd,
        upper_bound: dir === "above" ? threshold : 0,
        lower_bound: dir === "below" ? threshold : 0,
        recipient_address: wallet,
        is_private: true,
        condition_tree: null,
        from_chain: String(chainId),
        to_chain: String(chainId),
        output_mode: "bridge",
        payout: funding,
        price_feed_id: `hyperliquid:${symbol}`,
        execution_window_sec: windowHours * 3600,
        // The anchor and id buildV3Single ARMED with — the enclave keys the leg by them.
        schedule_anchor: single.scheduleAnchor,
        arm_strategy_id: single.armStrategyId,
        note_label: single.noteLabel,
        arming_fee_wei: fee.armingCollectedWei.toString(),
        arming_tx_hash: fee.armingTxHash,
        hl_meta: {
          coin: symbol,
          side,
          leverage,
          take_profit_px: takeProfitPx,
          stop_loss_px: stopLossPx,
          trigger_dir: dir,
          exit_to: params.exitTo ?? { to_chain_id: HYPERLIQUID_CHAIN_ID, to_address: wallet },
        },
      },
      cb,
    );
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
