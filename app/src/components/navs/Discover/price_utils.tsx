/**
 * Price Utilities
 * 
 * Contains all price-related calculations and formatting functions
 */

export interface PriceUtils {
  formatAmount: (amount: number, coin?: string) => string;
  calculateExchange: (inputAmount: number, coinA: string, coinB: string, coinPrices: Record<string, number>) => number;
  calculateVariableCost: (duration: string) => number;
  calculateFixedCost: (transactionOutputUSD: number) => number;
  getTransactionOutputForCost: (
    modalStrategyNodes: Array<{ id: string; data?: { type?: string; coin?: string; toCoin?: string } }>,
    runModeValues: Record<string, Record<string, string>>,
    coinPrices: Record<string, number>,
    calculateExchange: (inputAmount: number, coinA: string, coinB: string, coinPrices: Record<string, number>) => number
  ) => number;
  getInitialBalance: (modalStrategyNodes: Array<{ id: string; data?: { type?: string } }>, runModeValues: Record<string, Record<string, string>>) => string;
  getInputCoin: (modalStrategyNodes: Array<{ id: string; data?: { type?: string; coin?: string } }>, runModeValues: Record<string, Record<string, string>>) => string;
}

/**
 * Format amount with appropriate decimal places based on coin type
 */
export const formatAmount = (amount: number, coin?: string): string => {
  if (amount <= 0 || isNaN(amount) || !isFinite(amount)) return '0.0';
  
  // Determine decimal places based on coin type
  let decimals = 6;
  if (coin) {
    // Stablecoins (USDC, USDT) show 2 decimals
    if (coin === 'USDC' || coin === 'USDT') {
      decimals = 2;
    }
    // Bitcoin shows 8 decimals
    else if (coin === 'BTC') {
      decimals = 8;
    }
    // Ethereum and other altcoins show 6 decimals
    else {
      decimals = 6;
    }
  }
  
  // Format with appropriate decimals
  const formatted = amount.toFixed(decimals);
  
  // Remove trailing zeros but keep at least one decimal place
  if (formatted.includes('.')) {
    return formatted.replace(/\.?0+$/, '') || '0.0';
  }
  
  return formatted;
};

/**
 * Calculate exchange rate between two coins using their USD prices
 * Uses Pyth prices: outputAmount = inputAmount * (priceA / priceB)
 */
export const calculateExchange = (
  inputAmount: number,
  coinA: string,
  coinB: string,
  coinPrices: Record<string, number>
): number => {
  if (inputAmount <= 0) return 0;
  if (coinA === coinB) return inputAmount;
  
  const priceA = coinPrices[coinA] || 0;
  const priceB = coinPrices[coinB] || 0;
  
  if (priceA === 0 || priceB === 0) {
    console.warn(`[Exchange] Missing prices for pair ${coinA}/${coinB}:`, {
      priceA,
      priceB,
      coinPrices: { ...coinPrices }
    });
    return 0;
  }
  
  // Calculate: outputAmount = inputAmount * (priceA / priceB)
  // Example: 1 ETH * (3000 USD / 1 USD) = 3000 USDC
  const exchangeRate = priceA / priceB;
  const outputAmount = inputAmount * exchangeRate;
  
  console.log(`[Exchange] ${inputAmount} ${coinA} → ${outputAmount.toFixed(6)} ${coinB}`, {
    priceA: `${coinA}: $${priceA}`,
    priceB: `${coinB}: $${priceB}`,
    exchangeRate: `${exchangeRate.toFixed(6)} ${coinB}/${coinA}`,
    calculation: `${inputAmount} × (${priceA} / ${priceB}) = ${outputAmount.toFixed(6)}`
  });
  
  return outputAmount;
};

// Arming-fee params now come from the shared fee model (matches the backend).
import { FEE, armingFeeUsd, executionFeeUsd } from "@/lib/feeModel";
const RUN_FEE_MIN_USD = FEE.ARMING_USDC;
const RUN_FEE_PER_HOUR_USD = 0;

/** Spot output after slippage % and the EXECUTION fee (Part B) deducted in output-token terms.
 * The arming fee (Part A) is upfront and shown separately, not deducted from the trade output. */
