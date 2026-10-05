/**
 * zkMe zkKYC widget launcher — browser only (dynamic import).
 */
import type { KycResults, Provider, ZkMeWidget } from "@zkmelabs/widget";
import {
  isZkKycEnabled,
  zkMeAppId,
  zkMeProgramNo,
  zkMeWidgetChainId,
  zkMeWidgetLoginMode,
} from "@/lib/zkmeConfig";
import { saveLevel2Status } from "@/lib/trustLevel2";

export type LaunchZkKycOptions = {
  wallet: string;
  chainId: number;
  onFinished?: (results: KycResults) => void;
};

async function fetchAccessToken(): Promise<string> {
  const { getSigner } = await import("@/lib/nexus");
  const { fetchWithWalletAuth } = await import("@/lib/walletAuthHeaders");
  const signer = getSigner();
  if (!signer) throw new Error("Connect a wallet first");

  const resp = await fetchWithWalletAuth(signer, "/api/zkme/token", {
    method: "POST",
    body: JSON.stringify({ lv: "zkKYC" }),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    accessToken?: string;
    error?: string;
    message?: string;
  };
  if (!resp.ok || !data.accessToken) {
    throw new Error(data.message || data.error || "Could not start zkKYC — try again shortly");
  }
  return data.accessToken;
}

async function buildProvider(wallet: string): Promise<Provider> {
  const normalized = wallet.toLowerCase();
  return {
    async getAccessToken() {
      return fetchAccessToken();
    },
    async getUserAccounts() {
      return [normalized];
    },
    async delegateTransaction(tx) {
      const { BrowserProvider } = await import("ethers");
      const { connectedEvmProvider } = await import("./activeEvmProvider");
      // This SPENDS — it is the zkKYC fee transaction — so it must go through the wallet the
      // user connected with, never whichever extension happens to own window.ethereum. Refuse
      // rather than sign from an account the user did not pick.
      const eth = connectedEvmProvider();
      if (!eth) throw new Error("Connect a wallet before running zkKYC");
      const provider = new BrowserProvider(eth as ConstructorParameters<typeof BrowserProvider>[0]);
      const signer = await provider.getSigner();
      const txResponse = await signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        chainId: tx.chainId ? Number(BigInt(tx.chainId)) : undefined,
        gasLimit: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
        gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
        maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas
          ? BigInt(tx.maxPriorityFeePerGas)
          : undefined,
      });
      return txResponse.hash;
    },
  };
}

let activeWidget: ZkMeWidget | null = null;

const GRANT_CHECK_URL = "https://nest-api.zk.me/api/grant/check_v2";

/** zkMe returns 80000040 when the program is Created but not Applied in the dashboard. */
async function assertZkKycProgramApplied(
  appId: string,
  programNo: string,
  wallet: string,
): Promise<void> {
  const resp = await fetch(GRANT_CHECK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appId,
      programNo,
      userAccount: wallet.toLowerCase(),
    }),
  });
  const data = (await resp.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (data.code === 80000040) {
    throw new Error(
      "zkKYC program is not activated in zkMe — open dashboard.zk.me → Configuration → zkKYC, " +
        `select program ${programNo}, and click Apply program (status must not stay Created).`,
    );
  }
}

export async function launchZkKyc(opts: LaunchZkKycOptions): Promise<void> {
  if (!isZkKycEnabled()) {
    throw new Error("zkKYC is not configured for this deployment");
  }
  const appId = zkMeAppId();
  if (!appId) throw new Error("zkKYC is not configured");

  await import("@zkmelabs/widget/dist/style.css");

  const { ZkMeWidget } = await import("@zkmelabs/widget");
  const provider = await buildProvider(opts.wallet);
  const programNo = zkMeProgramNo();
  const lv = "zkKYC" as const;
  const loginMode = zkMeWidgetLoginMode(lv);
  const widgetChainId = zkMeWidgetChainId(opts.chainId);

  if (programNo) {
    await assertZkKycProgramApplied(appId, programNo, opts.wallet);
  }

  activeWidget?.destroy();
  const widget = new ZkMeWidget(appId, "Siphon", widgetChainId, provider, {
    lv,
    ...(loginMode ? { mode: loginMode } : {}),
    ...(programNo ? { programNo } : {}),
    theme: "auto",
    locale: "en",
  });
  activeWidget = widget;

  widget.on("kycFinished", (results) => {
    if (
      results.isGrant &&
      results.status === "matching" &&
      results.associatedAccount.toLowerCase() === opts.wallet.toLowerCase()
    ) {
      saveLevel2Status({
        wallet: opts.wallet,
        kind: "zkkyc",
        verifiedAt: results.verifyTimeAsIso ?? new Date().toISOString(),
        programNo: results.programNo,
        source: "zkme_widget",
      });
    }
    opts.onFinished?.(results);
  });

  widget.on("close", () => {
    widget.destroy();
    if (activeWidget === widget) activeWidget = null;
  });

  widget.launch();
}
