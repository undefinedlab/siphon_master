/**
 * Action public-signals derivation for MERGE / SWAP / SPLIT / RAGEQUIT (Phase 5).
 *
 * Browser mirrors of spend-core validate_{merge,swap,split,ragequit} → to_bn254_limbs(). The client
 * recomputes the 25 limbs locally and matches them against the proof's publicSignals before submit
 * (PROTOCOL §9 / O-30). WITHDRAW lives in withdrawPublicsV3.
 *
 * All actions: public[8]=outLabel=0, public[16]=PROGRAM_VERSION, public[9+i]=Poseidon(inNullifier).
 */

import {
  hashCommitment,
  hashCommitmentWithPre,
  hashNullifier,
  hashPrecommitment,
  modField,
  poseidon2,
} from "./noteCryptoV3";
import { PROGRAM_VERSION_V3 } from "./configV3";
import { labelCommit } from "./complianceProofV3";
import { payeeIdEvm } from "./payeeV3";

export const ACTION_MERGE = 1;
export const ACTION_SWAP = 2;
export const ACTION_SPLIT = 3;
export const ACTION_RAGEQUIT = 4;
export const PUBLIC_WIDTH = 25;
export const MAX_SPLIT_OUTPUTS = 8;

export interface ActionInput {
  inValue: bigint;
  inNullifier: bigint;
  inSecret: bigint;
  inLabel: bigint;
  inAssetId: bigint;
}

interface Roots {
  stateRoot: bigint;
  admittedRoot: bigint;
  revokedRoot: bigint;
}

/**
 * Limbs common to every action.
 *
 * `bind` carries the COMPLIANCE_CIRCUIT_SPLIT binding: limb 24 is `labelCommit` over the spend's
 * labels and a shared non-zero salt, and the compliance proof must recompute the same value.
 * RAGEQUIT passes `undefined` — it is the one action the kernel does not bind to a compliance
 * proof, so its limb 24 stays 0.
 */
async function baseLimbs(
  action: number,
  inputCount: number,
  r: Roots,
  bind?: { inputs: ActionInput[]; labelCommitSalt: bigint },
): Promise<bigint[]> {
  const limbs: bigint[] = new Array(PUBLIC_WIDTH).fill(0n);
  limbs[0] = BigInt(action);
  limbs[1] = BigInt(inputCount);
  limbs[2] = modField(r.stateRoot);
  limbs[3] = modField(r.admittedRoot);
  limbs[4] = modField(r.revokedRoot);
  limbs[16] = BigInt(PROGRAM_VERSION_V3);
  if (bind) {
    limbs[24] = await labelCommit(
      inputCount,
      bind.inputs.map((i) => i.inLabel),
      bind.labelCommitSalt,
    );
  }
  return limbs;
}

async function nullifierHashes(inputs: ActionInput[]): Promise<bigint[]> {
  const nh: bigint[] = [];
  for (let i = 0; i < 6; i++) nh.push(i < inputs.length ? await hashNullifier(inputs[i].inNullifier) : 0n);
  return nh;
}

function assertOneAsset(inputs: ActionInput[]): bigint {
  const a = inputs[0].inAssetId;
  for (const i of inputs) if (i.inAssetId !== a) throw new Error("actionPublics: assetId mismatch across inputs");
  return a;
}

function toStrs(limbs: bigint[]): string[] {
  return limbs.map((x) => modField(x).toString());
}

// ------------------------------------------------------------------- MERGE

export interface MergeParams {
  inputs: ActionInput[];
  boundaryIndex: number;
  outNullifier: bigint;
  outSecret: bigint;
  roots: Roots;
  /** Shared binding salt for the COMPLIANCE half — non-zero (COMPLIANCE_CIRCUIT_SPLIT §3.2). */
  labelCommitSalt: bigint;
}

