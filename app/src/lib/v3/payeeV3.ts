/**
 * EVM payee encoding (PROTOCOL §1.2 / §A.2).
 *
 *   payeeField = BigUint(zero_pad_12 || address_20) mod FIELD   // = the 20-byte address as a BE int
 *   payeeId    = Poseidon(DOMAIN_PAYEE, payeeField)             // DOMAIN_PAYEE = 4
 *
 * The circuit binds `public[15] == payeeId(rawPayee)`; the vault pays `rawPayee` from calldata after
 * verifying the bind. Mirrors `spend-core::chain_profile::EvmProfile::payee_id` and the test-vector
 * `evmPayeeId`.
 */

import { DOMAIN_PAYEE_SOL_COMPRESS, fieldFromBe32, poseidon2, modField } from "./noteCryptoV3";

export const DOMAIN_PAYEE = 4n;
export { DOMAIN_PAYEE_SOL_COMPRESS };

/** Normalize a 0x address to its BN254 field element (the payeeField). */
export function payeeFieldEvm(rawPayee: string): bigint {
  const addr = (rawPayee || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    throw new Error(`payeeFieldEvm: expected a 20-byte 0x address, got "${rawPayee}"`);
  }
  // 12 high zero bytes then 20 address bytes → the value is just the address as an integer.
  return modField(BigInt(addr));
}

/** payeeId = Poseidon(DOMAIN_PAYEE, payeeField(rawPayee)). */
export async function payeeIdEvm(rawPayee: string): Promise<bigint> {
  return poseidon2(DOMAIN_PAYEE, payeeFieldEvm(rawPayee));
}

/**
 * Solana payee (solana-v1 profile): 32-byte pubkey is compressed into the field first.
 *
 *   payeeField = Poseidon(DOMAIN_PAYEE_SOL_COMPRESS, BE(rawPayee))
 *   payeeId    = Poseidon(DOMAIN_PAYEE, payeeField)
 *
 * Mirrors `siphon-vault-zk::poseidon::solana_payee_id` (the vault re-derives it from calldata).
 */
export async function payeeIdSolana(rawPayee: Uint8Array): Promise<bigint> {
  const payeeField = await poseidon2(DOMAIN_PAYEE_SOL_COMPRESS, fieldFromBe32(rawPayee));
  return poseidon2(DOMAIN_PAYEE, payeeField);
}

/** 20-byte big-endian byte array for the circuit's `rawPayee[20]` input. */
export function rawPayeeBytes(rawPayee: string): number[] {
  const addr = (rawPayee || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    throw new Error(`rawPayeeBytes: expected a 20-byte 0x address, got "${rawPayee}"`);
  }
  const hex = addr.slice(2);
  const out: number[] = [];
  for (let i = 0; i < 20; i++) {
    out.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return out;
}
