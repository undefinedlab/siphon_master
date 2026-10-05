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

import { FIELD, modField, getPoseidon } from "./noteCrypto";
import { PROGRAM_VERSION_V3 } from "./constants";

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
    bytes[0] &= 0x3f; // FIELD < 2^254: keeps acceptance ~0.76 (was ~0.19 at 256 bits)
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
