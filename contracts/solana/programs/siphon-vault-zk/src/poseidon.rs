//! Circom-compatible BN254 Poseidon via Solana `sol_poseidon` (minimal BPF stack).

use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};

pub const DOMAIN_VAULT_SCOPE: u64 = 3;
pub const DOMAIN_PAYEE: u64 = 4;
pub const DOMAIN_CHAIN_SOL: u64 = 6;
pub const DOMAIN_PAYEE_SOL_COMPRESS: u64 = 7;

#[derive(Clone, Copy, Debug)]
pub struct PoseidonError;

fn hash_be2(a: &[u8], b: &[u8]) -> Result<[u8; 32], PoseidonError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b])
        .map(|h| h.to_bytes())
        .map_err(|_| PoseidonError)
}

fn hash_be3(a: &[u8], b: &[u8], c: &[u8]) -> Result<[u8; 32], PoseidonError> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b, c])
        .map(|h| h.to_bytes())
        .map_err(|_| PoseidonError)
}

/// LE limb → BE field bytes for the syscall.
pub fn le_to_be(limb: &[u8; 32]) -> [u8; 32] {
    let mut be = *limb;
    be.reverse();
    be
}

pub fn be_to_le(be: &[u8; 32]) -> [u8; 32] {
    le_to_be(be)
}

pub fn u64_be_field(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..32].copy_from_slice(&v.to_be_bytes());
    out
}

/// BN254 scalar field modulus (big-endian, 32 bytes).
const FIELD_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
    0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00,
    0x00, 0x01,
];

fn be_u256_cmp(a: &[u8; 32], b: &[u8; 32]) -> core::cmp::Ordering {
    for (x, y) in a.iter().zip(b.iter()) {
        match x.cmp(y) {
            core::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    core::cmp::Ordering::Equal
}

fn be_u256_sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let ai = a[i] as i16;
        let bi = b[i] as i16;
        let mut v = ai - bi - borrow;
        if v < 0 {
            v += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[i] = v as u8;
    }
    out
}

/// Raw 32-byte strings (pubkeys, mints) often exceed the BN254 modulus as BE integers.
/// Circom / host `field_from_be_bytes` reduces mod p; `sol_poseidon` rejects unreduced inputs.
pub fn be_field_from_bytes(bytes: &[u8; 32]) -> [u8; 32] {
    let mut x = *bytes;
    while be_u256_cmp(&x, &FIELD_MODULUS_BE) != core::cmp::Ordering::Less {
        x = be_u256_sub(&x, &FIELD_MODULUS_BE);
    }
    x
}

pub fn hash2_be(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    hash_be2(a.as_ref(), b.as_ref())
}

pub fn hash3_be(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    hash_be3(a.as_ref(), b.as_ref(), c.as_ref())
}

pub fn hash2_le(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    let out = hash2_be(&le_to_be(a), &le_to_be(b))?;
    Ok(be_to_le(&out))
}

pub fn hash3_le(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    let out = hash3_be(&le_to_be(a), &le_to_be(b), &le_to_be(c))?;
    Ok(be_to_le(&out))
}

/// `Poseidon3(DOMAIN_CHAIN_SOL, program_id, vault_pda)` → LE limb.
pub fn vault_scope_id(program_id: &[u8; 32], vault_pda: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    let scope = hash3_be(
        &u64_be_field(DOMAIN_CHAIN_SOL),
        &be_field_from_bytes(program_id),
        &be_field_from_bytes(vault_pda),
    )?;
    Ok(be_to_le(&scope))
}

pub fn deposit_label(
    vault_scope_id: &[u8; 32],
    deposit_nonce: u64,
    user_salt: &[u8; 32],
) -> Result<[u8; 32], PoseidonError> {
    let stem = hash3_be(
        &u64_be_field(DOMAIN_VAULT_SCOPE),
        &le_to_be(vault_scope_id),
        &u64_be_field(deposit_nonce),
    )?;
    let label = hash2_be(&stem, &le_to_be(user_salt))?;
    Ok(be_to_le(&label))
}

pub fn deposit_commitment(
    amount: u64,
    label_le: &[u8; 32],
    mint: &[u8; 32],
    precommitment: &[u8; 32],
) -> Result<[u8; 32], PoseidonError> {
    let inner = hash3_be(
        &u64_be_field(amount),
        &le_to_be(label_le),
        &be_field_from_bytes(mint),
    )?;
    let commitment = hash2_be(&inner, &le_to_be(precommitment))?;
    Ok(be_to_le(&commitment))
}

pub fn solana_payee_id(raw_payee: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    let payee_field = hash2_be(
        &u64_be_field(DOMAIN_PAYEE_SOL_COMPRESS),
        &be_field_from_bytes(raw_payee),
    )?;
    let id = hash2_be(&u64_be_field(DOMAIN_PAYEE), &payee_field)?;
    Ok(be_to_le(&id))
}

/// Temporary Devnet bridge: shipped withdraw circuits still bind `PayeeIdEvm(rawPayee[20])`.
/// Use the first 20 bytes of the Solana pubkey as that EVM address until a solana-v1 circuit ships.
pub fn spend_payee_id_compat(raw_payee: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    let mut field = [0u8; 32];
    field[12..32].copy_from_slice(&raw_payee[0..20]);
    let id = hash2_be(&u64_be_field(DOMAIN_PAYEE), &field)?;
    Ok(be_to_le(&id))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vault_scope_devnet_program_id() {
        let program_id: [u8; 32] = hex::decode(
            "d1ee29295d5c4f401fe8d1cba9d6bd7c1068c1e9cb4b05f6c69fec27b807da6a",
        )
        .unwrap()
        .try_into()
        .unwrap();
        let vault: [u8; 32] = hex::decode(
            "dd61e3564a6bcd949ef2850db45221c98bb6d7aece22d0bae888fa2b24713d78",
        )
        .unwrap()
        .try_into()
        .unwrap();
        let scope = vault_scope_id(&program_id, &vault).expect("scope");
        assert_ne!(scope, [0u8; 32]);
    }

    #[test]
    fn hash2_zero_first_empty_tree_level() {
        let z = [0u8; 32];
        let out = hash2_le(&z, &z).expect("hash2_le");
        // circomlibjs: Poseidon(0, 0) → LE limb
        let expect = hex::decode(
            "6448b64684ee39a823d5fe5fd52431dc81e4817bf2c3ea3cab9e239efbf59820",
        )
        .unwrap();
        assert_eq!(out.as_slice(), expect.as_slice());
    }
}
