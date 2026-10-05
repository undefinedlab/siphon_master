import { decryptResult, getStoredClientKey, restoreInFlight } from "@/lib/fhe";
import { getNetwork, getSelectedChainId, SOLANA_DEVNET_UI_CHAIN_ID } from "@/lib/networks";
import { authorizeExecution, fetchStrategyResult } from "@/lib/strategyAuthorizer";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import { getSigner } from "@/lib/nexus";
import { getWalletAuthHeaders, getWalletWriteAuthHeaders, getCachedWalletAuthHeaders } from "@/lib/walletAuthHeaders";

export type StrategyStatusValue =
  | "PENDING"
  | "ARMED"
  | "EXECUTED"
  | "FAILED"
  | "EXPIRED"
  | "ABORTED"
  | "PARTIALLY_EXECUTED";

export interface StrategyRecord {
  id: string;
  strategy_type: string;
  asset_in: string;
  asset_out: string;
  amount: number;
  status: StrategyStatusValue;
  tx_hash: string | null;
  executed_at: string | null;
  created_at: string;
  from_chain?: string;
  has_encrypted_result?: boolean;
  result_updated_at?: string | null;
  /** Single-order phantom change-note commitment (null for TWAP/grid). Used by abort/fail recovery. */
  change_commitment?: string | null;
  /** Payout strategies: where the executor pays the fired order out, and how that is going. */
  payout?: import("./bridge/hub").StrategyPayout | null;
  payout_order?: Pick<import("./bridge/hub").BridgeOrder, "id" | "status" | "amount_out" | "bridge_tx" | "dest_tx" | "refund_tx" | "error"> | null;
  leg_count?: number | null;
  executed_count?: number | null;
  /** PIPELINE public meta only (hop_cursor / hop_count) — never sealed secrets. */
  zkp_data?: { pipeline?: boolean; hop_cursor?: number; hop_count?: number } | null;
  legs?: Array<{ leg_index: number; status: string; tx_hash?: string | null; settlement?: unknown; leg_kind?: string | null }> | null;
}

async function readAuthHeaders(userId: string): Promise<Record<string, string>> {
  // A Phantom user id reads with its Phantom session — an EVM signature cannot speak for it.
  if (userId && !userId.startsWith("0x")) {
    const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
    return { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) };
  }
  const signer = getSigner();
  if (signer) return getWalletAuthHeaders(signer);
  return {
    "Content-Type": "application/json",
    ...getCachedWalletAuthHeaders(userId),
  };
}

export function getExplorerTxUrl(txHash: string, chainId?: number | string): string {
  // Use the tx's OWN chain when the row carries one (strategies store from_chain as a string);
  // falling back to the selected tab sent Sepolia txs to Basescan when Base was selected.
  const parsed = Number(chainId);
  const id = Number.isFinite(parsed) && parsed > 0 ? parsed : getSelectedChainId();
  if (id === SOLANA_DEVNET_UI_CHAIN_ID) {
    return `https://explorer.solana.com/tx/${txHash}?cluster=devnet`;
  }
  const net = getNetwork(id);
  return `${net.explorer}/tx/${txHash}`;
}

/** Browser "Failed to fetch", a down executor, or a refused connection — not an empty list. */
export function isExecutorUnreachableError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /failed to fetch|fetch failed|networkerror|network request failed|econnrefused|enotfound|executor is unreachable|trade executor proxy failed/i.test(
    message,
  );
}

function formatTradeExecutorError(raw: string): string {
  if (isExecutorUnreachableError(raw)) {
    return "Trade executor is unreachable. Set NEXT_PUBLIC_TRADE_EXECUTOR_URL or start the local executor on port 5005.";
  }
  return raw;
}

export async function getStrategies(
  userId: string,
): Promise<{ success: boolean; strategies?: StrategyRecord[]; error?: string }> {
  try {
    const base = getTradeExecutorBaseUrl();
    const res = await fetch(`${base}/strategies/${encodeURIComponent(userId)}`, {
      method: "GET",
      headers: await readAuthHeaders(userId),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 200) || `HTTP ${res.status}`;
      try {
        const json = JSON.parse(text) as { error?: string };
        if (json.error) message = json.error;
      } catch {
        /* plain text body */
      }
      return { success: false, error: formatTradeExecutorError(message) };
    }
    const json = await res.json();
    if (json.status === "success" && Array.isArray(json.strategies)) {
      return { success: true, strategies: json.strategies };
    }
    return { success: false, error: json.error || "Failed to fetch strategies" };
  } catch (err) {
    return {
      success: false,
      error: formatTradeExecutorError(err instanceof Error ? err.message : "Unknown error"),
    };
  }
}

