use spend_core::validate_witness_json;

use crate::journal::{GuestError, GuestOutput};

/// Native guest: full spend validation + 25-limb journal (M2 default).
pub fn run_native_guest(witness_json: &str) -> Result<GuestOutput, GuestError> {
    let public = validate_witness_json(witness_json)?;
    GuestOutput::from_public(public)
}

#[cfg(test)]
mod tests {
    use super::*;
    use spend_core::constants::test_vectors_dir;
    use std::fs;

    fn run_fixture(name: &str) -> GuestOutput {
        let path = test_vectors_dir().join(name);
        let json = fs::read_to_string(path).unwrap_or_else(|_| panic!("missing {name}"));
        run_native_guest(&json).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    fn guest_withdraw_w3() {
        let out = run_fixture("withdraw-w3-ok.json");
        assert_eq!(out.public.action, 0);
        assert_eq!(out.public.input_count, 3);
        assert_eq!(out.committed.limbs[8], "0");
    }

    #[test]
    fn guest_merge_m2() {
        let out = run_fixture("merge-m2-ok.json");
        assert_eq!(out.public.action, 1);
        assert_eq!(out.committed.limbs[5], "0");
        assert_eq!(out.committed.limbs[6], "0");
    }

    #[test]
    fn guest_merge_m6() {
        let out = run_fixture("merge-m6-ok.json");
        assert_eq!(out.public.action, 1);
        assert_eq!(out.public.input_count, 6);
    }

    #[test]
    fn guest_ragequit_pending() {
        let out = run_fixture("ragequit-pending-witness-ok.json");
        assert_eq!(out.public.action, 4);
        assert_ne!(out.committed.limbs[17], "0");
    }

    #[test]
    fn guest_swap_ok() {
        let out = run_fixture("swap-ok.json");
        assert_eq!(out.public.action, 2);
        assert_ne!(out.committed.limbs[22], "0");
        assert_eq!(out.committed.limbs[15], "0");
    }

    #[test]
    fn guest_split_ok() {
        let out = run_fixture("split-ok.json");
        assert_eq!(out.public.action, 3);
        assert_eq!(out.committed.limbs[7], "0");
        assert_ne!(out.committed.limbs[17], "0");
    }
}
