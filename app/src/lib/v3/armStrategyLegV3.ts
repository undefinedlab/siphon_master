/**
 * Arm one v3 strategy leg from the browser: seal its secrets to the enclave and record the
 * output note so the proceeds stay resolvable.
 *
 * This is the v3 counterpart of `atomicVaultSwap.armSameChainVaultSwap`, and the difference is
 * the whole point of v3: the v2 path builds a finished Groth16 proof here, at arming time. v3
 * cannot, because the circuit binds `admittedRoot`/`revokedRoot` as public inputs and those move
 * on every ASP publish — a proof built now is stale long before the trigger fires. So this
 * assembles the witness inputs, seals the note secrets to the enclave's attested key, and lets the
 * enclave prove at fire time.
 *
 * Two things must both happen for a leg to be safe, and neither is optional:
 *
 *  1. `submitArmedLeg` — without it the enclave has no secrets and the leg can never fire.
 *  2. `postPrecommitment` — the leg re-shields its proceeds into a note owned by
 *     `outputPrecommitment`. Without the matching {nullifier, secret} row the note exists on-chain
 *     and is permanently unresolvable: funds correctly shielded and invisible forever. That exact
 *     failure has already shipped twice (the fill-fee change, and the vault-output Merkle assert),
 *     which is why the executor now refuses to fire a vault leg whose `output_precommitment` is
 *     missing — but the executor cannot write this row, because it is encrypted under the user's
 *     own key. Only the browser can.
 *
 * The precommitment is posted BEFORE the leg is armed, deliberately. If posting fails we have an
 * orphan row and no leg, which costs nothing. The other order risks an armed leg that fires into
 * an unresolvable note.
 */
import type { Signer } from "ethers";

import { postPrecommitment } from "../precommitmentStore";
import { stashPendingOutputNote } from "./outputNoteResolverV3";
import { buildArmedLeg, submitArmedLeg } from "./armLegV3";
import { fetchComplianceRoots } from "./aspClientV3";
import { requireStrategySupport, v3Config } from "./configV3";
import { hashPrecommitment, randomUserSalt } from "./noteCryptoV3";
import type { StoredV3Note } from "./noteStoreV3";
import { fetchStateLeaves } from "./stateLeavesClient";

export interface ArmV3LegParams {
  chainId: number;
  strategyId: string;
  legIndex: number;
  signer: Signer;
  /** The slice note this leg spends — minted for this leg and exactly sized. */
  note: StoredV3Note;
  /** Uppercased symbol of the OUTPUT token, for the precommitment row's `asset` column. */
  outSymbol: string;
  /** ASP screen token. Passed in rather than read from config, matching withdrawWitnessV3 — the
   *  callers already hold it and it is not part of the chain's static configuration. */
  screenToken: string;
  /** Payout leg: WITHDRAW the note to this address (the executor's bridge payee) — no swap, no
   *  output note to record. The executor bridges what it receives. `swap` is then ignored. */
  payee?: string;
  swap: {
    amountIn: bigint;
    /** Remainder left in the input asset. Usually 0 for an exact slice spend. */
    change: bigint;
    pool: bigint;
    dstToken: bigint;
    fee: bigint;
    minAmountOut: bigint;
  };
}

export interface ArmedV3Leg {
  /** Goes on the leg row so the executor can check the note will be resolvable. */
  output_precommitment: string;
  legKey?: string;
}

/**
 * Seal one leg to the enclave and record its output note.
 *
 * Throws rather than returning a partial result: a half-armed leg is worse than none, because the
 * user has already paid an arming fee for something that cannot fire.
 */
