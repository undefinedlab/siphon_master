/**
 * Seal the private half of a v3 strategy leg's witness to the decryptor enclave.
 *
 * WHY THIS EXISTS
 * A v2 strategy ships a finished Groth16 proof, built in the browser at arming time. That cannot
 * work on v3: the circuit takes `admittedRoot`/`revokedRoot` as public inputs
 * (withdrawal.circom:34-35) and `ComplianceHub.admittedRootIsCurrent` demands an exact match with
 * the live root, which is republished every bus epoch and immediately on any revocation. A proof
 * built at arming is stale long before the trigger fires.
 *
 * So the proof is built at FIRE time, inside the enclave that already evaluates the FHE trigger.
 * The enclave needs the note secrets to do that — it derives the state/ASP/SMT paths itself from
 * synced trees, but it cannot derive `nullifier`/`secret`/`label`. Those travel sealed.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST
 * An enclave holding these secrets could spend this slice somewhere other than the intended
 * recipient. The exposure is bounded to one slice — slice notes are minted per leg, exactly sized,
 * and already committed to being spent by the executor — but it is not zero. The alternative that
 * makes it zero (proving compliance in a separate circuit so only the label is needed) requires
 * re-running the trusted setup for every circuit.
 *
 * The mitigations that DO apply, and are all upstream of this file:
 *   - the payload is sealed to an ATTESTED enclave key (quote signature + report_data binding +
 *     measurement pin) via {@link attestAndSeal} — never to a bare pubkey;
 *   - the enclave stores it under its KMS storage-seal key, so it survives a CVM restart between
 *     arming and firing without ever being written in the clear;
 *   - the enclave derives ASP paths from a full tree sync, so it never queries the ASP about this
 *     leg's label at fire time (which would correlate with the spend landing on-chain).
 */
import { attestAndSeal } from "../decryptorAttestation";

/** One input note the leg spends. Every field here is private and must never leave unsealed. */
export interface LegInputSecretV3 {
  /** Note amount in base units, decimal string. */
  value: string;
  /** Poseidon preimage half — with `secret`, forms the precommitment. */
  nullifier: string;
  secret: string;
  /** Poseidon(nonceStem, userSalt). Not on-chain; the ASP knows it, the chain does not. */
  label: string;
  /** uint160(token) — see noteCryptoV3.noteAssetIdFor. Native ETH resolves to WETH. */
  assetId: string;
  /** Leaf index in the kernel's note tree; the enclave derives the path from its synced tree. */
  stateLeafIndex: number;
}

/** The private half of one leg's witness. Public parameters travel unsealed alongside. */
export interface LegSecretsV3 {
  /** PROTOCOL action: 0 withdraw, 1 merge, 2 swap. Fixes the circuit arity at fire time. */
  action: number;
  inputs: LegInputSecretV3[];
  /** Change-note secrets — the leg's unspent remainder returns as a fresh note. */
  outNullifier: string;
  outSecret: string;
  /** SWAP only: destination note secrets binding `outputPrecommitment`. */
  destNullifier?: string;
  destSecret?: string;
  /**
   * Binding salt for `labelCommit` (COMPLIANCE_CIRCUIT_SPLIT §3.2) — spend limb 24 and compliance
   * limb 3 are both this hash, so the enclave must fire with the same value the browser armed with.
   *
   * Sealed rather than public: limb 24 is on chain, and a readable salt would let an observer
   * recompute the commit from a guessed label set. Enclave field `LegSecrets::label_salt`.
   */
  labelSalt: string;
}

const DECIMAL = /^[0-9]+$/;

/**
 * Fail closed on an incomplete payload.
 *
 * A missing or malformed field does not surface at arming — it surfaces hours later when the
 * trigger fires and the enclave cannot build a witness, by which point the arming fee is spent,
 * the slice notes are minted, and the user's strategy silently never executes. Every one of these
 * checks is cheap here and expensive there.
 */
export function assertLegSecretsComplete(s: LegSecretsV3): void {
  if (![0, 1, 2].includes(s.action)) {
    throw new Error(`sealLegSecrets: action must be 0 (withdraw), 1 (merge) or 2 (swap), got ${s.action}`);
  }
  if (!Array.isArray(s.inputs) || s.inputs.length < 1) {
    throw new Error("sealLegSecrets: at least one input note is required");
  }
  if (s.action === 1 && s.inputs.length < 2) {
    throw new Error(`sealLegSecrets: merge requires >= 2 inputs, got ${s.inputs.length}`);
  }
  // withdraw1..6 / merge2..6 are the only verifiers deployed; more inputs than that has no circuit.
  if (s.inputs.length > 6) {
    throw new Error(`sealLegSecrets: at most 6 inputs (no verifier beyond arity 6), got ${s.inputs.length}`);
  }

  s.inputs.forEach((inp, i) => {
    for (const field of ["value", "nullifier", "secret", "label", "assetId"] as const) {
      const v = inp[field];
      if (typeof v !== "string" || !DECIMAL.test(v)) {
        throw new Error(
          `sealLegSecrets: inputs[${i}].${field} must be a decimal string, got ${JSON.stringify(v)}`,
        );
      }
    }
    if (!Number.isInteger(inp.stateLeafIndex) || inp.stateLeafIndex < 0) {
      throw new Error(
        `sealLegSecrets: inputs[${i}].stateLeafIndex must be a non-negative integer, got ${inp.stateLeafIndex}`,
      );
    }
  });

  // A note spent twice in one leg burns one nullifier and silently drops the other's value.
  const seen = new Set(s.inputs.map((i) => i.nullifier));
  if (seen.size !== s.inputs.length) {
    throw new Error("sealLegSecrets: duplicate input nullifier — the same note cannot be spent twice in one leg");
  }

  // Non-zero: both circuit halves constrain `salt != 0`. An enclave that received "0" — or, before
  // this field existed, nothing at all — fails at FIRE time with "labelSalt required and MUST be
  // non-zero", after the arming fee is spent and the slice notes are minted.
  if (typeof s.labelSalt !== "string" || !DECIMAL.test(s.labelSalt) || /^0+$/.test(s.labelSalt)) {
    throw new Error(
      `sealLegSecrets: labelSalt must be a non-zero decimal string, got ${JSON.stringify(s.labelSalt)}`,
    );
  }

  for (const field of ["outNullifier", "outSecret"] as const) {
    if (typeof s[field] !== "string" || !DECIMAL.test(s[field])) {
      throw new Error(`sealLegSecrets: ${field} must be a decimal string`);
    }
  }

  if (s.action === 2) {
    for (const field of ["destNullifier", "destSecret"] as const) {
      const v = s[field];
      if (typeof v !== "string" || !DECIMAL.test(v)) {
        throw new Error(`sealLegSecrets: swap requires ${field} (binds outputPrecommitment)`);
      }
    }
  }
}

/** UTF-8 JSON -> lowercase hex, the payload encoding {@link attestAndSeal} expects. */
export function encodeLegSecrets(s: LegSecretsV3): string {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Validate → attest → seal. Returns hex(crypto_box_seal(json, attestedEnclavePubkey)).
 *
 * The return value is the ONLY thing that may be attached to a strategy. Callers must not keep the
 * plaintext `LegSecretsV3` anywhere it could be submitted — that is the whole point of sealing.
 */
export async function sealLegSecrets(s: LegSecretsV3, executorBase?: string): Promise<string> {
  assertLegSecretsComplete(s);
  return attestAndSeal(encodeLegSecrets(s), executorBase);
}
