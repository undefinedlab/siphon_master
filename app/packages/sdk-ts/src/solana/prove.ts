/**
 * Solana Devnet spends, proven locally. Mirrors siphon-app solanaVaultZk.ts (proveSolanaZkSpend,
 * splitZkSolana): the same v5 withdraw/split circuits with the dev-beacon keys, no compliance half —
 * the program checks the admitted/revoked roots in limbs 3/4 against its compliance account.
 *
 * Every read the proof depends on is checked against the chain before proving, so stale or forged
 * API data fails here instead of after the relayer has paid for a doomed spend.
 */
import { Connection } from "@solana/web3.js";
import { MAX_SPLIT_OUTPUTS, deriveSplitPublics, type SplitSlice } from "../v5/actionPublics";
import { randomLabelSalt } from "../v5/labelCommit";
import { hashCommitment, randomUserSalt } from "../v5/noteCrypto";
import { planWithdraw, type PlannerNote, type WithdrawPlan } from "../v5/planWithdraw";
import { Prover, type FlatProof } from "../v5/prover";
import { buildStatePath, computeStateRoot, findLeafIndex, TREE_DEPTH } from "../v5/stateTree";
import type { V5DataSource } from "../v5/types";
import { buildWithdrawWitness } from "../v5/withdrawWitness";
import {
  COMPLIANCE_PDA,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_PROGRAM_VERSION,
  TREE_PDA,
  VAULT_PDA,
  bytesToHex,
  fieldOfKey,
  fromLe,
  mintFor,
} from "./constants";
import type { SolanaNote } from "./notes";
import { PublicKey } from "@solana/web3.js";

/** What POST /v1/payouts (`solana_spend`) and POST /v1/splits take. */
export interface SolanaSpend {
  public_inputs: string[];
  proof_hex: string;
  circuit_index: number;
}

export interface ChainHead {
  stateRoot: bigint;
  admittedRoot: bigint;
  revokedRoot: bigint;
}

export async function readChainHead(connection: Connection): Promise<ChainHead> {
  const [vault, tree, comp] = await connection.getMultipleAccountsInfo([VAULT_PDA, TREE_PDA, COMPLIANCE_PDA], "confirmed");
  if (!vault || !tree || !comp) throw new Error("Solana Devnet vault is not initialized");
  const version = fromLe(vault.data.subarray(41, 73));
  if (version !== BigInt(SOLANA_PROGRAM_VERSION)) {
    throw new Error(`vault program_version ${version} != ${SOLANA_PROGRAM_VERSION}: SDK and vault are out of sync`);
  }
  return {
    stateRoot: fromLe(tree.data.subarray(24, 56)),
    admittedRoot: fromLe(comp.data.subarray(9, 41)),
    revokedRoot: fromLe(comp.data.subarray(41, 73)),
  };
}

/** The program's 256-byte proof: A | B (each G2 coordinate c1‖c0) | C, big-endian — the flat order. */
export function proofHex(flat: FlatProof): string {
  return flat.map((v) => BigInt(v).toString(16).padStart(64, "0")).join("");
}

/** Leaves from the API, accepted only when they rebuild the on-chain root. */
async function checkedLeaves(data: V5DataSource, head: ChainHead): Promise<bigint[]> {
  const leaves = await data.stateLeaves(SOLANA_DEVNET_CHAIN_ID);
  if ((await computeStateRoot(leaves)) !== head.stateRoot) {
    throw new Error("state leaves do not rebuild the on-chain root (stale or forged) — retry shortly");
  }
  return leaves;
}

function toPlanner(notes: SolanaNote[]): PlannerNote[] {
  return notes.map((n) => ({ commitment: n.commitment, value: BigInt(n.value), label: n.label, assetId: n.assetId, nullifier: n.nullifier, secret: n.secret }));
}

