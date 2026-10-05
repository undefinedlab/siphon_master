/**
 * Withdraw public-signals derivation (PROTOCOL §4, WITHDRAW action, PROGRAM_VERSION 4).
 *
 * Browser-native equivalent of `spend-core::validate_withdraw` → `to_bn254_limbs()` for the WITHDRAW
 * action only. The client MUST recompute the 25 public limbs locally and match them against the
 * proof's publicSignals before submit (PROTOCOL §9, O-30). This module produces that expected array.
 *
 * Mirrors withdraw.rs exactly:
 *   - primary + secondary == Σ inValue  (conservation)
 *   - secondary <= inValue[boundary]     (v4 fractional change)
 *   - outLabel = inLabel[boundary]; outCommitment = 0 if secondary==0 else commitment(secondary,…)
 *   - public[8] = 0; public[16] = 4; public[17] = assetId; public[18..24] = 0
 *   - public[9+i] = Poseidon(inNullifier[i]) for i<inputCount, else 0
 *   - public[15] = payeeId(rawPayee)
 */

import {
  hashCommitment,
  hashNullifier,
  modField,
} from "./noteCrypto";
import { PROGRAM_VERSION_V3 } from "./constants";
import { payeeIdEvm } from "./payee";
import { labelCommit } from "./labelCommit";

export const ACTION_WITHDRAW = 0;
export const PUBLIC_WIDTH = 25;

export interface WithdrawInput {
  inValue: bigint;
  inNullifier: bigint;
  inSecret: bigint;
  inLabel: bigint;
  inAssetId: bigint;
}

export interface WithdrawPublicsParams {
  inputs: WithdrawInput[];
  boundaryIndex: number;
  primaryValue: bigint;
  secondaryValue: bigint;
  stateRoot: bigint;
  admittedRoot: bigint;
  revokedRoot: bigint;
  outNullifier: bigint;
  outSecret: bigint;
  /** 20-byte recipient address (0x…). */
  rawPayee: string;
  chainId: number;
  /**
   * Binding salt shared with the COMPLIANCE half (COMPLIANCE_CIRCUIT_SPLIT §3.2). Non-zero.
   * Limb 24 is `labelCommit` over this salt, and the compliance proof must recompute the same
   * value — that identity is the only thing tying the two halves together.
   */
  labelCommitSalt: bigint;
}

/**
 * Compute the 25 public limbs (as decimal strings) for a v4 withdraw.
 * @throws on the same conditions spend-core rejects (bad boundary, sum mismatch, change>boundary).
 */
export async function deriveWithdrawPublics(
  p: WithdrawPublicsParams,
): Promise<string[]> {
  const n = p.inputs.length;
  if (n < 1 || n > 6) throw new Error("deriveWithdrawPublics: inputCount out of [1,6]");
  if (p.boundaryIndex < 0 || p.boundaryIndex >= n) {
    throw new Error("deriveWithdrawPublics: boundaryIndex out of range");
  }
  if (p.primaryValue <= 0n) throw new Error("deriveWithdrawPublics: primaryValue must be positive");

  // Asset bind: every input shares one assetId.
  const assetId = p.inputs[0].inAssetId;
  for (const inp of p.inputs) {
    if (inp.inAssetId !== assetId) throw new Error("deriveWithdrawPublics: assetId mismatch across inputs");
  }

  const sum = p.inputs.reduce((acc, i) => acc + i.inValue, 0n);
  if (sum !== p.primaryValue + p.secondaryValue) {
    throw new Error("deriveWithdrawPublics: primary + secondary != sum");
  }
  const boundaryValue = p.inputs[p.boundaryIndex].inValue;
  if (p.secondaryValue > boundaryValue) {
    throw new Error("deriveWithdrawPublics: change exceeds boundary value (§6.1 v4)");
  }

  const outLabel = p.inputs[p.boundaryIndex].inLabel;
  const outCommitment =
    p.secondaryValue === 0n
      ? 0n
      : await hashCommitment(p.secondaryValue, outLabel, assetId, p.outNullifier, p.outSecret);

  // nullifierHash[0..5]: hash for active inputs, 0 for padding.
  const nh: bigint[] = [];
  for (let i = 0; i < 6; i++) {
    nh.push(i < n ? await hashNullifier(p.inputs[i].inNullifier) : 0n);
  }

  const payeeId = await payeeIdEvm(p.rawPayee);

  const limbs: bigint[] = new Array(PUBLIC_WIDTH).fill(0n);
  limbs[0] = BigInt(ACTION_WITHDRAW);
  limbs[1] = BigInt(n);
  limbs[2] = modField(p.stateRoot);
  limbs[3] = modField(p.admittedRoot);
  limbs[4] = modField(p.revokedRoot);
  limbs[5] = p.primaryValue;
  limbs[6] = p.secondaryValue;
  limbs[7] = outCommitment;
  limbs[8] = 0n; // outLabel — must be 0 on-chain
  for (let i = 0; i < 6; i++) limbs[9 + i] = nh[i];
  limbs[15] = payeeId;
  limbs[16] = BigInt(PROGRAM_VERSION_V3);
  limbs[17] = assetId; // WITHDRAW mux: assetId
  // limbs[18..23] stay 0
  limbs[24] = await labelCommit(
    n,
    p.inputs.map((i) => i.inLabel),
    p.labelCommitSalt,
  );

  return limbs.map((x) => modField(x).toString());
}
