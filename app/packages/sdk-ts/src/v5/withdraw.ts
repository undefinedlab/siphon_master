/**
 * v5 withdrawal, proven locally. Mirrors siphon-app src/lib/v3/withdrawV3.ts + spendRouterV3.ts.
 *
 * Returns a SpendBundle — the exact body the relayer's `/relaySpend` takes — plus the change note
 * the caller must store. Nothing here is submitted: the Siphon API relays the bundle, or the caller
 * sends `VaultKernel.spend` itself (it is permissionless).
 */
import { Contract, getAddress, type Provider } from "ethers";
import { chainConfig } from "./constants";
import { hashCommitment, noteAssetIdFor, randomUserSalt } from "./noteCrypto";
import { planWithdraw, type PlannerNote, type WithdrawPlan } from "./planWithdraw";
import { Prover, type FlatProof } from "./prover";
import { computeStateRoot } from "./stateTree";
import type { Note, V5DataSource } from "./types";
import { buildWithdrawWitness } from "./withdrawWitness";

export interface SpendBundle {
  chain_id: number;
  public_inputs: string[];
  proof: FlatProof;
  compliancePublicInputs: string[];
  complianceProof: FlatProof;
  extra: { rawPayee: string };
}

export interface PreparedWithdrawal {
  bundle: SpendBundle;
  /** Notes this spend consumes — mark them spent once the transaction is mined. */
  spent: Note[];
  /** The leftover, if any. Store it BEFORE submitting: once the spend lands it is the only copy. */
  change: Note | null;
  plan: WithdrawPlan;
}

export async function prepareWithdrawal(p: {
  chainId: number;
  /** The token to withdraw (NATIVE_TOKEN/zero for ETH — paid out of WETH notes). */
  token: string;
  amount: bigint | string;
  /** Fresh address that receives the funds. Reusing the depositor links the two. */
  recipient: string;
  notes: Note[];
  data: V5DataSource;
  prover?: Prover;
  /**
   * An RPC for `chainId`. When given (recommended), the state root rebuilt from the data source's
   * leaves must equal `VaultKernel.stateRoot()` — so forged or stale leaves fail here, before
   * proving, instead of reverting after the relayer has paid gas.
   */
  provider?: Provider;
}): Promise<PreparedWithdrawal> {
  const cfg = chainConfig(p.chainId);
  let recipient: string;
  try {
    // EIP-55: a mixed-case address with one wrong character is rejected, not paid irreversibly.
    recipient = getAddress(p.recipient);
  } catch {
    throw new Error("prepareWithdrawal: recipient is not a valid address (bad length or EIP-55 checksum)");
  }
  const assetId = noteAssetIdFor(p.chainId, p.token).toString();
  const byCommitment = new Map(p.notes.map((n) => [n.commitment, n]));
  const planner: PlannerNote[] = p.notes
    .filter((n) => n.chainId === p.chainId)
    .map((n) => ({ commitment: n.commitment, value: BigInt(n.value), label: n.label, assetId: n.assetId, nullifier: n.nullifier, secret: n.secret }));
  const plan = planWithdraw(planner, BigInt(p.amount), assetId);

  const leaves = await p.data.stateLeaves(p.chainId);
  const stateRoot = await computeStateRoot(leaves);
  if (p.provider) {
    const onChain = BigInt(await new Contract(cfg.vaultKernel, ["function stateRoot() view returns (uint256)"], p.provider).stateRoot());
    if (onChain !== stateRoot) {
      throw new Error("prepareWithdrawal: state leaves do not rebuild the on-chain root (stale or forged) — retry");
    }
  }
  const labels = plan.selected.map((n) => String(n.label));
  const compliance = await p.data.complianceWitness(p.chainId, labels);

  const outNullifier = randomUserSalt();
  const outSecret = randomUserSalt();
  const built = await buildWithdrawWitness({
    plan,
    leaves,
    outNullifier,
    outSecret,
    rawPayee: recipient,
    chainId: p.chainId,
    stateRoot,
    compliance,
  });

  const prover = p.prover ?? new Prover();
  const proof = await prover.prove(p.chainId, `withdraw${plan.inputCount}`, built.input, built.expectedPublics);
  const complianceHalf = await prover.proveCompliance({
    chainId: p.chainId,
    labels: plan.selected.map((n) => BigInt(n.label)),
    compliance: built.compliance,
    salt: built.labelCommitSalt,
    expectedCommit: BigInt(built.expectedPublics[24]),
  });

  let change: Note | null = null;
  if (plan.secondaryValue > 0n) {
    // Change inherits the boundary note's label; limb 7 is its commitment. Recompute and compare so
    // a stored change note is provably the one the proof commits to.
    const label = plan.selected[plan.boundaryIndex].label;
    const commitment = await hashCommitment(plan.secondaryValue, BigInt(label), BigInt(assetId), outNullifier, outSecret);
    if (commitment.toString() !== BigInt(built.expectedPublics[7]).toString()) {
      throw new Error("prepareWithdrawal: change commitment does not match public limb 7");
    }
    change = {
      chainId: p.chainId,
      token: byCommitment.get(plan.selected[0].commitment)?.token ?? "",
      assetId,
      value: plan.secondaryValue.toString(),
      label,
      nullifier: outNullifier.toString(),
      secret: outSecret.toString(),
      commitment: commitment.toString(),
    };
  }

  return {
    bundle: {
      chain_id: cfg.chainId,
      public_inputs: built.expectedPublics,
      proof,
      compliancePublicInputs: complianceHalf.publicInputs,
      complianceProof: complianceHalf.proof,
      extra: { rawPayee: recipient },
    },
    spent: plan.selected.map((n) => byCommitment.get(n.commitment)!),
    change,
    plan,
  };
}
