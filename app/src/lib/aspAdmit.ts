/** Request postman /set/admit via same-origin server proxy after a mined deposit. */
import type { Signer } from "ethers";
import { getPrivilegedWalletAuthHeaders } from "@/lib/walletAuthHeaders";

export type AdmitArgs = {
  chainId: number;
  label: string;
  txHash: string;
  vault: string;
  /** Depositing EOA — must match the signer address. */
  depositor: string;
  signer: Signer;
  /** v3/v5 deposits (no LabelMinted event): the note commitment and the deposit's userSalt. */
  commitment?: string;
  userSalt?: string;
};

/**
 * The ASP will not admit a label until the deposit tx has ASP_CHAIN_MIN_CONFIRMATIONS (2), but
 * the deposit flow calls admit the moment the tx is mined — at 1 confirmation. That race is
 * expected, not a failure: it returns 400 "transaction has 1/2 confirmations".
 */
const NEEDS_MORE_CONFIRMATIONS = /confirmation/i;
// One Sepolia block is ~12s; Base is ~2s. Four tries covers both without running long enough to
// overlap the watcher's own sweep.
const RETRY_DELAYS_MS = [4_000, 9_000, 14_000, 20_000];

/**
 * Admit a freshly mined deposit's label into the ASP set.
 *
 * On the confirmation race this keeps retrying in the BACKGROUND and resolves immediately, so the
 * deposit UI never blocks on a block time. The asp-watcher is still the backstop and would admit
 * the label regardless — but only on its next sweep, which leaves the fresh deposit unprovable
 * for minutes. Winning the fast postman path is the difference between "provable in seconds" and
 * "provable in ~2 minutes".
 *
 * Each attempt re-signs: the privileged header binds METHOD, path, sha256(body) AND a timestamp,
 * so a signature minted for the first try is stale by the time the later delays elapse.
 */
export async function requestAspAdmit(args: AdmitArgs): Promise<{ ok: boolean; error?: string }> {
  const first = await attemptAspAdmit(args);
  if (!first.ok && first.error && NEEDS_MORE_CONFIRMATIONS.test(first.error)) {
    void retryUntilConfirmed(args);
  }
  return first;
}

async function retryUntilConfirmed(args: AdmitArgs): Promise<void> {
  for (const delay of RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    const res = await attemptAspAdmit(args);
    if (res.ok) {
      console.log("[deposit] ASP label admitted (after confirmations)");
      // Mirror the inline success path in handler.ts: the new leaf is only visible once the
      // cached leaf set is dropped, and the balance UI listens for this event.
      const { invalidateLeafCache } = await import("./zkHandler");
      invalidateLeafCache();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("siphon:vaultBalanceInvalidate"));
      }
      return;
    }
    // Anything that is not the confirmation race is terminal for this path — stop and let the
    // watcher handle it rather than hammering the postman with a request that cannot succeed.
    if (!res.error || !NEEDS_MORE_CONFIRMATIONS.test(res.error)) return;
  }
}

async function attemptAspAdmit(args: AdmitArgs): Promise<{ ok: boolean; error?: string }> {
  const bodyText = JSON.stringify({
    chainId: args.chainId,
    label: args.label,
    txHash: args.txHash,
    vault: args.vault,
    depositor: args.depositor,
    ...(args.commitment && args.userSalt ? { commitment: args.commitment, userSalt: args.userSalt } : {}),
  });

  const postOnce = async (headers: Record<string, string>) => {
    const res = await fetch("/api/asp-admit", {
      method: "POST",
      headers,
      body: bodyText,
    });
    const data = (await res.json()) as Record<string, unknown>;
    return { res, data };
  };

  try {
    let headers = await getPrivilegedWalletAuthHeaders(
      args.signer,
      "POST",
      "/api/asp-admit",
      bodyText,
    );
    let { res, data } = await postOnce(headers);

    // Request-bound sig expired or invalid — re-sign once, retry.
    if (
      res.status === 401 &&
      (data.error === "wallet_auth_expired" || data.error === "wallet_auth_invalid")
    ) {
      headers = await getPrivilegedWalletAuthHeaders(
        args.signer,
        "POST",
        "/api/asp-admit",
        bodyText,
      );
      ({ res, data } = await postOnce(headers));
    }

    if (!res.ok) {
      const msg =
        (typeof data.message === "string" && data.message) ||
        (typeof data.error === "string" && data.error) ||
        `asp_admit_http_${res.status}`;
      return { ok: false, error: msg };
    }
    if (data.error) {
      return { ok: false, error: String(data.error) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "asp_admit_failed" };
  }
}
