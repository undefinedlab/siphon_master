/**
 * Prove a spend inside the TEE instead of in the browser, with the browser as fallback.
 *
 * WHY THIS EXISTS. The v3 revamp folded state-Merkle + ASP inclusion + revoked-SMT non-inclusion
 * into one circuit, and the proving keys grew accordingly: withdraw1 is 23MB, withdraw6 and
 * merge6 are 144MB each, ~1.0GB across all fourteen. The browser cannot prefetch the right one,
 * because which arity a spend needs is decided by coin selection at the moment the user picks an
 * amount. On a slow connection that is minutes of download before proving starts. The enclave
 * already holds every key on disk and proves with rapidsnark natively.
 *
 * WHY IT IS NOT THE TRUSTED RELAYER THAT WAS REMOVED. The omega report struck out a plaintext
 * proving relayer: an unattested third party that sees note secrets. This is not that. It is the
 * same DCAP-attested enclave that already holds every user's FHE ClientKey and already sees the
 * full witness of every armed strategy leg, running a prover whose script path is baked into the
 * measured image specifically so a malicious host cannot swap it (spend.rs:1395). The circuit is
 * derived inside the enclave from (action, inputCount) in the witness, never from a parameter, and
 * the proof is verified against that circuit's own vkey before it is returned.
 *
 * WHAT IS GENUINELY WIDER. Before this, a user who never armed a strategy never sent the enclave
 * anything. Now a plain withdrawal does. That is a real expansion of who trusts the TEE, even
 * though it is not a new party to trust — which is why the browser path stays and why this is a
 * fallback chain, not a replacement.
 */
import type { Groth16Proof } from "snarkjs";

import { getSigner } from "@/lib/nexus";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import { getWalletAuthHeaders } from "@/lib/walletAuthHeaders";

/** PROTOCOL action ids — see siphon-zk-v2/scripts/lib/circuits.cjs::circuitKeyForAction. */
export const ACTION = {
  withdraw: 0,
  merge: 1,
  swap: 2,
  split: 3,
  ragequit: 4,
} as const;
export type SpendAction = (typeof ACTION)[keyof typeof ACTION];

/** Off unless explicitly enabled, so a misconfigured deploy proves in the browser rather than failing. */
export function isTeeProverEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TEE_PROVER === "true";
}

/**
 * `withdraw3` -> {action: 0, inputCount: 3}. The callers already computed the circuit name from
 * their own coin selection, so re-deriving here beats adding two parameters to four call sites —
 * and the enclave re-derives it a third time from the witness, which is the one that binds.
 */
export function circuitToAction(circuit: string): { action: SpendAction; inputCount: number } {
  const m = /^(withdraw|merge)([1-6])$/.exec(circuit);
  if (m) {
    return {
      action: m[1] === "withdraw" ? ACTION.withdraw : ACTION.merge,
      inputCount: Number(m[2]),
    };
  }
  if (circuit === "swap") return { action: ACTION.swap, inputCount: 1 };
  if (circuit === "split") return { action: ACTION.split, inputCount: 1 };
  if (circuit === "ragequit") return { action: ACTION.ragequit, inputCount: 1 };
  throw new Error(`circuitToAction: unknown circuit ${circuit}`);
}

type Circom = Record<string, unknown>;
type Proved = { proof: Groth16Proof; publicSignals: string[] };

/**
 * Invert `siphon-zk-v2/scripts/lib/witness-to-input.cjs` — the app builds Circom input directly,
 * the enclave wants the PROTOCOL witness it derives that input from.
 *
 * Keeping the witness (rather than shipping the Circom input and a circuit name) is what preserves
 * the safety property: the enclave picks the circuit from `action` + `inputCount` here, so a
 * caller cannot ask a 6-input witness to be proved by a weaker 1-input circuit.
 *
 * proveRemote.check.ts round-trips this through the REAL converter and asserts the Circom input
 * comes back byte-identical. That check is the only thing standing between a transpose typo and a
 * withdrawal that dies inside witness generation, so do not edit this without running it.
 */