export interface PreparedSolanaWithdrawal {
  spend: SolanaSpend;
  /** Notes this spend consumes — mark them spent once the payout confirms. */
  spent: SolanaNote[];
  /** The leftover, if any. Store it BEFORE submitting: once the spend lands it is the only copy. */
  change: SolanaNote | null;
  plan: WithdrawPlan;
}

/**
 * Prove a withdraw of `amount` of `asset` to `recipient` (a base58 wallet; the program pays its ATA).
 * Order spends use the same proof with the executor's settlement wallet as the recipient.
 */
export async function prepareSolanaWithdrawal(p: {
  asset: string;
  amount: bigint | string | number;
  recipient: string;
  notes: SolanaNote[];
  data: V5DataSource;
  connection: Connection;
  prover?: Prover;
}): Promise<PreparedSolanaWithdrawal> {
  const { mint } = mintFor(p.asset);
  const recipient = new PublicKey(p.recipient);
  const assetId = fieldOfKey(mint).toString();
  const mine = p.notes.filter((n) => n.chainId === SOLANA_DEVNET_CHAIN_ID && n.token === mint.toBase58());
  const plan = planWithdraw(toPlanner(mine), BigInt(p.amount), assetId);

  const head = await readChainHead(p.connection);
  const leaves = await checkedLeaves(p.data, head);
  const compliance = await p.data.complianceWitness(SOLANA_DEVNET_CHAIN_ID, plan.selected.map((n) => String(n.label)));
  if (BigInt(compliance.admittedRoot) !== head.admittedRoot || BigInt(compliance.revokedRoot) !== head.revokedRoot) {
    throw new Error("compliance roots differ from the vault's on-chain roots — new roots are publishing; retry");
  }

  const outNullifier = randomUserSalt();
  const outSecret = randomUserSalt();
  const built = await buildWithdrawWitness({
    plan,
    leaves,
    outNullifier,
    outSecret,
    // The program binds the payee as PayeeId over the FIRST 20 bytes of the pubkey (the circuit's
    // EVM-width rawPayee), then checks the payee ATA's owner against all 32 bytes.
    rawPayee: `0x${bytesToHex(recipient.toBytes().subarray(0, 20))}`,
    chainId: SOLANA_DEVNET_CHAIN_ID,
    stateRoot: head.stateRoot,
    compliance,
  });
  const circuit = `withdraw${plan.inputCount}`;
  const flat = await (p.prover ?? new Prover()).prove(SOLANA_DEVNET_CHAIN_ID, circuit, built.input, built.expectedPublics);

  let change: SolanaNote | null = null;
  if (plan.secondaryValue > 0n) {
    const label = plan.selected[plan.boundaryIndex].label;
    const commitment = await hashCommitment(plan.secondaryValue, BigInt(label), BigInt(assetId), outNullifier, outSecret);
    if (commitment !== BigInt(built.expectedPublics[7])) throw new Error("change commitment does not match public limb 7");
    change = {
      chainId: SOLANA_DEVNET_CHAIN_ID, token: mint.toBase58(), assetId, value: plan.secondaryValue.toString(), label,
      nullifier: outNullifier.toString(), secret: outSecret.toString(), commitment: commitment.toString(),
    };
  }
  const byCommitment = new Map(mine.map((n) => [n.commitment, n]));
  return {
    spend: { public_inputs: built.expectedPublics, proof_hex: proofHex(flat), circuit_index: plan.inputCount - 1 },
    spent: plan.selected.map((n) => byCommitment.get(n.commitment)!),
    change,
    plan,
  };
}

export interface PreparedSolanaSplit {
  spend: SolanaSpend;
  /** The 8 slice commitments the program re-hashes to limb 17 (0 for unused slots). */
  splitCommitments: string[];
  /** The new notes, in order. Store them BEFORE submitting. */
  slices: SolanaNote[];
  /** Tree leaves once the split lands (the pre-split leaves plus the slices, in order). */
  leavesAfter: bigint[];
}

