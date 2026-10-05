/**
 * Hard ASP depositsByLabel reads. NativeVault.json in the app can lag this mapping,
 * so callers always use this fragment — never the stale artifact ABI.
 */
import { Contract, ethers } from "ethers";

export const DEPOSITS_BY_LABEL_ABI = [
  "function depositsByLabel(uint256) view returns (address depositor, uint256 amount, uint256 commitment, uint8 status)",
] as const;

/** LabelStatus: Pending=0, Admitted=1, Revoked=2, Ragequit=3 */
export const LABEL_PENDING = 0;
export const LABEL_ADMITTED = 1;
export const LABEL_REVOKED = 2;
export const LABEL_RAGEQUIT = 3;

export type AspNoteAccess = "deposited" | "checking" | "flagged" | "spent";

/** Chain revocation is authoritative. On-chain Admitted is deposited even if the
 * HTTP association-set indexer is lagging. Pending is deposited only once published. */
export function classifyAspNote(status: number, inAssociationSet: boolean): AspNoteAccess {
  if (status === LABEL_RAGEQUIT) return "spent";
  if (status === LABEL_REVOKED) return "flagged";
  if (status === LABEL_ADMITTED) return "deposited";
  return inAssociationSet ? "deposited" : "checking";
}

export type OnChainDepositInfo = {
  depositor: string;
  amount: bigint;
  commitment: bigint;
  status: number;
};

export function depositInfoReader(vault: Contract): Contract {
  const addr = vault.target as string;
  return new Contract(addr, DEPOSITS_BY_LABEL_ABI, vault.runner);
}

export async function readDepositInfo(
  vault: Contract,
  label: bigint | string,
): Promise<OnChainDepositInfo | null> {
  const lab = BigInt(label);
  if (lab === 0n) return null;
  const reader = depositInfoReader(vault);
  const info = await reader.depositsByLabel(lab);
  const depositor = String(info.depositor ?? info[0] ?? "");
  if (!depositor || depositor === ethers.ZeroAddress) return null;
  return {
    depositor,
    amount: BigInt(info.amount ?? info[1] ?? 0),
    commitment: BigInt(info.commitment ?? info[2] ?? 0),
    status: Number(info.status ?? info[3] ?? -1),
  };
}

export function sameUint(a: bigint | string | number, b: bigint | string | number): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

export function isOriginalDepositNote(
  noteCommitment: string | bigint,
  info: OnChainDepositInfo,
): boolean {
  return sameUint(noteCommitment, info.commitment);
}

/** Original pending/revoked notes take ragequit — never private withdraw. */
export function isRagequitOriginal(info: OnChainDepositInfo, noteCommitment: string | bigint): boolean {
  if (!isOriginalDepositNote(noteCommitment, info)) return false;
  return info.status === LABEL_PENDING || info.status === LABEL_REVOKED;
}