export function toProtocolWitness(
  action: SpendAction,
  inputCount: number,
  input: Circom,
  opts: { rawPayeeHex?: string } = {},
): Record<string, unknown> {
  // The payee is already in the Circom input as 20 bytes for the actions that have one, so it is
  // recovered here rather than threaded through every caller as a second source of truth.
  const rawPayeeHex =
    opts.rawPayeeHex ??
    (Array.isArray(input.rawPayee)
      ? (input.rawPayee as number[]).map((b) => Number(b).toString(16).padStart(2, "0")).join("")
      : undefined);
  const multi = action === ACTION.withdraw || action === ACTION.merge;
  const at = (k: string, i: number) => (multi ? (input[k] as unknown[])[i] : input[k]);

  const inputs = Array.from({ length: inputCount }, (_, i) => ({
    inValue: String(at("inValue", i)),
    inNullifier: String(at("inNullifier", i)),
    inSecret: String(at("inSecret", i)),
    inLabel: String(at("inLabel", i)),
    inAssetId: String(at("inAssetId", i)),
    admittedLeafIndex: String(at("admittedLeafIndex", i)),
    statePathElements: at("statePathElements", i),
    statePathIndices: at("statePathIndices", i),
    admittedPathElements: at("admittedPathElements", i),
    admittedPathIndices: at("admittedPathIndices", i),
    revokedSmtPathElements: at("revokedSmtPathElements", i),
    revokedSmtPathIndices: at("revokedSmtPathIndices", i),
    revokedSmtLeaf: String(at("revokedSmtLeaf", i)),
  }));

  const w: Record<string, unknown> = {
    action,
    inputCount,
    inputs,
    expectedPublic: input.publicInputs,
  };

  // COMPLIANCE_CIRCUIT_SPLIT: the enclave recomputes labelCommit (spend limb 24) from this salt,
  // so the witness must carry the SAME value the browser derived the publics with. The enclave
  // calls the field `labelSalt` (witness-to-input.cjs::requireLabelSalt) while the spend circuit
  // signal is `labelCommitSalt` — same value, different name at the boundary.
  //
  // Without it every remote-proved spend fails inside the enclave with "labelSalt required and
  // MUST be non-zero", which is a 502 from the relayer with the local path never attempted.
  // RAGEQUIT is exempt: it carries no compliance proof and its circuit declares no salt.
  if (action !== ACTION.ragequit) {
    const salt = input.labelCommitSalt;
    if (salt === undefined || salt === null || String(salt) === "0") {
      throw new Error(
        `toProtocolWitness: action ${action} requires a non-zero labelCommitSalt ` +
          `(COMPLIANCE_CIRCUIT_SPLIT §3.2)`,
      );
    }
    w.labelSalt = String(salt);
  }

  // Only withdraw(0) and ragequit(4) carry a payee; the converter throws on a malformed one, so
  // a missing hex must fail here rather than reach the enclave.
  if (action === ACTION.withdraw || action === ACTION.ragequit) {
    if (!rawPayeeHex) throw new Error(`toProtocolWitness: action ${action} requires rawPayeeHex`);
    w.rawPayeeHex = rawPayeeHex;
  }
  if (multi) {
    w.boundaryIndex = String(input.boundaryIndex ?? 0);
    w.outNullifier = String(input.outNullifier ?? "0");
    w.outSecret = String(input.outSecret ?? "0");
  }
  if (action === ACTION.swap) {
    w.outNullifier = String(input.outNullifier ?? "0");
    w.outSecret = String(input.outSecret ?? "0");
    w.destLabel = String(input.destLabel ?? inputs[0].inLabel);
  }
  if (action === ACTION.split) {
    w.splitValues = (input.outValue as unknown[]).map(String);
    w.splitNullifiers = (input.outNullifier as unknown[]).map(String);
    w.splitSecrets = (input.outSecret as unknown[]).map(String);
  }
  if (action === ACTION.ragequit) {
    w.ragequitBranch = String(input.branch ?? 0);
  }
  return w;
}

/**
 * Prove in the enclave, falling back to `browser()` on ANY enclave failure.
 *
 * Every failure is a fallback, never a user-visible error: the enclave being down, slow, rate
 * limited or misconfigured must not be able to block a withdrawal, because the browser can still
 * do the job — just slowly. The only thing lost by falling back is time.
 */
export async function proveSpend(
  args: { circuit: string; input: Circom },
  browser: () => Promise<Proved>,
): Promise<Proved & { provedIn: "enclave" | "browser" }> {
  if (!isTeeProverEnabled()) return { ...(await browser()), provedIn: "browser" };

  try {
    const signer = getSigner();
    if (!signer) throw new Error("no signer for wallet auth");
    const { action, inputCount } = circuitToAction(args.circuit);
    const witness = toProtocolWitness(action, inputCount, args.input);
    // /tee/prove, not /prove: Caddy routes /prove* to the v1 proving-relayer, so this would
    // never reach the trade-executor. Unmatched paths fall through to it, so this needs no
    // Caddy rule of its own.
    const res = await fetch(`${getTradeExecutorBaseUrl()}/tee/prove`, {
      method: "POST",
      // READ headers, not WRITE. wallet_auth.py has two schemes and they do not interoperate:
      // @verify_wallet_sig checks _check_wallet_sig (X-Wallet-Address / X-Signature / X-Timestamp
      // over "Siphon auth v1:<ts>"), while getWalletWriteAuthHeaders signs a single-use challenge
      // nonce that only verify_wallet_write accepts. Sending write headers to a read route is a
      // flat 401 -- which silently fell back to browser proving, so the feature looked wired and
      // never once ran in the enclave.
      //
      // Read auth is also the right scheme here: this route authorises nothing. The caller can
      // only prove a witness whose note secrets it already holds. And it rides the session key,
      // so there is no wallet popup per withdrawal on top of the one the spend already needs.
      headers: { "Content-Type": "application/json", ...(await getWalletAuthHeaders(signer)) },
      body: JSON.stringify(witness),
    });
    const body = await res.json();
    if (!res.ok || !body?.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    if (!body.proof || !Array.isArray(body.publicSignals)) {
      throw new Error("enclave returned no proof");
    }
    return {
      proof: body.proof as Groth16Proof,
      publicSignals: body.publicSignals as string[],
      provedIn: "enclave",
    };
  } catch (e) {
    // Deliberately not surfaced: the caller still verifies the fallback proof locally and against
    // its recomputed publics, so a bad enclave cannot smuggle anything through this path.
    console.warn("[prove] enclave prover unavailable, proving in browser:", e);
    return { ...(await browser()), provedIn: "browser" };
  }
}
