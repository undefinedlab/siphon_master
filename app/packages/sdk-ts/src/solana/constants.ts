/**
 * Solana Devnet (chain 900002): Siphon's ZK vault program. Pinned here, not read from the API, so a
 * hostile API cannot point deposits at another program or vault. Mirrors siphon-contracts-v2
 * solana/DEVNET-DEPLOYMENT.md and siphon-app solanaVaultZk.ts.
 */
import { PublicKey } from "@solana/web3.js";
import { FIELD, modField } from "../v5/noteCrypto";

export const SOLANA_DEVNET_CHAIN_ID = 900002;
export const SOLANA_PROGRAM_VERSION = 5;
/** Domain separator of the Solana chain profile: scope = P3(6, programId, vaultPda). */
export const DOMAIN_CHAIN_SOLANA = 6n;

export const PROGRAM_ID = new PublicKey("9W7XnJ79fDexvNY6vkpZwGG8xk1P7j3epbLdAxUrVFP4");
export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Circle devnet USDC
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";

const utf8 = (s: string) => new TextEncoder().encode(s);

export function pda(...seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

export const VAULT_PDA = pda(utf8("siphon-vault-v1"));
export const TREE_PDA = pda(utf8("siphon-tree-v1"));
export const COMPLIANCE_PDA = pda(utf8("siphon-compliance-v1"));

export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

export function le32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = modField(value);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function fromLe(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/** A 32-byte key read big-endian, reduced into the field (assetId, scope inputs). */
export function fieldOfKey(key: PublicKey): bigint {
  let v = 0n;
  for (const b of key.toBytes()) v = (v << 8n) | BigInt(b);
  return v % FIELD;
}

export type SolanaAsset = "SOL" | "USDC";

export const DECIMALS: Record<SolanaAsset, number> = { SOL: 9, USDC: 6 };

/** The mint a note holds for an asset. SOL is deposited native and held as WSOL. */
export function mintFor(asset: string): { asset: SolanaAsset; mint: PublicKey; native: boolean } {
  const a = asset.trim().toUpperCase();
  if (a === "SOL" || a === "WSOL") return { asset: "SOL", mint: WSOL_MINT, native: true };
  if (a === "USDC") return { asset: "USDC", mint: USDC_MINT, native: false };
  throw new Error(`Solana Devnet assets are SOL and USDC (got ${asset})`);
}

export function assetIdOf(asset: string): bigint {
  return fieldOfKey(mintFor(asset).mint);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error("invalid hex");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
}
