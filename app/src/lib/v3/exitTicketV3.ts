/** Turn a clean pending v3 deposit into the circuit's existing revoked ragequit branch. */
import { Contract, Interface, type Signer } from "ethers";

import { getUserActivities } from "../userActivityLog";
import { fetchWithWalletAuth } from "../walletAuthHeaders";
import type { SpendNote } from "./spendActionsV3";
import { requireV3 } from "./configV3";

const DEPOSIT_IFACE = new Interface([
  "function deposit(address token, uint256 amount, uint256 userSalt, uint256 precommitment)",
  "function depositNative(uint256 userSalt, uint256 precommitment) payable",
]);
const HUB_ABI = ["function revokedRoot() view returns (uint256)"];

export function userSaltFromDepositCalldata(data: string): string | null {
  try {
    const parsed = DEPOSIT_IFACE.parseTransaction({ data });
    if (!parsed) return null;
    if (parsed.name === "deposit") return parsed.args.userSalt.toString();
    if (parsed.name === "depositNative") return parsed.args.userSalt.toString();
    return null;
  } catch {
    return null;
  }
}

async function exitTicketMetadata(args: {
  chainId: number;
  noteKey: string;
  note: SpendNote;
  signer: Signer;
}): Promise<{ txHash: string; userSalt: string; depositor: string }> {
  const cfg = requireV3(args.chainId);
  const depositor = (await args.signer.getAddress()).toLowerCase();
  const activityTx = getUserActivities(depositor).find(
    (row) => row.kind === "deposit" && row.noteKey === args.noteKey && row.txHash,
  )?.txHash;
  const txHash = String(args.note.depositTxHash || activityTx || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error(
      "This older note is missing its deposit transaction reference. Open its deposit receipt and retry from the device that created it.",
    );
  }

  let userSalt = String(args.note.userSalt || "");
  if (!userSalt) {
    const provider = args.signer.provider;
    if (!provider) throw new Error("A connected chain provider is required for the exit ticket.");
    const tx = await provider.getTransaction(txHash);
    if (!tx || (tx.to || "").toLowerCase() !== cfg.vaultKernel.toLowerCase()) {
      throw new Error("The original v3 deposit transaction could not be verified.");
    }
    userSalt = userSaltFromDepositCalldata(tx.data) || "";
  }
  try {
    if (BigInt(userSalt) === 0n) throw new Error("zero");
  } catch {
    throw new Error("The original deposit salt could not be recovered from its transaction.");
  }
  return { txHash, userSalt, depositor };
}

async function memberStatusFresh(
  signer: Signer,
  label: string,
  chainId: number,
): Promise<{ admitted: boolean; revoked: boolean }> {
  // chainId picks the ASP: without it the proxy asks the default chain's ASP about this label.
  const res = await fetchWithWalletAuth(
    signer,
    `/api/asp-set/member?label=${encodeURIComponent(label)}&chainId=${chainId}`,
    { method: "GET" },
  );
  if (!res.ok) throw new Error(`ASP membership check failed (${res.status}).`);
  const body = (await res.json()) as { admitted?: boolean; revoked?: boolean };
  return { admitted: body.admitted === true, revoked: body.revoked === true };
}

async function waitForPublishedRevocation(args: {
  signer: Signer;
  chainId: number;
  label: string;
  timeoutMs?: number;
}): Promise<void> {
  const cfg = requireV3(args.chainId);
  if (!args.signer.provider) throw new Error("A connected chain provider is required for ragequit.");
  const hub = new Contract(cfg.complianceHub, HUB_ABI, args.signer.provider);
  const started = Date.now();
  const timeoutMs = args.timeoutMs ?? 180_000;

  while (Date.now() - started < timeoutMs) {
    try {
      const member = await memberStatusFresh(args.signer, args.label, args.chainId);
      const pathRes = await fetchWithWalletAuth(
        args.signer,
        `/api/asp-set/smt-path?label=${encodeURIComponent(args.label)}&chainId=${args.chainId}`,
        { method: "GET" },
      );
      if (member.revoked && pathRes.ok) {
        const path = (await pathRes.json()) as { revokedRoot?: string; claimedLeaf?: string };
        const root = String(path.revokedRoot || "");
        const claimedLeaf = String(path.claimedLeaf || "0");
        const liveRoot = String(await hub.revokedRoot());
        if (root && claimedLeaf !== "0" && liveRoot === root) return;
      }
    } catch {
      // The ASP and per-chain postman converge asynchronously; retry inside the bounded window.
    }
    // Stay below the authenticated proxy's 20 requests/minute per-wallet limit.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error("The ragequit exit ticket is ready at the ASP but its on-chain root is still publishing. Retry shortly.");
}

/**
 * No-op for an already-revoked label. During the deposit's five-minute grace period, both pending
 * and newly admitted labels may request a deposit-bound exit ticket; the server enforces the
 * deadline from the mined block. Then wait until that root is current on the selected chain so the
 * existing branch-1 proof cannot race the Base/Sepolia postmen.
 */
export async function ensureRagequitExitTicket(args: {
  chainId: number;
  noteKey: string;
  note: SpendNote;
  signer: Signer;
}): Promise<void> {
  const cfg = requireV3(args.chainId);
  const status = await memberStatusFresh(args.signer, args.note.label, args.chainId);
  if (status.revoked) {
    await waitForPublishedRevocation({
      signer: args.signer,
      chainId: args.chainId,
      label: args.note.label,
    });
    return;
  }
  const meta = await exitTicketMetadata(args);
  const body = JSON.stringify({
    chainId: args.chainId,
    label: args.note.label,
    commitment: args.note.commitment,
    txHash: meta.txHash,
    userSalt: meta.userSalt,
    vault: cfg.vaultKernel,
    depositor: meta.depositor,
  });
  const res = await fetchWithWalletAuth(args.signer, "/api/asp-revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const response = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new Error(response.message || response.error || `Exit-ticket request failed (${res.status}).`);
  }

  await waitForPublishedRevocation({
    signer: args.signer,
    chainId: args.chainId,
    label: args.note.label,
  });
}
