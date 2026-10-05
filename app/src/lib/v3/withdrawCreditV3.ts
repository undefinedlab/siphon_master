/**
 * Prepaid withdrawal-fee credit (v3).
 *
 * The v3 VaultKernel has no fee module and is immutable, so a withdrawal fee cannot be carved out
 * on-chain the way the v2 vaults did. It is charged by the RELAYER instead, against a balance the
 * user tops up in advance.
 *
 * Two things follow from that, and both are visible in this file:
 *
 *  - The fee does NOT reduce the withdrawal. The recipient still receives the full amount; the fee
 *    comes out of the prepaid balance. So none of this touches the withdraw solver, and the
 *    "recipient receives X" line stays true.
 *
 *  - It is optional by construction. `VaultKernel.spend()` is permissionless so a TEE outage can
 *    never trap funds, which means anyone can self-submit and pay nothing. The UI should offer the
 *    relayer as a convenience, never imply the exit is gated on paying.
 *
 * Top-ups are deliberately infrequent: paying per withdrawal would put a transfer from the user's
 * PUBLIC wallet moments before their shielded exit, which correlates the two by timing.
 */

import { Contract, Signer, ethers } from "ethers";
import { requireV3 } from "./configV3";
import { getNetwork, getTokens } from "../networks";
// The executor is CROSS-ORIGIN (api.siphon.money), so it needs write-challenge headers. The
// same-origin helper used for /api/* proxies is request-bound to that path and its headers fail
// the executor's @verify_wallet_write with "Write challenge required" — which this module would
// swallow into a null credit and show no fee at all. Same helper executorSubmitV3 uses.
import { getWalletAuthHeaders, getWalletWriteAuthHeaders } from "../walletAuthHeaders";

export interface WithdrawCredit {
  /** False when the relayer charges nothing — quote no fee rather than a price it will not take. */
  enabled: boolean;
  chainId: number;
  feeWei: bigint;
  balanceWei: bigint;
  collector: string;
  asset: string;
  decimals: number;
}

const ERC20_TRANSFER_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

/** Why a top-up of `needWei` cannot be sent from a wallet holding `haveWei`, or null if it can. */
export function topUpShortfall(
  haveWei: bigint,
  needWei: bigint,
  networkName: string,
  decimals = 6,
): string | null {
  if (haveWei >= needWei) return null;
  return (
    `Top-up needs ${formatCredit(needWei, decimals)} USDC on ${networkName}, but this wallet holds ` +
    `${formatCredit(haveWei, decimals)} there. Send USDC to it on ${networkName} and try again.`
  );
}

/**
 * How much to actually send: all of `wantWei` if the wallet covers it, otherwise as many whole
 * withdrawals' worth as it can afford (0n when it cannot afford one). The bulk amount is a privacy
 * convenience, not a price — a wallet holding 0.99 USDC must not be refused a 1.00 top-up when a
 * single relay costs 0.05. The relayer credits whatever the transfer carries.
 */
export function affordableTopUp(haveWei: bigint, wantWei: bigint, feeWei: bigint): bigint {
  if (haveWei >= wantWei) return wantWei;
  return feeWei > 0n ? (haveWei / feeWei) * feeWei : 0n;
}

/** USDC minor units → a display string. */
export function formatCredit(wei: bigint, decimals = 6): string {
  return ethers.formatUnits(wei, decimals);
}

/** True when the relayer will refuse this withdrawal for lack of credit. */
export function needsTopUp(c: WithdrawCredit | null): boolean {
  return !!c && c.enabled && c.feeWei > 0n && c.balanceWei < c.feeWei;
}

/**
 * Read the current balance and price.
 * Returns null when the endpoint is unreachable or the chain has no executor — an unknown fee must
 * read as unknown, never as zero, and never block the withdraw button.
 */
export async function fetchWithdrawCredit(
  chainId: number,
  signer: Signer,
): Promise<WithdrawCredit | null> {
  const cfg = requireV3(chainId);
  if (!cfg.executorUrl) return null;
  try {
    // READ auth. getWalletWriteAuthHeaders signs on EVERY call by design — "a write is something
    // the user just clicked" — so using it here popped a MetaMask signature on every dashboard
    // load, and a page load is not consent. Worse, an unsigned prompt threw, this function
    // swallowed it into null, and the panel showed a free withdrawal while the relayer charged.
    const headers = await getWalletAuthHeaders(signer);
    const res = await fetch(`${cfg.executorUrl}/withdrawCredit?chain_id=${chainId}`, { headers });
    if (!res.ok) return null;
    const b = (await res.json()) as Record<string, unknown>;
    return {
      enabled: Boolean(b.enabled),
      chainId,
      feeWei: BigInt(String(b.fee_wei ?? "0")),
      balanceWei: BigInt(String(b.balance_wei ?? "0")),
      collector: String(b.collector ?? ""),
      asset: String(b.asset ?? "USDC"),
      decimals: Number(b.decimals ?? 6),
    };
  } catch {
    return null;
  }
}

/**
 * Send a USDC transfer to the collector and register it as credit.
 *
 * The transfer is sent from the connected wallet, so it must be confirmed before the relayer can
 * see it — we wait for the receipt rather than posting the hash optimistically, or the first
 * top-up reliably fails with "transaction not found" and looks like the payment was lost.
 *
 * @param amountWei USDC minor units to add.
 * @returns the new balance in minor units.
 */
export async function topUpWithdrawCredit(
  chainId: number,
  signer: Signer,
  amountWei: bigint,
): Promise<bigint> {
  const cfg = requireV3(chainId);
  if (!cfg.executorUrl) throw new Error("no executor configured for this network");
  if (amountWei <= 0n) throw new Error("top-up amount must be positive");

  const credit = await fetchWithdrawCredit(chainId, signer);
  const collector = credit?.collector;
  if (!collector || !/^0x[0-9a-fA-F]{40}$/.test(collector)) {
    throw new Error("relayer did not report a collector address");
  }

  const usdc = getTokens(chainId)?.USDC?.address;
  if (!usdc) throw new Error(`no USDC configured for chain ${chainId}`);

  const token = new Contract(usdc, ERC20_TRANSFER_ABI, signer);
  // Check first: without this the wallet's gas estimate reverts and the user is shown a raw
  // "ERC20: transfer amount exceeds balance" calldata dump instead of what to do about it.
  const have = (await token.balanceOf(await signer.getAddress())) as bigint;
  const fee = credit?.feeWei ?? 0n;
  const pay = affordableTopUp(have, amountWei, fee);
  if (pay <= 0n) {
    const need = fee > 0n ? fee : amountWei;
    throw new Error(
      topUpShortfall(have, need, getNetwork(chainId).name, credit?.decimals) ?? "top-up amount must be positive",
    );
  }
  const tx = await token.transfer(collector, pay);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("top-up transfer reverted");

  const headers = await getWalletWriteAuthHeaders(signer);
  const res = await fetch(`${cfg.executorUrl}/withdrawCredit/topup`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ chain_id: chainId, tx_hash: tx.hash }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // The money HAS moved at this point. Say so, and name the hash, so the user can have it
    // credited rather than assuming it vanished.
    throw new Error(
      `${String(body.error ?? `HTTP ${res.status}`)} — the transfer ${tx.hash} was sent and can ` +
        `still be credited with this hash.`,
    );
  }
  return BigInt(String(body.balance_wei ?? "0"));
}
