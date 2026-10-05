/**
 * v3 spend action orchestrators (Phase 5) — MERGE / SWAP / SPLIT / RAGEQUIT via VaultKernel.spend.
 *
 * Each mirrors the withdrawV3 pipeline: build the circom witness (state path reconstruction + ASP
 * inclusion + SMT paths + action publics) → snarkjs prove against the v4 artifacts → match publics
 * (O-30) → local verify → G2-swap calldata → submit hook. Fails closed until v3 is deployed
 * (requireV3) and state leaves are served.
 *
 * MERGE/SWAP/SPLIT are private spends (ASP inclusion + SMT non-inclusion per input). RAGEQUIT is the
 * attributed exit (pending or revoked branch) — it needs ASP path (for the branch check) + SMT path
 * but is not gated on admittance.
 */

import * as snarkjs from "snarkjs";
import { requireV3, zkProvingBase } from "./configV3";
import {
  emptyComplianceHalf,
  proveComplianceV3,
  randomLabelSalt,
  type ComplianceHalf,
} from "./complianceProofV3";
import { zkUrl } from "../zkAssets";
import { hashCommitment } from "./noteCryptoV3";
import { buildStatePath, computeStateRoot, findLeafIndex, TREE_DEPTH } from "./stateTreeV3";
import { fetchStateLeaves } from "./stateLeavesClient";
import { loadComplianceWitnessMulti } from "./aspClientV3";
import { rawPayeeBytes } from "./payeeV3";
import { proveSpend } from "./proveRemote";
import {
  deriveMergePublics,
  deriveSwapPublics,
  deriveSplitPublics,
  deriveRagequitPublics,
  type ActionInput,
  type SplitSlice,
} from "./actionPublicsV3";
import type { Groth16Calldata } from "./withdrawV3";
import { ragequitBlockedReason } from "./ragequitEligibility";
import { loadZkey } from "./zkeyCache";

export interface SpendNote {
  commitment: string;
  value: bigint;
  label: string;
  assetId: string;
  nullifier: string;
  secret: string;
  /** Present on original deposits created after exit-ticket support shipped. */
  depositTxHash?: string;
  /** Present on original deposits; encrypted at rest with the rest of the note. */
  userSalt?: string;
  /** Timestamp of the original deposit block, in Unix seconds. */
  depositTimestamp?: number;
  /** Local row timestamp, used only as a display fallback for older notes. */
  createdAt?: number;
}

export interface SpendActionResult {
  ok: boolean;
  txHash?: string;
  publicSignals: string[];
  calldata: Groth16Calldata;
  circuit: string;
  /** Present for SPLIT — the 8 slice commitments the vault checks per-index. */
  splitCommitments?: string[];
}

export type SubmitHook = (payload: {
  chainId: number;
  vaultKernel: string;
  publicInputs: string[];
  proof: Groth16Calldata;
  /**
   * The COMPLIANCE half (COMPLIANCE_CIRCUIT_SPLIT). The kernel verifies it conjunctively with the
   * spend proof, so omitting it is not a degraded submission — it reverts ComplianceProofFailed().
   * RAGEQUIT passes the zero-filled half, which is what the kernel expects there.
   */
  compliance: ComplianceHalf;
  extra: Record<string, unknown>;
}) => Promise<{ tx_hash: string }>;

function proofToCalldata(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): Groth16Calldata {
  const s = (v: string | bigint) => BigInt(v).toString();
  return {
    pA: [s(proof.pi_a[0]), s(proof.pi_a[1])],
    pB: [
      [s(proof.pi_b[0][1]), s(proof.pi_b[0][0])],
      [s(proof.pi_b[1][1]), s(proof.pi_b[1][0])],
    ],
    pC: [s(proof.pi_c[0]), s(proof.pi_c[1])],
  };
}

