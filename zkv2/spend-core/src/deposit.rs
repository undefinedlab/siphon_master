//! Deposit guards — PROTOCOL.md §2.3, §2.7 (fake amount + label borrow).

use crate::commitment::commitment;
use crate::poseidon::{hash2, hash3, Field, PoseidonError};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DepositError {
    #[error("measured amount must be positive")]
    ZeroAmount,
    #[error("claimed note amount != measured token delta")]
    AmountMismatch,
    #[error("userSalt must be non-zero")]
    ZeroSalt,
    #[error("user-supplied label is forbidden; vault mints from nonce+salt")]
    UserSuppliedLabel,
    #[error("supplied label does not match vault mint (borrow / piggyback)")]
    LabelBorrow,
    #[error("ASP already contains this label")]
    DuplicateAspLabel,
    #[error(transparent)]
    Poseidon(#[from] PoseidonError),
}

/// `label = Poseidon(Poseidon(DOMAIN_VAULT_SCOPE, vaultScopeId, depositNonce), userSalt)`
pub fn mint_label_salted(
    domain_vault_scope: Field,
    vault_scope_id: Field,
    deposit_nonce: u64,
    user_salt: Field,
) -> Result<Field, DepositError> {
    if user_salt == Field::from(0u64) {
        return Err(DepositError::ZeroSalt);
    }
    let stem = hash3(
        domain_vault_scope,
        vault_scope_id,
        Field::from(deposit_nonce),
    )?;
    Ok(hash2(stem, user_salt)?)
}

/// Bind measured tokens to the note. `user_supplied_label` MUST be `None`.
pub fn bind_deposit(
    measured_amount: Field,
    claimed_amount: Field,
    domain_vault_scope: Field,
    vault_scope_id: Field,
    deposit_nonce: u64,
    user_salt: Field,
    asset_id: Field,
    nullifier: Field,
    secret: Field,
    user_supplied_label: Option<Field>,
) -> Result<(Field, Field), DepositError> {
    if let Some(_) = user_supplied_label {
        return Err(DepositError::UserSuppliedLabel);
    }
    if measured_amount == Field::from(0u64) {
        return Err(DepositError::ZeroAmount);
    }
    if claimed_amount != measured_amount {
        return Err(DepositError::AmountMismatch);
    }
    if asset_id == Field::from(0u64) {
        return Err(DepositError::ZeroAmount);
    }
    let label = mint_label_salted(
        domain_vault_scope,
        vault_scope_id,
        deposit_nonce,
        user_salt,
    )?;
    let note = commitment(measured_amount, label, asset_id, nullifier, secret)?;
    Ok((label, note))
}

/// Reject inserting a label that is already an ASP leaf (borrow after Alice was admitted).
pub fn asp_label_available(existing: &[Field], label: Field) -> Result<(), DepositError> {
    if existing.iter().any(|&l| l == label) {
        return Err(DepositError::DuplicateAspLabel);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::Domains;
    use crate::poseidon::field_from_str;

    fn amt(n: u64) -> Field {
        Field::from(n)
    }

    #[test]
    fn ok_deposit_binds_measured_amount() {
        let d = Domains::load();
        let scope = field_from_str("7");
        let salt = field_from_str("99");
        let (label, c) = bind_deposit(
            amt(1000),
            amt(1000),
            d.vault_scope,
            scope,
            1,
            salt,
            amt(1),
            amt(11),
            amt(22),
            None,
        )
        .unwrap();
        assert_ne!(label, Field::from(0u64));
        let (label2, c2) = bind_deposit(
            amt(1000),
            amt(1000),
            d.vault_scope,
            scope,
            1,
            salt,
            amt(1),
            amt(11),
            amt(22),
            None,
        )
        .unwrap();
        assert_eq!(label, label2);
        assert_eq!(c, c2);
    }

    #[test]
    fn fake_amount_fails() {
        let d = Domains::load();
        let err = bind_deposit(
            amt(1000),
            amt(1_000_000),
            d.vault_scope,
            amt(7),
            1,
            amt(99),
            amt(1),
            amt(11),
            amt(22),
            None,
        )
        .unwrap_err();
        assert!(matches!(err, DepositError::AmountMismatch));
    }

    #[test]
    fn zero_salt_fails() {
        let d = Domains::load();
        let err = mint_label_salted(d.vault_scope, amt(7), 1, amt(0)).unwrap_err();
        assert!(matches!(err, DepositError::ZeroSalt));
    }

    #[test]
    fn user_supplied_label_fails() {
        let d = Domains::load();
        let err = bind_deposit(
            amt(1000),
            amt(1000),
            d.vault_scope,
            amt(7),
            1,
            amt(99),
            amt(1),
            amt(11),
            amt(22),
            Some(amt(12345)),
        )
        .unwrap_err();
        assert!(matches!(err, DepositError::UserSuppliedLabel));
    }

    #[test]
    fn different_salt_different_label_cannot_borrow() {
        let d = Domains::load();
        let alice = mint_label_salted(d.vault_scope, amt(7), 1, amt(111)).unwrap();
        let bob_try = mint_label_salted(d.vault_scope, amt(7), 2, amt(111)).unwrap();
        assert_ne!(alice, bob_try);
        asp_label_available(&[alice], alice).unwrap_err();
        asp_label_available(&[alice], bob_try).unwrap();
    }

    #[test]
    fn unsalted_counter_label_differs_from_salted() {
        let d = Domains::load();
        let unsalted = hash3(d.vault_scope, amt(7), amt(1)).unwrap();
        let salted = mint_label_salted(d.vault_scope, amt(7), 1, amt(99)).unwrap();
        assert_ne!(unsalted, salted);
    }
}
