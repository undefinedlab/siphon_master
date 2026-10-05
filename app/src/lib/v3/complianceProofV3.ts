/**
 * The COMPLIANCE half of a v5 spend (COMPLIANCE_CIRCUIT_SPLIT).
 *
 * PROGRAM_VERSION 5 splits what used to be one proof into two that the kernel verifies
 * conjunctively: the SPEND proof (25 public limbs) and a COMPLIANCE proof (5). They are bound by
 * `labelCommit` — spend limb 24 and compliance limb 3 must be the same field element, and both
 * circuits recompute it from the same `salt` over the same labels. That shared salt IS the
 * binding: nothing else stops an attacker pairing a valid spend with someone else's compliance
 * proof.
 *
 * Two naming traps, both load-bearing:
 *   - the spend circuits call the salt signal `labelCommitSalt`, the compliance circuits call it
 *     `salt`. Same value.
 *   - the compliance circuits are EXACT-arity (`inputCount === N`), so a 2-note spend must use
 *     `compliance2`, not a padded `compliance6`. Wrong arity fails the circuit's own assert.
 *
 * `labelCommit` is nonetheless always hashed over the full MAX_INPUTS-wide vector with inactive
 * slots zeroed, so the commit matches the spend circuit's byte for byte regardless of arity.
 *
 * RAGEQUIT carries NO compliance proof: it is the exit for unadmitted or revoked labels, so there
 * is nothing to prove admission against. The kernel takes a zero-filled struct there.
 */

import * as snarkjs from "snarkjs";

import { zkUrl } from "../zkAssets";
import { FIELD, modField, getPoseidon } from "./noteCryptoV3";
import { PROGRAM_VERSION_V3, zkProvingBase } from "./configV3";
import { loadZkey } from "./zkeyCache";
import type { AssembledPaths } from "./spendActionsV3";

/** domains.circom::DOMAIN_LABEL_COMMIT. Reserved 7, not 3 — 1..6 are taken (see domains.json). */
export const DOMAIN_LABEL_COMMIT = 7n;

/** circuits/lib/domains.circom::MAX_INPUTS. The commit is always hashed at this width. */
export const MAX_INPUTS = 6;

/** [inputCount, admittedRoot, revokedRoot, labelCommit, programVersion] */
export const COMPLIANCE_PUBLIC_WIDTH = 5;

export interface ComplianceHalf {
  /** The 5 public limbs, as decimal strings — kernel `ComplianceProof.publicInputs`. */
  publicInputs: string[];
  /** Flat row-major 8, G2 coordinates already swapped — kernel `ComplianceProof.proof`. */
  proof: string[];
}

/** A zero-filled half, for the one action that carries none. */
export function emptyComplianceHalf(): ComplianceHalf {
  return {
    publicInputs: new Array(COMPLIANCE_PUBLIC_WIDTH).fill("0"),
    proof: new Array(8).fill("0"),
  };
}

/**
 * Fresh non-zero binding salt. Both circuits constrain `salt != 0` — a zero salt collapses
 * labelCommit to a deterministic function of the labels, which is exactly the linkability this
 * exists to prevent.
 *
 * Rejection-sampled into the field rather than reduced, mirroring `randomUserSalt`.
 */
export function randomLabelSalt(): bigint {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i++) {
    crypto.getRandomValues(bytes);
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    if (v < FIELD && v !== 0n) return v;
  }
  throw new Error("randomLabelSalt: exhausted rejection sampling");
}

/**
 * `Poseidon(DOMAIN_LABEL_COMMIT, inputCount, inLabel[0..MAX_INPUTS-1], salt)` — arity MAX_INPUTS+3.
 *
 * Mirrors circuits/lib/label_commit.circom::LabelCommit. Labels are padded with zeros to
 * MAX_INPUTS so the value is arity-independent, which is what lets an exact-N compliance circuit
 * produce the same commit as the padded spend circuit.
 */
export async function labelCommit(
  inputCount: number,
  labels: bigint[],
  salt: bigint,
): Promise<bigint> {
  if (labels.length > MAX_INPUTS) {
    throw new Error(`labelCommit: ${labels.length} labels exceeds MAX_INPUTS=${MAX_INPUTS}`);
  }
  if (modField(salt) === 0n) {
    throw new Error("labelCommit: salt must be non-zero (COMPLIANCE_CIRCUIT_SPLIT §3.2)");
  }
  const padded = Array.from({ length: MAX_INPUTS }, (_, i) => labels[i] ?? 0n);
  const p = await getPoseidon();
  const inputs = [DOMAIN_LABEL_COMMIT, BigInt(inputCount), ...padded, salt].map(modField);
  return BigInt(p.F.toObject(p(inputs)));
}

