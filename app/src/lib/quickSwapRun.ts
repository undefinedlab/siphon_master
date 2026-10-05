import { walletManager } from "@/components/extensions/walletManager";
import { fetchCoinPrices } from "@/components/navs/Discover/price_utils";
import { initializeWithProvider, getSigner } from "@/lib/nexus";
import { createVaultOutputNote } from "@/lib/outputNoteResolver";
import {
  getNetwork,
  getSelectedChainId,
  getTokens,
  getZkWithdrawRecipient,
  selectChainAndSwitchWallet,
} from "@/lib/networks";
import { resolveWalletAddress } from "@/lib/walletAddress";
import {
  buildStrategyPayload,
  inferSideFromSwap,
} from "@/lib/strategySpec";
import { submitEncryptedStrategy } from "@/lib/strategySubmit";
import { slippagePctToBps } from "@/lib/quickSwapSettings";
import { markQuickSwapStrategy } from "@/lib/quickSwapStrategyIds";
import { generateZKData } from "@/lib/zkHandler";
import { collectArmingFee } from "@/lib/multiLegBuilder";
import { requireV2StrategyPath, v3StrategiesLive } from "@/lib/v3/configV3";
import { quickSwapRoute } from "@/lib/quickSwapRoute";
import { ethers } from "ethers";

export interface QuickSwapRunInput {
  assetIn: string;
  assetOut: string;
  amount: number;
  recipient: string;
  slippagePct: number;
  onProgress?: (message: string) => void;
}

