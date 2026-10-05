/**
 * v3 withdraw witness assembly — builds the circom `input` object for withdraw{N}.circom.
 *
 * Ties together: the coin-selection plan (planWithdrawV3), state Merkle paths (stateTreeV3),
 * ASP inclusion + SMT non-inclusion paths (aspClientV3), and the 25 public limbs
 * (withdrawPublicsV3). Output feeds the browser prover (snarkjs, v4 withdraw artifacts).
 *
 * Circom input field names match circuits/spend/withdrawal.circom (per-N mains withdraw1..6).
 */

import { hashCommitment } from "./noteCryptoV3";
import { buildStatePath, findLeafIndex, TREE_DEPTH } from "./stateTreeV3";
import type { WithdrawPlan } from "./planWithdrawV3";
import { loadComplianceWitnessMulti } from "./aspClientV3";
import { deriveWithdrawPublics, type WithdrawInput } from "./withdrawPublicsV3";
import { payeeIdSolana, rawPayeeBytes } from "./payeeV3";
import { randomLabelSalt } from "./complianceProofV3";

/** Circom input for a withdraw{N} proof. Values are decimal strings (snarkjs-friendly). */
export interface WithdrawCircomInput {
  publicInputs: string[];
  boundaryIndex: string;
  inValue: string[];
  inNullifier: string[];
  inSecret: string[];
  inLabel: string[];
  inAssetId: string[];
  statePathElements: string[][];
  statePathIndices: number[][];
  admittedLeafIndex: string[];
  admittedPathElements: string[][];
  admittedPathIndices: number[][];
  revokedSmtPathElements: string[][];
  revokedSmtPathIndices: number[][];
  revokedSmtLeaf: string[];
  outNullifier: string;
  outSecret: string;
  rawPayee: number[];
  /** Shared with the COMPLIANCE half; the compliance circuit calls the same value `salt`. */
  labelCommitSalt: string;
}

export interface BuildWithdrawWitnessParams {
  plan: WithdrawPlan;
  /** Ordered state-tree leaves (from stateLeavesClient). */
  leaves: bigint[];
  /** Fresh output-note secrets for the change note. */
  outNullifier: bigint;
  outSecret: bigint;
  /** 20-byte recipient (fresh address). */
  rawPayee: string;
  chainId: number;
  /** State root (from on-chain NoteTree.currentRoot() — used for the freshness assert upstream). */
  stateRoot: bigint;
  /** ASP service. */
  aspUrl: string;
  screenToken: string;
  /**
   * solana-v1: the 32-byte payee pubkey. Replaces the 20-byte EVM `rawPayee` — publics[15] becomes
   * `payeeIdSolana(pubkey)` and the circuit's `rawPayee` input carries the 32 bytes.
   */
  solanaPayee?: Uint8Array;
  /**
   * Pre-fetched ASP witness (server-side pipeline prove). When set, skips
   * {@link loadComplianceWitnessMulti} so the caller can load paths with the screen token.
   */
  compliance?: Awaited<ReturnType<typeof loadComplianceWitnessMulti>>;
}

export interface BuiltWithdrawWitness {
  input: WithdrawCircomInput;
  /** Recomputed 25 public limbs (must match the proof's publicSignals). */
  expectedPublics: string[];
  /** Roots used, for the pre-submit freshness gate. */
  roots: { stateRoot: string; admittedRoot: string; revokedRoot: string };
  inputCount: number;
  /** The binding salt this witness was built with — the compliance half must reuse it. */
  labelCommitSalt: bigint;
  /** ASP admission/revocation witness, reused verbatim by the compliance half. */
  compliance: Awaited<ReturnType<typeof loadComplianceWitnessMulti>>;
}

/**
 * Assemble the withdraw witness. Fetches ASP/SMT paths, reconstructs state paths, derives publics.
 * @throws if a selected note is not found in the leaf set (stale leaves) or ASP paths mismatch.
 */