/** The 5 compliance public limbs. `commit` must equal spend limb 24. */
export function compliancePublics(
  inputCount: number,
  admittedRoot: bigint,
  revokedRoot: bigint,
  commit: bigint,
): string[] {
  return [
    BigInt(inputCount),
    modField(admittedRoot),
    modField(revokedRoot),
    modField(commit),
    BigInt(PROGRAM_VERSION_V3),
  ].map((v) => v.toString());
}

/**
 * Prove the compliance half for a spend over `paths`.
 *
 * `labels` and `paths.compliance.inputs` are sliced to the spend's arity, never padded: the
 * circuit asserts `inputCount === N`.
 */
export async function proveComplianceV3(args: {
  chainId: number;
  labels: bigint[];
  paths: AssembledPaths;
  salt: bigint;
  /** Spend limb 24, so a drift between the halves fails here rather than on-chain. */
  expectedCommit: bigint;
}): Promise<ComplianceHalf> {
  const n = args.labels.length;
  if (n < 1 || n > MAX_INPUTS) throw new Error(`proveComplianceV3: invalid arity ${n}`);

  const slots = args.paths.compliance.inputs.slice(0, n);
  if (slots.length !== n) {
    throw new Error(`proveComplianceV3: ASP returned ${slots.length} inputs, need ${n}`);
  }
  for (let i = 0; i < n; i++) {
    if (BigInt(slots[i].inLabel) !== args.labels[i]) {
      throw new Error(`proveComplianceV3: ASP label mismatch at ${i}`);
    }
  }

  const commit = await labelCommit(n, args.labels, args.salt);
  if (commit !== modField(args.expectedCommit)) {
    // Would revert ComplianceProofFailed() on-chain after the gas is spent.
    throw new Error("proveComplianceV3: labelCommit drift between the spend and compliance halves");
  }

  const admittedRoot = BigInt(args.paths.compliance.admittedRoot);
  const revokedRoot = BigInt(args.paths.compliance.revokedRoot);
  const publicInputs = compliancePublics(n, admittedRoot, revokedRoot, commit);

  const input: Record<string, unknown> = {
    publicInputs,
    salt: args.salt.toString(),
    inLabel: args.labels.map(String),
    admittedLeafIndex: slots.map((c) => String(c.admittedLeafIndex)),
    admittedPathElements: slots.map((c) => c.admittedPathElements),
    admittedPathIndices: slots.map((c) => c.admittedPathIndices),
    revokedSmtPathElements: slots.map((c) => c.revokedSmtPathElements),
    revokedSmtPathIndices: slots.map((c) => c.revokedSmtPathIndices),
    revokedSmtLeaf: slots.map((c) => String(c.revokedSmtLeaf)),
  };

  const circuit = `compliance${n}`;
  // Per-CHAIN keys, exactly as the spend half: Base's verifiers hold the ceremony delta, Sepolia's
  // the dev-beacon one. The local verify below cannot catch a mismatch — it checks the proof
  // against the same key set it was proved with.
  const keys = zkProvingBase(args.chainId);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    zkUrl(`/zk/${circuit}/main_${circuit}.wasm`),
    await loadZkey(`${keys}/${circuit}/zkey_final.zkey`),
  );

  const got = (publicSignals as string[]).map((v) => BigInt(v).toString());
  for (let i = 0; i < COMPLIANCE_PUBLIC_WIDTH; i++) {
    if (got[i] !== publicInputs[i]) {
      throw new Error(
        `proveComplianceV3: public limb ${i} drift — circuit ${got[i]} vs expected ${publicInputs[i]}`,
      );
    }
  }

  const vKey = await fetch(`${keys}/${circuit}/verification_key.json`).then((r) => {
    if (!r.ok) throw new Error(`compliance: vkey HTTP ${r.status}`);
    return r.json();
  });
  if (!(await snarkjs.groth16.verify(vKey, publicSignals, proof))) {
    throw new Error(`compliance: local verify failed (${circuit})`);
  }

  const p = proof as unknown as { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  const s = (v: string) => BigInt(v).toString();
  return {
    publicInputs,
    // Flat row-major 8 with the G2 coordinates swapped — the layout the routers unpack.
    proof: [
      s(p.pi_a[0]),
      s(p.pi_a[1]),
      s(p.pi_b[0][1]),
      s(p.pi_b[0][0]),
      s(p.pi_b[1][1]),
      s(p.pi_b[1][0]),
      s(p.pi_c[0]),
      s(p.pi_c[1]),
    ],
  };
}