function assertPublicsMatch(expected: string[], got: string[]): void {
  if (expected.length !== got.length) throw new Error("publics length mismatch");
  for (let i = 0; i < expected.length; i++) {
    if (BigInt(expected[i]) !== BigInt(got[i])) {
      throw new Error(`publics limb[${i}] mismatch: expected ${expected[i]} got ${got[i]}`);
    }
  }
}

export interface AssembledPaths {
  statePathElements: string[][];
  statePathIndices: number[][];
  compliance: Awaited<ReturnType<typeof loadComplianceWitnessMulti>>;
  stateRoot: bigint;
}

/** Shared: reconstruct state paths + fetch ASP/SMT paths for a set of notes. */
async function assemblePaths(
  chainId: number,
  aspUrl: string,
  screenToken: string,
  notes: SpendNote[],
  opts?: { requireAdmittedPath?: boolean },
): Promise<AssembledPaths> {
  const leavesRes = await fetchStateLeaves(chainId);
  if (!leavesRes.available || !leavesRes.data) {
    throw new Error(`v3 spend: state leaves unavailable — ${leavesRes.reason ?? "unknown"}`);
  }
  const leaves = leavesRes.data.leaves;
  const stateRoot = await computeStateRoot(leaves);

  const statePathElements: string[][] = [];
  const statePathIndices: number[][] = [];
  for (const note of notes) {
    const commitment = await hashCommitment(
      BigInt(note.value),
      BigInt(note.label),
      BigInt(note.assetId),
      BigInt(note.nullifier),
      BigInt(note.secret),
    );
    const idx = findLeafIndex(leaves, commitment);
    if (idx < 0) throw new Error(`v3 spend: note ${note.commitment} not in state leaves (resync)`);
    const path = await buildStatePath(leaves, idx, TREE_DEPTH);
    statePathElements.push(path.pathElements.map((x) => x.toString()));
    statePathIndices.push(path.pathIndices);
  }

  const labels = notes.map((n) => String(n.label));
  const compliance = await loadComplianceWitnessMulti(aspUrl, screenToken, labels, {
    ...opts,
    chainId,
  });
  if (compliance.inputs.length !== notes.length) throw new Error("v3 spend: ASP input count mismatch");
  for (let i = 0; i < labels.length; i++) {
    if (String(compliance.inputs[i].inLabel) !== labels[i]) throw new Error(`v3 spend: ASP label mismatch at ${i}`);
  }
  return { statePathElements, statePathIndices, compliance, stateRoot };
}

function toActionInputs(notes: SpendNote[]): ActionInput[] {
  return notes.map((n) => ({
    inValue: BigInt(n.value),
    inNullifier: BigInt(n.nullifier),
    inSecret: BigInt(n.secret),
    inLabel: BigInt(n.label),
    inAssetId: BigInt(n.assetId),
  }));
}

/** Common circom per-input arrays (values + reconstructed/fetched paths). */
function inputArrays(notes: SpendNote[], paths: AssembledPaths) {
  return {
    inValue: notes.map((n) => String(n.value)),
    inNullifier: notes.map((n) => String(n.nullifier)),
    inSecret: notes.map((n) => String(n.secret)),
    inLabel: notes.map((n) => String(n.label)),
    inAssetId: notes.map((n) => String(n.assetId)),
    statePathElements: paths.statePathElements,
    statePathIndices: paths.statePathIndices,
    admittedLeafIndex: paths.compliance.inputs.map((c) => String(c.admittedLeafIndex)),
    admittedPathElements: paths.compliance.inputs.map((c) => c.admittedPathElements),
    admittedPathIndices: paths.compliance.inputs.map((c) => c.admittedPathIndices),
    revokedSmtPathElements: paths.compliance.inputs.map((c) => c.revokedSmtPathElements),
    revokedSmtPathIndices: paths.compliance.inputs.map((c) => c.revokedSmtPathIndices),
    revokedSmtLeaf: paths.compliance.inputs.map((c) => c.revokedSmtLeaf),
  };
}