export async function buildWithdrawWitness(
  p: BuildWithdrawWitnessParams,
): Promise<BuiltWithdrawWitness> {
  const { plan } = p;
  const n = plan.inputCount;

  // 1) State inclusion path per selected note (reconstructed from the leaf list).
  const statePathElements: string[][] = [];
  const statePathIndices: number[][] = [];
  for (const note of plan.selected) {
    const commitment = await hashCommitment(
      BigInt(note.value),
      BigInt(note.label),
      BigInt(note.assetId),
      BigInt(note.nullifier),
      BigInt(note.secret),
    );
    const idx = findLeafIndex(p.leaves, commitment);
    if (idx < 0) {
      throw new Error(
        `buildWithdrawWitness: note ${note.commitment} not in state leaves ` +
          `(orphan or prior vault — deposit on the live program, or resync leaves)`,
      );
    }
    const path = await buildStatePath(p.leaves, idx, TREE_DEPTH);
    statePathElements.push(path.pathElements.map((x) => x.toString()));
    statePathIndices.push(path.pathIndices);
  }

  // 2) ASP inclusion + SMT non-inclusion per label.
  const labels = plan.selected.map((n2) => String(n2.label));
  const compliance =
    p.compliance ??
    (await loadComplianceWitnessMulti(p.aspUrl, p.screenToken, labels, {
      chainId: p.chainId,
    }));
  if (compliance.inputs.length !== n) {
    throw new Error("buildWithdrawWitness: ASP returned wrong input count");
  }
  for (let i = 0; i < n; i++) {
    if (String(compliance.inputs[i].inLabel) !== labels[i]) {
      throw new Error(`buildWithdrawWitness: ASP label mismatch at input ${i}`);
    }
  }

  // 3) Derive the 25 public limbs (browser-native spend-core mirror).
  const witInputs: WithdrawInput[] = plan.selected.map((note) => ({
    inValue: BigInt(note.value),
    inNullifier: BigInt(note.nullifier),
    inSecret: BigInt(note.secret),
    inLabel: BigInt(note.label),
    inAssetId: BigInt(note.assetId),
  }));
  // One salt per spend, shared by both halves. Sampled here so the publics and the witness
  // cannot disagree, and returned so the caller can prove the compliance half against it.
  const labelCommitSalt = randomLabelSalt();
  const expectedPublics = await deriveWithdrawPublics({
    inputs: witInputs,
    boundaryIndex: plan.boundaryIndex,
    primaryValue: plan.primaryValue,
    secondaryValue: plan.secondaryValue,
    stateRoot: p.stateRoot,
    admittedRoot: BigInt(compliance.admittedRoot),
    revokedRoot: BigInt(compliance.revokedRoot),
    outNullifier: p.outNullifier,
    outSecret: p.outSecret,
    rawPayee: p.rawPayee,
    chainId: p.chainId,
    labelCommitSalt,
    payeeId: p.solanaPayee ? await payeeIdSolana(p.solanaPayee) : undefined,
  });

  // 4) Assemble the circom input.
  const input: WithdrawCircomInput = {
    publicInputs: expectedPublics,
    boundaryIndex: String(plan.boundaryIndex),
    inValue: plan.selected.map((x) => String(x.value)),
    inNullifier: plan.selected.map((x) => String(x.nullifier)),
    inSecret: plan.selected.map((x) => String(x.secret)),
    inLabel: labels,
    inAssetId: plan.selected.map((x) => String(x.assetId)),
    statePathElements,
    statePathIndices,
    admittedLeafIndex: compliance.inputs.map((c) => String(c.admittedLeafIndex)),
    admittedPathElements: compliance.inputs.map((c) => c.admittedPathElements),
    admittedPathIndices: compliance.inputs.map((c) => c.admittedPathIndices),
    revokedSmtPathElements: compliance.inputs.map((c) => c.revokedSmtPathElements),
    revokedSmtPathIndices: compliance.inputs.map((c) => c.revokedSmtPathIndices),
    revokedSmtLeaf: compliance.inputs.map((c) => c.revokedSmtLeaf),
    outNullifier: String(p.outNullifier),
    outSecret: String(p.outSecret),
    rawPayee: p.solanaPayee ? Array.from(p.solanaPayee) : rawPayeeBytes(p.rawPayee),
    labelCommitSalt: labelCommitSalt.toString(),
  };

  return {
    input,
    expectedPublics,
    roots: {
      stateRoot: p.stateRoot.toString(),
      admittedRoot: compliance.admittedRoot,
      revokedRoot: compliance.revokedRoot,
    },
    inputCount: n,
    labelCommitSalt,
    compliance,
  };
}
