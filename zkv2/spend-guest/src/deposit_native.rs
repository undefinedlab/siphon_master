use spend_core::validate_deposit_witness_json;

use crate::deposit_journal::{DepositGuestError, DepositGuestOutput};

/// Native deposit guest — bind measured tokens to commitment (M-deposit POC).
pub fn run_native_deposit_guest(witness_json: &str) -> Result<DepositGuestOutput, DepositGuestError> {
    let public = validate_deposit_witness_json(witness_json)?;
    Ok(DepositGuestOutput::from_public(public))
}

#[cfg(test)]
mod tests {
    use super::*;
    use spend_core::constants::test_vectors_dir;
    use std::fs;

    fn run_fixture(name: &str) -> DepositGuestOutput {
        let path = test_vectors_dir().join(name);
        let json = fs::read_to_string(path).unwrap_or_else(|_| panic!("missing {name}"));
        run_native_deposit_guest(&json).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    fn deposit_guest_ok() {
        let out = run_fixture("deposit-ok.json");
        assert_eq!(out.committed.limbs.len(), 5);
        assert_ne!(out.committed.limbs[1], "0");
    }
}
