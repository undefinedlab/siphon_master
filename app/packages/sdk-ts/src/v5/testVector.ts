// The siphon-zk-v2 v5 withdraw vector as SDK inputs — shared by v5.test.ts and prove.check.ts.
import vec from "../../test-vectors/withdraw-w3-ok.json";
import * as sdk from "./noteCrypto";
import type { WithdrawPlan } from "./planWithdraw";
import type { ComplianceWitness } from "./types";
import { buildWithdrawWitness } from "./withdrawWitness";

export { vec };

export async function vectorWorld() {
  const notes = [];
  for (const i of vec.inputs) {
    const commitment = await sdk.hashCommitment(BigInt(i.inValue), BigInt(i.inLabel), BigInt(i.inAssetId), BigInt(i.inNullifier), BigInt(i.inSecret));
    notes.push({ commitment: commitment.toString(), value: BigInt(i.inValue), label: i.inLabel, assetId: i.inAssetId, nullifier: i.inNullifier, secret: i.inSecret });
  }
  const plan: WithdrawPlan = {
    selected: notes,
    boundaryIndex: vec.boundaryIndex,
    primaryValue: BigInt(vec.primaryValue),
    secondaryValue: BigInt(vec.secondaryValue),
    total: BigInt(vec.primaryValue) + BigInt(vec.secondaryValue),
    inputCount: vec.inputCount,
  };
  const compliance: ComplianceWitness = {
    admittedRoot: vec.admittedRoot,
    revokedRoot: vec.revokedRoot,
    inputs: vec.inputs.map((i) => ({
      inLabel: i.inLabel,
      admittedLeafIndex: Number(i.admittedLeafIndex),
      admittedPathElements: i.admittedPathElements,
      admittedPathIndices: i.admittedPathIndices.map(Number),
      revokedSmtPathElements: i.revokedSmtPathElements,
      revokedSmtPathIndices: i.revokedSmtPathIndices.map(Number),
      revokedSmtLeaf: "0",
    })),
  };
  const built = await buildWithdrawWitness({
    plan,
    leaves: notes.map((n) => BigInt(n.commitment)), // the vector's notes sit at leaves 0..2
    outNullifier: BigInt(vec.outNullifier),
    outSecret: BigInt(vec.outSecret),
    rawPayee: `0x${vec.rawPayeeHex}`,
    chainId: vec.chainId,
    stateRoot: BigInt(vec.stateRoot),
    compliance,
    labelCommitSalt: BigInt(vec.labelSalt),
  });
  return { plan, built, compliance };
}
