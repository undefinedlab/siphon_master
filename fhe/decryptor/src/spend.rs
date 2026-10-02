//! Fire-time spend proving — the v3 strategy path.
//!
//! # Why this lives in the enclave
//!
//! A v2 strategy ships a finished Groth16 proof built in the browser at arming time. v3 cannot:
//! the circuit takes `admittedRoot`/`revokedRoot` as public inputs (withdrawal.circom:34-35) and
//! `ComplianceHub.admittedRootIsCurrent` demands an exact match with the live root, which is
//! republished every bus epoch and immediately on any revocation. A proof built at arming is stale
//! long before the trigger fires.
//!
//! So the proof is built when the trigger fires, inside the enclave that already evaluates that
//! trigger. On-chain the result is indistinguishable from a manual withdrawal — same current
//! roots, same anonymity set. Accepting historical roots instead would have made every strategy
//! leg carry its arming timestamp in `pi[3]`, and shrunk its anonymity set to the admitted-set
//! size at that moment.
//!
//! # Trust boundary
//!
//! To build a witness the enclave needs the note secrets. It derives every path itself, but
//! `nullifier`/`secret`/`label` cannot be derived. Those arrive sealed to the enclave's attested
//! x25519 identity and are re-sealed at rest under the KMS storage key, so they survive a CVM
//! restart between arming and firing without ever being written in the clear.
//!
//! Residual risk, stated plainly: an enclave holding these could spend the slice somewhere other
//! than intended. Bounded to one slice — slice notes are minted per leg and exactly sized — but
//! not zero. Removing it entirely means proving compliance in a separate circuit so only the label
//! is needed, which costs a re-run of the trusted setup for every circuit.

use serde::{Deserialize, Serialize};
use spend_core::{
    asp::AspTree,
    poseidon::{field_from_str, field_to_str, Field},
};

/// One input note the leg spends. Mirrors `siphon-app/src/lib/v3/sealLegSecretsV3.ts`.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegInputSecret {
    pub value: String,
    pub nullifier: String,
    pub secret: String,
    pub label: String,
    pub asset_id: String,
    pub state_leaf_index: u64,
}

/// The private half of one leg's witness — the sealed payload.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegSecrets {
    /// PROTOCOL action: 0 withdraw, 1 merge, 2 swap.
    pub action: u8,
    pub inputs: Vec<LegInputSecret>,
    pub out_nullifier: String,
    pub out_secret: String,
    #[serde(default)]
    pub dest_nullifier: String,
    #[serde(default)]
    pub dest_secret: String,
    /// Binding salt for `labelCommit` — COMPLIANCE_CIRCUIT_SPLIT §3.2.
    ///
    /// Sealed by the browser at arming time (armLegV3 samples it and seals it alongside the note
    /// secrets) because limb 24 is public on chain: a salt an observer could read would let them
    /// recompute the commit from a guessed label set and undo the unlinkability it exists for.
    ///
    /// This struct predated the split and had no field for it, so serde silently dropped the key
    /// and the witness reached `prove-witness.cjs` without it. Every enclave-armed leg then failed
    /// at FIRE time with "labelSalt required and MUST be non-zero" — after the trigger evaluated
    /// TRUE, the arming fee was spent and the slice notes were minted.
    #[serde(default)]
    pub label_salt: String,
}


/// Redacted `Debug`. These structs hold spendable material; a stray `{:?}` in a log line or an
/// error path would put note secrets in the host's journal, which is exactly what sealing them to
/// the enclave was meant to prevent. Derive would have printed every field.
impl std::fmt::Debug for LegInputSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LegInputSecret")
            .field("stateLeafIndex", &self.state_leaf_index)
            .field("assetId", &self.asset_id)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for LegSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LegSecrets")
            .field("action", &self.action)
            .field("inputs", &self.inputs.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SpendError {
    #[error("leg secrets malformed: {0}")]
    Malformed(String),
    #[error("asp sync did not reproduce the served admitted root — truncated or reordered")]
    AspRootMismatch,
    #[error("asp sync did not reproduce the served revoked root")]
    RevokedRootMismatch,
    #[error("label {0} is not in the admitted set")]
    NotAdmitted(String),
    #[error("label {0} is revoked — this spend must not be proved")]
    Revoked(String),
    #[error("asp snapshot is unsigned — refusing to attest freshness against it")]
    SnapshotUnsigned,
    #[error("asp snapshot is {age}s old, max {max_age}s")]
    SnapshotStale { age: u64, max_age: u64 },
    #[error("asp snapshot issuedAt {issued_at} is ahead of enclave clock {now}")]
    SnapshotFromTheFuture { issued_at: u64, now: u64 },
    #[error("asp snapshot signature: {0}")]
    SnapshotBadSignature(String),
    #[error("asp snapshot signed by {got}, expected postman {want}")]
    SnapshotWrongSigner { got: String, want: String },
}

/// Exactly what `GET /set/leaves` returns.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AspLeaves {
    pub admitted_root: String,
    pub revoked_root: String,
    /// Index i IS leaf index i. Order is the tree — never sort this.
    pub admitted_labels: Vec<String>,
    pub revoked_labels: Vec<String>,
    /// Unix seconds the ASP signed this snapshot at. `None` means unsigned, which is refused.
    pub issued_at: Option<u64>,
    /// `0x` + 65 bytes of r‖s‖v from the postman key over [`snapshot_digest`].
    pub snapshot_sig: Option<String>,
    // NOTE: the response also carries `snapshotChainId` / `snapshotHub`, and they are deliberately
    // NOT deserialized. The enclave rebuilds the digest from its OWN configured chain and hub;
    // taking them from the response would let a snapshot signed for another deployment verify
    // against itself, which is exactly the replay the binding exists to stop.
}

/// Tolerated forward clock skew between the ASP and the enclave. Small on purpose: it widens the
/// replay window by exactly this much, so it buys clock tolerance and nothing else.
pub const MAX_SNAPSHOT_SKEW_SECS: u64 = 30;

/// What the enclave requires of an ASP snapshot before it will attest against it.
///
/// Every field is enclave-side configuration. None of it is ever read from the ASP's response —
/// a policy taken from the thing being checked checks nothing.
#[derive(Debug, Clone)]
pub struct SnapshotPolicy {
    pub chain_id: u64,
    /// The `ComplianceHub` this enclave attests for.
    pub hub: [u8; 20],
    /// `ComplianceHub.postman` — immutable on-chain, so this is a constant per deployment.
    pub postman: [u8; 20],
    /// How old a snapshot may be. Should be well under `ComplianceHub.attestationMaxAge`: the two
    /// compose, and the sum is the true revocation-evasion window.
    pub max_age_secs: u64,
}

/// `keccak256(abi.encode(SNAPSHOT_TYPEHASH, chainId, hub, admittedRoot, revokedRoot, issuedAt))`.
///
/// Byte-identical twin of `siphon-asp-v2/snapshot_sig.py::snapshot_digest`, pinned in both
/// directions by a shared vector (see `snapshot_digest_matches_the_python_vector` below and
/// `test_digest_matches_pinned_vector` there). A silent divergence would not fail either test
/// suite — it would fail at fire time as "signed by the wrong signer", hours after arming.
pub fn snapshot_digest(
    chain_id: u64,
    hub: &[u8; 20],
    admitted_root: &str,
    revoked_root: &str,
    issued_at: u64,
) -> Result<[u8; 32], SpendError> {
    use sha3::{Digest, Keccak256};

    // One unbroken literal on purpose: a `\`-continuation would silently change the preimage, and
    // the only symptom would be "wrong signer" at fire time.
    const TYPE_STRING: &[u8] = b"SiphonAspSnapshot(uint256 chainId,address hub,uint256 admittedRoot,uint256 revokedRoot,uint256 issuedAt)";
    let type_hash: [u8; 32] = {
        let mut h = Keccak256::new();
        h.update(TYPE_STRING);
        h.finalize().into()
    };

    let mut buf = Vec::with_capacity(32 * 6);
    buf.extend_from_slice(&type_hash);
    buf.extend_from_slice(&u256_be(chain_id));
    let mut hub_word = [0u8; 32];
    hub_word[12..].copy_from_slice(hub);
    buf.extend_from_slice(&hub_word);
    buf.extend_from_slice(&u256_from_dec(admitted_root)?);
    buf.extend_from_slice(&u256_from_dec(revoked_root)?);
    buf.extend_from_slice(&u256_be(issued_at));

    let mut h = Keccak256::new();
    h.update(&buf);
    Ok(h.finalize().into())
}

