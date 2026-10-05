// Client-side encrypted strategy submission.
//
// The browser:
//   1. holds a per-wallet FHE client key (generated + persisted locally),
//   2. uploads the matching (compressed) server key to the trade-executor once,
//   3. when TEE autonomous mode is on, uploads the client key to the confidential VM
//      (via trade-executor proxy) so decryption happens only inside that VM,
//   4. encrypts price bounds / condition tree locally,
//   5. POSTs the encrypted strategy to the trade-executor's /createStrategy.
// Plaintext bounds never leave the browser; the backend only ever sees ciphertext.

import {
  getOrCreateClientKey,
  encryptPrice,
  encryptConditionTree,
} from "@/lib/fhe";
import { ensureServerKeyUploaded, verifyKeyConsistency } from "@/lib/fheKeyWarmup";
import { invalidateAttestationCache } from "@/lib/decryptorAttestation";

// Re-export so existing callers keep working (implementation moved to fheKeyWarmup.ts,
// which caches the derived server key and skips redundant re-uploads).
export { ensureServerKeyUploaded };
import { ensureClientKeyInDecryptor, isTeeAutonomousMode } from "@/lib/decryptorClient";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import { NETWORKS } from "@/lib/networks";
import { appendUserActivity } from "@/lib/userActivityLog";
import { getSigner } from "@/lib/nexus";
import { getWalletWriteAuthHeaders, getCachedWalletAuthHeaders } from "@/lib/walletAuthHeaders";
import { isAdminWallet } from "@/lib/adminWalletCore";

function formatSubmitError(status: number, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return `Request failed (HTTP ${status})`;

  try {
    const json = JSON.parse(trimmed) as { error?: string; message?: string };
    const msg = json.error || json.message;
    if (msg) return msg;
  } catch {
    /* not JSON */
  }

  if (trimmed.startsWith("<!") || trimmed.includes("<html")) {
    if (status === 429) return "Rate limited — wait a minute and try again.";
    return `Server error (HTTP ${status}).`;
  }

  if (trimmed.length > 280) {
    return `${trimmed.slice(0, 280)}… (HTTP ${status})`;
  }
  return status >= 400 ? `${trimmed} (HTTP ${status})` : trimmed;
}

/** Wallet write-challenge headers for mutating strategy routes. Never send API_TOKEN from the browser. */
async function writeAuthHeaders(
  userId: string,
  opts?: { allowSolanaDevnetOpen?: boolean },
): Promise<Record<string, string>> {
  // Solana Devnet: a Phantom session the executor verifies (wallet_auth._solana_session_wallet).
  // Checked first: with an EVM wallet also connected, its signature cannot speak for a Phantom id.
  if (opts?.allowSolanaDevnetOpen && userId && !userId.startsWith("0x")) {
    const { getSolanaExecutorHeaders } = await import("@/lib/solanaWalletAuth");
    return { "Content-Type": "application/json", ...(await getSolanaExecutorHeaders()) };
  }
  const signer = getSigner();
  if (signer) return getWalletWriteAuthHeaders(signer);
  throw new Error("Wallet required for strategy writes — connect and retry");
}

export interface StrategyInput {
  user_id: string;
  strategy_type: string;
  asset_in: string;
  asset_out: string;
  amount: number;
  recipient_address: string;
  // Single-strategy proof. Optional: multi-leg (TWAP/grid) strategies carry per-leg proofs in
  // `legs[]` instead and have no single zk_proof.
  zk_proof?: unknown;
  to_chain?: string;
  from_chain?: string;
  // Swap output routing. 'vault' re-deposits the swap output into the asset_out vault as a
  // private note owned by output_precommitment (user withdraws it later themselves). 'address'
  // (default) sends the output to recipient_address.
  // 'bridge': the armed leg withdraws to the executor, which pays `payout` out through LI.FI.
  output_mode?: "vault" | "address" | "bridge";
  payout?: import("./bridge/hub").StrategyPayout;
  output_precommitment?: string;
  // Plaintext bounds (used when there's no condition tree). Encrypted here, never sent raw.
  upper_bound?: number;
  lower_bound?: number;
  // Composable strategies: tree with plaintext LEAF `bound`s, encrypted here.
  condition_tree?: unknown | null;
  // Multi-leg strategies (TWAP / RANGE_GRID): N independent legs, each with its own swap proof
  // + per-leg encrypted trigger (encrypted fire-time for TWAP, encrypted price band for grid).
  // Built by multiLegBuilder.buildTwapLegs / buildGridLegs. Already-encrypted — forwarded as-is.
  legs?: import("./multiLegBuilder").BuiltLeg[];
  interval_sec?: number;
  grid_levels?: number;
  schedule_anchor?: number;
  // Any extra fields (side, slices, …) are forwarded untouched.
  [key: string]: unknown;
}

export interface SubmitResult {
  success: boolean;
  data?: { strategy_id?: string | number; payload_id?: string; [key: string]: unknown };
  error?: string;
}

