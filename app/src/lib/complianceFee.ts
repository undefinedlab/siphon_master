/**
 * Compliance fees — separate $0.50 / year products on asp-v2:
 *   kyt_year_v1 — Level 1 transaction-risk KYT (zkMe server screening)
 *   kyc_year_v1 — Level 2 zkKYC identity widget
 */
import { showAppToast } from "@/lib/appToast";

export const PRODUCT_KYT = "kyt_year_v1" as const;
export const PRODUCT_KYC = "kyc_year_v1" as const;
export type ComplianceProduct = typeof PRODUCT_KYT | typeof PRODUCT_KYC;

export type ComplianceFeeStatus = {
  paid?: boolean;
  active?: boolean;
  expiresAt?: string | null;
  vault?: string | null;
  feeUsdc?: number;
  feeWei?: number | string;
  entitlementDays?: number;
  product?: string;
  error?: string;
};

export const KYT_FEE_REQUIRED_MESSAGE =
  "KYT fee required — pay $0.50/year to activate transaction screening.";

export const KYC_FEE_REQUIRED_MESSAGE =
  "KYC fee required — pay $0.50/year to activate zkKYC identity verification.";

/** wei → a short ETH string for balance / shortfall messages. */
function fmtEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(5);
}

/** Gas a bare value transfer needs, with headroom. 0 if the node won't quote a fee. */
async function gasHeadroomWei(provider: {
  getFeeData: () => Promise<{ maxFeePerGas?: bigint | null; gasPrice?: bigint | null }>;
}): Promise<bigint> {
  try {
    const fee = await provider.getFeeData();
    const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    // 21k for the transfer, doubled so a basefee spike between this quote and the signature
    // can't turn "you have enough" back into the opaque estimateGas failure.
    return 21_000n * price * 2n;
  } catch {
    return 0n;
  }
}

async function getSignerAndChainId(): Promise<{
  signer: import("ethers").Signer;
  chainId: number;
} | null> {
  const { getSigner } = await import("@/lib/nexus");
  const signer = getSigner();
  if (!signer) return null;
  const chainId = Number((await signer.provider?.getNetwork())?.chainId ?? 0);
  return { signer, chainId };
}

/**
 * A fee that was PAID but not yet VERIFIED. The ASP only records a payment after it has
 * CHAIN_MIN_CONFIRMATIONS (2) blocks, so the verify can lose the race with the chain — and the
 * money has already left the wallet. Remembering the hash means the next attempt re-verifies that
 * payment instead of charging the user a second time.
 */
const pendingFeeKey = (chainId: number, product: ComplianceProduct, wallet: string) =>
  `siphon.complianceFeeTx.${chainId}.${product}.${wallet.toLowerCase()}`;