export const calculateNetReceiveEstimate = (
  inputAmount: number,
  coinA: string,
  coinB: string,
  coinPrices: Record<string, number>,
  slippagePct: number,
  _runFeeUsd: number,   // kept for signature compat; net-receive uses the execution fee
): number => {
  const spot = calculateExchange(inputAmount, coinA, coinB, coinPrices);
  if (spot <= 0) return 0;

  const afterSlippage = spot * (1 - Math.max(0, slippagePct) / 100);
  const outSym = coinB.toUpperCase();
  const outPrice = coinPrices[outSym] ?? (outSym === "USDC" ? 1 : 0);

  // Notional = input value in USD; execution fee is taken from the trade (Part B).
  const inPrice = coinPrices[coinA.toUpperCase()] ?? (coinA.toUpperCase() === "USDC" ? 1 : 0);
  const notionalUsd = inputAmount * inPrice;
  const execFeeUsd = executionFeeUsd(notionalUsd);
  const feeInOut = outPrice > 0 ? execFeeUsd / outPrice : 0;

  return Math.max(0, afterSlippage - feeInOut);
};

function coinUsd(symbol: string, coinPrices: Record<string, number>): number {
  const s = symbol.toUpperCase();
  if (s === "USDC" || s === "USDT" || s === "JLUSDC") return coinPrices[s] ?? coinPrices.USDC ?? 1;
  if (s === "JITOSOL") return coinPrices.JITOSOL ?? coinPrices.SOL ?? 0;
  return coinPrices[s] ?? 0;
}

/**
 * Approx net receive after a private multi-hop path (Earn/Stake ~1:1 value, each swap
 * pays slippage, one execution fee deducted once in the final asset).
 */
export const calculatePipelineNetReceiveEstimate = (
  inputAmount: number,
  hops: Array<{ kind: "lend" | "swap"; assetIn: string; assetOut: string }>,
  coinPrices: Record<string, number>,
  slippagePct: number,
): number => {
  if (!(inputAmount > 0) || !hops.length) return 0;
  let amt = inputAmount;
  let coin = hops[0].assetIn;
  let swapHops = 0;
  const slip = 1 - Math.max(0, slippagePct) / 100;
  for (const h of hops) {
    const inP = coinUsd(coin, coinPrices);
    const outP = coinUsd(h.assetOut, coinPrices);
    if (!(inP > 0 && outP > 0)) return 0;
    // Share tokens track underlying ~1:1 in USD (jlUSDC≈USDC, JitoSOL≈SOL).
    // Meteora hops apply the path slippage once each.
    const spot = (amt * inP) / outP;
    if (h.kind === "swap") {
      swapHops += 1;
      amt = spot * slip;
    } else {
      amt = spot;
    }
    coin = h.assetOut;
  }
  const inP0 = coinUsd(hops[0].assetIn, coinPrices);
  const outP = coinUsd(coin, coinPrices);
  const notionalUsd = inputAmount * inP0;
  // Slightly higher effective fee haircut when many public swaps are in the path.
  const exec = executionFeeUsd(notionalUsd) * (1 + Math.max(0, swapHops - 1) * 0.15);
  const feeInOut = outP > 0 ? exec / outP : 0;
  return Math.max(0, amt - feeInOut);
};

/** @deprecated Use calculateNetReceiveEstimate with explicit slippage + fee. */
export const ESTIMATED_RECEIVE_FACTOR = 0.98;

export const applyEstimatedReceiveHaircut = (spotOutputAmount: number): number => {
  if (spotOutputAmount <= 0) return 0;
  return spotOutputAmount * ESTIMATED_RECEIVE_FACTOR;
};

export const calculateEstimatedReceive = (
  inputAmount: number,
  coinA: string,
  coinB: string,
  coinPrices: Record<string, number>,
  slippagePct = 2,
  runFeeUsd = RUN_FEE_MIN_USD,
): number =>
  calculateNetReceiveEstimate(inputAmount, coinA, coinB, coinPrices, slippagePct, runFeeUsd);

/** Parse run duration strings like `6h`, `2d` into whole hours. */
export function durationToHours(duration: string): number {
  const match = duration.match(/(\d+)([hd])/);
  if (!match) return 1;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "h") return value;
  if (unit === "d") return value * 24;
  return 1;
}

/**
 * Arming fee (Part A): fixed $0.25 USDC. Charged upfront.
 */
export const calculateRunFee = (duration: string): number => {
  return armingFeeUsd(durationToHours(duration));
};

/**
 * Retained for UI compatibility; there is no hourly arming fee.
 */
export const calculateVariableCost = (duration: string): number => {
  return RUN_FEE_PER_HOUR_USD * durationToHours(duration);
};