export async function executeQuickSwapPayAndRun(
  input: QuickSwapRunInput,
): Promise<{ success: boolean; error?: string; strategyId?: string }> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (label: string, start: number) => {
    timings[label] = performance.now() - start;
  };

  const { assetIn, assetOut, amount, recipient, slippagePct, onProgress } = input;
  const log = (msg: string) => onProgress?.(msg);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: "Enter a valid amount." };
  }
  if (!recipient) {
    return { success: false, error: "Connect your wallet or enter a destination address." };
  }

  const wallet = walletManager.getPrimaryWallet();
  if (!wallet?.address) {
    return { success: false, error: "Connect your wallet first, then try Pay & Run again." };
  }

  // Solana Devnet: a market order in its own vault — proved to the settlement wallet and settled
  // on Meteora at once (execute_now), with the output returned to the vault as the user's note.
  if (getSelectedChainId() === 900_002) {
    try {
      const { armSolanaDevnetOrder } = await import("@/lib/chains/solanaDevnetStrategy");
      const armed = await armSolanaDevnetOrder({
        amountHuman: amount,
        assetIn,
        assetOut,
        strategyType: assetIn.toUpperCase() === "USDC" ? "LIMIT_BUY" : "LIMIT_SELL",
        // Always true: should the immediate settle find no route, the order fires on the next tick.
        conditionTree: { op: "AND", conditions: [{ op: "LEAF", asset: "SOL", condition: "GTE", bound: 0 }] },
        maxSlippageBps: Math.round((slippagePct ?? 0.5) * 100),
        windowHours: 1,
        executeNow: true,
        onStatus: log,
      });
      log(armed.executed
        ? "Swapped — the output is back in your Devnet vault."
        : "Order placed — it settles on the next tick.");
      return { success: true, strategyId: armed.strategyId };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Devnet swap failed." };
    }
  }

  const evmProvider = walletManager.getEvmProvider();
  if (evmProvider) {
    try {
      await initializeWithProvider(evmProvider);
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Failed to initialize wallet provider.",
      };
    }
  }

  const chainId = getSelectedChainId();
  log(`Switching to ${getNetwork(chainId).name}…`);
  let step = performance.now();
  const switchResult = await selectChainAndSwitchWallet(chainId, resolveWalletAddress());
  mark("networkSwitch", step);
  if (!switchResult.ok) {
    return { success: false, error: switchResult.error ?? "Could not switch network." };
  }

  const tokenMap = getTokens(chainId);
  const tokenInfo = tokenMap[assetIn.toUpperCase()];
  if (!tokenInfo) {
    return { success: false, error: `Token ${assetIn} is not supported on this chain.` };
  }

  const outToken = tokenMap[assetOut.toUpperCase()];
  if (!outToken) {
    return { success: false, error: `Token ${assetOut} is not supported on this chain.` };
  }

  const sameAsset = assetIn.toUpperCase() === assetOut.toUpperCase();
  const maxSlippageBps = slippagePctToBps(slippagePct);

  step = performance.now();
  const prices = await fetchCoinPrices();
  mark("priceFetch", step);
  const ethUsd = prices.ETH;
  if (!ethUsd || ethUsd <= 0) {
    return { success: false, error: "Could not fetch ETH price for immediate limit trigger." };
  }

  // Undefined on the v3 path: there is no proof at arming time, and its ABSENCE from the payload
  // is what routes the strategy through the executor's attested path.
  let zkProof: Record<string, unknown> | undefined;
  let v3Single: { armStrategyId: string; scheduleAnchor: number; noteLabel: string } | undefined;
  let spentDepositKey: string | null | undefined;
  let changeValue = 0n;
  let newDeposit: {
    nullifier: string;
    secret: string;
    commitment?: string;
    precommitment: string;
    nullifierHash?: string;
    label?: string;
    amount: string;
  } | undefined;
  let newDepositKey: string | undefined;
  let changePoolId: string | null | undefined;
  let outputPrecommitment: string;

  const route = quickSwapRoute(sameAsset, v3StrategiesLive(chainId));
  if (route === "same-asset-unsupported") {
    return { success: false, error: "Choose two different assets — a swap needs a destination token." };
  }

  if (route === "v3") {
    // v3 arms through the ENCLAVE and proves at FIRE time. armSameChainVaultSwap below builds a
    // finished proof against the v1 Entrypoint's tree, whose root the v3 kernel has never seen —
    // and worse, it looks for the spend note in the v1 vault, where a v3 depositor holds nothing.
    // That is the "0 candidates" this branch exists to prevent, and it is the same dispatch
    // DetailsModal and Build already do. Quick Swap was the one arming entry point without it.
    const signer = getSigner();
    if (!signer) {
      return { success: false, error: "Connect your wallet first, then try Pay & Run again." };
    }
    step = performance.now();
    log(`Finding the best ${tokenInfo.symbol}/${outToken.symbol} pool on ${getNetwork(chainId).name}…`);
    const { buildV3Single, v3SwapParams } = await import("@/lib/v3/strategyOrchestrateV3");
    const { createExecutorSubmitV3 } = await import("@/lib/v3/executorSubmitV3");
    // Resolved before the arm rather than inline: it reads the pool on-chain and fetches prices,
    // which is seconds of RPC the user would otherwise wait on under the previous log line.
    const v3Swap = await v3SwapParams(chainId, tokenInfo, outToken, maxSlippageBps);

    log("Sealing this order to the enclave…");
    const single = await buildV3Single({
      chainId,
      signer,
      screenToken: "",
      inToken: { address: tokenInfo.address, symbol: tokenInfo.symbol, decimals: tokenInfo.decimals },
      outToken: { address: outToken.address, symbol: outToken.symbol, decimals: outToken.decimals },
      amountStr: String(amount),
      swap: v3Swap,
      submit: createExecutorSubmitV3(signer),
      log,
    });
    mark("zkProof", step);
    v3Single = single;
    outputPrecommitment = single.outputPrecommitment;
    log(`Order sealed to the enclave (${assetIn}→${assetOut})`);
  } else if (route === "v2-swap") {
    // Fail loudly if a v3 chain ever reaches here — silently proving against the wrong vault is
    // how this bug presented: a 51-second scan of the v1 tree ending in "0 candidates".
    requireV2StrategyPath(chainId);
    log("Generating atomic swap+re-shield proof…");
    step = performance.now();
    const { armSameChainVaultSwap } = await import("@/lib/atomicVaultSwap");
    const armed = await armSameChainVaultSwap({
      chainId,
      inToken: tokenInfo,
      outToken,
      amountHuman: String(amount),
      ethUsdPrice: ethUsd,
      maxSlippageBps,
    });
    mark("zkProof", step);
    if ("error" in armed) {
      return { success: false, error: armed.error };
    }
    const tx = armed.zkpData;
    zkProof = {
      pA: tx.pA,
      pB: tx.pB,
      pC: tx.pC,
      nullifierHashes: tx.nullifierHashes,
      noteCount: Array.isArray(tx.nullifierHashes) ? (tx.nullifierHashes as string[]).length : 1,
      nullifierHash: tx.nullifier,
      nullifier: tx.nullifier,
      newCommitment: tx.newCommitment,
      changeCommitment: tx.changeCommitment,
      stateRoot: tx.stateRoot,
      aspRoot: tx.aspRoot,
      changeLabel: tx.changeLabel ?? tx.newLabel,
      newLabel: tx.newLabel,
      venue: "swap_and_deposit",
      amountIn: tx.amountIn,
      recipient: tx.recipient,
      pool: tx.pool,
      dstToken: tx.dstToken,
      fee: tx.fee,
      minAmountOut: tx.minAmountOut,
    };
    outputPrecommitment = armed.outputPrecommitment;
    spentDepositKey = armed.swapProof.spentNoteKey;
    const chg = armed.swapProof.change;
    const chgWei = BigInt(chg.amountWei || "0");
    if (chgWei > 0n) {
      changeValue = chgWei;
      newDeposit = {
        nullifier: chg.nullifier,
        secret: chg.secret,
        commitment: chg.commitment,
        precommitment: chg.precommitment,
        label: chg.label,
        amount: ethers.formatUnits(chgWei, tokenInfo.decimals),
      };
      const { noteKey } = await import("@/lib/localNoteStore");
      newDepositKey = noteKey(chainId, tokenInfo.symbol, chg.commitment);
    }
    log(`Atomic vault-swap prepared (${assetIn}→${assetOut})`);
  } else {
    requireV2StrategyPath(chainId);
    log("Generating ZK proof…");
    step = performance.now();
    const zkResult = await generateZKData(
      chainId,
      tokenInfo,
      String(amount),
      getZkWithdrawRecipient(chainId),
    );
    mark("zkProof", step);
    if ("error" in zkResult) {
      return { success: false, error: zkResult.error };
    }
    const { withdrawalTxData } = zkResult;
    changeValue = zkResult.changeValue;
    newDeposit = zkResult.newDeposit;
    newDepositKey = zkResult.newDepositKey;
    spentDepositKey = zkResult.spentDepositKey;
    changePoolId = zkResult.changePoolId;
    zkProof = {
      pA: withdrawalTxData.pA,
      pB: withdrawalTxData.pB,
      pC: withdrawalTxData.pC,
      nullifierHashes: withdrawalTxData.nullifierHashes,
      noteCount: withdrawalTxData.nullifierHashes.length,
      publicSignals: withdrawalTxData.publicSignals,
      nullifierHash: withdrawalTxData.nullifierHash,
      newCommitment: withdrawalTxData.newCommitment,
      stateRoot: withdrawalTxData.stateRoot,
      // Entrypoint.withdraw._changeValue — private circuit input the executor cannot derive.
      changeValue: withdrawalTxData.changeValue,
      aspRoot: withdrawalTxData.aspRoot,
      changeLabel: withdrawalTxData.changeLabel,
    };
    step = performance.now();
    const out = await createVaultOutputNote(chainId, outToken);
    mark("vaultOutputNote", step);
    outputPrecommitment = out.precommitment;
    log(`Vault output prepared (${assetOut})`);
  }

  // Instant swap: bias the limit trigger PAST spot so the executor's FHE price check is already
  // satisfied and the leg fires on the very next tick — instead of waiting for the live price to
  // exactly meet spot (a one-cent tick against the side would otherwise leave it pending). The fill
  // itself is still protected by max_slippage_bps (Uniswap min-out at the live price), so a wide
  // trigger only removes the wait; it can never execute below slippage tolerance.
  //   LIMIT_SELL fires when price >= upper_bound  → set the bound BELOW spot.
  //   LIMIT_BUY  fires when price <= lower_bound  → set the bound ABOVE spot.
  const side = inferSideFromSwap(assetIn, assetOut);
  const INSTANT_TRIGGER_MARGIN = 0.1; // 10% past spot — comfortably fires across normal volatility
  const triggerPrice =
    side === "buy" ? ethUsd * (1 + INSTANT_TRIGGER_MARGIN) : ethUsd * (1 - INSTANT_TRIGGER_MARGIN);
  const bounds = buildStrategyPayload("Limit Order", {
    side,
    priceGoal: String(triggerPrice),
  });

  log("Collecting $0.25 USDC arming fee…");
  step = performance.now();
  const arming = await collectArmingFee(chainId);
  mark("armingFee", step);

  const strategyPayload = {
    user_id: recipient,
    strategy_type: bounds.strategy_type,
    asset_in: assetIn,
    asset_out: assetOut,
    amount,
    upper_bound: bounds.upper_bound,
    lower_bound: bounds.lower_bound,
    recipient_address: recipient,
    max_slippage_bps: maxSlippageBps,
    from_chain: String(chainId),
    to_chain: String(chainId),
    output_mode: "vault" as const,
    output_precommitment: outputPrecommitment,
    arming_fee_wei: arming.armingCollectedWei.toString(),
    arming_tx_hash: arming.armingTxHash,
    ...(v3Single
      ? {
          // Tells the executor which id the enclave keys this leg by; without it /spend/prove
          // finds no armed leg and the order expires unfired.
          arm_strategy_id: v3Single.armStrategyId,
          // The anchor buildV3Single ARMED with. A fresh Date.now() here would differ by however
          // long the arm took, and the two must be one value.
          schedule_anchor: v3Single.scheduleAnchor,
          // createStrategy hard-requires this. strategySubmit lifts it out of zk_proof on the v2
          // path; a v3 leg has no proof, so it has to be passed explicitly.
          note_label: v3Single.noteLabel,
          // zk_proof is deliberately OMITTED — that absence is what routes the strategy through
          // the executor's attested path, where the enclave proves at fire time.
        }
      : { zk_proof: zkProof }),
  };

  log("Encrypting and submitting strategy…");
  step = performance.now();
  const result = await submitEncryptedStrategy(strategyPayload, {
    onKeygen: () => log("Generating FHE keys (one-time)…"),
    onUploadKey: () => log("Uploading FHE server key…"),
    onUploadClientKey: () => log("Securing your key in the attested enclave…"),
    onEncrypt: () => log("Encrypting price bounds…"),
  });
  mark("fheSubmit", step);
  timings.total = performance.now() - t0;
  console.log(
    "[QuickSwap timing]",
    Object.entries(timings)
      .map(([k, ms]) => `${k}=${ms.toFixed(0)}ms`)
      .join(" "),
  );

  if (!result.success) {
    return { success: false, error: result.error ?? "Strategy submission failed." };
  }

  // Persist the change note DURABLY (encrypted localStorage via writeNote + server backup) — a raw
  // setItem of the plaintext note has no nullifier_enc/secret_enc, so readNote rejects it and the
  // change value is permanently unspendable. Mirrors the withdraw path in handler.ts. FUND-SAFETY.
  if (changeValue > 0n && newDeposit && newDepositKey) {
    const changeSigner = getSigner();
    if (changeSigner) {
      try {
        const { writeNote } = await import("@/lib/localNoteStore");
        await writeNote(newDepositKey, {
          nullifier:     newDeposit.nullifier,
          secret:        newDeposit.secret,
          commitment:    newDeposit.commitment!,
          precommitment: newDeposit.precommitment,
          nullifierHash: newDeposit.nullifierHash ?? "",
          amount:        newDeposit.amount,
          spent:         false,
        }, changeSigner);
      } catch (e) { console.warn("[QuickSwap] change note write failed:", e); }
      try {
        const { postCommitment } = await import("@/lib/commitmentStore");
        await postCommitment(changeSigner, {
          nullifier:     newDeposit.nullifier,
          secret:        newDeposit.secret,
          commitment:    newDeposit.commitment!,
          amount:        newDeposit.amount,
          chainId,
          nullifierHash: newDeposit.nullifierHash ?? "",
          precommitment: newDeposit.precommitment,
        }, tokenInfo.symbol, "change");
      } catch (e) { console.warn("[QuickSwap] change note server save failed:", e); }
      if (changePoolId) {
        try {
          const { resolvePrecommitment } = await import("@/lib/precommitmentStore");
          await resolvePrecommitment(changeSigner, changePoolId);
        } catch (e) { console.warn("[QuickSwap] pool resolve failed:", e); }
      }
    } else {
      console.warn("[QuickSwap] no signer — change note NOT persisted durably (would strand change)");
    }
  }
  if (spentDepositKey) {
    // Delete rather than mark spent:'true' — a local 'true' out-ranks the server's 'false' in
    // syncFromServer and would push it to Supabase, stranding a note the executor never spent.
    try {
      localStorage.removeItem(spentDepositKey);
    } catch {
      /* best-effort */
    }
  }

  const strategyId = String(result.data?.strategy_id ?? result.data?.payload_id ?? "");
  if (strategyId) {
    markQuickSwapStrategy(strategyId);
    window.dispatchEvent(
      new CustomEvent("siphon:strategySubmitted", { detail: { strategyId, userId: recipient } }),
    );
  }

  return { success: true, strategyId: strategyId || undefined };
}