/** Split one note into 2-8 slices under its label — the funding step of a multi-leg order. */
export async function prepareSolanaSplit(p: {
  note: SolanaNote;
  values: bigint[];
  data: V5DataSource;
  connection: Connection;
  prover?: Prover;
}): Promise<PreparedSolanaSplit> {
  const { note, values } = p;
  if (values.length < 2 || values.length > MAX_SPLIT_OUTPUTS) throw new Error("split into 2 to 8 notes");
  if (values.some((v) => v <= 0n) || values.reduce((a, b) => a + b, 0n) !== BigInt(note.value)) {
    throw new Error("split values must be positive and add up to the note");
  }
  const head = await readChainHead(p.connection);
  const leaves = await checkedLeaves(p.data, head);
  const idx = findLeafIndex(leaves, BigInt(note.commitment));
  if (idx < 0) throw new Error("this note is not in the vault tree yet — wait for its deposit to index");
  const path = await buildStatePath(leaves, idx, TREE_DEPTH);
  const compliance = await p.data.complianceWitness(SOLANA_DEVNET_CHAIN_ID, [note.label]);
  if (BigInt(compliance.admittedRoot) !== head.admittedRoot || BigInt(compliance.revokedRoot) !== head.revokedRoot) {
    throw new Error("compliance roots differ from the vault's on-chain roots — new roots are publishing; retry");
  }

  const slices: SplitSlice[] = Array.from({ length: MAX_SPLIT_OUTPUTS }, (_, i) =>
    i < values.length ? { value: values[i], nullifier: randomUserSalt(), secret: randomUserSalt() } : { value: 0n, nullifier: 0n, secret: 0n },
  );
  const labelCommitSalt = randomLabelSalt();
  const { publics, splitCommitments } = await deriveSplitPublics({
    input: { inValue: BigInt(note.value), inNullifier: BigInt(note.nullifier), inSecret: BigInt(note.secret), inLabel: BigInt(note.label), inAssetId: BigInt(note.assetId) },
    slices,
    roots: { stateRoot: head.stateRoot, admittedRoot: head.admittedRoot, revokedRoot: head.revokedRoot },
    labelCommitSalt,
  });
  const c = compliance.inputs[0];
  // split.circom declares its note fields as SCALARS (only withdraw/merge take N inputs).
  const input = {
    publicInputs: publics,
    labelCommitSalt: labelCommitSalt.toString(),
    inValue: note.value, inNullifier: note.nullifier, inSecret: note.secret, inLabel: note.label, inAssetId: note.assetId,
    statePathElements: path.pathElements.map(String),
    statePathIndices: path.pathIndices,
    admittedLeafIndex: String(c.admittedLeafIndex),
    admittedPathElements: c.admittedPathElements,
    admittedPathIndices: c.admittedPathIndices,
    revokedSmtPathElements: c.revokedSmtPathElements,
    revokedSmtPathIndices: c.revokedSmtPathIndices,
    revokedSmtLeaf: String(c.revokedSmtLeaf),
    outValue: slices.map((s) => String(s.value)),
    outNullifier: slices.map((s) => String(s.nullifier)),
    outSecret: slices.map((s) => String(s.secret)),
  };
  const flat = await (p.prover ?? new Prover()).prove(SOLANA_DEVNET_CHAIN_ID, "split", input, publics);
  const out: SolanaNote[] = values.map((v, i) => ({
    chainId: SOLANA_DEVNET_CHAIN_ID, token: note.token, assetId: note.assetId, value: v.toString(), label: note.label,
    nullifier: slices[i].nullifier.toString(), secret: slices[i].secret.toString(), commitment: splitCommitments[i],
  }));
  return {
    spend: { public_inputs: publics, proof_hex: proofHex(flat), circuit_index: 12 },
    splitCommitments,
    slices: out,
    leavesAfter: [...leaves, ...out.map((n) => BigInt(n.commitment))],
  };
}