/**
 * The single-input counterpart of `inputArrays`.
 *
 * SPLIT, SWAP and RAGEQUIT declare their note fields as SCALARS (`signal input inValue;`), not
 * arrays — only WITHDRAW and MERGE take N inputs. All three were being fed `inputArrays` plus a
 * `boundaryIndex` that only the multi-input circuits declare, so witness generation died on
 * "Signal boundaryIndex not found" before it ever reached a constraint. That is why no TWAP could
 * arm: its SPLIT leg never produced a proof.
 *
 * Mirrors `siphon-zk-v2/scripts/lib/witness-to-input.cjs::mapInputSlot`, which is the normative
 * scenario→witness mapping the circuits are tested against.
 */
function inputScalars(note: SpendNote, paths: AssembledPaths) {
  const c = paths.compliance.inputs[0];
  return {
    inValue: String(note.value),
    inNullifier: String(note.nullifier),
    inSecret: String(note.secret),
    inLabel: String(note.label),
    inAssetId: String(note.assetId),
    statePathElements: paths.statePathElements[0],
    statePathIndices: paths.statePathIndices[0],
    admittedLeafIndex: String(c.admittedLeafIndex),
    admittedPathElements: c.admittedPathElements,
    admittedPathIndices: c.admittedPathIndices,
    revokedSmtPathElements: c.revokedSmtPathElements,
    revokedSmtPathIndices: c.revokedSmtPathIndices,
    revokedSmtLeaf: String(c.revokedSmtLeaf),
  };
}

/**
 * The exact witness each single-input circuit declares. Exported so `spendWitnessShape.check.ts`
 * can feed the real thing to the real wasm — the previous versions of these three were assembled
 * inline and drifted from the circuits with nothing to notice.
 *
 * Normative sources: `siphon-zk-v2/circuits/spend/{split,swap,ragequit}.circom` and the scenario
 * mapping in `scripts/lib/witness-to-input.cjs`.
 */

/** split.circom — Split(32, 8). Slice arrays are `outValue`/`outNullifier`/`outSecret`;
 *  `splitValues` &c. are test-vector field names that exist only on the way IN to
 *  witness-to-input.cjs, and reach the circuit as a signal-not-found. */
export function splitWitnessInput(
  note: SpendNote,
  slices: SplitSlice[],
  paths: AssembledPaths,
  publics: string[],
  labelCommitSalt: bigint,
): Record<string, unknown> {
  return {
    publicInputs: publics,
    labelCommitSalt: String(labelCommitSalt),
    ...inputScalars(note, paths),
    outValue: slices.map((s) => String(s.value)),
    outNullifier: slices.map((s) => String(s.nullifier)),
    outSecret: slices.map((s) => String(s.secret)),
  };
}

/** swap.circom — Swap(32). The trade parameters ride in `publicInputs` limbs 17-22 and are NOT
 *  declared signals, so passing pool/dstToken/fee/minAmountOut/outputPrecommitment is a
 *  signal-not-found. `destLabel` IS declared, and is the inherited input label. */
export function swapWitnessInput(
  note: SpendNote,
  outNullifier: bigint,
  outSecret: bigint,
  paths: AssembledPaths,
  publics: string[],
  labelCommitSalt: bigint,
): Record<string, unknown> {
  return {
    publicInputs: publics,
    labelCommitSalt: String(labelCommitSalt),
    ...inputScalars(note, paths),
    outNullifier: String(outNullifier),
    outSecret: String(outSecret),
    destLabel: String(note.label),
  };
}

/** ragequit.circom — Ragequit(32). The escape hatch proves non-membership of the REVOKED set and
 *  declares no admitted* signals at all, so a note that was never admitted can still exit. */
export function ragequitWitnessInput(
  note: SpendNote,
  recipient: string,
  branch: 0 | 1,
  paths: AssembledPaths,
  publics: string[],
): Record<string, unknown> {
  const {
    admittedLeafIndex: _ali,
    admittedPathElements: _ape,
    admittedPathIndices: _api,
    ...scalars
  } = inputScalars(note, paths);
  return {
    publicInputs: publics,
    branch: String(branch),
    ...scalars,
    rawPayee: rawPayeeBytes(recipient),
  };
}

