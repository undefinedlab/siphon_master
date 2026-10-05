/**
 * Solana Devnet notes. Same hashing as v5 (noteCrypto) with the Solana chain profile:
 *
 *   scope      = P3(6, programId, vaultPda)            (each 32-byte key big-endian mod p)
 *   label      = P2(P3(3, scope, depositNonce), userSalt)
 *   assetId    = mint big-endian mod p
 *   commitment = P2(P3(amount, label, assetId), P2(nullifier, secret))
 *
 * The program recomputes the commitment from the vault's CURRENT deposit_nonce and rejects a
 * mismatch, so a deposit is prepared against a fresh nonce (GET /v1/chains/900002/vault).
 */
import { hashCommitmentWithPre, hashPrecommitment, mintLabelSalted, poseidon3, randomUserSalt } from "../v5/noteCrypto";
import type { Note } from "../v5/types";
import { DOMAIN_CHAIN_SOLANA, PROGRAM_ID, SOLANA_DEVNET_CHAIN_ID, VAULT_PDA, fieldOfKey, mintFor, type SolanaAsset } from "./constants";

/** A spendable Devnet note. `token` is the mint (base58). Every field is decimal except leafIndex. */
export type SolanaNote = Note;

export async function solanaVaultScope(): Promise<bigint> {
  return poseidon3(DOMAIN_CHAIN_SOLANA, fieldOfKey(PROGRAM_ID), fieldOfKey(VAULT_PDA));
}

export interface PendingSolanaDeposit {
  chainId: number;
  asset: SolanaAsset;
  mint: string;
  native: boolean;
  amount: string;
  depositNonce: string;
  nullifier: string;
  secret: string;
  userSalt: string;
  precommitment: string;
  label: string;
  assetId: string;
  commitment: string;
}

/**
 * Note secrets for a deposit. PERSIST the result before sending anything: once the deposit lands
 * these secrets are the only way to spend it.
 */
export async function prepareSolanaDeposit(p: {
  asset: string;
  amount: bigint | string | number;
  /** The vault's current deposit_nonce (GET /v1/chains/900002/vault). */
  depositNonce: bigint | string | number;
  /** The vault's scope_id as the API reports it; must equal the one derived from the pinned program. */
  scopeId: bigint | string;
}): Promise<PendingSolanaDeposit> {
  const { asset, mint, native } = mintFor(p.asset);
  const amount = BigInt(p.amount);
  if (amount <= 0n || amount >= 1n << 64n) throw new Error("prepareSolanaDeposit: amount must be a positive u64");
  const scope = await solanaVaultScope();
  if (BigInt(p.scopeId) !== scope) {
    throw new Error("prepareSolanaDeposit: the vault's scope_id does not match the pinned program and vault — refusing");
  }
  const nullifier = randomUserSalt();
  const secret = randomUserSalt();
  const userSalt = randomUserSalt();
  const precommitment = await hashPrecommitment(nullifier, secret);
  const label = await mintLabelSalted(scope, BigInt(p.depositNonce), userSalt);
  const assetId = fieldOfKey(mint);
  const commitment = await hashCommitmentWithPre(amount, label, assetId, precommitment);
  return {
    chainId: SOLANA_DEVNET_CHAIN_ID,
    asset,
    mint: mint.toBase58(),
    native,
    amount: amount.toString(),
    depositNonce: BigInt(p.depositNonce).toString(),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    userSalt: userSalt.toString(),
    precommitment: precommitment.toString(),
    label: label.toString(),
    assetId: assetId.toString(),
    commitment: commitment.toString(),
  };
}

export function noteFromDeposit(d: PendingSolanaDeposit, leafIndex?: number): SolanaNote {
  return {
    chainId: SOLANA_DEVNET_CHAIN_ID,
    token: d.mint,
    assetId: d.assetId,
    value: d.amount,
    label: d.label,
    nullifier: d.nullifier,
    secret: d.secret,
    commitment: d.commitment,
    ...(leafIndex !== undefined ? { leafIndex } : {}),
  };
}

/** The return note of a filled order, rebuilt from the executor's record and the secrets we kept. */
export async function noteFromReturn(r: {
  returned: { commitment: string; deposit_nonce: string | number; leaf_index?: string | number; amount: string | number; mint: string };
  nullifier: string;
  secret: string;
  userSalt: string;
}): Promise<SolanaNote> {
  const scope = await solanaVaultScope();
  const label = await mintLabelSalted(scope, BigInt(r.returned.deposit_nonce), BigInt(r.userSalt));
  const { mint } = mintFor(r.returned.mint === mintFor("SOL").mint.toBase58() ? "SOL" : "USDC");
  if (mint.toBase58() !== r.returned.mint) throw new Error("noteFromReturn: unknown mint in the returned note");
  const assetId = fieldOfKey(mint);
  const pre = await hashPrecommitment(BigInt(r.nullifier), BigInt(r.secret));
  const commitment = await hashCommitmentWithPre(BigInt(r.returned.amount), label, assetId, pre);
  if (commitment !== BigInt(r.returned.commitment)) {
    throw new Error("noteFromReturn: the executor's returned note does not open with our secrets");
  }
  return {
    chainId: SOLANA_DEVNET_CHAIN_ID,
    token: mint.toBase58(),
    assetId: assetId.toString(),
    value: BigInt(r.returned.amount).toString(),
    label: label.toString(),
    nullifier: r.nullifier,
    secret: r.secret,
    commitment: commitment.toString(),
    ...(r.returned.leaf_index !== undefined ? { leafIndex: Number(r.returned.leaf_index) } : {}),
  };
}