function readPendingFee(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function writePendingFee(key: string, txHash: string | null): void {
  try {
    if (txHash) localStorage.setItem(key, txHash);
    else localStorage.removeItem(key);
  } catch {
    /* no storage — the in-call retries below still cover the common case */
  }
}

/** Confirmation-floor refusals are "not yet", not "no": the tx is fine, the chain is just behind. */
export const NOT_YET_CONFIRMED = /confirmations|not (yet )?(mined|found)|pending/i;

/**
 * ASP answers that mean the stored tx can NEVER verify (compliance_fee.py FeeNotPaid texts). Only
 * these may drop a remembered payment — an RPC blip ("Cannot fetch transaction…") or a missing
 * vault config must keep it, or the next click charges the user again for a fee they already paid.
 */
export const PAYMENT_INVALID =
  /reverted|does not match wallet|does not contain a valid fee payment|already consumed|txHash must be/i;

function productLabel(product: ComplianceProduct): string {
  return product === PRODUCT_KYC ? "KYC" : "KYT";
}

/** Authoritative ASP entitlement check for a product. */
export async function fetchComplianceFeeStatus(
  wallet: string,
  product: ComplianceProduct = PRODUCT_KYT,
  chainId?: number,
): Promise<ComplianceFeeStatus | null> {
  try {
    const session = await getSignerAndChainId();
    if (!session) return null;
    const { fetchWithWalletAuth } = await import("@/lib/walletAuthHeaders");
    const cid = chainId ?? session.chainId;
    const resp = await fetchWithWalletAuth(
      session.signer,
      `/api/compliance-fee?wallet=${encodeURIComponent(wallet)}` +
        `&product=${encodeURIComponent(product)}` +
        (cid ? `&chainId=${cid}` : ""),
    );
    if (!resp.ok) return null;
    return (await resp.json()) as ComplianceFeeStatus;
  } catch {
    return null;
  }
}

export async function checkComplianceFeePaid(
  wallet: string,
  product: ComplianceProduct = PRODUCT_KYT,
): Promise<boolean> {
  const status = await fetchComplianceFeeStatus(wallet, product);
  return Boolean(status?.paid ?? status?.active);
}

export async function checkKytFeePaid(wallet: string): Promise<boolean> {
  return checkComplianceFeePaid(wallet, PRODUCT_KYT);
}

export async function checkKycFeePaid(wallet: string): Promise<boolean> {
  return checkComplianceFeePaid(wallet, PRODUCT_KYC);
}

export async function ensureComplianceFeePaid(
  wallet: string,
  product: ComplianceProduct,
): Promise<boolean> {
  if (await checkComplianceFeePaid(wallet, product)) return true;
  return payComplianceFee(wallet, product);
}

export async function ensureKytFeePaid(wallet: string): Promise<boolean> {
  return ensureComplianceFeePaid(wallet, PRODUCT_KYT);
}

export async function ensureKycFeePaid(wallet: string): Promise<boolean> {
  return ensureComplianceFeePaid(wallet, PRODUCT_KYC);
}

export async function payComplianceFee(
  wallet: string,
  product: ComplianceProduct = PRODUCT_KYT,
): Promise<boolean> {
  const { BrowserProvider, parseUnits } = await import("ethers");
  const { fetchWithWalletAuth } = await import("@/lib/walletAuthHeaders");
  const { connectedEvmProvider } = await import("@/lib/activeEvmProvider");
  const { getSelectedChainId } = await import("@/lib/networks");
  // The wallet the user actually connected through — NOT window.ethereum. With more than one
  // extension installed, that global belongs to whichever won the injection race, which is a
  // different account on a possibly different network. Quoting the vault from ITS chain and
  // paying from ITS account is how a real $0.50 leaves the wallet and the ASP still answers
  // "Transaction does not contain a valid fee payment": the money went to another chain's vault.
  const eth = connectedEvmProvider();
  if (!eth) {
    showAppToast("Connect a wallet first", "error");
    return false;
  }
  const label = productLabel(product);
  try {
    const provider = new BrowserProvider(eth as ConstructorParameters<typeof BrowserProvider>[0]);
    const signer = await provider.getSigner();
    const chainId = Number((await provider.getNetwork()).chainId);
    // Vaults are per-chain and the fee is a bare value transfer, so a chain mismatch is
    // unrecoverable — the ETH lands at an address that holds no code on the chain we then ask
    // the ASP to verify against. Refuse instead of spending.
    const selected = getSelectedChainId();
    if (chainId !== selected) {
      showAppToast(
        `Wallet is on chain ${chainId} but the app is on ${selected} — switch networks in your wallet, then retry.`,
        "error",
      );
      return false;
    }
    const checkResp = await fetchWithWalletAuth(
      signer,
      `/api/compliance-fee?wallet=${encodeURIComponent(wallet)}` +
        `&chainId=${chainId}&product=${encodeURIComponent(product)}`,
    );
    const checkData = (await checkResp.json().catch(() => ({}))) as ComplianceFeeStatus;
    if (!checkResp.ok) {
      const why =
        checkResp.status === 401 || checkResp.status === 403
          ? "Your wallet signature expired — reconnect and try again."
          : checkResp.status === 429
            ? "Too many attempts — wait a moment and try again."
            : checkData.error === "asp_unconfigured"
              ? "Compliance service is not configured for this deployment — contact support."
              : `Couldn't reach the compliance service (HTTP ${checkResp.status}) — try again shortly.`;
      showAppToast(why, "error");
      return false;
    }
    if (checkData.paid) {
      writePendingFee(pendingFeeKey(chainId, product, wallet), null);
      return true;
    }

    const verify = async (txHash: string): Promise<{ ok?: boolean; message?: string }> => {
      const resp = await fetchWithWalletAuth(signer, "/api/compliance-fee", {
        method: "POST",
        body: JSON.stringify({ wallet, txHash, chainId, product }),
      });
      return (await resp.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    };
    // Retry only the "not confirmed yet" answer, a few block times apart. Anything else is final.
    const verifyWithRetry = async (txHash: string) => {
      let last: { ok?: boolean; message?: string } = {};
      for (let attempt = 0; attempt < 6; attempt++) {
        last = await verify(txHash);
        if (last.ok || !NOT_YET_CONFIRMED.test(last.message ?? "")) return last;
        await new Promise((r) => setTimeout(r, 3_000));
      }
      return last;
    };
    const pendingKey = pendingFeeKey(chainId, product, wallet);

    // Paid before but never verified: finish THAT payment instead of sending another.
    const pending = readPendingFee(pendingKey);
    if (pending) {
      showAppToast(`Verifying your earlier ${label} fee payment…`, "info");
      const res = await verifyWithRetry(pending);
      if (res.ok) {
        writePendingFee(pendingKey, null);
        showAppToast(`${label} fee active — 1 year coverage`, "success");
        return true;
      }
      if (!PAYMENT_INVALID.test(res.message ?? "")) {
        showAppToast(
          NOT_YET_CONFIRMED.test(res.message ?? "")
            ? "Your fee payment is still confirming — try again in a minute."
            : `Couldn't verify your earlier fee payment yet (${res.message ?? "no answer"}) — try again shortly. You will not be charged twice.`,
          "error",
        );
        return false;
      }
      // The stored tx can never verify (reverted, wrong sender, wrong amount/vault): forget it and
      // let the user pay fresh rather than wedging them on it forever.
      writePendingFee(pendingKey, null);
    }

    const vault = checkData.vault;
    if (!vault) {
      showAppToast(
        `Compliance vault not configured for chain ${chainId} — contact support`,
        "error",
      );
      return false;
    }

    const feeWei =
      checkData.feeWei != null ? BigInt(checkData.feeWei) : parseUnits("0.0002", "ether");
    const feeLabel =
      checkData.feeUsdc != null
        ? `$${(checkData.feeUsdc / 1e6).toFixed(2)}`
        : "$0.50";
    // Pre-flight the balance. This is a bare value transfer, so a wallet that cannot cover
    // fee + gas fails inside estimateGas as an opaque `missing revert data … CALL_EXCEPTION`
    // with no `reason` — which used to reach the toast verbatim at the very start of KYT. The
    // shortfall is knowable before we spend, so quote it in ETH instead.
    const payer = await signer.getAddress();
    const needed = feeWei + (await gasHeadroomWei(provider));
    const balance = await provider.getBalance(payer);
    if (balance < needed) {
      showAppToast(
        `Not enough ETH for the ${label} fee — it costs ${feeLabel} paid in ETH, so you need ` +
          `about ${fmtEth(needed)} ETH including gas. This wallet holds ${fmtEth(balance)} ETH.`,
        "error",
      );
      return false;
    }
    showAppToast(`Sending ${feeLabel} ${label} fee (1-year activation)…`, "info");
    const tx = await signer.sendTransaction({ to: vault, value: feeWei });
    // Remember it BEFORE waiting: from here on the money is gone, whatever happens to this tab.
    writePendingFee(pendingKey, tx.hash);
    showAppToast("Waiting for confirmation…", "info");
    // 2, not 1 — the ASP's CHAIN_MIN_CONFIRMATIONS floor. Verifying after one block raced it and
    // failed with "fee transaction has 1/2 confirmations" after the fee had already been paid.
    const receipt = await tx.wait(2);
    if (!receipt || receipt.status !== 1) {
      writePendingFee(pendingKey, null);
      showAppToast("Fee transaction failed", "error");
      return false;
    }

    const verifyData = await verifyWithRetry(receipt.hash);
    if (!verifyData.ok) {
      // The fee is paid either way; only a definitive rejection may let the next click pay again.
      if (PAYMENT_INVALID.test(verifyData.message ?? "")) writePendingFee(pendingKey, null);
      showAppToast(
        PAYMENT_INVALID.test(verifyData.message ?? "")
          ? (verifyData.message ?? "Fee verification failed")
          : "Fee paid — still confirming. Try again in a minute; you will not be charged twice.",
        "error",
      );
      return false;
    }
    writePendingFee(pendingKey, null);
    showAppToast(`${label} fee active — 1 year coverage`, "success");
    return true;
  } catch (e) {
    const raw = e instanceof Error ? e.message : "";
    // Same shortfall, reached a different way: the pre-flight check passed against a stale
    // basefee, or the wallet moved funds between the check and the signature.
    const msg = /insufficient funds|missing revert data|CALL_EXCEPTION/i.test(raw)
      ? `Not enough ETH to cover the ${label} fee and gas — top this wallet up and retry.`
      : raw || "Fee payment failed";
    showAppToast(msg, "error");
    return false;
  }
}

export function formatFeeExpiry(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  try {
    return new Date(expiresAt).toLocaleDateString();
  } catch {
    return null;
  }
}