async function proveAndVerify(
  chainId: number,
  circuit: string,
  input: Record<string, unknown>,
  expectedPublics: string[],
): Promise<{ publicSignals: string[]; calldata: Groth16Calldata }> {
  // Proving keys are per-CHAIN (see zkProvingBase): Base's verifiers hold the production ceremony
  // delta, Sepolia's the dev-beacon one. Getting this wrong still passes the local verify below —
  // it checks the proof against the SAME key set it was proved with — and only fails on-chain.
  const keys = zkProvingBase(chainId);
  // Enclave first, browser as fallback — the merge6 key is 144MB and cannot be prefetched, since
  // the arity is only known once coin selection has run. Both paths land in the same two gates
  // below, so a proof from the enclave gets no more trust than one proved here.
  const { proof, publicSignals } = await proveSpend({ circuit, input }, async () =>
    snarkjs.groth16.fullProve(
      input,
      zkUrl(`/zk/${circuit}/main_${circuit}.wasm`),
      await loadZkey(`${keys}/${circuit}/zkey_final.zkey`),
    ),
  );
  assertPublicsMatch(expectedPublics, publicSignals as string[]);
  const vKey = await fetch(`${keys}/${circuit}/verification_key.json`).then((r) => {
    if (!r.ok) throw new Error(`v3 spend: vkey HTTP ${r.status}`);
    return r.json();
  });
  if (!(await snarkjs.groth16.verify(vKey, publicSignals, proof))) {
    throw new Error(`v3 spend: local verify failed (${circuit})`);
  }
  return {
    publicSignals: publicSignals as string[],
    calldata: proofToCalldata(proof as unknown as { pi_a: string[]; pi_b: string[][]; pi_c: string[] }),
  };
}

// ------------------------------------------------------------------- MERGE

export interface MergeV3Params {
  chainId: number;
  notes: SpendNote[]; // 2..6, same asset
  boundaryIndex: number; // must be the max-value note
  outNullifier: bigint;
  outSecret: bigint;
  aspUrl?: string;
  screenToken: string;
  submit?: SubmitHook;
  dryRun?: boolean;
}

/** Consolidate 2..6 notes into one (boundary = largest). */
export async function mergeV3(p: MergeV3Params): Promise<SpendActionResult> {
  const cfg = requireV3(p.chainId);
  const aspUrl = p.aspUrl ?? cfg.aspUrl;
  const n = p.notes.length;
  if (n < 2 || n > 6) throw new Error("mergeV3: need 2..6 notes");
  const circuit = `merge${n}`;
  const paths = await assemblePaths(p.chainId, aspUrl, p.screenToken, p.notes);

  const labelCommitSalt = randomLabelSalt();
  const expectedPublics = await deriveMergePublics({
    inputs: toActionInputs(p.notes),
    boundaryIndex: p.boundaryIndex,
    outNullifier: p.outNullifier,
    outSecret: p.outSecret,
    roots: {
      stateRoot: paths.stateRoot,
      admittedRoot: BigInt(paths.compliance.admittedRoot),
      revokedRoot: BigInt(paths.compliance.revokedRoot),
    },
    labelCommitSalt,
  });

  const input: Record<string, unknown> = {
    publicInputs: expectedPublics,
    boundaryIndex: String(p.boundaryIndex),
    labelCommitSalt: String(labelCommitSalt),
    ...inputArrays(p.notes, paths),
    outNullifier: String(p.outNullifier),
    outSecret: String(p.outSecret),
  };

  const { publicSignals, calldata } = await proveAndVerify(p.chainId, circuit, input, expectedPublics);
  const compliance = await proveComplianceV3({
    chainId: p.chainId,
    labels: p.notes.map((x) => BigInt(x.label)),
    paths,
    salt: labelCommitSalt,
    expectedCommit: BigInt(expectedPublics[24]),
  });
  const result: SpendActionResult = { ok: true, publicSignals, calldata, circuit };
  if (p.dryRun || !p.submit) return result;
  const r = await p.submit({ chainId: p.chainId, vaultKernel: cfg.vaultKernel, publicInputs: publicSignals, proof: calldata, compliance, extra: {} });
  return { ...result, txHash: r.tx_hash };
}