/**
 * Abort a strategy's unfired work. The executor stops any PENDING/ARMED legs (leaving
 * anything already on-chain untouched), then we restore the freed input note.
 *
 * Fund recovery: the input note's secret is still in Supabase (backed at deposit, never
 * marked spent at submit) and was never spent on-chain (the strategy never fired). So after
 * the abort we re-sync notes from the server and the freed note reappears as spendable —
 * the executor returns nothing sensitive; it can't (it never held the secret).
 */
export interface AbortResult {
  success: boolean;
  strategyStatus?: string;
  /** asset_in symbol for the amounts below. */
  assetIn?: string;
  /** asset_in units that already fired on-chain (unrecoverable). */
  spentAmount?: number;
  /** asset_in units freed by the abort (restored to spendable balance). */
  returnedAmount?: number;
  /**
   * True when the abort was refused because the strategy is already EXECUTING/EXECUTED on-chain —
   * it is processing and can no longer be cancelled (executor returns 409). The UI should show an
   * informational "processing, can't cancel" message (not an error) and refresh the status.
   */
  processing?: boolean;
  error?: string;
}

export async function abortStrategy(
  signer: import("ethers").Signer,
  strategyId: string,
  /** The strategy's own chain (its from_chain). Defaults to the selected tab. */
  chainId?: number,
): Promise<AbortResult> {
  try {
    const userId = (await signer.getAddress()).toLowerCase();
    // The executor that armed it is the one that can stop it — not whichever tab is showing.
    const chain = chainId && chainId > 0 ? chainId : getSelectedChainId();
    const base = getTradeExecutorBaseUrl(chain);
    const res = await fetch(`${base}/strategies/${encodeURIComponent(strategyId)}/abort`, {
      method: "POST",
      headers: await getWalletWriteAuthHeaders(signer, chain),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 200) || `HTTP ${res.status}`;
      let statusFromBody: string | undefined;
      try {
        const json = JSON.parse(text) as { error?: string; strategy_status?: string };
        if (json.error) message = json.error;
        statusFromBody = json.strategy_status;
      } catch { /* plain text */ }
      // 409 with an EXECUTING/EXECUTED status means the strategy started firing on-chain and can
      // no longer be cancelled — surface it as "processing", not a generic error, so the UI can
      // show a calm message and refresh the card to its live status instead of an alarming toast.
      const processing =
        res.status === 409 &&
        (statusFromBody === "EXECUTING" || statusFromBody === "EXECUTED" ||
          /processing|can no longer be cancelled/i.test(message));
      return {
        success: false,
        processing,
        strategyStatus: statusFromBody,
        error: formatTradeExecutorError(message),
      };
    }
    const json = (await res.json()) as {
      strategy_status?: string;
      asset_in?: string;
      spent_amount?: number;
      returned_amount?: number;
      invalidate_commitments?: string[];
    };

    // Correct abort recovery (two halves — see strategyNoteReservation.ts):
    //  1. INPUT note A: reverted to spendable by reconcileReservedNotes (ABORTED → 'false'),
    //     which the status poller runs. We also nudge a re-sync so it reflects promptly.
    //  2. PHANTOM CHANGE note B: written spendable at submit but never minted on-chain (the
    //     withdraw tx never fired). Mark it SPENT in BOTH stores, else A + phantom-B double-count.
    //     The executor can't do this (commitments are encrypted server-side); it returns B's
    //     commitment value and we resolve the row client-side.
    try {
      const commits = json.invalidate_commitments ?? [];
      if (commits.length > 0) {
        const { markCommitmentSpentByCommitment } = await import("./commitmentStore");
        const { markNoteSpentByKey, scanAllNoteMeta } = await import("./localNoteStore");
        const localByCommitment = new Map(scanAllNoteMeta().map((m) => [m.commitment, m.key]));
        for (const c of commits) {
          // Supabase: mark every row for this commitment value spent (idempotent).
          await markCommitmentSpentByCommitment(signer, c).catch((e) =>
            console.warn("[abort] phantom change-note Supabase mark-spent failed:", c, e),
          );
          // localStorage: mark the matching note spent (bypasses the rank guard's block on
          // false→true? no — true is the max rank, so markNoteSpentByKey advances it fine).
          const key = localByCommitment.get(c);
          if (key) markNoteSpentByKey(key, "true");
        }
      }

      // Revert the reserved INPUT note now (don't wait for the 20s poller). This flips the
      // reservation + local input note back to spendable for the just-ABORTED strategy.
      // (Do NOT call syncWalletNotesFromServer here: local input note A is still spent:'true'
      // until this runs, and sync's one-directional merge would push that stale 'true' up to
      // Supabase, re-locking A. reconcileReservedNotes reverts BOTH stores correctly instead.)
      const { reconcileReservedNotes } = await import("./strategyNoteReservation");
      await reconcileReservedNotes(signer, [
        { id: strategyId, status: json.strategy_status ?? "ABORTED" },
      ]).catch((e) => console.warn("[abort] input-note reconciliation failed:", e));

      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("siphon:vaultBalanceInvalidate"));
      }
    } catch (e) {
      console.warn("[abort] note recovery post-processing failed (retry a balance refresh):", e);
    }

    return {
      success: true,
      strategyStatus: json.strategy_status,
      assetIn: json.asset_in,
      spentAmount: json.spent_amount,
      returnedAmount: json.returned_amount,
    };
  } catch (err) {
    return {
      success: false,
      error: formatTradeExecutorError(err instanceof Error ? err.message : "Unknown error"),
    };
  }
}