fn u256_be(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

/// Decimal field element -> 32-byte big-endian, left-padded. Roots are < p < 2^254, so they fit.
fn u256_from_dec(s: &str) -> Result<[u8; 32], SpendError> {
    let n = s
        .parse::<num_bigint_dig::BigUint>()
        .map_err(|e| SpendError::Malformed(format!("root {s:?} is not decimal: {e}")))?;
    let be = n.to_bytes_be();
    if be.len() > 32 {
        return Err(SpendError::Malformed(format!("root {s:?} exceeds 32 bytes")));
    }
    let mut w = [0u8; 32];
    w[32 - be.len()..].copy_from_slice(&be);
    Ok(w)
}

/// An ASP state the enclave has independently rebuilt and checked.
///
/// Constructing one is the only way to get a path out of this module, so a path can never be
/// derived from an unverified sync. A truncated or reordered `/set/leaves` response still yields a
/// well-formed path that fails the circuit's `AspInclusion` assert on-chain — which reads as a
/// proving bug, not a sync bug. The root check here is what turns that into a local error.
#[derive(Debug)]
pub struct AspSnapshot {
    tree: AspTree,
    admitted_root: Field,
    revoked_root: Field,
    revoked: Vec<Field>,
}

impl AspSnapshot {
    /// Rebuild both trees from the served leaves and verify they reproduce the served roots.
    pub fn rebuild(leaves: &AspLeaves) -> Result<Self, SpendError> {
        let mut tree = AspTree::new();
        for (i, label) in leaves.admitted_labels.iter().enumerate() {
            tree.insert(field_from_str(label))
                .map_err(|e| SpendError::Malformed(format!("admitted label {i}: {e}")))?;
        }

        let served_admitted = field_from_str(&leaves.admitted_root);
        if tree.root() != served_admitted {
            return Err(SpendError::AspRootMismatch);
        }

        let revoked: Vec<Field> = leaves.revoked_labels.iter().map(|s| field_from_str(s)).collect();

        Ok(Self {
            tree,
            admitted_root: served_admitted,
            revoked_root: field_from_str(&leaves.revoked_root),
            revoked,
        })
    }

    /// Refuse a snapshot that is not a fresh, postman-signed statement for THIS deployment.
    ///
    /// This replaced a check against roots supplied by the caller of `/spend/prove`. That check was
    /// circular — the caller simply echoed the roots this same response had just served, so it
    /// proved "the caller agrees with the ASP" and never "the ASP is current". It was load-bearing
    /// only because `spend()` re-checked the root on-chain and a stale snapshot merely reverted.
    /// `spendAttested` removes that safety net: the hub accepts ANY once-published revoked root,
    /// so a stale-but-published snapshot would let a revoked note spend.
    ///
    /// The postman signs because it is already the on-chain revocation authority — the only address
    /// `ComplianceHub.updateRevokedRoot` accepts. Independence from it would buy nothing (a
    /// malicious postman can just decline to revoke). What the enclave needs independence from is
    /// TIME, and `issued_at` under a signature gives exactly that.
    pub fn verify_snapshot(
        &self,
        leaves: &AspLeaves,
        policy: &SnapshotPolicy,
        now: u64,
    ) -> Result<(), SpendError> {
        let issued_at = leaves.issued_at.ok_or(SpendError::SnapshotUnsigned)?;
        let sig_hex = leaves.snapshot_sig.as_deref().ok_or(SpendError::SnapshotUnsigned)?;

        // Age first: a replayed snapshot carries a perfectly valid signature, so the timestamp is
        // the only thing that distinguishes it. Allow a small forward skew — the enclave clock and
        // the ASP clock are independent, and rejecting a snapshot for being milliseconds "early"
        // would strand legs for no security gain.
        if issued_at > now + MAX_SNAPSHOT_SKEW_SECS {
            return Err(SpendError::SnapshotFromTheFuture { issued_at, now });
        }
        let age = now.saturating_sub(issued_at);
        if age > policy.max_age_secs {
            return Err(SpendError::SnapshotStale { age, max_age: policy.max_age_secs });
        }

        let raw = hex::decode(sig_hex.trim_start_matches("0x"))
            .map_err(|e| SpendError::SnapshotBadSignature(format!("not hex: {e}")))?;
        let sig: [u8; 65] = raw
            .try_into()
            .map_err(|_| SpendError::SnapshotBadSignature("must be 65 bytes".into()))?;

        // Digest is built from the enclave's OWN chain/hub and from the roots it independently
        // rebuilt in `rebuild()` — never from anything the response merely asserts. That is what
        // ties the signature to this deployment and to these exact leaves.
        let digest = snapshot_digest(
            policy.chain_id,
            &policy.hub,
            &field_to_str(&self.admitted_root),
            &field_to_str(&self.revoked_root),
            issued_at,
        )?;

        let signer = crate::attester::recover_signer(&digest, &sig)
            .map_err(|e| SpendError::SnapshotBadSignature(e.to_string()))?;
        if signer != policy.postman {
            return Err(SpendError::SnapshotWrongSigner {
                got: format!("0x{}", hex::encode(signer)),
                want: format!("0x{}", hex::encode(policy.postman)),
            });
        }
        Ok(())
    }

    pub fn admitted_root(&self) -> String {
        field_to_str(&self.admitted_root)
    }

    pub fn revoked_root(&self) -> String {
        field_to_str(&self.revoked_root)
    }

    pub fn is_revoked(&self, label: &str) -> bool {
        let l = field_from_str(label);
        self.revoked.iter().any(|r| *r == l)
    }

    /// Inclusion path for `label` against the CURRENT admitted root, derived locally.
    ///
    /// Deliberately never queries the ASP for a specific label. A per-label lookup at fire time
    /// correlates in real time with the spend that lands on-chain moments later, handing the ASP a
    /// deposit -> spend link it does not otherwise have. Syncing the whole set removes the query.
    pub fn admitted_path(&self, label: &str) -> Result<(u64, Vec<String>, Vec<u8>), SpendError> {
        // Revocation is checked before inclusion: a revoked label is still IN the admitted tree
        // (separate trees), so inclusion alone would happily produce a path for a banned note.
        if self.is_revoked(label) {
            return Err(SpendError::Revoked(label.to_string()));
        }
        let index = self
            .tree
            .index_of(field_from_str(label))
            .ok_or_else(|| SpendError::NotAdmitted(label.to_string()))?;
        let path = self
            .tree
            .path_for_index(index)
            .map_err(|e| SpendError::Malformed(format!("admitted path: {e}")))?;
        Ok((
            index,
            path.path_elements.iter().map(field_to_str).collect(),
            path.path_indices,
        ))
    }
}

/// Validate a sealed payload the moment it is unsealed.
///
/// Mirrors `assertLegSecretsComplete` in the browser. Both sides check because the browser's copy
/// is advisory — anything reaching this function has crossed a trust boundary, and a malformed leg
/// discovered at fire time is a strategy that silently never executes after the fee is paid.
pub fn validate_secrets(s: &LegSecrets) -> Result<(), SpendError> {
    let bad = |m: String| Err(SpendError::Malformed(m));

    if !matches!(s.action, 0 | 1 | 2) {
        return bad(format!("action must be 0, 1 or 2, got {}", s.action));
    }
    if s.inputs.is_empty() {
        return bad("at least one input note is required".into());
    }
    if s.action == 1 && s.inputs.len() < 2 {
        return bad(format!("merge requires >= 2 inputs, got {}", s.inputs.len()));
    }
    if s.inputs.len() > 6 {
        return bad(format!("at most 6 inputs (no verifier beyond arity 6), got {}", s.inputs.len()));
    }

    let decimal = |v: &str| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
    for (i, inp) in s.inputs.iter().enumerate() {
        for (name, v) in [
            ("value", &inp.value),
            ("nullifier", &inp.nullifier),
            ("secret", &inp.secret),
            ("label", &inp.label),
            ("assetId", &inp.asset_id),
        ] {
            if !decimal(v) {
                return bad(format!("inputs[{i}].{name} must be a decimal string"));
            }
        }
    }

    // The same note twice burns one nullifier and silently drops the other's value.
    for i in 0..s.inputs.len() {
        for j in (i + 1)..s.inputs.len() {
            if s.inputs[i].nullifier == s.inputs[j].nullifier {
                return bad("duplicate input nullifier — a note cannot be spent twice in one leg".into());
            }
        }
    }

    // D1 notes are asset-bound; the circuit has one assetId per spend.
    if let Some(first) = s.inputs.first() {
        if s.inputs.iter().any(|i| i.asset_id != first.asset_id) {
            return bad("all inputs must share one assetId — D1 notes are asset-bound".into());
        }
    }

    for (name, v) in [("outNullifier", &s.out_nullifier), ("outSecret", &s.out_secret)] {
        if !decimal(v) {
            return bad(format!("{name} must be a decimal string"));
        }
    }
    if s.action == 2 {
        for (name, v) in [("destNullifier", &s.dest_nullifier), ("destSecret", &s.dest_secret)] {
            if !decimal(v) {
                return bad(format!("swap requires {name} (binds outputPrecommitment)"));
            }
        }
    }
    Ok(())
}

/// Mirror fresh roots into BOTH representations of a witness.
///
/// `witnessToCircomInput` builds `publicInputs` from `expectedPublic` ONLY — the scalar
/// `stateRoot`/`admittedRoot`/`revokedRoot` fields beside it are never read. Updating one and not
/// the other produces a proof that binds the STALE root, verifies locally, and reverts on-chain
/// after the trade has fired. `prove-witness.cjs` refuses a witness whose two representations
/// disagree; this is the function that keeps them in step.
pub fn apply_fresh_roots(
    witness: &mut serde_json::Value,
    state_root: &str,
    admitted_root: &str,
    revoked_root: &str,
) -> Result<(), SpendError> {
    let obj = witness
        .as_object_mut()
        .ok_or_else(|| SpendError::Malformed("witness must be a JSON object".into()))?;

    // PublicInputs.sol: stateRoot => pi[2], admittedRoot => pi[3], revokedRoot => pi[4].
    for (field, slot, value) in [
        ("stateRoot", 2usize, state_root),
        ("admittedRoot", 3, admitted_root),
        ("revokedRoot", 4, revoked_root),
    ] {
        obj.insert(field.into(), serde_json::Value::String(value.into()));

        let pub_arr = obj
            .get_mut("expectedPublic")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| SpendError::Malformed("witness.expectedPublic must be an array".into()))?;
        if pub_arr.len() != crate::attester::PUBLIC_WIDTH {
            return Err(SpendError::Malformed(format!(
                "witness.expectedPublic must be {} limbs (PROTOCOL §4), got {}",
                crate::attester::PUBLIC_WIDTH,
                pub_arr.len()
            )));
        }
        pub_arr[slot] = serde_json::Value::String(value.into());
    }

    // COMPLIANCE_CIRCUIT_SPLIT §6.2: the compliance public vector is a PROJECTION of the spend
    // publics, so a copy carried in the witness is a third representation of the roots we just
    // moved — the exact drift this function exists to prevent. Drop it and let
    // `prove-witness.cjs` re-derive from the refreshed `expectedPublic`.
    obj.remove("expectedCompliancePublic");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(nullifier: &str, leaf: u64) -> LegInputSecret {
        LegInputSecret {
            value: "1000000".into(),
            nullifier: nullifier.into(),
            secret: "222222".into(),
            label: "123456789".into(),
            asset_id: "1461501637330902918203684832716283019655932542975".into(),
            state_leaf_index: leaf,
        }
    }

    fn swap() -> LegSecrets {
        LegSecrets {
            action: 2,
            inputs: vec![input("111111", 0)],
            out_nullifier: "333333".into(),
            out_secret: "444444".into(),
            dest_nullifier: "555555".into(),
            dest_secret: "666666".into(),
                label_salt: "12345".into(),
        }
    }

    // ------------------------------------------------------------------ validation

    #[test]
    fn a_well_formed_leg_is_accepted() {
        validate_secrets(&swap()).unwrap();
    }

    #[test]
    fn arity_without_a_verifier_is_refused() {
        let too_many = LegSecrets {
            inputs: (0..7).map(|i| input(&format!("{i}"), i)).collect(),
            ..swap()
        };
        assert!(matches!(validate_secrets(&too_many), Err(SpendError::Malformed(_))));

        let lone_merge = LegSecrets { action: 1, ..swap() };
        assert!(matches!(validate_secrets(&lone_merge), Err(SpendError::Malformed(_))));

        let unknown = LegSecrets { action: 9, ..swap() };
        assert!(matches!(validate_secrets(&unknown), Err(SpendError::Malformed(_))));
    }

    #[test]
    fn the_same_note_cannot_be_spent_twice_in_one_leg() {
        let dup = LegSecrets {
            action: 1,
            inputs: vec![input("111111", 0), input("111111", 1)],
            ..swap()
        };
        assert!(matches!(validate_secrets(&dup), Err(SpendError::Malformed(_))));
    }

    #[test]
    fn mixed_assets_are_refused() {
        let mut mixed = LegSecrets { action: 1, inputs: vec![input("1", 0), input("2", 1)], ..swap() };
        mixed.inputs[1].asset_id = "999".into();
        assert!(matches!(validate_secrets(&mixed), Err(SpendError::Malformed(_))));
    }

    #[test]
    fn non_decimal_fields_are_refused() {
        let mut hexed = swap();
        hexed.inputs[0].secret = "0xdeadbeef".into();
        assert!(matches!(validate_secrets(&hexed), Err(SpendError::Malformed(_))));

        let mut no_dest = swap();
        no_dest.dest_secret = String::new();
        assert!(matches!(validate_secrets(&no_dest), Err(SpendError::Malformed(_))));
    }

    // ------------------------------------------------------------------ asp snapshot

    fn leaves_for(labels: &[u64], revoked: &[u64]) -> AspLeaves {
        let mut tree = AspTree::new();
        for l in labels {
            tree.insert(Field::from(*l)).unwrap();
        }
        AspLeaves {
            admitted_root: field_to_str(&tree.root()),
            // Revoked-root reconstruction is the SMT's job; these tests exercise the admitted side
            // and membership, so the served value is taken as given.
            revoked_root: "42".into(),
            admitted_labels: labels.iter().map(|l| l.to_string()).collect(),
            revoked_labels: revoked.iter().map(|l| l.to_string()).collect(),
            issued_at: None,
            snapshot_sig: None,
        }
    }

    #[test]
    fn every_admitted_label_gets_a_current_root_path() {
        let labels: Vec<u64> = (1000..1017).collect();
        let snap = AspSnapshot::rebuild(&leaves_for(&labels, &[])).unwrap();

        for (i, l) in labels.iter().enumerate() {
            let (index, elements, indices) = snap.admitted_path(&l.to_string()).unwrap();
            assert_eq!(index, i as u64);
            assert_eq!(elements.len(), 32);
            assert_eq!(indices.len(), 32);
        }
    }

    #[test]
    fn a_truncated_sync_is_rejected_not_silently_used() {
        let mut leaves = leaves_for(&[1, 2, 3, 4], &[]);
        leaves.admitted_labels.pop();
        assert_eq!(AspSnapshot::rebuild(&leaves).unwrap_err(), SpendError::AspRootMismatch);
    }

    #[test]
    fn a_reordered_sync_is_rejected() {
        // Same members, different order: order IS the tree.
        let mut leaves = leaves_for(&[900, 100, 500, 300], &[]);
        leaves.admitted_labels.sort();
        assert_eq!(AspSnapshot::rebuild(&leaves).unwrap_err(), SpendError::AspRootMismatch);
    }

    #[test]
    fn a_stranger_label_gets_no_path() {
        let snap = AspSnapshot::rebuild(&leaves_for(&[1, 2, 3], &[])).unwrap();
        assert_eq!(
            snap.admitted_path("99").unwrap_err(),
            SpendError::NotAdmitted("99".into()),
        );
    }

    #[test]
    fn a_revoked_label_gets_no_path_even_though_it_is_still_admitted() {
        // The trees are separate — revocation does not remove the label from the admitted tree, so
        // an inclusion-only check would happily produce a path for a banned note.
        let snap = AspSnapshot::rebuild(&leaves_for(&[1, 2, 3], &[2])).unwrap();
        assert!(snap.admitted_path("1").is_ok());
        assert_eq!(snap.admitted_path("2").unwrap_err(), SpendError::Revoked("2".into()));
    }

    // ------------------------------------------------------------------ snapshot freshness
    //
    // The property: the enclave can tell a CURRENT revoked set from a REPLAYED one, using only its
    // own configuration and the ASP's signature — never anything its caller supplies. The check
    // this replaced compared the snapshot against roots the caller passed in, which the caller
    // could read straight off the same response. That was circular, and `spendAttested` (which
    // accepts any once-published revoked root) is what turned the circularity into a live hole.

    /// Throwaway test key. Same bytes as `tests/test_snapshot_sig.py::POSTMAN_KEY`, so the vector
    /// below is genuinely cross-language and not two copies of one implementation.
    const TEST_KEY: [u8; 32] = [0x11; 32];
    const VECTOR_HUB: [u8; 20] = [
        0x66, 0x71, 0x66, 0xfe, 0x7b, 0xfb, 0x51, 0xfd, 0x2b, 0x3b, 0x92, 0x81, 0xaf, 0x0a, 0x9d,
        0xfe, 0xb5, 0x84, 0x52, 0x88,
    ];

    fn test_signing_key() -> k256::ecdsa::SigningKey {
        k256::ecdsa::SigningKey::from_slice(&TEST_KEY).unwrap()
    }

    fn test_policy() -> SnapshotPolicy {
        SnapshotPolicy {
            chain_id: 11155111,
            hub: VECTOR_HUB,
            postman: crate::attester::address_from_verifying_key(test_signing_key().verifying_key()),
            max_age_secs: 120,
        }
    }

    /// Sign `leaves` exactly as the ASP would, and stamp it.
    fn sign_leaves(
        leaves: &mut AspLeaves,
        policy: &SnapshotPolicy,
        issued_at: u64,
        key: &k256::ecdsa::SigningKey,
    ) {
        let digest = snapshot_digest(
            policy.chain_id,
            &policy.hub,
            &leaves.admitted_root,
            &leaves.revoked_root,
            issued_at,
        )
        .unwrap();
        let sig = crate::attester::sign_digest(key, &digest).unwrap();
        leaves.issued_at = Some(issued_at);
        leaves.snapshot_sig = Some(format!("0x{}", hex::encode(sig)));
    }

    const NOW: u64 = 1_756_300_000;

    #[test]
    fn snapshot_digest_matches_the_python_vector() {
        // Pinned against siphon-asp-v2/tests/test_snapshot_sig.py::test_digest_matches_pinned_vector.
        // If these ever diverge the failure does NOT surface here or there — it surfaces inside the
        // enclave at fire time as "wrong signer", which reads as a key problem, not an encoding one.
        let digest = snapshot_digest(11155111, &VECTOR_HUB, "1", "2", 1_756_300_000).unwrap();
        assert_eq!(
            hex::encode(digest),
            "840c1778b80e883faf9ac559b11ff4b42a70f4a1b6f61d3952b9e0724c16cad4"
        );
    }

    #[test]
    fn signature_from_the_python_side_verifies_here() {
        // The exact bytes emitted by eth_account in the Python test. Proves the two sign/recover
        // stacks agree, not merely that each is self-consistent.
        let sig_hex = "2dc735a1704af397b94bc2bfca07621898987dee350f71bf768e25477743851776901f28cd58ddcb193977765efd8ec7c4c34049e631770b184f6e5e2001b1fa1b";
        let sig: [u8; 65] = hex::decode(sig_hex).unwrap().try_into().unwrap();
        let digest = snapshot_digest(11155111, &VECTOR_HUB, "1", "2", 1_756_300_000).unwrap();
        assert_eq!(
            crate::attester::recover_signer(&digest, &sig).unwrap(),
            test_policy().postman
        );
    }

    #[test]
    fn a_freshly_signed_snapshot_is_accepted() {
        let mut leaves = leaves_for(&[1, 2, 3], &[]);
        let policy = test_policy();
        sign_leaves(&mut leaves, &policy, NOW, &test_signing_key());
        let snap = AspSnapshot::rebuild(&leaves).unwrap();
        snap.verify_snapshot(&leaves, &policy, NOW).unwrap();
    }

    #[test]
    fn an_unsigned_snapshot_is_refused() {
        // The old code path: no signature at all. Must fail closed rather than fall back.
        let leaves = leaves_for(&[1, 2, 3], &[]);
        let snap = AspSnapshot::rebuild(&leaves).unwrap();
        assert_eq!(
            snap.verify_snapshot(&leaves, &test_policy(), NOW),
            Err(SpendError::SnapshotUnsigned)
        );
    }

    #[test]
    fn a_replayed_snapshot_is_refused_once_it_ages_out() {
        // THE attack. The signature stays valid forever; only issuedAt distinguishes a snapshot
        // captured before a revocation from one taken after it.
        let mut leaves = leaves_for(&[1, 2, 3], &[]);
        let policy = test_policy();
        sign_leaves(&mut leaves, &policy, NOW, &test_signing_key());
        let snap = AspSnapshot::rebuild(&leaves).unwrap();

        snap.verify_snapshot(&leaves, &policy, NOW + policy.max_age_secs).unwrap();
        assert!(matches!(
            snap.verify_snapshot(&leaves, &policy, NOW + policy.max_age_secs + 1),
            Err(SpendError::SnapshotStale { .. })
        ));
    }

    #[test]
    fn a_snapshot_stamped_in_the_future_is_refused_beyond_the_skew_allowance() {
        let mut leaves = leaves_for(&[1, 2, 3], &[]);
        let policy = test_policy();
        sign_leaves(&mut leaves, &policy, NOW + MAX_SNAPSHOT_SKEW_SECS, &test_signing_key());
        let snap = AspSnapshot::rebuild(&leaves).unwrap();
        snap.verify_snapshot(&leaves, &policy, NOW).unwrap();

        let mut far = leaves_for(&[1, 2, 3], &[]);
        sign_leaves(&mut far, &policy, NOW + MAX_SNAPSHOT_SKEW_SECS + 1, &test_signing_key());
        let snap = AspSnapshot::rebuild(&far).unwrap();
        assert!(matches!(
            snap.verify_snapshot(&far, &policy, NOW),
            Err(SpendError::SnapshotFromTheFuture { .. })
        ));
    }

    #[test]
    fn a_snapshot_signed_by_anyone_but_the_postman_is_refused() {
        let mut leaves = leaves_for(&[1, 2, 3], &[]);
        let policy = test_policy();
        let impostor = k256::ecdsa::SigningKey::from_slice(&[0x22; 32]).unwrap();
        sign_leaves(&mut leaves, &policy, NOW, &impostor);
        let snap = AspSnapshot::rebuild(&leaves).unwrap();
        assert!(matches!(
            snap.verify_snapshot(&leaves, &policy, NOW),
            Err(SpendError::SnapshotWrongSigner { .. })
        ));
    }

    #[test]
    fn a_snapshot_signed_for_another_deployment_is_refused() {
        // Same postman, same leaves, different chain / hub. Without this binding a Sepolia snapshot
        // would authorise a Base spend.
        let policy = test_policy();
        for wrong in [
            SnapshotPolicy { chain_id: 8453, ..policy.clone() },
            SnapshotPolicy { hub: [0xAB; 20], ..policy.clone() },
        ] {
            let mut leaves = leaves_for(&[1, 2, 3], &[]);
            sign_leaves(&mut leaves, &wrong, NOW, &test_signing_key());
            let snap = AspSnapshot::rebuild(&leaves).unwrap();
            assert!(
                matches!(
                    snap.verify_snapshot(&leaves, &policy, NOW),
                    Err(SpendError::SnapshotWrongSigner { .. })
                ),
                "a snapshot bound to another deployment must not verify here"
            );
        }
    }

    #[test]
    fn tampering_with_the_revoked_root_after_signing_is_refused() {
        // The concrete attack: serve genuine leaves, swap in an older revoked root so a revoked
        // label looks absent. The digest covers the roots the enclave REBUILT, so this cannot pass.
        let mut leaves = leaves_for(&[1, 2, 3], &[]);
        let policy = test_policy();
        sign_leaves(&mut leaves, &policy, NOW, &test_signing_key());
        leaves.revoked_root = "999".into();
        let snap = AspSnapshot::rebuild(&leaves).unwrap();
        assert!(matches!(
            snap.verify_snapshot(&leaves, &policy, NOW),
            Err(SpendError::SnapshotWrongSigner { .. })
        ));
    }

    #[test]
    fn a_malformed_signature_is_refused_rather_than_panicking() {
        let mut leaves = leaves_for(&[1, 2, 3], &[]);
        let policy = test_policy();
        sign_leaves(&mut leaves, &policy, NOW, &test_signing_key());
        let snap = AspSnapshot::rebuild(&leaves).unwrap();

        for bad in ["0x", "0xzz", &"0x".to_string().repeat(1), "0xdeadbeef"] {
            let mut l = leaves.clone();
            l.snapshot_sig = Some(bad.to_string());
            assert!(matches!(
                snap.verify_snapshot(&l, &policy, NOW),
                Err(SpendError::SnapshotBadSignature(_))
            ));
        }
    }

    #[test]
    fn the_high_s_twin_of_a_valid_signature_is_refused() {
        // secp256k1 signatures are malleable: (r, s) and (r, n-s) both verify. Accepting both would
        // mean one authorisation exists in two encodings.
        let mut leaves = leaves_for(&[1, 2, 3], &[]);
        let policy = test_policy();
        sign_leaves(&mut leaves, &policy, NOW, &test_signing_key());
        let mut raw: [u8; 65] = hex::decode(
            leaves.snapshot_sig.as_ref().unwrap().trim_start_matches("0x"),
        )
        .unwrap()
        .try_into()
        .unwrap();

        // n - s, and flip the recovery bit to match.
        let n = num_bigint_dig::BigUint::parse_bytes(
            b"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
            16,
        )
        .unwrap();
        let s = num_bigint_dig::BigUint::from_bytes_be(&raw[32..64]);
        let flipped = (n - s).to_bytes_be();
        raw[32..64].copy_from_slice(&[vec![0u8; 32 - flipped.len()], flipped].concat());
        raw[64] = if raw[64] == 27 { 28 } else { 27 };

        leaves.snapshot_sig = Some(format!("0x{}", hex::encode(raw)));
        let snap = AspSnapshot::rebuild(&leaves).unwrap();
        assert!(matches!(
            snap.verify_snapshot(&leaves, &policy, NOW),
            Err(SpendError::SnapshotBadSignature(_))
        ));
    }

    // ------------------------------------------------------------------ the stale-root trap

    fn witness_json() -> serde_json::Value {
        let mut pi: Vec<serde_json::Value> = (0..crate::attester::PUBLIC_WIDTH)
            .map(|_| serde_json::Value::String("0".into()))
            .collect();
        pi[2] = serde_json::Value::String("old-state".into());
        pi[3] = serde_json::Value::String("old-admitted".into());
        pi[4] = serde_json::Value::String("old-revoked".into());
        serde_json::json!({
            "stateRoot": "old-state",
            "admittedRoot": "old-admitted",
            "revokedRoot": "old-revoked",
            "expectedPublic": pi,
        })
    }

    #[test]
    fn fresh_roots_land_in_both_representations() {
        let mut w = witness_json();
        apply_fresh_roots(&mut w, "s1", "a1", "r1").unwrap();

        // The scalar fields are what a human reads; expectedPublic is what actually binds.
        assert_eq!(w["stateRoot"], "s1");
        assert_eq!(w["admittedRoot"], "a1");
        assert_eq!(w["revokedRoot"], "r1");
        assert_eq!(w["expectedPublic"][2], "s1");
        assert_eq!(w["expectedPublic"][3], "a1");
        assert_eq!(w["expectedPublic"][4], "r1");
    }

    #[test]
    fn updating_only_the_scalar_field_would_leave_the_stale_root_bound() {
        // Demonstrates why apply_fresh_roots exists: the naive update binds the OLD root, because
        // publicInputs is built from expectedPublic alone.
        let mut w = witness_json();
        w["admittedRoot"] = serde_json::Value::String("a1".into());
        assert_eq!(w["expectedPublic"][3], "old-admitted");

        apply_fresh_roots(&mut w, "s1", "a1", "r1").unwrap();
        assert_eq!(w["expectedPublic"][3], "a1");
    }

    #[test]
    fn a_malformed_public_encoding_is_refused() {
        let mut short = serde_json::json!({ "expectedPublic": ["0", "0"] });
        assert!(matches!(
            apply_fresh_roots(&mut short, "s", "a", "r"),
            Err(SpendError::Malformed(_))
        ));

        let mut missing = serde_json::json!({});
        assert!(matches!(
            apply_fresh_roots(&mut missing, "s", "a", "r"),
            Err(SpendError::Malformed(_))
        ));
    }

    // ------------------------------------------------------------------ sealed payload shape

    #[test]
    fn the_sealed_payload_round_trips_the_browser_json() {
        // Field names must match sealLegSecretsV3.ts exactly, or unsealing yields a serde error at
        // fire time — hours after arming, with the fee already spent.
        let json = serde_json::json!({
            "action": 2,
            "inputs": [{
                "value": "1000000",
                "nullifier": "111111",
                "secret": "222222",
                "label": "123456789",
                "assetId": "1461501637330902918203684832716283019655932542975",
                "stateLeafIndex": 0
            }],
            "outNullifier": "333333",
            "outSecret": "444444",
            "destNullifier": "555555",
            "destSecret": "666666",
            // armLegV3.ts:154 seals this. The struct had no field for it, so serde dropped the key
            // silently and every enclave-armed leg died at fire time on
            // "labelSalt required and MUST be non-zero". The fixture omitted it too, so the suite
            // agreed with the bug.
            "labelSalt": "12345"
        });
        let parsed: LegSecrets = serde_json::from_value(json).expect("browser JSON must deserialize");
        assert_eq!(parsed, swap());
        validate_secrets(&parsed).unwrap();
    }

}