// ----------------------------------------------------------------- RAGEQUIT

export interface RagequitV3Params {
  chainId: number;
  note: SpendNote;
  recipient: string; // secret-holder / fresh address
  aspUrl?: string;
  screenToken: string;
  submit?: SubmitHook;
  dryRun?: boolean;
  /** Eligibility branch — ragequit.circom enforces exactly one:
   *    0 = pending: SMT non-inclusion AND admittedRoot == EMPTY_ASP_ROOT (bootstrap only)
   *    1 = revoked: SMT inclusion of inLabel (the live pre-admit / KYT-fail exit)
   *  Defaults to 1 because the circuit's own note is explicit that a prod ASP is non-empty after
   *  its first bus, so branch 0 cannot satisfy the admittedRoot check on a live deployment. An
   *  admitted note cannot ragequit at all — that is a circuit constraint, not a UI rule. */
  branch?: 0 | 1;
}

/** Attributed exit for a pending/flagged note (§5.2). */
export async function ragequitV3(p: RagequitV3Params): Promise<SpendActionResult> {
  const cfg = requireV3(p.chainId);
  const aspUrl = p.aspUrl ?? cfg.aspUrl;
  const circuit = "ragequit";
  // Ragequit is for notes the ASP has NOT admitted (§5.2), and the circuit reads no admitted path,
  // so requiring one here rejected exactly the notes this action exists for.
  const paths = await assemblePaths(p.chainId, aspUrl, p.screenToken, [p.note], {
    requireAdmittedPath: false,
  });

  const branch = p.branch ?? 1;
  // Fail here rather than 30s deep in the prover with an opaque assert — see ragequitEligibility.
  const blocked = ragequitBlockedReason(branch, paths.compliance.inputs[0].revokedSmtLeaf);
  if (blocked) throw new Error(blocked);

  const expectedPublics = await deriveRagequitPublics({
    input: toActionInputs([p.note])[0],
    rawPayee: p.recipient,
    roots: {
      stateRoot: paths.stateRoot,
      admittedRoot: BigInt(paths.compliance.admittedRoot),
      revokedRoot: BigInt(paths.compliance.revokedRoot),
    },
  });

  const input = ragequitWitnessInput(p.note, p.recipient, branch, paths, expectedPublics);

  const { publicSignals, calldata } = await proveAndVerify(p.chainId, circuit, input, expectedPublics);
  const result: SpendActionResult = { ok: true, publicSignals, calldata, circuit };
  if (p.dryRun || !p.submit) return result;
  // RAGEQUIT carries no compliance proof — it exists precisely for labels the ASP will not admit.
  const r = await p.submit({ chainId: p.chainId, vaultKernel: cfg.vaultKernel, publicInputs: publicSignals, proof: calldata, compliance: emptyComplianceHalf(), extra: { rawPayee: p.recipient } });
  return { ...result, txHash: r.tx_hash };
}

// ------------------------------------------------------------------- SPLIT

export interface SplitV3Params {
  chainId: number;
  note: SpendNote;
  slices: SplitSlice[]; // exactly 8; Σ active = note.value
  aspUrl?: string;
  screenToken: string;
  submit?: SubmitHook;
  dryRun?: boolean;
}