/** IDs currently being submitted to /executeStrategy (dedupe across pollers). */
const executingIds = new Set<string>();

/** Decrypt ARMED results locally and authorize any that triggered. */
export async function processArmedStrategies(userId: string): Promise<string[]> {
  const clientKey = getStoredClientKey(userId);
  if (!clientKey) return [];

  const { success, strategies } = await getStrategies(userId);
  if (!success || !strategies) return [];

  const armed = strategies.filter((s) => s.status === "ARMED");
  const executed: string[] = [];

  for (const s of armed) {
    if (executingIds.has(s.id)) continue;
    try {
      const result = await fetchStrategyResult(s.id, userId);
      if (!result.encrypted_result) continue;

      const triggered = await decryptResult(result.encrypted_result, clientKey);
      console.log(`[strategyApi] ${s.id.slice(0, 8)}… decrypt → ${triggered ? "TRIGGERED" : "not yet"}`);

      if (!triggered) continue;

      executingIds.add(s.id);
      console.log(`[strategyApi] ${s.id} triggered — calling /executeStrategy…`);
      try {
        const exec = await authorizeExecution(s.id, userId);
        if (exec.error || exec.status === "error") {
          console.error(`[strategyApi] execute failed for ${s.id}:`, exec.error);
          continue;
        }
        executed.push(s.id);
      } finally {
        executingIds.delete(s.id);
      }
    } catch (e) {
      executingIds.delete(s.id);
      console.error(`[strategyApi] process ${s.id}:`, e);
    }
  }
  return executed;
}

/** Manually try to authorize one ARMED strategy (user-initiated). */
export async function tryAuthorizeStrategy(
  strategyId: string,
  userId: string,
): Promise<{ ok: boolean; txHash?: string; error?: string; triggered?: boolean }> {
  // A restore may be in flight (localStorage or server tier). getStoredClientKey is synchronous
  // and returns null during that window, so waiting here is the difference between telling the
  // user their key is missing and it simply not having landed yet.
  let clientKey = getStoredClientKey(userId);
  if (!clientKey) {
    await restoreInFlight(userId);
    clientKey = getStoredClientKey(userId);
  }
  if (!clientKey) {
    return { ok: false, error: "No FHE key on this device. Re-submit from the same browser." };
  }
  try {
    const result = await fetchStrategyResult(strategyId, userId);
    if (!result.encrypted_result) {
      return { ok: false, error: "Waiting for scheduler evaluation…" };
    }
    const triggered = await decryptResult(result.encrypted_result, clientKey);
    if (!triggered) {
      let priceHint = "";
      try {
        const pr = await fetch("/api/pyth_price?coin=ETH");
        if (pr.ok) {
          const j = await pr.json();
          const eth = j?.prices?.ETH ?? j?.price;
          if (eth) {
            priceHint =
              ` Oracle ETH/USD ≈ $${Number(eth).toFixed(2)} (Pyth on Base).` +
              ` LIMIT SELL fires when 1 ETH ≥ your trigger price (not USDC output amount).`;
          }
        }
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        triggered: false,
        error: `Price condition not met (decrypted locally).${priceHint}`,
      };
    }
    const exec = await authorizeExecution(strategyId, userId);
    if (exec.error || exec.status === "error") {
      return { ok: false, error: exec.error || "Execution failed" };
    }
    return { ok: true, txHash: exec.tx_hash, triggered: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export function formatStrategyStatus(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "ARMED":
      return "Armed";
    case "EXECUTED":
      return "Executed";
    case "FAILED":
      return "Failed";
    case "EXPIRED":
      return "Expired";
    case "ABORTED":
      return "Aborted";
    case "PARTIALLY_EXECUTED":
      return "Partially executed";
    default:
      return status;
  }
}

export function isActiveStatus(status: string): boolean {
  return status === "PENDING" || status === "ARMED";
}