// ===========================================================================================
// Storage + routes
// ===========================================================================================

/// One armed leg, awaiting its trigger. Held in enclave memory and mirrored to the encrypted
/// volume under the KMS storage-seal key, because arming and firing can be hours apart and a CVM
/// restart in between must not strand the strategy.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmedLeg {
    pub secrets: LegSecrets,
    /// Public leg parameters (payee, pool, dstToken, fee, minAmountOut, values...). Carried
    /// verbatim into the witness; nothing here is secret, so it is stored as-is.
    pub public: serde_json::Value,
}

impl std::fmt::Debug for ArmedLeg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArmedLeg").field("secrets", &self.secrets).finish_non_exhaustive()
    }
}

/// `strategyId:legIndex` — one armed leg per key.
pub fn leg_key(strategy_id: &str, leg_index: u32) -> String {
    let safe: String = strategy_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    format!("{safe}:{leg_index}")
}

/// Fetch the ASP set and rebuild it, then refuse anything the chain has already moved past.
///
/// The two steps are inseparable: rebuilding proves the sync was not truncated or reordered, and
/// the chain check proves it is the root the kernel will actually accept. Either alone lets a
/// doomed proof through — and it is only discovered on-chain, after the trigger is spent.
pub async fn fetch_verified_snapshot(
    asp_base: &str,
    screen_token: &str,
    policy: &SnapshotPolicy,
    now: u64,
) -> Result<AspSnapshot, String> {
    // ?chainId= makes the ASP bind the signature to this deployment. Without it the response comes
    // back unsigned and `verify_snapshot` refuses — fail-closed, not fail-quiet.
    let url = format!(
        "{}/set/leaves?chainId={}",
        asp_base.trim_end_matches('/'),
        policy.chain_id
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(screen_token)
        .send()
        .await
        .map_err(|e| format!("asp /set/leaves unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("asp /set/leaves returned {}", resp.status()));
    }
    let leaves: AspLeaves = resp
        .json()
        .await
        .map_err(|e| format!("asp /set/leaves malformed: {e}"))?;

    // Order matters: rebuild first so the roots checked below are ones the enclave DERIVED from
    // the leaves, not ones the response merely claimed. Verifying a signature over asserted roots
    // would authenticate the assertion, not the data.
    let snap = AspSnapshot::rebuild(&leaves).map_err(|e| e.to_string())?;
    snap.verify_snapshot(&leaves, policy, now).map_err(|e| e.to_string())?;
    Ok(snap)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArmReq {
    pub strategy_id: String,
    pub leg_index: u32,
    /// hex(crypto_box_seal(json(LegSecrets), enclave_pubkey)) — sealed by the browser only after
    /// it has verified the attestation quote binds this enclave's pubkey.
    pub sealed_secrets: String,
    pub public: serde_json::Value,
}

/// Unseal a browser payload with the enclave identity and validate it.
///
/// Validation happens HERE, at arming, not at fire time. A malformed leg discovered when the
/// trigger fires is a strategy that silently never executes, hours after the arming fee was paid
/// and the slice notes were minted — the user sees nothing until they go looking.
pub fn unseal_and_validate(
    sealed_hex: &str,
    secret: &crypto_box::SecretKey,
) -> Result<LegSecrets, String> {
    use crypto_box::aead::OsRng as _OsRng;
    let _ = &_OsRng; // keep the seal feature's trait in scope across crypto_box versions

    let blob = hex::decode(sealed_hex).map_err(|e| format!("sealedSecrets is not hex: {e}"))?;
    let plain = secret
        .unseal(&blob)
        .map_err(|_| "sealedSecrets did not unseal — sealed to a different enclave boot?".to_string())?;
    let secrets: LegSecrets =
        serde_json::from_slice(&plain).map_err(|e| format!("sealed payload is not LegSecrets JSON: {e}"))?;
    validate_secrets(&secrets).map_err(|e| e.to_string())?;
    Ok(secrets)
}

#[cfg(test)]
mod route_tests {
    use super::*;

    #[test]
    fn leg_key_is_stable_and_sanitised() {
        assert_eq!(leg_key("abc-123", 2), "abc-123:2");
        // A path-traversal attempt in strategyId must not escape the key dir.
        assert_eq!(leg_key("../../etc/passwd", 0), "etcpasswd:0");
    }

    #[test]
    fn a_sealed_payload_round_trips_through_the_enclave_identity() {
        let secret = crypto_box::SecretKey::generate(&mut rand_core::OsRng);
        let secrets = LegSecrets {
            action: 0,
            inputs: vec![LegInputSecret {
                value: "1000".into(),
                nullifier: "1".into(),
                secret: "2".into(),
                label: "3".into(),
                asset_id: "4".into(),
                state_leaf_index: 0,
            }],
            out_nullifier: "5".into(),
            out_secret: "6".into(),
            dest_nullifier: String::new(),
            dest_secret: String::new(),
                label_salt: "12345".into(),
        };
        let json = serde_json::to_vec(&secrets).unwrap();
        let sealed = hex::encode(
            secret.public_key().seal(&mut rand_core::OsRng, &json).unwrap(),
        );

        let got = unseal_and_validate(&sealed, &secret).unwrap();
        assert_eq!(got, secrets);
    }

    #[test]
    fn a_payload_sealed_to_another_enclave_is_refused() {
        let mine = crypto_box::SecretKey::generate(&mut rand_core::OsRng);
        let theirs = crypto_box::SecretKey::generate(&mut rand_core::OsRng);
        let sealed = hex::encode(
            theirs.public_key().seal(&mut rand_core::OsRng, b"{}").unwrap(),
        );
        assert!(unseal_and_validate(&sealed, &mine).is_err());
    }

    #[test]
    fn a_malformed_leg_is_rejected_at_arming_not_at_fire_time() {
        let secret = crypto_box::SecretKey::generate(&mut rand_core::OsRng);
        // action 1 (merge) with a single input has no verifier.
        let bad = serde_json::json!({
            "action": 1,
            "inputs": [{
                "value": "1", "nullifier": "1", "secret": "2",
                "label": "3", "assetId": "4", "stateLeafIndex": 0
            }],
            "outNullifier": "5", "outSecret": "6"
        });
        let sealed = hex::encode(
            secret
                .public_key()
                .seal(&mut rand_core::OsRng, &serde_json::to_vec(&bad).unwrap())
                .unwrap(),
        );
        let err = unseal_and_validate(&sealed, &secret).unwrap_err();
        assert!(err.contains("merge requires"), "unexpected error: {err}");
    }

    #[test]
    fn debug_never_prints_note_secrets() {
        // A stray {:?} in a log line must not defeat sealing.
        let secrets = LegSecrets {
            action: 2,
            inputs: vec![LegInputSecret {
                value: "1000".into(),
                nullifier: "SECRET-NULLIFIER".into(),
                secret: "SECRET-SECRET".into(),
                label: "SECRET-LABEL".into(),
                asset_id: "4".into(),
                state_leaf_index: 0,
            }],
            out_nullifier: "SECRET-OUT-N".into(),
            out_secret: "SECRET-OUT-S".into(),
            dest_nullifier: "SECRET-DEST-N".into(),
            dest_secret: "SECRET-DEST-S".into(),
                label_salt: "12345".into(),
        };
        let rendered = format!("{:?}", ArmedLeg { secrets, public: serde_json::json!({}) });
        for needle in [
            "SECRET-NULLIFIER", "SECRET-SECRET", "SECRET-LABEL",
            "SECRET-OUT-N", "SECRET-OUT-S", "SECRET-DEST-N", "SECRET-DEST-S",
        ] {
            assert!(!rendered.contains(needle), "{needle} leaked into Debug output: {rendered}");
        }
    }
}

// ===========================================================================================
// Witness assembly
// ===========================================================================================

impl AspSnapshot {
    /// Revoked-SMT non-inclusion witness for `label`, against the CURRENT revoked root.
    ///
    /// Non-inclusion is the direction that MUST be fresh. The revoked set only grows, so
    /// "absent from an older set" says nothing about the current one — accepting a stale revoked
    /// root is precisely a revocation-bypass window. (Inclusion proofs run the other way: an older
    /// admitted root is a subset of the current one, which is why `NoteTree.knownRoots` can be
    /// unbounded for the state tree.)
    pub fn revoked_non_inclusion(
        &self,
        label: &str,
    ) -> Result<(Vec<String>, Vec<u8>, String), SpendError> {
        let domains = spend_core::domains::Domains::load();
        let empty_subtrees = spend_core::poseidon::build_empty_subtrees(spend_core::smt::empty_leaf())
            .map_err(|e| SpendError::Malformed(format!("empty subtrees: {e}")))?;

        let (root, path, claimed_leaf) = spend_core::smt::non_inclusion_path(
            field_from_str(label),
            &self.revoked,
            domains.smt_key,
            domains.smt_leaf,
            &empty_subtrees,
        )
        .map_err(|e| SpendError::Malformed(format!("smt non-inclusion: {e}")))?;

        // The SMT we just built must agree with the root the ASP served, or the proof binds a
        // revoked-set snapshot the chain will not accept.
        if root != self.revoked_root {
            return Err(SpendError::RevokedRootMismatch);
        }

        Ok((
            path.path_elements.iter().map(field_to_str).collect(),
            path.path_indices,
            field_to_str(&claimed_leaf),
        ))
    }
}

/// Assemble the full PROTOCOL witness for one armed leg at fire time.
///
/// `public` is the arming-time half, carried verbatim. Crucially that includes the STATE path and
/// state root: `NoteTree.knownRoots` is unbounded (NoteTree.sol:8), so every state root ever
/// inserted stays valid forever and an arming-time state witness never goes stale. Only the two
/// ASP roots are refreshed here — they are the only ones the kernel pins to "current".
///
/// The per-input ASP and revoked-SMT witnesses are derived locally from `snap`, never fetched
/// per-label, so nothing about which note is being spent leaves the enclave.
pub fn build_witness(
    leg: &ArmedLeg,
    snap: &AspSnapshot,
) -> Result<serde_json::Value, SpendError> {
    validate_secrets(&leg.secrets)?;

    let mut witness = leg.public.clone();
    let obj = witness
        .as_object_mut()
        .ok_or_else(|| SpendError::Malformed("public leg params must be a JSON object".into()))?;

    // The arming-time state witness must be present — without it there is nothing to prove against.
    let state_root = obj
        .get("stateRoot")
        .and_then(|v| v.as_str())
        .ok_or_else(|| SpendError::Malformed("public.stateRoot missing (arming-time state witness)".into()))?
        .to_string();

    let state_paths = obj
        .get("statePaths")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| SpendError::Malformed("public.statePaths missing (one per input)".into()))?;
    if state_paths.len() != leg.secrets.inputs.len() {
        return Err(SpendError::Malformed(format!(
            "public.statePaths has {} entries for {} inputs",
            state_paths.len(),
            leg.secrets.inputs.len()
        )));
    }

    let mut inputs = Vec::with_capacity(leg.secrets.inputs.len());
    for (i, sec) in leg.secrets.inputs.iter().enumerate() {
        let (admitted_index, admitted_elements, admitted_indices) = snap.admitted_path(&sec.label)?;
        let (smt_elements, smt_indices, smt_leaf) = snap.revoked_non_inclusion(&sec.label)?;

        let sp = &state_paths[i];
        let take = |k: &str| -> Result<serde_json::Value, SpendError> {
            sp.get(k)
                .cloned()
                .ok_or_else(|| SpendError::Malformed(format!("public.statePaths[{i}].{k} missing")))
        };

        inputs.push(serde_json::json!({
            "inValue": sec.value,
            "inNullifier": sec.nullifier,
            "inSecret": sec.secret,
            "inLabel": sec.label,
            "inAssetId": sec.asset_id,
            "statePathElements": take("pathElements")?,
            "statePathIndices": take("pathIndices")?,
            "admittedLeafIndex": admitted_index,
            "admittedPathElements": admitted_elements,
            "admittedPathIndices": admitted_indices,
            "revokedSmtPathElements": smt_elements,
            "revokedSmtPathIndices": smt_indices,
            "revokedSmtLeaf": smt_leaf,
        }));
    }

    obj.remove("statePaths");
    obj.insert("action".into(), serde_json::json!(leg.secrets.action));
    obj.insert("inputCount".into(), serde_json::json!(leg.secrets.inputs.len()));
    obj.insert("inputs".into(), serde_json::Value::Array(inputs));
    obj.insert("outNullifier".into(), serde_json::json!(leg.secrets.out_nullifier));
    obj.insert("outSecret".into(), serde_json::json!(leg.secrets.out_secret));
    // §3.2: non-zero or the prover refuses. Checked here rather than deeper so the error names the
    // sealed payload — the layer that can actually be wrong — instead of the prover.
    if leg.secrets.label_salt.trim().is_empty() || leg.secrets.label_salt.trim() == "0" {
        return Err(SpendError::Malformed(
            "sealed leg carries no labelSalt (COMPLIANCE_CIRCUIT_SPLIT §3.2) — it was armed by a \
             client that predates the compliance split"
                .into(),
        ));
    }
    obj.insert("labelSalt".into(), serde_json::json!(leg.secrets.label_salt));
    if leg.secrets.action == 2 {
        obj.insert("destNullifier".into(), serde_json::json!(leg.secrets.dest_nullifier));
        obj.insert("destSecret".into(), serde_json::json!(leg.secrets.dest_secret));
    }

    // Fresh ASP roots into BOTH representations; the state root is re-applied unchanged so the
    // consistency guard in prove-witness.cjs sees a coherent witness.
    apply_fresh_roots(&mut witness, &state_root, &snap.admitted_root(), &snap.revoked_root())?;
    Ok(witness)
}

#[cfg(test)]
mod witness_tests {
    use super::*;

    fn snapshot(labels: &[u64], revoked: &[u64]) -> AspSnapshot {
        let mut tree = AspTree::new();
        for l in labels {
            tree.insert(Field::from(*l)).unwrap();
        }
        let domains = spend_core::domains::Domains::load();
        let empty = spend_core::poseidon::build_empty_subtrees(spend_core::smt::empty_leaf()).unwrap();
        let rev: Vec<Field> = revoked.iter().map(|r| Field::from(*r)).collect();
        let revoked_root = spend_core::smt::revoked_tree_root(
            &rev, domains.smt_key, domains.smt_leaf, &empty,
        )
        .unwrap();

        AspSnapshot::rebuild(&AspLeaves {
            admitted_root: field_to_str(&tree.root()),
            revoked_root: field_to_str(&revoked_root),
            admitted_labels: labels.iter().map(|l| l.to_string()).collect(),
            revoked_labels: revoked.iter().map(|l| l.to_string()).collect(),
            issued_at: None,
            snapshot_sig: None,
        })
        .unwrap()
    }

    /// A leg armed by a pre-split client unseals fine and then cannot be proved. Refuse while the
    /// error can still name the sealed payload rather than blaming the prover.
    #[test]
    fn a_leg_without_a_label_salt_is_refused_at_witness_time() {
        let mut l = leg(123456789);
        l.secrets.label_salt = String::new();
        let err = build_witness(&l, &snapshot(&[123456789], &[])).unwrap_err();
        assert!(
            format!("{err:?}").contains("labelSalt"),
            "the error must name labelSalt, got {err:?}"
        );
    }

    fn leg(label: u64) -> ArmedLeg {
        let pi: Vec<serde_json::Value> =
            (0..crate::attester::PUBLIC_WIDTH)
                .map(|_| serde_json::Value::String("0".into()))
                .collect();
        ArmedLeg {
            secrets: LegSecrets {
                action: 0,
                inputs: vec![LegInputSecret {
                    value: "1000".into(),
                    nullifier: "11".into(),
                    secret: "22".into(),
                    label: label.to_string(),
                    asset_id: "44".into(),
                    state_leaf_index: 0,
                }],
                out_nullifier: "55".into(),
                out_secret: "66".into(),
                dest_nullifier: String::new(),
                dest_secret: String::new(),
                label_salt: "12345".into(),
            },
            public: serde_json::json!({
                "stateRoot": "state-root-from-arming",
                "boundaryIndex": 0,
                "primaryValue": "1000",
                "secondaryValue": "0",
                "rawPayeeHex": "00".repeat(20),
                "expectedPublic": pi,
                "statePaths": [{
                    "pathElements": vec!["0"; 32],
                    "pathIndices": vec![0u8; 32],
                }],
            }),
        }
    }

    #[test]
    fn a_full_witness_is_assembled_with_fresh_asp_roots() {
        let snap = snapshot(&[1000, 1001, 1002], &[]);
        let w = build_witness(&leg(1001), &snap).unwrap();

        assert_eq!(w["action"], 0);
        assert_eq!(w["inputCount"], 1);
        assert_eq!(w["inputs"].as_array().unwrap().len(), 1);

        // ASP roots refreshed, in both representations.
        assert_eq!(w["admittedRoot"], snap.admitted_root());
        assert_eq!(w["expectedPublic"][3], snap.admitted_root());
        assert_eq!(w["revokedRoot"], snap.revoked_root());
        assert_eq!(w["expectedPublic"][4], snap.revoked_root());

        // The arming-time state witness is carried through untouched: knownRoots is unbounded, so
        // a state root from arming is still accepted at fire time.
        assert_eq!(w["stateRoot"], "state-root-from-arming");
        assert_eq!(w["expectedPublic"][2], "state-root-from-arming");

        // Derived locally, at the right leaf.
        let inp = &w["inputs"][0];
        assert_eq!(inp["admittedLeafIndex"], 1);
        assert_eq!(inp["admittedPathElements"].as_array().unwrap().len(), 32);
        assert_eq!(inp["revokedSmtPathElements"].as_array().unwrap().len(), 32);
        assert_eq!(inp["inSecret"], "22");
        // statePaths is consumed into inputs[], not left dangling.
        assert!(w.get("statePaths").is_none());
    }

    #[test]
    fn a_revoked_label_cannot_be_assembled_into_a_witness() {
        let snap = snapshot(&[1000, 1001, 1002], &[1001]);
        assert_eq!(
            build_witness(&leg(1001), &snap).unwrap_err(),
            SpendError::Revoked("1001".into()),
        );
        // A sibling that is NOT revoked still proves.
        assert!(build_witness(&leg(1000), &snap).is_ok());
    }

    #[test]
    fn an_unadmitted_label_cannot_be_assembled() {
        let snap = snapshot(&[1000], &[]);
        assert_eq!(
            build_witness(&leg(4242), &snap).unwrap_err(),
            SpendError::NotAdmitted("4242".into()),
        );
    }

    #[test]
    fn a_missing_state_witness_is_refused() {
        let snap = snapshot(&[1000], &[]);

        let mut no_root = leg(1000);
        no_root.public.as_object_mut().unwrap().remove("stateRoot");
        assert!(matches!(build_witness(&no_root, &snap), Err(SpendError::Malformed(_))));

        let mut no_paths = leg(1000);
        no_paths.public.as_object_mut().unwrap().remove("statePaths");
        assert!(matches!(build_witness(&no_paths, &snap), Err(SpendError::Malformed(_))));
    }

    #[test]
    fn a_state_path_count_mismatch_is_refused() {
        // Two inputs, one state path: silently proving the wrong note is far worse than failing.
        let snap = snapshot(&[1000, 1001], &[]);
        let mut two = leg(1000);
        two.secrets.action = 1;
        let mut second = two.secrets.inputs[0].clone();
        second.nullifier = "99".into();
        second.label = "1001".into();
        second.state_leaf_index = 1;
        two.secrets.inputs.push(second);

        assert!(matches!(build_witness(&two, &snap), Err(SpendError::Malformed(_))));
    }

    #[test]
    fn the_smt_witness_must_match_the_served_revoked_root() {
        // Tamper the served revoked root: the locally rebuilt SMT will not agree, and a proof bound
        // to a revoked-set snapshot the chain does not hold would revert.
        let mut snap = snapshot(&[1000], &[]);
        snap.revoked_root = field_from_str("999");
        assert_eq!(
            build_witness(&leg(1000), &snap).unwrap_err(),
            SpendError::RevokedRootMismatch,
        );
    }
}

// ===========================================================================================
// Prover subprocess
// ===========================================================================================

/// Where the enclave finds its prover. All of it is baked into the image, never host-supplied
/// beyond the ASP endpoint — a host that could point `prover_script` elsewhere could swap the
/// prover for one that exfiltrates the witness.
#[derive(Debug, Clone)]
pub struct SpendConfig {
    pub asp_base: String,
    pub screen_token: String,
    pub node_bin: String,
    /// `siphon-zk-v2/scripts/prove-witness.cjs`, copied into the image.
    pub prover_script: String,
    pub artifacts_dir: String,
    /// `rapidsnark` on a 2-vCPU CVM; snarkjs would be 6-12s per leg instead of well under one.
    pub backend: String,
    /// What makes an ASP snapshot acceptable. `None` when the deployment is not fully configured,
    /// in which case `/spend/prove` refuses rather than falling back to an unverified snapshot.
    pub snapshot: Option<SnapshotPolicy>,
    /// The VaultKernel this enclave attests for. Bound into the freshness digest because one hub
    /// is shared across kernels, so without it an attestation for one is replayable against another.
    pub kernel: Option<[u8; 20]>,
    /// `ComplianceHub.attesterEpoch`. Bumped by setAttester, so every signature minted under a
    /// previous key stops verifying the moment governance rotates — including a rotation done
    /// because that key leaked. Read it from the hub; never cache across a rotation.
    pub attester_epoch: u64,
    /// How long an attestation stays valid. Must be <= ComplianceHub.attestationMaxAge or the hub
    /// rejects it with AttestationTooLong; it composes with SNAPSHOT_MAX_AGE_SECS, and the SUM is
    /// the true revocation-evasion window.
    pub attestation_ttl_secs: u64,
}

/// Parse `0x`-prefixed 20-byte hex. Returns None on anything else, so a typo'd address disables
/// the policy (and therefore `/spend/prove`) instead of silently becoming a different address.
fn parse_addr(s: &str) -> Option<[u8; 20]> {
    let raw = hex::decode(s.trim().trim_start_matches("0x")).ok()?;
    raw.try_into().ok()
}

impl SpendConfig {
    pub fn from_env() -> Self {
        let env = |k: &str, d: &str| std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.into());

        // Per-chain config: `SPEND_CHAIN_IDS` names the chain(s) this deployment serves, and each
        // setting may be given as `<VAR>_<chainId>`. The unsuffixed names are the fallback and, on
        // a multi-chain deployment, they belong to whichever chain was configured FIRST — which is
        // not necessarily the one being served. Reading only the unsuffixed set is how this enclave
        // came to prove against Sepolia's ASP and sign attestations bound to Sepolia's kernel while
        // the executor submitted them to Base: every signature recovered to a stranger and the hub
        // answered WrongAttester, naming nothing.
        let primary: Option<u64> = env("SPEND_CHAIN_IDS", "")
            .split(|c| c == ',' || c == ' ')
            .find(|t| !t.trim().is_empty())
            .and_then(|t| t.trim().parse().ok());
        let ev = |k: &str, d: &str| -> String {
            if let Some(c) = primary {
                let v = env(&format!("{k}_{c}"), "");
                if !v.is_empty() {
                    return v;
                }
            }
            env(k, d)
        };

        // All four must be present and well-formed, or there is no policy at all. A partially
        // configured policy is the dangerous case: it would verify a signature against the wrong
        // hub or the wrong postman and read as a working check.
        let snapshot = match (
            primary.or_else(|| env("SNAPSHOT_CHAIN_ID", "").parse::<u64>().ok()),
            parse_addr(&ev("COMPLIANCE_HUB", "")),
            parse_addr(&ev("ASP_POSTMAN_ADDRESS", "")),
        ) {
            (Some(chain_id), Some(hub), Some(postman)) => Some(SnapshotPolicy {
                chain_id,
                hub,
                postman,
                // Composes with ComplianceHub.attestationMaxAge — the SUM is the real
                // revocation-evasion window, so keep this well under it.
                max_age_secs: ev("SNAPSHOT_MAX_AGE_SECS", "120").parse().unwrap_or(120),
            }),
            _ => None,
        };

        Self {
            asp_base: ev("ASP_BASE_URL", ""),
            screen_token: ev("ASP_SCREEN_TOKEN", ""),
            node_bin: env("NODE_BIN", "node"),
            prover_script: env("PROVER_SCRIPT", "/app/prover/prove-witness.cjs"),
            artifacts_dir: {
                let per_chain = ev("PROTOCOL_ARTIFACTS_DIR", "");
                if !per_chain.is_empty() && std::path::Path::new(&per_chain).is_dir() {
                    per_chain
                } else {
                    if !per_chain.is_empty() {
                        eprintln!(
                            "[Decryptor] PROTOCOL_ARTIFACTS_DIR {per_chain:?} does not exist — \
                             using the baked-in artifacts"
                        );
                    }
                    env("PROTOCOL_ARTIFACTS_DIR", "/app/prover/artifacts")
                }
            },
            backend: env("PROVE_BACKEND", "rapidsnark"),
            snapshot,
            kernel: parse_addr(&ev("VAULT_KERNEL", "")),
            attester_epoch: ev("ATTESTER_EPOCH", "0").parse().unwrap_or(0),
            attestation_ttl_secs: ev("ATTESTATION_TTL_SECS", "120").parse().unwrap_or(120),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ProofResult {
    pub circuit: String,
    pub backend: String,
    pub prove_ms: u64,
    pub proof: serde_json::Value,
    pub public_signals: serde_json::Value,
    /// COMPLIANCE_CIRCUIT_SPLIT §2.2 — the second half. `None` only for RAGEQUIT, which proves
    /// its own eligibility inline. A private spend without this cannot finalize on-chain.
    pub compliance: Option<ComplianceProof>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComplianceProof {
    /// `compliance1`..`compliance6` — the family is arity-specific, so this names which
    /// verifying key the vault's router must reach.
    pub circuit: String,
    pub proof: serde_json::Value,
    pub public_signals: serde_json::Value,
    pub prove_ms: u64,
}

/// Write the witness to a private temp file and shell out to `prove-witness.cjs`.
///
/// The witness holds note secrets, so the file lives in the enclave's own tmpdir and is removed on
/// every path out, success or failure. `prove-witness.cjs` exits non-zero unless the proof VERIFIES
/// locally — a prover that returned an unverified proof would just move the failure on-chain, after
/// the trigger is spent and gas is paid.
pub fn prove_witness(cfg: &SpendConfig, witness: &serde_json::Value) -> Result<ProofResult, String> {
    use std::io::Write;

    let dir = std::env::temp_dir().join(format!("siphon-spend-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("tmpdir: {e}"))?;
    let witness_path = dir.join("witness.json");

    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&witness_path)?;
        f.write_all(serde_json::to_string(witness).unwrap().as_bytes())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("write witness: {e}"));
    }

    let output = std::process::Command::new(&cfg.node_bin)
        .arg(&cfg.prover_script)
        .arg("--witness")
        .arg(&witness_path)
        .arg("--artifacts")
        .arg(&cfg.artifacts_dir)
        .arg("--backend")
        .arg(&cfg.backend)
        .output();

    // Remove the witness before inspecting the result — every return path below is after this.
    let _ = std::fs::remove_dir_all(&dir);

    let output = output.map_err(|e| format!("spawn prover: {e}"))?;
    if !output.status.success() {
        // stderr can echo witness content on a parse error; truncate rather than log it whole.
        let err: String = String::from_utf8_lossy(&output.stderr).chars().take(400).collect();
        return Err(format!("prover failed: {err}"));
    }

    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("prover output is not JSON: {e}"))?;
    if parsed["verified"] != serde_json::Value::Bool(true) {
        return Err("prover returned an unverified proof".into());
    }

    let circuit = parsed["circuit"].as_str().unwrap_or_default().to_string();

    // Fail closed rather than hand back half a spend. `prove-witness.cjs` already exits non-zero
    // on an unverified compliance proof, so a missing half here means the enclave is running an
    // older prover script than the artifacts it was built with — silently returning the spend
    // half alone would surface as a ComplianceProofFailed revert after gas is paid.
    let compliance = match parsed.get("compliance") {
        Some(c) if c.is_object() => {
            if c["verified"] != serde_json::Value::Bool(true) {
                return Err("prover returned an unverified compliance proof".into());
            }
            Some(ComplianceProof {
                circuit: c["circuit"].as_str().unwrap_or_default().to_string(),
                proof: c["proof"].clone(),
                public_signals: c["publicSignals"].clone(),
                prove_ms: c["prove_ms"].as_u64().unwrap_or_default(),
            })
        }
        _ => {
            if circuit != "ragequit" {
                return Err(format!(
                    "prover returned no compliance proof for circuit {circuit} — a private spend \
                     cannot finalize without both halves (COMPLIANCE_CIRCUIT_SPLIT §2.2)"
                ));
            }
            None
        }
    };

    Ok(ProofResult {
        circuit,
        backend: parsed["backend"].as_str().unwrap_or_default().to_string(),
        prove_ms: parsed["prove_ms"].as_u64().unwrap_or_default(),
        proof: parsed["proof"].clone(),
        public_signals: parsed["publicSignals"].clone(),
        compliance,
    })
}

#[cfg(test)]
mod prover_tests {
    use super::*;

    #[test]
    fn config_defaults_to_rapidsnark_and_baked_in_paths() {
        // The image ships these; a 2-vCPU CVM cannot afford the snarkjs path.
        let cfg = SpendConfig::from_env();
        assert_eq!(cfg.backend, "rapidsnark");
        assert!(cfg.prover_script.starts_with('/'), "prover script must be an absolute, baked-in path");
        assert!(cfg.artifacts_dir.starts_with('/'));
    }

    #[test]
    fn a_failing_prover_leaves_no_witness_on_disk() {
        // The witness holds note secrets; a crashed prover must not leave them in tmp.
        let cfg = SpendConfig {
            asp_base: String::new(),
            screen_token: String::new(),
            node_bin: "/nonexistent/node".into(),
            prover_script: "/nonexistent/prove.cjs".into(),
            artifacts_dir: "/nonexistent".into(),
            snapshot: None,
            kernel: None,
            attester_epoch: 0,
            attestation_ttl_secs: 120,
            backend: "rapidsnark".into(),
        };
        assert!(prove_witness(&cfg, &serde_json::json!({"a": 1})).is_err());

        let leaked = std::env::temp_dir().join(format!("siphon-spend-{}", std::process::id()));
        assert!(!leaked.exists(), "witness tmpdir survived a prover failure: {leaked:?}");
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    /// Cross-language contract with `siphon-asp-v2/app.py::set_leaves`.
    ///
    /// The ASP is Python and this is Rust; nothing but this test stops a field rename on one side
    /// from silently breaking the other. serde would report a missing field only at fire time, as
    /// a strategy that never executes.
    #[test]
    fn the_asp_set_leaves_response_deserializes() {
        // Verbatim shape of GET /set/leaves (see tests/test_set_leaves.py for the live assertions).
        let body = serde_json::json!({
            "admittedRoot": "12345",
            "revokedRoot": "67890",
            "admittedLabels": ["1000", "1001", "1002"],
            "admittedCount": 3,
            "revokedLabels": ["1001"],
            "revokedCount": 1
        });

        let leaves: AspLeaves = serde_json::from_value(body).expect("ASP response must deserialize");
        assert_eq!(leaves.admitted_root, "12345");
        assert_eq!(leaves.revoked_root, "67890");
        assert_eq!(leaves.admitted_labels, vec!["1000", "1001", "1002"]);
        assert_eq!(leaves.revoked_labels, vec!["1001"]);
    }

    /// The count fields are advisory — the tree rebuild is the real check — but a response whose
    /// count disagrees with its own list means the ASP truncated somewhere, so callers should not
    /// be able to rely on the count instead of rebuilding.
    #[test]
    fn counts_are_not_load_bearing_the_root_check_is() {
        let body = serde_json::json!({
            "admittedRoot": "0",
            "revokedRoot": "0",
            "admittedLabels": ["1"],
            "admittedCount": 999,
            "revokedLabels": [],
            "revokedCount": 0
        });
        // Deserializes fine (count is ignored)...
        let leaves: AspLeaves = serde_json::from_value(body).unwrap();
        // ...and the root check is what actually rejects it.
        assert_eq!(AspSnapshot::rebuild(&leaves).unwrap_err(), SpendError::AspRootMismatch);
    }

    /// An empty pool must be usable, not a special case that panics on the first deposit.
    #[test]
    fn an_empty_admitted_set_rebuilds_to_the_empty_root() {
        let empty_root = field_to_str(&AspTree::new().root());
        let leaves = AspLeaves {
            admitted_root: empty_root.clone(),
            revoked_root: "0".into(),
            admitted_labels: vec![],
            revoked_labels: vec![],
            issued_at: None,
            snapshot_sig: None,
        };
        let snap = AspSnapshot::rebuild(&leaves).unwrap();
        assert_eq!(snap.admitted_root(), empty_root);
        // No label is admitted yet, so nothing can be proved against it.
        assert!(matches!(snap.admitted_path("1"), Err(SpendError::NotAdmitted(_))));
    }
}

/// Parse `public.statePaths` into Merkle paths, one per input note.
///
/// The attester proves each note's commitment against `publicInputs[2]` by recomputing this path,
/// so a malformed entry must be an error rather than a silently-empty path — an empty path
/// recomputes to the leaf itself and would match nothing, which reads as "note not deposited"
/// instead of "the arm payload was malformed".
pub fn state_paths_from_public(
    public: &serde_json::Value,
) -> Result<Vec<spend_core::merkle::MerklePath>, SpendError> {
    let entries = public
        .get("statePaths")
        .and_then(|v| v.as_array())
        .ok_or_else(|| SpendError::Malformed("public.statePaths missing (one per input)".into()))?;

    entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let elements = e
                .get("pathElements")
                .and_then(|v| v.as_array())
                .ok_or_else(|| SpendError::Malformed(format!("statePaths[{i}].pathElements missing")))?
                .iter()
                .map(|v| field_from_str(v.as_str().unwrap_or("0")))
                .collect::<Vec<_>>();
            let indices = e
                .get("pathIndices")
                .and_then(|v| v.as_array())
                .ok_or_else(|| SpendError::Malformed(format!("statePaths[{i}].pathIndices missing")))?
                .iter()
                .map(|v| v.as_u64().unwrap_or(0) as u8)
                .collect::<Vec<_>>();
            Ok(spend_core::merkle::MerklePath { path_elements: elements, path_indices: indices })
        })
        .collect()
}

#[cfg(test)]
mod chain_scoped_config_tests {
    use super::*;

    /// Env is process-global, so these run under one lock and clean up after themselves.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const KEYS: [&str; 8] = [
        "SPEND_CHAIN_IDS", "SNAPSHOT_CHAIN_ID", "COMPLIANCE_HUB", "COMPLIANCE_HUB_8453",
        "ASP_POSTMAN_ADDRESS", "ASP_POSTMAN_ADDRESS_8453", "VAULT_KERNEL", "VAULT_KERNEL_8453",
    ];

    fn clear() {
        for k in KEYS {
            std::env::remove_var(k);
        }
    }

    /// The WrongAttester bug: a deployment serving 8453 read the unsuffixed Sepolia values,
    /// proved against Sepolia's ASP and signed attestations bound to Sepolia's kernel, and every
    /// signature recovered to a stranger on Base.
    #[test]
    fn per_chain_values_win_over_the_unsuffixed_fallback() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        std::env::set_var("SPEND_CHAIN_IDS", "8453");
        std::env::set_var("SNAPSHOT_CHAIN_ID", "11155111");
        std::env::set_var("COMPLIANCE_HUB", "0x3a9bc800e61be52dc7dbcaf45920946f4877a51b");
        std::env::set_var("VAULT_KERNEL", "0x50db1b65fe56de4015912fd3e1adc1bccfb08151");
        std::env::set_var("ASP_POSTMAN_ADDRESS", "0x1111111111111111111111111111111111111111");
        std::env::set_var("COMPLIANCE_HUB_8453", "0x64E092415E9C017eb742EBaa31bCda94d9BF8078");
        std::env::set_var("VAULT_KERNEL_8453", "0x94242AE27e0E17000Fb9d28B43118B8A7904c51A");
        std::env::set_var("ASP_POSTMAN_ADDRESS_8453", "0x5cAd4998e8A01225b67C6D49A92352ec0E949b3d");

        let cfg = SpendConfig::from_env();
        let snap = cfg.snapshot.expect("policy must resolve");
        assert_eq!(snap.chain_id, 8453, "SPEND_CHAIN_IDS must win over SNAPSHOT_CHAIN_ID");
        assert_eq!(hex::encode(snap.hub), "64e092415e9c017eb742ebaa31bcda94d9bf8078");
        assert_eq!(hex::encode(snap.postman), "5cad4998e8a01225b67c6d49a92352ec0e949b3d");
        assert_eq!(hex::encode(cfg.kernel.unwrap()), "94242ae27e0e17000fb9d28b43118b8a7904c51a");
        clear();
    }

    /// Single-chain deployments set no suffixed vars at all; nothing may change for them.
    #[test]
    fn unsuffixed_values_still_apply_when_no_per_chain_override_exists() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        std::env::set_var("SNAPSHOT_CHAIN_ID", "11155111");
        std::env::set_var("COMPLIANCE_HUB", "0x3a9bc800e61be52dc7dbcaf45920946f4877a51b");
        std::env::set_var("VAULT_KERNEL", "0x50db1b65fe56de4015912fd3e1adc1bccfb08151");
        std::env::set_var("ASP_POSTMAN_ADDRESS", "0x1111111111111111111111111111111111111111");

        let cfg = SpendConfig::from_env();
        let snap = cfg.snapshot.expect("policy must resolve");
        assert_eq!(snap.chain_id, 11155111);
        assert_eq!(hex::encode(snap.hub), "3a9bc800e61be52dc7dbcaf45920946f4877a51b");
        assert_eq!(hex::encode(cfg.kernel.unwrap()), "50db1b65fe56de4015912fd3e1adc1bccfb08151");
        clear();
    }

    /// A per-chain artifacts path from an image that laid them out differently must not be taken:
    /// it names a directory inside THIS image, and a missing one breaks every proof.
    #[test]
    fn a_nonexistent_artifacts_override_falls_back_to_the_baked_in_path() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        std::env::set_var("SPEND_CHAIN_IDS", "8453");
        std::env::set_var("PROTOCOL_ARTIFACTS_DIR_8453", "/nonexistent/artifacts-8453");
        let cfg = SpendConfig::from_env();
        assert_eq!(cfg.artifacts_dir, "/app/prover/artifacts");
        std::env::remove_var("PROTOCOL_ARTIFACTS_DIR_8453");
        clear();
    }
}