/** MERGE §6.2: primary=secondary=0; boundary=max; outCommitment=commitment(Σ, boundaryLabel,…). */
export async function deriveMergePublics(p: MergeParams): Promise<string[]> {
  const n = p.inputs.length;
  if (n < 2 || n > 6) throw new Error("deriveMergePublics: inputCount out of [2,6]");
  if (p.boundaryIndex < 0 || p.boundaryIndex >= n) throw new Error("deriveMergePublics: bad boundary");
  const assetId = assertOneAsset(p.inputs);
  const boundaryValue = p.inputs[p.boundaryIndex].inValue;
  for (const i of p.inputs) {
    if (i.inValue > boundaryValue) throw new Error("deriveMergePublics: boundary must be the max input");
  }
  const sum = p.inputs.reduce((acc, i) => acc + i.inValue, 0n);
  const outLabel = p.inputs[p.boundaryIndex].inLabel;
  const outCommitment = await hashCommitment(sum, outLabel, assetId, p.outNullifier, p.outSecret);
  const nh = await nullifierHashes(p.inputs);

  const limbs = await baseLimbs(ACTION_MERGE, n, p.roots, { inputs: p.inputs, labelCommitSalt: p.labelCommitSalt });
  // primary(5)=secondary(6)=0; outCommitment(7); outLabel(8)=0; mux all 0.
  limbs[7] = outCommitment;
  for (let i = 0; i < 6; i++) limbs[9 + i] = nh[i];
  // payeeId(15)=0
  return toStrs(limbs);
}

// -------------------------------------------------------------------- SWAP

export interface SwapParams {
  input: ActionInput;
  primaryValue: bigint; // amountIn
  secondaryValue: bigint; // change
  pool: bigint;
  dstToken: bigint;
  fee: bigint;
  minAmountOut: bigint;
  outputPrecommitment: bigint;
  outNullifier: bigint;
  outSecret: bigint;
  roots: Roots;
  /** Shared binding salt for the COMPLIANCE half — non-zero (COMPLIANCE_CIRCUIT_SPLIT §3.2). */
  labelCommitSalt: bigint;
}

/** SWAP §6.3: N=1; mux 17..23 = pool,dstToken,fee,minOut,outPre,destCommitment,srcAssetId. */
export async function deriveSwapPublics(p: SwapParams): Promise<string[]> {
  const FEE_U24_MAX = (1n << 24n) - 1n;
  if (p.fee > FEE_U24_MAX) throw new Error("deriveSwapPublics: fee exceeds uint24");
  if (p.primaryValue <= 0n) throw new Error("deriveSwapPublics: amountIn must be positive");
  if (p.primaryValue > p.input.inValue) throw new Error("deriveSwapPublics: amountIn exceeds input");
  if (p.primaryValue + p.secondaryValue !== p.input.inValue) throw new Error("deriveSwapPublics: sum mismatch");

  const inLabel = p.input.inLabel;
  const srcAssetId = p.input.inAssetId;
  const outCommitment =
    p.secondaryValue === 0n
      ? 0n
      : await hashCommitment(p.secondaryValue, inLabel, srcAssetId, p.outNullifier, p.outSecret);
  // destLabel == inLabel (private); destCommitment = commitment_with_pre(minOut, destLabel, dstToken, outPre)
  const destCommitment = await hashCommitmentWithPre(p.minAmountOut, inLabel, p.dstToken, p.outputPrecommitment);
  const nh = await nullifierHashes([p.input]);

  const limbs = await baseLimbs(ACTION_SWAP, 1, p.roots, { inputs: [p.input], labelCommitSalt: p.labelCommitSalt });
  limbs[5] = p.primaryValue;
  limbs[6] = p.secondaryValue;
  limbs[7] = outCommitment;
  limbs[9] = nh[0];
  // payeeId(15) = 0 (D1 pool)
  limbs[17] = p.pool;
  limbs[18] = p.dstToken;
  limbs[19] = p.fee;
  limbs[20] = p.minAmountOut;
  limbs[21] = p.outputPrecommitment;
  limbs[22] = destCommitment;
  limbs[23] = srcAssetId;
  return toStrs(limbs);
}

// ------------------------------------------------------------------- SPLIT

