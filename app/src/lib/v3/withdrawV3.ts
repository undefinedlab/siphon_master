/**
 * v3 withdraw orchestrator (Phase 3) — the top-level fractional-change withdraw flow.
 *
 * plan (planWithdrawV3) → build witness (withdrawWitnessV3) → prove (browser snarkjs, v4 withdraw
 * artifacts) → local verify → encode calldata (G2 swap) → submit VaultKernel.spend via executor.
 *
 * Fails closed when v3 contracts are not deployed (requireV3) or the state-leaf indexer is not yet
 * serving leaves (stateLeavesClient). No submission happens until the whole pipeline is green and
 * the recomputed publics match the proof (PROTOCOL §9 / O-30).
 */

import * as snarkjs from "snarkjs";
import { proveSpend } from "./proveRemote";
import { requireV3, PROGRAM_VERSION_V3, zkProvingBase } from "./configV3";
import { proveComplianceV3, type ComplianceHalf } from "./complianceProofV3";
import { zkUrl } from "../zkAssets";
import { planWithdraw, type PlannerNote, type WithdrawPlan } from "./planWithdrawV3";
import { fetchStateLeaves } from "./stateLeavesClient";
import { computeStateRoot } from "./stateTreeV3";
import { buildWithdrawWitness, type WithdrawCircomInput } from "./withdrawWitnessV3";
import { loadZkey } from "./zkeyCache";

export interface Groth16Calldata {
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
}

export interface WithdrawV3Result {
  ok: boolean;
  txHash?: string;
  publicSignals: string[];
  calldata: Groth16Calldata;
  circuit: string;
  inputCount: number;
  plan: WithdrawPlan;
}

export interface WithdrawV3Params {
  chainId: number;
  notes: PlannerNote[];
  target: bigint;
  assetId: string;
  /** Fresh recipient (breaks the deposit link). */
  recipient: string;
  /** Fresh change-note secrets. */
  outNullifier: bigint;
  outSecret: bigint;
  /** ASP screen token (for path fetch). */
  screenToken: string;
  /**
   * Submit hook: POSTs the built spend to the executor/relayer, returns tx hash. Injected so this
   * module stays free of transport specifics and is unit-testable. When omitted, the flow stops
   * after proving (dryRun) and returns the calldata for the caller to submit.
   */
  submit?: (payload: {
    chainId: number;
    vaultKernel: string;
    publicInputs: string[];
    proof: Groth16Calldata;
    /** The COMPLIANCE half — verified conjunctively with the spend proof (PROGRAM_VERSION 5). */
    compliance: ComplianceHalf;
    rawPayee: string;
  }) => Promise<{ tx_hash: string }>;
  dryRun?: boolean;
}