/** Fixed run fee ($0.25 USDC). */
export const calculateFixedCost = (_transactionOutputUSD: number = 0): number => {
  return RUN_FEE_MIN_USD;
};

/**
 * Get transaction output in USD for cost calculation
 */
export const getTransactionOutputForCost = (
  modalStrategyNodes: Array<{ id: string; data?: { type?: string; coin?: string; toCoin?: string } }>,
  runModeValues: Record<string, Record<string, string>>,
  coinPrices: Record<string, number>,
  calculateExchangeFn: (inputAmount: number, coinA: string, coinB: string, coinPrices: Record<string, number>) => number
): number => {
  if (modalStrategyNodes.length === 0) return 0;
  
  const depositNode = modalStrategyNodes.find((node) => node.data?.type === 'deposit');
  const swapNode = modalStrategyNodes.find((node) => node.data?.type === 'swap');
  
  if (!depositNode) return 0;
  
  const depositStepId = depositNode.id;
  const depositStepValues = runModeValues[depositStepId] || {};
  const inputAmount = parseFloat(depositStepValues['amount'] || '0') || 0;
  const inputCoin = depositStepValues['tokenA'] || depositNode.data?.coin || 'USDC';
  
  // Get output coin
  let outputCoin = inputCoin;
  if (swapNode) {
    const swapStepId = swapNode.id;
    const swapStepValues = runModeValues[swapStepId] || {};
    outputCoin = swapStepValues['coinB'] || swapNode.data?.toCoin || inputCoin;
  }
  
  // Calculate output amount using simple exchange: Coin A → Coin B
  const outputAmount = calculateExchangeFn(inputAmount, inputCoin, outputCoin, coinPrices);
  
  // Convert output amount to USD for cost calculation
  const outputPriceUSD = coinPrices[outputCoin] || 0;
  return outputAmount * outputPriceUSD;
};

/**
 * Get initial balance from deposit step
 */
export const getInitialBalance = (
  modalStrategyNodes: Array<{ id: string; data?: { type?: string } }>,
  runModeValues: Record<string, Record<string, string>>
): string => {
  if (modalStrategyNodes.length === 0) return '0.0';
  const depositNode = modalStrategyNodes.find((node) => node.data?.type === 'deposit');
  if (depositNode) {
    const stepId = depositNode.id;
    const stepValues = runModeValues[stepId] || {};
    return stepValues['amount'] || '0.0';
  }
  return '0.0';
};

/**
 * Get input coin from deposit step
 */
export const getInputCoin = (
  modalStrategyNodes: Array<{ id: string; data?: { type?: string; coin?: string } }>,
  runModeValues: Record<string, Record<string, string>>
): string => {
  if (modalStrategyNodes.length === 0) return 'USDC';
  const depositNode = modalStrategyNodes.find((node) => node.data?.type === 'deposit');
  if (depositNode) {
    const stepId = depositNode.id;
    const stepValues = runModeValues[stepId] || {};
    return stepValues['tokenA'] || depositNode.data?.coin || 'USDC';
  }
  return 'USDC';
};

/**
 * Fetch coin prices from Pyth Network API
 */
export const fetchCoinPrices = async (): Promise<Record<string, number>> => {
  try {
    console.log('[PriceUtils] Fetching prices from Pyth Network...');
    const response = await fetch('/api/pyth_price?coin=all');
    if (response.ok) {
      const data = await response.json();
      if (data.prices) {
        console.log('[PriceUtils] ✓ Received Pyth prices:', data.prices);
        // Log each price
        Object.entries(data.prices).forEach(([coin, price]) => {
          console.log(`[PriceUtils]   ${coin}: $${price}`);
        });
        // Verify Ethereum price is present
        if (data.prices.ETH && data.prices.ETH > 0) {
          console.log('[PriceUtils] ✓ Ethereum price verified:', data.prices.ETH, 'USD');
        } else {
          console.warn('[PriceUtils] ⚠ Ethereum price missing or zero:', data.prices.ETH);
        }
        return data.prices;
      } else {
        console.error('[PriceUtils] Invalid price data format:', data);
        return {};
      }
    } else {
      console.error('[PriceUtils] Failed to fetch prices:', response.status, response.statusText);
      return {};
    }
  } catch (error) {
    console.error('[PriceUtils] Error fetching prices:', error);
    return {};
  }
};