export interface SubmitCallbacks {
  /** Called when a fresh FHE keypair is being generated (multi-second). */
  onKeygen?: () => void;
  /** Called when the server key is being uploaded (one-time, ~20MB). */
  onUploadKey?: () => void;
  /** Called when the client key is being sent to the confidential VM. */
  onUploadClientKey?: () => void;
  /** Called when bounds are being encrypted. */
  onEncrypt?: () => void;
}

/**
 * Encrypt + submit a strategy entirely client-side. `input` is the same shape the builder
 * already assembles (plaintext bounds / tree); this function encrypts them and posts the
 * ciphertext to the trade-executor.
 */
export async function submitEncryptedStrategy(
  input: StrategyInput,
  cb: SubmitCallbacks = {},
): Promise<SubmitResult> {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();
  const m: ClientMetrics = { keygenMs: 0, serverKeyMs: 0, encryptMs: 0, submitMs: 0, totalMs: 0 };
  let didKeygen = false;
  try {
    const userId = input.user_id;
    if (!userId) return { success: false, error: "Missing user_id." };

    // Predictions (POLYMARKET) is admin-only while it is in preview. The /markets page and the
    // dashboard widget already gate on this same allowlist, but the builder agent can also emit a
    // Predictions strategy, and that path reached the executor ungated. Guard the one function
    // every strategy submission routes through rather than each caller.
    if (input.strategy_type === "POLYMARKET" && !isAdminWallet(userId)) {
      return { success: false, error: "Private Markets is not available yet." };
    }
    // HYPERLIQUID is open to all wallets; the executor still refuses create if HL rails
    // (agent key) are not configured — that is ops, not a user allowlist.

    // Market PIPELINE / execute_now: no price/time trigger → still upload FHE server key
    // (executor createStrategy requires it) but skip dummy bounds encrypt (was upper/lower=0).
    const usingTree = input.condition_tree != null;
    const hasNumericBounds =
      typeof input.upper_bound === "number" || typeof input.lower_bound === "number";
    const needsFheTrigger = usingTree || hasNumericBounds;

    // 1. Per-wallet client key (generate + persist on first use).
    console.log("🔐 [FHE] Starting client-side encryption…");
    const tKey = now();
    const clientKey = await getOrCreateClientKey(userId, () => {
      didKeygen = true;
      console.log("🔐 [FHE] No client key found — generating a fresh FHE keypair (one-time, ~3-5s)…");
      cb.onKeygen?.();
    });
    if (didKeygen) m.keygenMs = now() - tKey;
    console.log(`🔐 [FHE] Client key ready (${didKeygen ? `generated in ${m.keygenMs.toFixed(0)}ms` : "loaded from session"}).`);

    // 2. Matching server key on the executor (required even when there is no trigger ciphertext).
    const tSrv = now();
    await ensureServerKeyUploaded(userId, clientKey, cb.onUploadKey, false, { refreshCanary: true });
    m.serverKeyMs = now() - tSrv;

    // Solana Devnet (900002) settles on Meteora after the executor submits the client Groth16 spend.
    const solanaDevnetArm = String(input.from_chain || "") === "900002";

    // TEE ClientKey sync only matters when the enclave must decrypt a trigger bit.
    if (needsFheTrigger) {
      console.log("🔐 [TEE] Securing your key in the attested enclave…");
      await ensureClientKeyInDecryptor(userId, clientKey, cb.onUploadClientKey, true);
      {
        let consistent = await verifyKeyConsistency(userId, clientKey);
        if (!consistent) {
          console.warn("🔐 [TEE] pre-arm key check FAILED — force re-syncing BOTH keys and retrying once…");
          invalidateAttestationCache();
          await ensureServerKeyUploaded(userId, clientKey, cb.onUploadKey, true, { refreshCanary: true });
          await ensureClientKeyInDecryptor(userId, clientKey, cb.onUploadClientKey, true);
          consistent = await verifyKeyConsistency(userId, clientKey);
        }
        if (!consistent) {
          throw new Error(
            "FHE key sync failed: the confidential VM couldn't decrypt a test value with your key. " +
            "Refresh the page to regenerate your keys, then try again.",
          );
        }
        console.log("🔐 [TEE] pre-arm key check ✅ — decryptor key verified consistent");
      }
    } else {
      console.log("🔐 [TEE] No FHE trigger — skipping ClientKey enclave sync (market / pipeline).");
    }

    // 3. Encrypt bounds / tree locally — only when the strategy actually has a trigger.

    let encrypted_upper_bound: string | undefined;
    let encrypted_lower_bound: string | undefined;
    let condition_tree: unknown = undefined;

    if (needsFheTrigger) {
      cb.onEncrypt?.();
      const tEnc = now();
      console.log(
        `🔐 [FHE] Encrypting ${usingTree ? "condition tree" : `bounds (upper=${input.upper_bound ?? 0}, lower=${input.lower_bound ?? 0})`} in the browser…`,
      );

      if (usingTree) {
        condition_tree = await encryptConditionTree(input.condition_tree, clientKey);
      } else {
        const upper = typeof input.upper_bound === "number" ? input.upper_bound : 0;
        const lower = typeof input.lower_bound === "number" ? input.lower_bound : 0;
        encrypted_upper_bound = await encryptPrice(upper, clientKey);
        encrypted_lower_bound = await encryptPrice(lower, clientKey);
      }
      m.encryptMs = now() - tEnc;
      const ctChars = usingTree
        ? JSON.stringify(condition_tree).length
        : (encrypted_upper_bound?.length ?? 0) + (encrypted_lower_bound?.length ?? 0);
      console.log(
        `🔐 [FHE] ✅ Encrypted in ${m.encryptMs.toFixed(0)}ms → ${ctChars.toLocaleString()} hex chars of ciphertext. ` +
          (isTeeAutonomousMode()
            ? "Plaintext bounds stay in the browser; trigger decryption runs only in the confidential VM."
            : "Plaintext bounds NEVER leave the browser; only ciphertext + the server (eval) key are sent."),
      );
    } else {
      console.log("🔐 [FHE] No price/time trigger — skipping bounds encryption (market / pipeline).");
    }

    // 4. Build the wire payload — strip plaintext bounds, attach ciphertext. No client key.
    const {
      upper_bound: _u,
      lower_bound: _l,
      condition_tree: _ct,
      ...rest
    } = input;
    void _u;
    void _l;
    void _ct;

    // Dual-generation safety boundary: the executor rejects (409) any strategy that doesn't name
    // the generation it considers active, so older/unclassified funds can't be armed. Injected
    // here rather than per-builder — every arm path funnels through this POST.
    const chainGeneration = NETWORKS[Number(rest.from_chain)]?.vaultGeneration;

    // Hard ASP: the executor re-checks the spent note's label against the live association set,
    // then drops it (never persisted on Strategy). Most builders already carry the label inside
    // zk_proof; lift it to the top level here so every path satisfies the check.
    const proofLike = (rest.zk_proof ?? rest.legs?.[0]?.zk_proof) as
      | { newLabel?: unknown; changeLabel?: unknown }
      | undefined;
    const noteLabel = rest.note_label ?? proofLike?.newLabel ?? proofLike?.changeLabel;

    const payload: Record<string, unknown> = {
      ...rest,
      ...(needsFheTrigger
        ? usingTree
          ? { condition_tree }
          : { encrypted_upper_bound, encrypted_lower_bound }
        : {}),
      ...(chainGeneration && !rest.vault_generation_id
        ? { vault_generation_id: chainGeneration }
        : {}),
      ...(noteLabel != null ? { note_label: noteLabel } : {}),
    };

    const base = getTradeExecutorBaseUrl();
    const tSubmit = now();
    const res = await fetch(`${base}/createStrategy`, {
      method: "POST",
      headers: await writeAuthHeaders(userId, { allowSolanaDevnetOpen: solanaDevnetArm }),
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    m.submitMs = now() - tSubmit;
    m.totalMs = now() - t0;
    if (!res.ok) {
      return { success: false, error: formatSubmitError(res.status, text) };
    }
    const data = JSON.parse(text);
    // Fire-and-forget: log the client-side encryption timings into the trade-executor terminal.
    void reportClientMetrics(userId, data?.strategy_id, m);
    try {
      appendUserActivity(userId, {
        kind: "strategy",
        strategyId: data?.strategy_id,
        status: "submitted",
        amount: payload.amount as number | string | undefined,
        token: payload.asset_in as string | undefined,
        label: `Strategy ${String(payload.strategy_type || "run").replace(/_/g, " ")}`,
      });
    } catch {
      /* activity log is best-effort */
    }
    return { success: true, data };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

interface ClientMetrics {
  keygenMs: number;
  serverKeyMs: number;
  encryptMs: number;
  submitMs: number;
  totalMs: number;
}

/** POST the in-browser encryption timings to the trade-executor so they show up in its logs. */
async function reportClientMetrics(
  userId: string,
  strategyId: string | number | undefined,
  m: ClientMetrics,
): Promise<void> {
  // Also surface in the browser console for quick local inspection.
  console.log(
    `[FHE timing] keygen=${m.keygenMs.toFixed(0)}ms serverKey=${m.serverKeyMs.toFixed(0)}ms ` +
      `encrypt=${m.encryptMs.toFixed(0)}ms submit=${m.submitMs.toFixed(0)}ms total=${m.totalMs.toFixed(0)}ms`,
  );
  try {
    await fetch(`${getTradeExecutorBaseUrl()}/clientMetrics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getCachedWalletAuthHeaders(userId),
      },
      body: JSON.stringify({ user_id: userId, strategy_id: strategyId, ...m }),
    });
  } catch {
    /* metrics are best-effort */
  }
}