/** G2 point swap: snarkjs [c0,c1] → Solidity verifier [c1,c0]. */
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
  if (expected.length !== got.length) {
    throw new Error(`publics length mismatch: expected ${expected.length}, got ${got.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (BigInt(expected[i]) !== BigInt(got[i])) {
      throw new Error(`publics limb[${i}] mismatch: expected ${expected[i]}, got ${got[i]}`);
    }
  }
}

/**
 * Execute a v3 fractional-change withdrawal.
 * @throws with a clear message at each gate (not deployed, no leaves, note not found, publics
 *         mismatch, local verify fail) — nothing is submitted unless every gate passes.
 */
export async function withdrawV3(p: WithdrawV3Params): Promise<WithdrawV3Result> {
  const cfg = requireV3(p.chainId); // fail closed if contracts unconfigured

  // 1) Coin selection.
  const plan = planWithdraw(p.notes, p.target, p.assetId);
  const circuit = `withdraw${plan.inputCount}`;

  // 2) State leaves (503-gated on the NoteTree emit).
  const leavesRes = await fetchStateLeaves(p.chainId);
  if (!leavesRes.available || !leavesRes.data) {
    throw new Error(`withdrawV3: state leaves unavailable — ${leavesRes.reason ?? "unknown"}`);
  }
  const stateRoot = await computeStateRoot(leavesRes.data.leaves);

  // 3) Assemble witness (state + ASP/SMT paths + publics).
  const built = await buildWithdrawWitness({
    plan,
    leaves: leavesRes.data.leaves,
    outNullifier: p.outNullifier,
    outSecret: p.outSecret,
    rawPayee: p.recipient,
    chainId: p.chainId,
    stateRoot,
    aspUrl: cfg.aspUrl,
    screenToken: p.screenToken,
  });

  // Sanity: the version limb is what the registry will be asked for.
  if (BigInt(built.expectedPublics[16]) !== BigInt(PROGRAM_VERSION_V3)) {
    throw new Error(`withdrawV3: expected programVersion ${PROGRAM_VERSION_V3}`);
  }

  // 4) Prove (browser snarkjs, v4 withdraw artifacts under /zk/withdrawN/).
  // The zkey is per-CHAIN: Base's verifiers hold the ceremony delta, Sepolia's the dev-beacon one.
  // The wasm is the compiled circuit and is shared.
  const keys = zkProvingBase(p.chainId);
  // Enclave first, browser as fallback. withdraw6 is a 144MB key and the arity is only known
  // after planWithdraw runs, so it cannot be prefetched — on a slow connection that download is
  // minutes before proving starts. Steps 5 and 6 below re-check whatever comes back, so this
  // changes where the proof is computed and nothing about what is trusted.
  //
  // The zkey load MUST stay inside the fallback: awaiting it out here downloads the key even when
  // the enclave proves, which is the entire cost this path exists to avoid. spendActionsV3 already
  // does it this way.
  const { proof, publicSignals } = await proveSpend(
    { circuit, input: built.input as unknown as Record<string, unknown> },
    async () =>
      snarkjs.groth16.fullProve(
        built.input as unknown as Record<string, unknown>,
        zkUrl(`/zk/${circuit}/main_${circuit}.wasm`),
        // Bytes from Cache Storage when we have them — a 144 MB key is not HTTP-cacheable.
        await loadZkey(`${keys}/${circuit}/zkey_final.zkey`),
      ),
  );

  // 5) Recomputed publics MUST match the proof (O-30) before any submit.
  assertPublicsMatch(built.expectedPublics, publicSignals as string[]);

  // 6) Local verify against the circuit vkey.
  const vKey = await fetch(`${keys}/${circuit}/verification_key.json`).then((r) => {
    if (!r.ok) throw new Error(`withdrawV3: vkey HTTP ${r.status}`);
    return r.json();
  });
  const valid = await snarkjs.groth16.verify(vKey, publicSignals, proof);
  if (!valid) throw new Error("withdrawV3: local Groth16 verify failed");

  const calldata = proofToCalldata(
    proof as unknown as { pi_a: string[]; pi_b: string[][]; pi_c: string[] },
  );

  // 6b) The COMPLIANCE half, over the SAME salt the witness was built with. Proved after the spend
  // half so a spend failure costs no compliance proving time, and bound to limb 24 so the two
  // cannot drift — a drift here would revert ComplianceProofFailed() with the gas already spent.
  const compliance = await proveComplianceV3({
    chainId: p.chainId,
    labels: plan.selected.map((n) => BigInt(n.label)),
    paths: {
      statePathElements: [],
      statePathIndices: [],
      compliance: built.compliance,
      stateRoot,
    },
    salt: built.labelCommitSalt,
    expectedCommit: BigInt(built.expectedPublics[24]),
  });

  const result: WithdrawV3Result = {
    ok: true,
    publicSignals: publicSignals as string[],
    calldata,
    circuit,
    inputCount: plan.inputCount,
    plan,
  };

  // 7) Submit (unless dry-run or no submit hook).
  if (p.dryRun || !p.submit) return result;

  const submitted = await p.submit({
    chainId: p.chainId,
    vaultKernel: cfg.vaultKernel,
    publicInputs: publicSignals as string[],
    proof: calldata,
    compliance,
    rawPayee: p.recipient,
  });
  return { ...result, txHash: submitted.tx_hash };
}

export type { WithdrawCircomInput };