export async function armV3StrategyLeg(p: ArmV3LegParams): Promise<ArmedV3Leg> {
  // Fails closed where the v3 strategy path is not fully configured, rather than arming into
  // nothing. NOT requireV2StrategyPath — that one refuses precisely the chains this path serves.
  requireStrategySupport(p.chainId);
  const cfg = v3Config(p.chainId);
  if (!cfg) throw new Error(`armV3StrategyLeg: v3 is not configured for chain ${p.chainId}`);

  // Fresh secrets for the two notes this leg mints: `out` is the change note (input asset), `dest`
  // is the swap proceeds (output asset). Distinct nullifiers, or the two collide on one spend.
  const outNullifier = randomUserSalt();
  const outSecret = randomUserSalt();
  const destNullifier = randomUserSalt();
  const destSecret = randomUserSalt();
  const outputPrecommitment = await hashPrecommitment(destNullifier, destSecret);

  // The state path is built from the leaf set; `NoteTree.knownRoots` is unbounded, so a path built
  // now stays valid however long the strategy waits. Only the ASP roots go stale, and the enclave
  // refreshes those itself at fire time.
  const leavesResult = await fetchStateLeaves(p.chainId);
  if (!leavesResult.available || !leavesResult.data) {
    throw new Error(`armV3StrategyLeg: state leaves unavailable (${leavesResult.reason ?? "unknown"})`);
  }

  // Only used to derive `expectedPublic`; the enclave overwrites both before proving.
  const roots = await fetchComplianceRoots(cfg.aspUrl, p.screenToken, p.chainId);

  // Record the output note FIRST — see the header. An orphan row is harmless; an armed leg whose
  // proceeds nobody can resolve is not. A payout leg mints no output note: its proceeds leave.
  if (!p.payee) await postPrecommitment(p.signer, {
    nullifier: destNullifier.toString(),
    secret: destSecret.toString(),
    precommitment: outputPrecommitment.toString(),
    asset: p.outSymbol.toUpperCase(),
    chainId: p.chainId,
  });

  const payload = await buildArmedLeg({
    chainId: p.chainId,
    strategyId: p.strategyId,
    legIndex: p.legIndex,
    note: {
      value: BigInt(p.note.value),
      nullifier: BigInt(p.note.nullifier),
      secret: BigInt(p.note.secret),
      label: BigInt(p.note.label),
      assetId: BigInt(p.note.assetId),
      commitment: BigInt(p.note.commitment),
    },
    stateLeaves: leavesResult.data.leaves,
    payee: p.payee,
    swap: { ...p.swap, outputPrecommitment },
    outNullifier,
    outSecret,
    destNullifier,
    destSecret,
    admittedRoot: BigInt(roots.admittedRoot),
    revokedRoot: BigInt(roots.revokedRoot),
  });

  // Stage the note this leg will MINT. The precommitment row above backs up the secrets, but it
  // carries no amount, label or asset, so nothing could ever reconstruct the commitment from it —
  // the proceeds landed on-chain and stayed invisible. `destCommitment` is public limb 22, the
  // exact leaf the kernel inserts, so resolveV3OutputNotes can match it without guessing.
  //
  // Staged BEFORE the leg is armed, for the same reason the precommitment is: a stash for a leg
  // that never armed is inert and gets cleaned up by nothing existing to match it, while a leg
  // armed with no stash mints funds the UI cannot see.
  if (!p.payee) await stashPendingOutputNote(
    p.chainId,
    {
      nullifier: destNullifier.toString(),
      secret: destSecret.toString(),
      // destLabel == inLabel — association inheritance, and what deriveSwapPublics binds.
      label: p.note.label,
      assetId: p.swap.dstToken.toString(),
      symbol: p.outSymbol.toUpperCase(),
      commitment: payload.destCommitment,
      value: p.swap.minAmountOut.toString(),
      precommitment: outputPrecommitment.toString(),
    },
    p.signer,
  );

  const res = await submitArmedLeg(p.chainId, payload);
  if (!res.ok) {
    throw new Error(`armV3StrategyLeg: leg ${p.legIndex} could not be armed: ${res.error ?? "unknown"}`);
  }

  return { output_precommitment: p.payee ? "" : outputPrecommitment.toString(), legKey: res.legKey };
}
