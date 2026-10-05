// constants.ts - Environment and configuration constants
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';

// Environment variables
export const SOLANA_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com';
export const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID || '8ndLKjoaUcjDTrL6Bsw3xkyafTV87ZC5XPUgf6AFJP6N');
export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000';
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER || 'devnet';

// Token mints
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT_DEVNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Constants
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const USDC_DECIMALS = 6;

// Scale factor for 2 decimal places (per new_inmp.md)
export const SCALE_FACTOR = 100;

// MXE Account PDA derivation
export function getMXEAccAddress(programId: PublicKey): PublicKey {
  const [mxeAccountPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('mxe_account')],
    programId
  );
  return mxeAccountPDA;
}

// User Ledger PDA derivation
export function getUserLedgerAddress(userPubkey: PublicKey, programId: PublicKey): PublicKey {
  const [ledgerPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_ledger'), userPubkey.toBuffer()],
    programId
  );
  return ledgerPDA;
}

// Order Account PDA derivation
// NOTE: Per new_inmp.md, order account only uses orderId, NOT user pubkey
export function getOrderAccountAddress(orderId: BN, programId: PublicKey): PublicKey {
  const [orderPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('order'),
      orderId.toArrayLike(Buffer, 'le', 8),
    ],
    programId
  );
  return orderPDA;
}

// Orderbook State PDA derivation
export function getOrderbookAddress(programId: PublicKey): PublicKey {
  const [orderbookPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('order_book_state')],
    programId
  );
  return orderbookPDA;
}

// Vault PDA derivation
export function getVaultAddress(mint: PublicKey, programId: PublicKey): PublicKey {
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), mint.toBuffer()],
    programId
  );
  return vaultPDA;
}

// Vault Authority PDA derivation
export function getVaultAuthorityAddress(programId: PublicKey): PublicKey {
  const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_authority')],
    programId
  );
  return vaultAuthorityPDA;
}