export interface SplitSlice {
  value: bigint;
  nullifier: bigint;
  secret: bigint;
}

export interface SplitParams {
  input: ActionInput;
  /** Exactly 8 slices (zero-valued slices are inactive; nullifier/secret must be 0 there). */
  slices: SplitSlice[];
  roots: Roots;
  /** Shared binding salt for the COMPLIANCE half — non-zero (COMPLIANCE_CIRCUIT_SPLIT §3.2). */
  labelCommitSalt: bigint;
}

/** Depth-3 Poseidon over 8 leaves in order (PROTOCOL §4.4 MerkleRoot8). */
export async function splitRoot8(leaves: bigint[]): Promise<bigint> {
  if (leaves.length !== 8) throw new Error("splitRoot8: expected 8 leaves");
  let level = leaves.slice();
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await poseidon2(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

/** SPLIT §6.4: primary=secondary=0; splitRoot at mux[0]; outCommitment(7)=0; Σ slices = inValue. */
export async function deriveSplitPublics(p: SplitParams): Promise<{ publics: string[]; splitCommitments: string[] }> {
  if (p.slices.length !== MAX_SPLIT_OUTPUTS) throw new Error("deriveSplitPublics: need 8 slices");
  const assetId = p.input.inAssetId;
  const label = p.input.inLabel;
  let sum = 0n;
  const commitments: bigint[] = [];
  const seenNf = new Set<string>();
  for (const s of p.slices) {
    if (s.value === 0n) {
      if (s.nullifier !== 0n || s.secret !== 0n) throw new Error("deriveSplitPublics: inactive slot must be zeroed");
      commitments.push(0n);
      continue;
    }
    if (s.nullifier === p.input.inNullifier) throw new Error("deriveSplitPublics: slice reuses input nullifier");
    const key = s.nullifier.toString();
    if (seenNf.has(key)) throw new Error("deriveSplitPublics: duplicate slice nullifier");
    seenNf.add(key);
    sum += s.value;
    commitments.push(await hashCommitment(s.value, label, assetId, s.nullifier, s.secret));
  }
  if (sum !== p.input.inValue) throw new Error("deriveSplitPublics: Σ slices != inValue");

  const root = await splitRoot8(commitments);
  const nh = await nullifierHashes([p.input]);

  const limbs = await baseLimbs(ACTION_SPLIT, 1, p.roots, { inputs: [p.input], labelCommitSalt: p.labelCommitSalt });
  // primary(5)=secondary(6)=0; outCommitment(7)=0; payeeId(15)=0; mux[0]=public[17]=splitRoot.
  limbs[9] = nh[0];
  limbs[17] = root;
  return { publics: toStrs(limbs), splitCommitments: commitments.map((c) => modField(c).toString()) };
}

// ----------------------------------------------------------------- RAGEQUIT

export interface RagequitParams {
  input: ActionInput;
  rawPayee: string;
  roots: Roots;
}

/** RAGEQUIT §6.5: N=1; primary=inValue; mux 17=payeeId, 18=assetId; outCommitment binds opened note. */
export async function deriveRagequitPublics(p: RagequitParams): Promise<string[]> {
  const { inValue, inLabel, inAssetId, inNullifier, inSecret } = p.input;
  if (inValue <= 0n) throw new Error("deriveRagequitPublics: value must be positive");
  const pre = await hashPrecommitment(inNullifier, inSecret);
  const outCommitment = await hashCommitmentWithPre(inValue, inLabel, inAssetId, pre);
  const payeeId = await payeeIdEvm(p.rawPayee);
  const nh = await nullifierHashes([p.input]);

  const limbs = await baseLimbs(ACTION_RAGEQUIT, 1, p.roots);
  limbs[5] = inValue; // primary
  limbs[7] = outCommitment;
  limbs[9] = nh[0];
  // payeeId(15)=0 — ragequit payee is mux 17
  limbs[17] = payeeId;
  limbs[18] = inAssetId;
  return toStrs(limbs);
}
