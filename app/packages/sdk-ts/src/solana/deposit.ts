/**
 * Solana Devnet deposits. The API returns an unsigned, simulated transaction; the SDK never signs it
 * until it equals the one built here instruction for instruction — a hostile API could otherwise
 * name its own commitment (the deposit becomes its note) or send the wrapped SOL elsewhere.
 */
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TREE_PDA,
  VAULT_PDA,
  WSOL_MINT,
  ata,
  le32,
  pda,
} from "./constants";
import type { PendingSolanaDeposit } from "./notes";
import type { SolanaWallet } from "./wallet";

async function disc(name: string): Promise<Uint8Array> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(d).slice(0, 8);
}

function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

export async function depositInstruction(wallet: PublicKey, d: PendingSolanaDeposit): Promise<TransactionInstruction> {
  const mint = new PublicKey(d.mint);
  const data = Buffer.concat([
    await disc("deposit"), u64le(BigInt(d.amount)), le32(BigInt(d.userSalt)), le32(BigInt(d.precommitment)), le32(BigInt(d.commitment)),
  ]);
  const keys: [PublicKey, boolean, boolean][] = [
    [wallet, true, true], [VAULT_PDA, false, true], [TREE_PDA, false, true], [mint, false, false],
    [ata(wallet, mint), false, true], [ata(VAULT_PDA, mint), false, true],
    [pda(new TextEncoder().encode("siphon-leaf-v1"), le32(BigInt(d.commitment))), false, true],
    [TOKEN_PROGRAM_ID, false, false], [ASSOCIATED_TOKEN_PROGRAM_ID, false, false], [SystemProgram.programId, false, false],
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })) });
}

function wrapSol(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const wsol = ata(owner, WSOL_MINT);
  return [
    new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      data: Buffer.from([1]), // CreateIdempotent
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true }, { pubkey: wsol, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    }),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]), keys: [{ pubkey: wsol, isSigner: false, isWritable: true }] }), // SyncNative
  ];
}

export async function expectedDepositInstructions(wallet: PublicKey, d: PendingSolanaDeposit): Promise<TransactionInstruction[]> {
  return [...(d.native ? wrapSol(wallet, BigInt(d.amount)) : []), await depositInstruction(wallet, d)];
}

/**
 * Parse the API's base64 transaction and refuse it unless it is exactly the deposit we built:
 * the wallet pays and is the only signer, and every instruction matches program, accounts and data.
 */
export async function verifyDepositTransaction(txBase64: string, wallet: PublicKey, d: PendingSolanaDeposit): Promise<Transaction> {
  const tx = Transaction.from(Buffer.from(txBase64, "base64"));
  if (!tx.feePayer?.equals(wallet)) throw new Error("deposit: the transaction's fee payer is not the account wallet");
  if (tx.compileMessage().header.numRequiredSignatures !== 1) throw new Error("deposit: the transaction asks for another signer");
  const expected = await expectedDepositInstructions(wallet, d);
  if (tx.instructions.length !== expected.length) throw new Error("deposit: unexpected instructions in the API's transaction — refusing it");
  tx.instructions.forEach((ix, i) => {
    const want = expected[i];
    const sameKeys = ix.keys.length === want.keys.length && ix.keys.every((k, j) => k.pubkey.equals(want.keys[j].pubkey));
    if (!ix.programId.equals(want.programId) || !sameKeys || !Buffer.from(ix.data).equals(Buffer.from(want.data))) {
      throw new Error(`deposit: instruction ${i} differs from the locally built deposit — refusing it`);
    }
  });
  return tx;
}

/** Sign with the wallet, send, and wait for confirmation. Returns the signature. */
export async function sendDepositTransaction(connection: Connection, wallet: SolanaWallet, tx: Transaction): Promise<string> {
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  const { value } = await connection.confirmTransaction(sig, "confirmed");
  if (value.err) throw new Error(`deposit failed on-chain: ${JSON.stringify(value.err)}`);
  return sig;
}

/** The note's position in the NoteTree, from its leaf PDA (u64 LE @9). */
export async function readLeafIndex(connection: Connection, commitment: string): Promise<number | undefined> {
  const info = await connection.getAccountInfo(pda(new TextEncoder().encode("siphon-leaf-v1"), le32(BigInt(commitment))), "confirmed");
  return info ? Number(Buffer.from(info.data).readBigUInt64LE(9)) : undefined;
}