/** Carve one note into up to 8 denominations (TWAP/DCA/grid legs). */
export async function splitV3(p: SplitV3Params): Promise<SpendActionResult> {
  const cfg = requireV3(p.chainId);
  const aspUrl = p.aspUrl ?? cfg.aspUrl;
  const circuit = "split";
  const paths = await assemblePaths(p.chainId, aspUrl, p.screenToken, [p.note]);

  const labelCommitSalt = randomLabelSalt();
  const { publics, splitCommitments } = await deriveSplitPublics({
    input: toActionInputs([p.note])[0],
    slices: p.slices,
    roots: {
      stateRoot: paths.stateRoot,
      admittedRoot: BigInt(paths.compliance.admittedRoot),
      revokedRoot: BigInt(paths.compliance.revokedRoot),
    },
    labelCommitSalt,
  });

  const input = splitWitnessInput(p.note, p.slices, paths, publics, labelCommitSalt);

  const { publicSignals, calldata } = await proveAndVerify(p.chainId, circuit, input, publics);
  const compliance = await proveComplianceV3({
    chainId: p.chainId,
    labels: [BigInt(p.note.label)],
    paths,
    salt: labelCommitSalt,
    expectedCommit: BigInt(publics[24]),
  });
  const result: SpendActionResult = { ok: true, publicSignals, calldata, circuit, splitCommitments };
  if (p.dryRun || !p.submit) return result;
  const r = await p.submit({ chainId: p.chainId, vaultKernel: cfg.vaultKernel, publicInputs: publicSignals, proof: calldata, compliance, extra: { splitCommitments } });
  return { ...result, txHash: r.tx_hash };
}

// -------------------------------------------------------------------- SWAP

export interface SwapV3Params {
  chainId: number;
  note: SpendNote;
  amountIn: bigint;
  pool: bigint;
  dstToken: bigint;
  fee: bigint;
  minAmountOut: bigint;
  /** Destination note precommitment = Poseidon(destNullifier, destSecret). */
  outputPrecommitment: bigint;
  /** Change note (src asset) secrets. */
  outNullifier: bigint;
  outSecret: bigint;
  aspUrl?: string;
  screenToken: string;
  submit?: SubmitHook;
  dryRun?: boolean;
}

/** Swap srcToken→dstToken through the pool; change stays in src asset (§6.3). */
export async function swapV3(p: SwapV3Params): Promise<SpendActionResult> {
  const cfg = requireV3(p.chainId);
  const aspUrl = p.aspUrl ?? cfg.aspUrl;
  const circuit = "swap";
  const paths = await assemblePaths(p.chainId, aspUrl, p.screenToken, [p.note]);
  const secondary = BigInt(p.note.value) - p.amountIn;
  const labelCommitSalt = randomLabelSalt();

  const expectedPublics = await deriveSwapPublics({
    input: toActionInputs([p.note])[0],
    primaryValue: p.amountIn,
    secondaryValue: secondary,
    pool: p.pool,
    dstToken: p.dstToken,
    fee: p.fee,
    minAmountOut: p.minAmountOut,
    outputPrecommitment: p.outputPrecommitment,
    outNullifier: p.outNullifier,
    outSecret: p.outSecret,
    roots: {
      stateRoot: paths.stateRoot,
      admittedRoot: BigInt(paths.compliance.admittedRoot),
      revokedRoot: BigInt(paths.compliance.revokedRoot),
    },
    labelCommitSalt,
  });

  const input = swapWitnessInput(p.note, p.outNullifier, p.outSecret, paths, expectedPublics, labelCommitSalt);

  const { publicSignals, calldata } = await proveAndVerify(p.chainId, circuit, input, expectedPublics);
  const compliance = await proveComplianceV3({
    chainId: p.chainId,
    labels: [BigInt(p.note.label)],
    paths,
    salt: labelCommitSalt,
    expectedCommit: BigInt(expectedPublics[24]),
  });
  const result: SpendActionResult = { ok: true, publicSignals, calldata, circuit };
  if (p.dryRun || !p.submit) return result;
  const r = await p.submit({ chainId: p.chainId, vaultKernel: cfg.vaultKernel, publicInputs: publicSignals, proof: calldata, compliance, extra: {} });
  return { ...result, txHash: r.tx_hash };
}
