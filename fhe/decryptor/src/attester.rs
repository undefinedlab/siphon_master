//! Spend-freshness attester — the TEE half of v3 compliance for strategy legs.
//!
//! # What this signs and why
//!
//! A strategy leg's Groth16 proof is built at arming, so it binds whatever `revokedRoot` was live
//! then. Revocation moves that root immediately, and the kernel's `spend()` demands the CURRENT
//! root — so a pre-built proof is unspendable the moment anyone is revoked.
//!
//! `spendAttested()` relaxes the on-chain root check to "was legitimately published" and requires
//! this signature instead: a statement, from an enclave whose measurement is attested, that as of
//! `expiry` none of the notes this spend consumes belong to a revoked label.
//!
//! # The binding that makes it sound
//!
//! The kernel only ever sees `nullifierHash`; the revocation check is by `label`; and the circuit
//! deliberately keeps the label private (limb 24 is a SALTED commit, not a label — see
//! COMPLIANCE_CIRCUIT_SPLIT §4.3 — so there is still no label-derived join key in the public
//! encoding — `pi[8]` outLabel is pinned to 0). So a label the caller merely *claims* proves
//! nothing: a revoked user could hand over a clean label from another of their deposits and have
//! this enclave attest to a note the proof spends under a revoked label.
//!
//! [`bind_label_to_nullifier`] is what closes that. The enclave RECOMPUTES
//! `commitment = Poseidon(Poseidon(value, label, assetId), Poseidon(nullifier, secret))` and
//! requires both that it appears in the state tree and that `Poseidon(nullifier)` equals the
//! `nullifierHash` the proof publishes. Only then is the label provably the one behind that
//! nullifier. This is the reason the enclave needs note secrets at all.
//!
//! # Key
//!
//! Derived from the dstack KMS, NOT the per-boot x25519 identity. The address is registered
//! on-chain in ComplianceHub, so a key that changed on every restart would require a governance
//! transaction after each reboot and would strand every armed leg in between.

use sha3::{Digest, Keccak256};

/// Domain separator — distinguishes this signature from every other thing the key could ever sign.
pub const ATTEST_TYPEHASH: &[u8] =
    b"SiphonSpendFreshness(uint256 chainId,address hub,address kernel,uint256 attesterEpoch,bytes32 piDigest,uint256 expiry)";

/// dstack KMS path. Stable per app_id: survives reboots AND replicas.
pub const ATTESTER_KEY_PATH: &str = "siphon-decryptor/spend-attester";

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum AttestError {
    #[error("attester key unavailable: {0}")]
    KeyUnavailable(String),
    #[error("note {index} does not hash to its published nullifierHash — label is not bound")]
    NullifierMismatch { index: usize },
    #[error("note {index} commitment is not in the state tree")]
    CommitmentNotInTree { index: usize },
    #[error("label {0} is revoked — refusing to attest")]
    Revoked(String),
    #[error("expiry {expiry} is not in (now, now+{max_age}]")]
    BadExpiry { expiry: u64, max_age: u64 },
    #[error("poseidon: {0}")]
    Poseidon(String),
    #[error("attested value {attested} != publicInputs[5]+[6] = {declared} — decoy note")]
    ValueMismatch { attested: String, declared: String },
    #[error("note {index} assetId {got} != publicInputs[{limb}] = {want} — decoy note")]
    AssetMismatch { index: usize, limb: usize, got: String, want: String },
    #[error("signature is malleable (high-S or bad v)")]
    MalleableSignature,
    #[error("signature: {0}")]
    BadSignature(String),
}

/// EIP-191-free digest: the hub recomputes exactly this and `ecrecover`s it.
///
/// `chain_id` and `hub` are in the preimage so a signature cannot be replayed onto another chain
/// or a redeployed hub — both are live risks here, since the hub is `immutable` in the kernel and
/// every hub change ships a new kernel alongside it.
///
/// `attester_epoch` is bumped by `ComplianceHub.setAttester`, so every signature minted under a
/// previous key becomes unverifiable the instant governance rotates — including a rotation done
/// precisely because that key leaked. Read it from the hub; never cache it across a rotation.
///
/// `pi_digest` is `keccak256(abi.encodePacked(publicInputs))` — the WHOLE 25-limb array. That
/// covers the nullifier hashes, both roots, the action, the payee and every mux limb, so the
/// signature authorises exactly one spend and cannot be moved onto a different one.
///
/// MUST stay byte-identical to `ComplianceHub.freshnessDigest`. The cross-check in
/// `tests::digest_matches_solidity_abi_encode` pins the layout.
pub fn freshness_digest(
    chain_id: u64,
    hub: [u8; 20],
    kernel: [u8; 20],
    attester_epoch: u64,
    pi_digest: [u8; 32],
    expiry: u64,
) -> [u8; 32] {
    let mut type_hash = Keccak256::new();
    type_hash.update(ATTEST_TYPEHASH);
    let type_hash: [u8; 32] = type_hash.finalize().into();

    // abi.encode layout: every field padded to 32 bytes, address right-aligned.
    let mut buf = Vec::with_capacity(32 * 7);
    buf.extend_from_slice(&type_hash);
    buf.extend_from_slice(&u256_be(chain_id));
    let mut addr_word = [0u8; 32];
    addr_word[12..].copy_from_slice(&hub);
    buf.extend_from_slice(&addr_word);
    // One hub is shared across kernels, so the kernel must bind or an attestation for one is
    // replayable against another that seeded the same historical root.
    let mut kernel_word = [0u8; 32];
    kernel_word[12..].copy_from_slice(&kernel);
    buf.extend_from_slice(&kernel_word);
    buf.extend_from_slice(&u256_be(attester_epoch));
    buf.extend_from_slice(&pi_digest);
    buf.extend_from_slice(&u256_be(expiry));

    let mut h = Keccak256::new();
    h.update(&buf);
    h.finalize().into()
}

fn u256_be(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

/// Ethereum address from a secp256k1 verifying key: last 20 bytes of keccak(uncompressed pubkey[1..]).
pub fn address_from_verifying_key(vk: &k256::ecdsa::VerifyingKey) -> [u8; 20] {
    let point = vk.to_encoded_point(false);
    let bytes = point.as_bytes(); // 0x04 || X || Y
    let mut h = Keccak256::new();
    h.update(&bytes[1..]);
    let digest: [u8; 32] = h.finalize().into();
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&digest[12..]);
    addr
}

/// Sign a freshness digest, returning 65-byte `r || s || v` with `v` in {27, 28}.
///
/// Low-S normalisation is what `k256`'s `sign_prehash_recoverable` already guarantees; emitting a
/// high-S signature would be rejected by any hub using OpenZeppelin's ECDSA (and would make the
/// signature malleable, so the same authorisation could be presented in two forms).
pub fn sign_digest(
    key: &k256::ecdsa::SigningKey,
    digest: &[u8; 32],
) -> Result<[u8; 65], AttestError> {
    use k256::ecdsa::signature::hazmat::PrehashSigner;
    let (sig, recid): (k256::ecdsa::Signature, k256::ecdsa::RecoveryId) = key
        .sign_prehash(digest)
        .map_err(|e| AttestError::KeyUnavailable(format!("sign: {e}")))?;
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = 27 + recid.to_byte();
    Ok(out)
}

/// App-scoped key material for `path`, from the dstack KMS.
#[cfg(not(feature = "mock-kms"))]
pub async fn kms_key(path: &str, purpose: &str) -> Option<Vec<u8>> {
    let resp = dstack_sdk::dstack_client::DstackClient::new(None)
        .get_key(Some(path.into()), Some(purpose.into()))
        .await
        .map_err(|e| eprintln!("[Decryptor] KMS key {path} unavailable (dev?): {e}"))
        .ok()?;
    resp.decode_key().ok()
}

/// MOCK: the same key material derived from `MOCK_KMS_SEED` (32 bytes, hex), for a host with no
/// TDX guest agent. This is NOT a TEE — whoever holds the seed, or root on the host, holds every
/// key derived here, the on-chain spend attester included. The feature is off by default, so the
/// Phala image cannot compile this path in.
#[cfg(feature = "mock-kms")]
pub async fn kms_key(path: &str, purpose: &str) -> Option<Vec<u8>> {
    use sha2::Digest;
    let seed = std::env::var("MOCK_KMS_SEED")
        .ok()
        .and_then(|s| hex::decode(s.trim().trim_start_matches("0x")).ok())
        .filter(|s| s.len() == 32);
    let Some(seed) = seed else {
        eprintln!("[Decryptor] mock-kms: MOCK_KMS_SEED must be 32 bytes of hex — no key for {path}");
        return None;
    };
    Some(
        sha2::Sha256::new()
            .chain_update(b"siphon-mock-kms:")
            .chain_update(&seed)
            .chain_update(path.as_bytes())
            .chain_update(b":")
            .chain_update(purpose.as_bytes())
            .finalize()
            .to_vec(),
    )
}

#[cfg(all(test, feature = "mock-kms"))]
mod mock_kms_tests {
    // Restarts must keep the attester address (it is registered on-chain) and the seal key (it
    // opens persisted ClientKeys and armed legs), and the two must never be the same bytes.
    #[tokio::test]
    async fn mock_kms_is_deterministic_and_path_separated() {
        std::env::set_var("MOCK_KMS_SEED", "11".repeat(32));
        let a = super::kms_key(super::ATTESTER_KEY_PATH, "sign").await.unwrap();
        assert_eq!(a, super::kms_key(super::ATTESTER_KEY_PATH, "sign").await.unwrap());
        assert_ne!(a, super::kms_key("siphon-decryptor/storage-seal", "encrypt").await.unwrap());
        let k1 = super::attester_key_from_kms().await.unwrap();
        assert_eq!(k1.to_bytes(), super::attester_key_from_kms().await.unwrap().to_bytes());
        std::env::set_var("MOCK_KMS_SEED", "not-hex");
        assert!(super::kms_key(super::ATTESTER_KEY_PATH, "sign").await.is_none());
        std::env::remove_var("MOCK_KMS_SEED");
    }
}

/// Derive the attester signing key from the dstack KMS.
///
/// Deterministic per app_id, so the address is stable across reboots and replicas — which it must
/// be, because it is registered on-chain in `ComplianceHub.setAttester`. A per-boot key would need
/// a governance transaction after every restart and would strand every armed leg in between.
///
/// The KMS material is domain-separated before use, exactly as the storage-seal key is: the same
/// path must never yield a key that is simultaneously an AEAD key and a signing key.
///
/// Returns `None` off-enclave (no dstack socket), which is what makes local dev possible — and is
/// also why `/spend/prove` refuses to attest rather than falling back to something unsigned.
///
/// KNOWN LIMITATION, stated where it will be read: dstack derives this from the `app_id`, NOT from
/// the code measurement. Anyone able to deploy under the same app_id derives the same key. The
/// on-chain attester therefore proves "an enclave belonging to this Phala account", not "the
/// reviewed build". Closing that needs KMS key release gated on the compose-hash (an on-chain
/// KmsAuth/AppAuth allowlist); until then the Phala API token is a custody credential.
pub async fn attester_key_from_kms() -> Option<k256::ecdsa::SigningKey> {
    use sha2::Digest;
    let raw = kms_key(ATTESTER_KEY_PATH, "sign").await?;
    let seed: [u8; 32] = sha2::Sha256::new()
        .chain_update(b"siphon-decryptor-spend-attester:")
        .chain_update(&raw)
        .finalize()
        .into();
    k256::ecdsa::SigningKey::from_slice(&seed)
        .map_err(|e| eprintln!("[Decryptor] spend-attester seed is not a valid scalar: {e}"))
        .ok()
}

/// Recover the signing address from a 65-byte `r || s || v` signature over `digest`.
///
/// The inverse of [`sign_digest`], and the enclave's own `ecrecover`. Used to check that the ASP's
/// snapshot really came from the postman (see `spend::verify_snapshot`) — the enclave takes no
/// root from its caller, so this signature is the whole freshness anchor.
///
/// Rejects the high-S twin for the same reason the hub does: a malleable signature means one
/// authorisation exists in two encodings, and any nonce/replay bookkeeping keyed on the bytes can
/// then be bypassed by presenting the other form.
pub fn recover_signer(digest: &[u8; 32], sig: &[u8; 65]) -> Result<[u8; 20], AttestError> {
    // secp256k1 order / 2. Above this is the malleable twin of a signature below it.
    const HALF_CURVE_ORDER: [u8; 32] = [
        0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFF, 0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B,
        0x20, 0xA0,
    ];
    if sig[32..64] > HALF_CURVE_ORDER[..] {
        return Err(AttestError::MalleableSignature);
    }
    if sig[64] != 27 && sig[64] != 28 {
        return Err(AttestError::MalleableSignature);
    }
    let signature = k256::ecdsa::Signature::from_slice(&sig[..64])
        .map_err(|e| AttestError::BadSignature(format!("malformed r/s: {e}")))?;
    let recid = k256::ecdsa::RecoveryId::from_byte(sig[64] - 27)
        .ok_or_else(|| AttestError::BadSignature("bad recovery id".into()))?;
    let vk = k256::ecdsa::VerifyingKey::recover_from_prehash(digest, &signature, recid)
        .map_err(|e| AttestError::BadSignature(format!("recover: {e}")))?;
    Ok(address_from_verifying_key(&vk))
}

/// Reject an expiry that is already past, or so far ahead that the attestation stops meaning
/// "recently". A long-lived signature is a standing licence to spend a note that may be revoked
/// in the meantime — the exact hole this whole mechanism exists to close.
pub fn check_expiry(expiry: u64, now: u64, max_age: u64) -> Result<(), AttestError> {
    if expiry <= now || expiry > now + max_age {
        return Err(AttestError::BadExpiry { expiry, max_age });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
    }

    #[test]
    fn digest_binds_every_field() {
        let base = freshness_digest(1, [0xAA; 20], [0x77; 20], 0, [0xBB; 32], 100);
        assert_ne!(base, freshness_digest(2, [0xAA; 20], [0x77; 20], 0, [0xBB; 32], 100), "chainId must bind");
        assert_ne!(base, freshness_digest(1, [0xCC; 20], [0x77; 20], 0, [0xBB; 32], 100), "hub must bind");
        assert_ne!(base, freshness_digest(1, [0xAA; 20], [0x77; 20], 0, [0xDD; 32], 100), "piDigest must bind");
        assert_ne!(base, freshness_digest(1, [0xAA; 20], [0x77; 20], 0, [0xBB; 32], 101), "expiry must bind");
        assert_eq!(base, freshness_digest(1, [0xAA; 20], [0x77; 20], 0, [0xBB; 32], 100), "must be deterministic");
    }

    /// Byte-for-byte agreement with `ComplianceHub.freshnessDigest`.
    ///
    /// Vector emitted by `siphon-contracts-v2/evm/test/AttestDigestVector.t.sol`. If Solidity and
    /// Rust ever disagree on this preimage, the enclave signs a digest the hub cannot recover and
    /// EVERY strategy leg fails at fire time — hours after arming, with the fee already spent.
    /// Regenerate the vector, never "fix" it by loosening this assertion.
    #[test]
    fn digest_matches_solidity_abi_encode() {
        let mut hub = [0u8; 20];
        hub.copy_from_slice(&hex::decode("5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f").unwrap());
        let pi_digest: [u8; 32] = hex::decode(
            "2222222222222222222222222222222222222222222222222222222222222222",
        )
        .unwrap()
        .try_into()
        .unwrap();

        // The typehash string itself must match, or the digest silently diverges.
        let mut th = Keccak256::new();
        th.update(ATTEST_TYPEHASH);
        let th: [u8; 32] = th.finalize().into();
        assert_eq!(
            hex::encode(th),
            "7e0229a34c9a02e9bb172b0292c505a0ebe732a2744a2ac603f67bdd6c316b47",
            "ATTEST_TYPEHASH string drifted from ComplianceHub.ATTEST_TYPEHASH",
        );

        // address(uint160(0xCAFE0001)) — the KERNEL the Solidity vector was emitted for.
        let mut kernel = [0u8; 20];
        kernel.copy_from_slice(&hex::decode("00000000000000000000000000000000cafe0001").unwrap());

        let got = freshness_digest(31337, hub, kernel, 0, pi_digest, 1_700_000_000);
        assert_eq!(
            hex::encode(got),
            "f2fce9f43343459b31cf8ca0089bb24683365c13b11c6f8f362b7ecaec8b1142",
            "Rust digest != ComplianceHub.freshnessDigest — signatures would never recover",
        );
    }

    #[test]
    fn rotating_the_attester_epoch_invalidates_old_signatures() {
        // setAttester bumps attesterEpoch. If the epoch did not bind, a leaked key's signatures
        // would stay valid after the rotation performed to contain the leak.
        let a = freshness_digest(1, [0xAA; 20], [0x77; 20], 0, [0xBB; 32], 100);
        let b = freshness_digest(1, [0xAA; 20], [0x77; 20], 1, [0xBB; 32], 100);
        assert_ne!(a, b, "attesterEpoch must bind into the digest");
    }

    #[test]
    fn signature_recovers_to_the_attester_address() {
        let k = key();
        let addr = address_from_verifying_key(k.verifying_key());
        let digest = freshness_digest(11155111, [0x11; 20], [0x77; 20], 0, [0x22; 32], 1_700_000_000);
        let sig = sign_digest(&k, &digest).unwrap();

        assert!(sig[64] == 27 || sig[64] == 28, "v must be 27/28 for ecrecover, got {}", sig[64]);

        let recid = k256::ecdsa::RecoveryId::from_byte(sig[64] - 27).unwrap();
        let s = k256::ecdsa::Signature::from_bytes(sig[..64].into()).unwrap();
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(&digest, &s, recid).unwrap();
        assert_eq!(address_from_verifying_key(&recovered), addr, "hub's ecrecover must land on the attester");
    }

    #[test]
    fn signatures_are_low_s_so_they_cannot_be_malleated() {
        // A high-S twin would be a second valid encoding of the same authorisation.
        let k = key();
        for i in 0..16u8 {
            let sig = sign_digest(&k, &freshness_digest(1, [i; 20], [0x77; 20], 0, [i; 32], 1000 + i as u64)).unwrap();
            let s = k256::ecdsa::Signature::from_bytes(sig[..64].into()).unwrap();
            assert!(s.normalize_s().is_none(), "signature {i} was high-S");
        }
    }

    #[test]
    fn a_different_spend_gets_a_different_signature() {
        let k = key();
        let a = sign_digest(&k, &freshness_digest(1, [1; 20], [0x77; 20], 0, [1; 32], 500)).unwrap();
        let b = sign_digest(&k, &freshness_digest(1, [1; 20], [0x77; 20], 0, [2; 32], 500)).unwrap();
        assert_ne!(a, b, "one signature must not authorise two different spends");
    }

    #[test]
    fn expiry_window_is_enforced_on_both_ends() {
        assert!(check_expiry(1000, 900, 300).is_ok());
        assert!(matches!(check_expiry(900, 900, 300), Err(AttestError::BadExpiry { .. })), "expiry == now is already past");
        assert!(matches!(check_expiry(800, 900, 300), Err(AttestError::BadExpiry { .. })), "past expiry");
        assert!(matches!(check_expiry(1201, 900, 300), Err(AttestError::BadExpiry { .. })), "beyond max_age is a standing licence");
        assert!(check_expiry(1200, 900, 300).is_ok(), "exactly max_age is allowed");
    }
}

// ===========================================================================================
// Label <-> nullifier binding
// ===========================================================================================

/// One note the enclave is asked to vouch for, with the secrets needed to PROVE the label is the
/// one behind the published nullifierHash.
pub struct BindingInput<'a> {
    pub value: &'a str,
    pub label: &'a str,
    pub asset_id: &'a str,
    pub nullifier: &'a str,
    pub secret: &'a str,
}

/// Prove that `label` really is the label of the note whose `nullifierHash` the proof publishes,
/// and that the note exists.
///
/// Without this the whole mechanism is unsound, and the exploit is short:
///   1. Alice's label L is admitted; she arms a leg. Her proof binds revokedRoot R1 and proves
///      L is absent from revokedSet(R1) — true at the time.
///   2. Alice is revoked. The ASP publishes R2.
///   3. The hub accepts R1 because it *was* published, so the on-chain check no longer helps.
///   4. Alice tells the enclave her label is L_clean, a label from another of her deposits.
///      The enclave finds L_clean unrevoked and signs over the nullifierHash of the REVOKED note.
///   5. Proof verifies, signature verifies, revoked note spent.
///
/// Recomputing the commitment removes step 4: the enclave accepts the label only if
/// (value, label, assetId, nullifier, secret) hash to a commitment that is actually in the state
/// tree, and only if Poseidon(nullifier) is the nullifierHash the proof published. A substituted
/// label produces a different commitment, which is in no tree.
///
/// Membership is proved against `publicInputs[2]` — the state root the SPEND ITSELF publishes —
/// by recomputing the Merkle path, rather than by scanning a separately-fetched leaf set.
///
/// That distinction matters. A leaf-set scan answers "is this commitment in the tree as the ASP
/// last showed it to me", which is a different tree from the one the proof is bound to and drifts
/// from it constantly. Recomputing the path answers "is this commitment in the exact tree this
/// spend claims", which is the only question whose answer the chain will also enforce: the kernel
/// checks `publicInputs[2]` against `NoteTree.knownRoots`, so a root that verifies here is a root
/// the chain accepts. It is also cheaper — one hash chain instead of a full leaf sync.
///
/// The path cannot be forged: `verify_inclusion` recomputes up to the root, so a wrong sibling or
/// a wrong index yields a different root and fails. A caller who picks the index no longer picks
/// which leaf is compared, because the leaf is the commitment recomputed here from the note.
pub fn bind_label_to_nullifier(
    index: usize,
    note: &BindingInput<'_>,
    published_nullifier_hash: &str,
    state_root: &str,
    state_path: &spend_core::merkle::MerklePath,
) -> Result<(), AttestError> {
    use spend_core::poseidon::{field_from_str, field_to_str};

    let nh = spend_core::commitment::nullifier_hash(field_from_str(note.nullifier))
        .map_err(|e| AttestError::Poseidon(e.to_string()))?;
    if field_to_str(&nh) != published_nullifier_hash {
        return Err(AttestError::NullifierMismatch { index });
    }

    let c = spend_core::commitment::commitment(
        field_from_str(note.value),
        field_from_str(note.label),
        field_from_str(note.asset_id),
        field_from_str(note.nullifier),
        field_from_str(note.secret),
    )
    .map_err(|e| AttestError::Poseidon(e.to_string()))?;

    let in_tree = spend_core::merkle::verify_inclusion(c, field_from_str(state_root), state_path)
        .map_err(|e| AttestError::Poseidon(format!("state path {index}: {e}")))?;
    if !in_tree {
        return Err(AttestError::CommitmentNotInTree { index });
    }
    Ok(())
}

#[cfg(test)]
mod binding_tests {
    use super::*;
    use spend_core::poseidon::{field_from_str, field_to_str};

    struct Note {
        value: String,
        label: String,
        asset_id: String,
        nullifier: String,
        secret: String,
    }

    fn note(label: &str, nullifier: &str) -> Note {
        Note {
            value: "1000000".into(),
            label: label.into(),
            asset_id: "1461501637330902918203684832716283019655932542975".into(),
            nullifier: nullifier.into(),
            secret: "222222".into(),
        }
    }

    fn input(n: &Note) -> BindingInput<'_> {
        BindingInput {
            value: &n.value,
            label: &n.label,
            asset_id: &n.asset_id,
            nullifier: &n.nullifier,
            secret: &n.secret,
        }
    }

    fn commitment_of(n: &Note) -> String {
        field_to_str(
            &spend_core::commitment::commitment(
                field_from_str(&n.value),
                field_from_str(&n.label),
                field_from_str(&n.asset_id),
                field_from_str(&n.nullifier),
                field_from_str(&n.secret),
            )
            .unwrap(),
        )
    }

    fn nh_of(n: &Note) -> String {
        field_to_str(&spend_core::commitment::nullifier_hash(field_from_str(&n.nullifier)).unwrap())
    }

    /// Build a real state tree from `leaves` and return `(root, path_to_leaf_at(index))`.
    ///
    /// Membership is now proved against the root the SPEND publishes, so the tests have to build a
    /// genuine tree rather than hand over a leaf list — which is the point: a path is checked by
    /// recomputation, so it cannot be satisfied by simply naming a leaf.
    fn tree_with(leaves: &[String], index: usize) -> (String, spend_core::merkle::MerklePath) {
        let mut t = spend_core::merkle::IncrementalMerkleTree::new();
        for l in leaves {
            t.insert(field_from_str(l)).unwrap();
        }
        (field_to_str(&t.root()), t.path_at_index(index as u64))
    }

    /// A path into an EMPTY tree — structurally valid, but recomputes to the empty root, so any
    /// real commitment checked against a real root fails. Models "this note was never deposited".
    fn absent_path() -> (String, spend_core::merkle::MerklePath) {
        let t = spend_core::merkle::IncrementalMerkleTree::new();
        (field_to_str(&t.root()), t.path_at_index(0))
    }

    #[test]
    fn an_honest_note_binds() {
        let n = note("123456789", "111111");
        let (root, path) = tree_with(&[commitment_of(&n)], 0);
        bind_label_to_nullifier(0, &input(&n), &nh_of(&n), &root, &path).unwrap();
    }

    #[test]
    fn the_substituted_label_attack_is_refused() {
        // THE attack this function exists for: real note under a revoked label, but the caller
        // claims a clean label. The nullifier (and so the published nullifierHash) is the real one.
        let real = note("999999", "111111"); // the genuinely-revoked label
        let claimed = note("123456789", "111111"); // same nullifier, DIFFERENT label

        // The tree holds the REAL note.
        let (root, path) = tree_with(&[commitment_of(&real)], 0);

        // nullifierHash matches (same nullifier), so that check alone would pass...
        assert_eq!(nh_of(&claimed), nh_of(&real));
        // ...but the commitment recomputed from the claimed label is in no tree.
        assert_eq!(
            bind_label_to_nullifier(0, &input(&claimed), &nh_of(&real), &root, &path).unwrap_err(),
            AttestError::CommitmentNotInTree { index: 0 },
        );
        // The real label binds fine, which is what makes the refusal meaningful.
        bind_label_to_nullifier(0, &input(&real), &nh_of(&real), &root, &path).unwrap();
    }

    #[test]
    fn a_nullifier_that_is_not_the_published_one_is_refused() {
        // Attaching a different note's secrets to this spend's nullifierHash.
        let n = note("123456789", "111111");
        let other = note("123456789", "777777");
        assert_eq!(
            {
                let (root, path) = tree_with(&[commitment_of(&n)], 0);
                bind_label_to_nullifier(3, &input(&n), &nh_of(&other), &root, &path).unwrap_err()
            },
            AttestError::NullifierMismatch { index: 3 },
        );
    }

    #[test]
    fn a_note_absent_from_the_state_tree_is_refused() {
        // A fabricated note that was never deposited.
        let n = note("123456789", "111111");
        let (root, path) = absent_path();
        assert_eq!(
            bind_label_to_nullifier(0, &input(&n), &nh_of(&n), &root, &path).unwrap_err(),
            AttestError::CommitmentNotInTree { index: 0 },
        );
    }

    #[test]
    fn every_field_is_load_bearing_for_the_commitment() {
        // Tampering ANY field must break membership — otherwise the binding is partial and a
        // caller could vary the untested field freely.
        let n = note("123456789", "111111");
        let (root, path) = tree_with(&[commitment_of(&n)], 0);
        for (which, tampered) in [
            ("value", Note { value: "999".into(), ..note("123456789", "111111") }),
            ("assetId", Note { asset_id: "42".into(), ..note("123456789", "111111") }),
            ("secret", Note { secret: "999".into(), ..note("123456789", "111111") }),
        ] {
            assert_eq!(
                bind_label_to_nullifier(0, &input(&tampered), &nh_of(&n), &root, &path).unwrap_err(),
                AttestError::CommitmentNotInTree { index: 0 },
                "{which} was not bound into the commitment",
            );
        }
    }
}

// ===========================================================================================
// Public-input digest + the full attest flow
// ===========================================================================================

/// PROTOCOL §4 — must equal `PublicInputs.WIDTH` on-chain.
///
/// The compliance split does NOT widen this. `labelCommit` rides index 24, the one mux slot no
/// action used, so the digest the hub computes is unchanged and an attested spend built before
/// the split still hashes the same way (COMPLIANCE_CIRCUIT_SPLIT §6.1).
pub const PUBLIC_WIDTH: usize = 25;

// ── spend-core agreement, enforced at COMPILE TIME ──────────────────────────
//
// `spend-core` is an UNPINNED path dependency (`decryptor/Cargo.toml`), so cargo silently resolves
// it to whatever branch the sibling siphon-zk-v2 checkout happens to have out. That is not
// hypothetical: it is why `AspTree::index_of` appeared missing on one lineage and present on
// another, and the same command produced different results for two people.
//
// That break at least failed LOUDLY — two compile errors. The next PROGRAM_VERSION bump would not.
// A decryptor built against a spend-core with a different width computes a `pi_digest` the
// ComplianceHub does not agree with, so every attested spend is rejected on-chain with nothing in
// the build to explain why. These asserts turn "wrong branch checked out" into a build failure.
//
// If one of these fires, the fix is to check out the matching spend-core branch — NOT to edit the
// constant here to make it pass.
const _: () = assert!(
    PUBLIC_WIDTH == spend_core::PUBLIC_WIDTH,
    "attester PUBLIC_WIDTH disagrees with spend-core — wrong siphon-zk-v2 branch checked out? \
     pi_digest would not match PublicInputs.commitDigest and every attested spend would revert."
);

/// The version this decryptor speaks. Bound to spend-core so it cannot drift, and asserted against
/// the witness at prove time.
pub const PROGRAM_VERSION: u32 = spend_core::PROGRAM_VERSION;

const _: () = assert!(
    spend_core::LABEL_COMMIT_INDEX < PUBLIC_WIDTH,
    "labelCommit index is outside the public vector — spend-core and the attester disagree on the \
     public layout."
);

/// `keccak256(abi.encodePacked(uint256[25]))` — byte-identical to `PublicInputs.commitDigest`.
///
/// `abi.encodePacked` of a `uint256[25]` is simply the 25 words concatenated big-endian, with no
/// length prefix and no padding beyond each word. Limb 24 (`labelCommit`) is inside the digest,
/// so an attestation is bound to this spend's compliance binding as well as its amounts.
pub fn pi_digest(pi: &[String]) -> Result<[u8; 32], AttestError> {
    if pi.len() != PUBLIC_WIDTH {
        return Err(AttestError::Poseidon(format!(
            "publicInputs must be {PUBLIC_WIDTH} limbs (PROTOCOL §4), got {}",
            pi.len()
        )));
    }
    let mut h = Keccak256::new();
    for (i, limb) in pi.iter().enumerate() {
        let v = limb
            .parse::<num_bigint_dig::BigUint>()
            .map_err(|e| AttestError::Poseidon(format!("publicInputs[{i}]: {e}")))?;
        let be = v.to_bytes_be();
        if be.len() > 32 {
            return Err(AttestError::Poseidon(format!("publicInputs[{i}] exceeds 32 bytes")));
        }
        let mut word = [0u8; 32];
        word[32 - be.len()..].copy_from_slice(&be);
        h.update(word);
    }
    Ok(h.finalize().into())
}

/// PROTOCOL §4: nullifier hashes occupy limbs 9..14.
pub const NULLIFIER_HASH_OFFSET: usize = 9;

/// One armed note as the attester needs it.
pub struct AttestNote {
    pub value: String,
    pub label: String,
    pub asset_id: String,
    pub nullifier: String,
    pub secret: String,
}

/// Everything the hub will check, decided here.
pub struct AttestParams<'a> {
    pub chain_id: u64,
    pub hub: [u8; 20],
    /// The VaultKernel this attestation authorises — the hub takes it from `msg.sender`.
    pub kernel: [u8; 20],
    pub attester_epoch: u64,
    pub expiry: u64,
    pub now: u64,
    pub max_age: u64,
    pub public_inputs: &'a [String],
    /// One Merkle path per input note, in input order. Checked against `public_inputs[2]`, the
    /// state root this spend publishes — not against a separately-synced leaf set, which would be
    /// a different tree from the one the proof is bound to.
    pub state_paths: &'a [spend_core::merkle::MerklePath],
}

/// Decide whether to vouch for this spend, and sign if so.
///
/// Order matters and is deliberate:
///  1. expiry sanity — never mint a long-lived licence;
///  2. bind each label to the nullifierHash the proof publishes, by recomputing the commitment
///     (without this the revocation check below is vacuous — see [`bind_label_to_nullifier`]);
///  3. only then consult the revoked set, using the CURRENT snapshot;
///  4. sign the exact digest the hub recomputes.
///
/// Any failure returns an error and signs nothing. There is no partial success: the signature is
/// the whole statement, and a spend without one simply reverts on-chain.
pub fn attest_spend(
    key: &k256::ecdsa::SigningKey,
    notes: &[AttestNote],
    is_revoked: impl Fn(&str) -> bool,
    p: &AttestParams<'_>,
) -> Result<[u8; 65], AttestError> {
    check_expiry(p.expiry, p.now, p.max_age)?;

    if notes.is_empty() || notes.len() > 6 {
        return Err(AttestError::Poseidon(format!(
            "expected 1..=6 input notes, got {}",
            notes.len()
        )));
    }
    if p.public_inputs.len() != PUBLIC_WIDTH {
        return Err(AttestError::Poseidon(format!(
            "publicInputs must be {PUBLIC_WIDTH} limbs"
        )));
    }

    // Every nullifier slot the spend DECLARES must be covered by a note we actually bound.
    // Attesting fewer notes than `inputCount` would leave the remaining slots — real notes, being
    // really spent — vouched for without ever being checked against the revoked set.
    let declared: usize = p.public_inputs[1]
        .parse()
        .map_err(|_| AttestError::Poseidon("publicInputs[1] (inputCount) is not a number".into()))?;
    if declared != notes.len() {
        return Err(AttestError::Poseidon(format!(
            "inputCount {declared} != {} attested notes — unattested nullifier slots would ride along",
            notes.len()
        )));
    }

    // ---------------------------------------------------------------- decoy-note defence
    //
    // Binding label -> nullifierHash is NOT sufficient on its own, because nullifiers are not
    // unique across leaves: `VaultKernel.deposit` accepts `precommitment` verbatim with no
    // uniqueness check (only the governance surplus path enforces it), and uniqueness is otherwise
    // imposed only at burn time. So an attacker can mint a second leaf carrying the SAME nullifier
    // under a clean label, show the enclave that decoy, and have the kernel spend the revoked note:
    // both satisfy Poseidon(nullifier) == pi[9] and both are real leaves.
    //
    // Reconciling the sealed notes against pi's own value and asset limbs closes it. The decoy must
    // now carry the same asset and the same total value as the spend it is covering for — and since
    // the shared nullifier is burned by that spend, the decoy is permanently stranded. Freeing X
    // costs exactly X, so there is nothing to gain.
    //
    // Circuit constraints being mirrored here:
    //   withdrawal.circom:94    primaryValue + secondaryValue === sum(inValue)
    //   withdrawal.circom:129   publicInputs[17] === inAssetId[0]
    //   swap.circom:46          srcAssetId <== publicInputs[23]
    let sum_in = notes.iter().try_fold(num_bigint_dig::BigUint::from(0u32), |acc, n| {
        n.value
            .parse::<num_bigint_dig::BigUint>()
            .map(|v| acc + v)
            .map_err(|e| AttestError::Poseidon(format!("note value: {e}")))
    })?;
    let primary = p.public_inputs[5]
        .parse::<num_bigint_dig::BigUint>()
        .map_err(|e| AttestError::Poseidon(format!("publicInputs[5]: {e}")))?;
    let secondary = p.public_inputs[6]
        .parse::<num_bigint_dig::BigUint>()
        .map_err(|e| AttestError::Poseidon(format!("publicInputs[6]: {e}")))?;
    let declared = primary + secondary;
    if sum_in != declared {
        return Err(AttestError::ValueMismatch {
            attested: sum_in.to_string(),
            declared: declared.to_string(),
        });
    }

    // Asset limb by action. Merge publishes none (it binds inAssetId[0] internally), so there is
    // nothing public to reconcile against there — but merge moves nothing out of the pool.
    let action: u8 = p.public_inputs[0]
        .parse()
        .map_err(|_| AttestError::Poseidon("publicInputs[0] (action) is not a number".into()))?;
    let asset_limb = match action {
        0 => Some(17usize), // withdraw
        2 => Some(23usize), // swap
        _ => None,
    };
    if let Some(limb) = asset_limb {
        for (i, n) in notes.iter().enumerate() {
            if n.asset_id != p.public_inputs[limb] {
                return Err(AttestError::AssetMismatch {
                    index: i,
                    limb,
                    got: n.asset_id.clone(),
                    want: p.public_inputs[limb].clone(),
                });
            }
        }
    }

    for (i, n) in notes.iter().enumerate() {
        let published = &p.public_inputs[NULLIFIER_HASH_OFFSET + i];
        bind_label_to_nullifier(
            i,
            &BindingInput {
                value: &n.value,
                label: &n.label,
                asset_id: &n.asset_id,
                nullifier: &n.nullifier,
                secret: &n.secret,
            },
            published,
            &p.public_inputs[2],
            p.state_paths.get(i).ok_or(AttestError::CommitmentNotInTree { index: i })?,
        )?;

        // Only meaningful AFTER the binding above: otherwise this checks a label the caller merely
        // asserted, and a revoked user substitutes a clean one.
        if is_revoked(&n.label) {
            return Err(AttestError::Revoked(n.label.clone()));
        }
    }

    let digest = freshness_digest(
        p.chain_id,
        p.hub,
        p.kernel,
        p.attester_epoch,
        pi_digest(p.public_inputs)?,
        p.expiry,
    );
    sign_digest(key, &digest)
}

#[cfg(test)]
mod attest_flow_tests {
    use super::*;
    use k256::ecdsa::SigningKey;
    use spend_core::poseidon::{field_from_str, field_to_str};

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[9u8; 32].into()).unwrap()
    }

    fn make_note(label: &str, nullifier: &str) -> AttestNote {
        AttestNote {
            value: "1000000".into(),
            label: label.into(),
            asset_id: "1461501637330902918203684832716283019655932542975".into(),
            nullifier: nullifier.into(),
            secret: "222222".into(),
        }
    }

    fn commitment_of(n: &AttestNote) -> String {
        field_to_str(
            &spend_core::commitment::commitment(
                field_from_str(&n.value),
                field_from_str(&n.label),
                field_from_str(&n.asset_id),
                field_from_str(&n.nullifier),
                field_from_str(&n.secret),
            )
            .unwrap(),
        )
    }

    fn nh_of(n: &AttestNote) -> String {
        field_to_str(&spend_core::commitment::nullifier_hash(field_from_str(&n.nullifier)).unwrap())
    }

    fn pi_with(nhs: &[String]) -> Vec<String> {
        let mut pi = vec!["0".to_string(); PUBLIC_WIDTH];
        pi[1] = nhs.len().to_string(); // inputCount must match the attested note count
        // Conservation + asset limbs, mirroring withdrawal.circom:94 and :129.
        pi[5] = (1_000_000u64 * nhs.len() as u64).to_string();
        pi[6] = "0".to_string();
        pi[17] = "1461501637330902918203684832716283019655932542975".to_string();
        for (i, nh) in nhs.iter().enumerate() {
            pi[NULLIFIER_HASH_OFFSET + i] = nh.clone();
        }
        pi
    }

    /// Build a real state tree from `leaves`, stamp its root into `pi[2]`, and return one path
    /// per leaf. Membership is proved against the root the spend publishes, so the tests must
    /// commit to an actual tree rather than hand over a leaf list.
    fn scene(pi: &mut [String], leaves: &[String]) -> Vec<spend_core::merkle::MerklePath> {
        let mut t = spend_core::merkle::IncrementalMerkleTree::new();
        for l in leaves {
            t.insert(field_from_str(l)).unwrap();
        }
        pi[2] = field_to_str(&t.root());
        // At least one path even for an empty tree, so "note was never deposited" is expressible.
        (0..leaves.len().max(1)).map(|i| t.path_at_index(i as u64)).collect()
    }

    fn params<'a>(pi: &'a [String], paths: &'a [spend_core::merkle::MerklePath]) -> AttestParams<'a> {
        AttestParams {
            chain_id: 84532,
            hub: [0x11; 20],
            kernel: [0x33; 20],
            attester_epoch: 0,
            expiry: 1_000_060,
            now: 1_000_000,
            max_age: 300,
            public_inputs: pi,
            state_paths: paths,
        }
    }

    #[test]
    fn an_honest_clean_leg_is_attested() {
        let n = make_note("123456789", "111111");
        let mut pi = pi_with(&[nh_of(&n)]);
        let leaves = vec![commitment_of(&n)];
        let paths = scene(&mut pi, &leaves);
        let sig = attest_spend(&key(), &[n], |_| false, &params(&pi, &paths)).unwrap();
        assert_eq!(sig.len(), 65);
    }

    #[test]
    fn a_revoked_label_is_refused() {
        let n = make_note("123456789", "111111");
        let mut pi = pi_with(&[nh_of(&n)]);
        let leaves = vec![commitment_of(&n)];
        let paths = scene(&mut pi, &leaves);
        let err = attest_spend(&key(), &[n], |l| l == "123456789", &params(&pi, &paths)).unwrap_err();
        assert_eq!(err, AttestError::Revoked("123456789".into()));
    }

    /// The end-to-end version of the substituted-label attack: a revoked note, a clean label
    /// claimed to the enclave. The revocation predicate would say "clean" — the BINDING is what
    /// stops it, and it must stop it before the predicate is even consulted.
    #[test]
    fn claiming_a_clean_label_for_a_revoked_note_is_refused() {
        let real = make_note("999999", "111111"); // revoked
        let claimed = make_note("123456789", "111111"); // clean label, same nullifier
        let mut pi = pi_with(&[nh_of(&real)]);
        let leaves = vec![commitment_of(&real)];
        let paths = scene(&mut pi, &leaves);

        let err = attest_spend(
            &key(),
            &[claimed],
            |l| l == "999999", // only the REAL label is revoked
            &params(&pi, &paths),
        )
        .unwrap_err();
        assert_eq!(err, AttestError::CommitmentNotInTree { index: 0 });
    }

    #[test]
    fn a_nullifier_hash_that_is_not_in_the_public_inputs_is_refused() {
        let n = make_note("123456789", "111111");
        let other = make_note("123456789", "777777");
        let mut pi = pi_with(&[nh_of(&other)]); // proof publishes a DIFFERENT note
        let leaves = vec![commitment_of(&n)];
        let paths = scene(&mut pi, &leaves);
        assert_eq!(
            attest_spend(&key(), &[n], |_| false, &params(&pi, &paths)).unwrap_err(),
            AttestError::NullifierMismatch { index: 0 },
        );
    }

    #[test]
    fn a_stale_or_overlong_expiry_signs_nothing() {
        let n = make_note("123456789", "111111");
        let mut pi = pi_with(&[nh_of(&n)]);
        let leaves = vec![commitment_of(&n)];
        let paths = scene(&mut pi, &leaves);

        let mut p = params(&pi, &paths);
        p.expiry = p.now; // already past
        assert!(matches!(
            attest_spend(&key(), std::slice::from_ref(&n), |_| false, &p),
            Err(AttestError::BadExpiry { .. })
        ));

        p.expiry = p.now + p.max_age + 1; // a standing licence
        assert!(matches!(
            attest_spend(&key(), &[n], |_| false, &p),
            Err(AttestError::BadExpiry { .. })
        ));
    }

    #[test]
    fn every_input_note_must_bind_not_just_the_first() {
        // A leg with two notes where only the SECOND is fabricated must still be refused.
        let a = make_note("111", "111111");
        let b = make_note("222", "222222");
        let mut pi = pi_with(&[nh_of(&a), nh_of(&b)]);
        let leaves = vec![commitment_of(&a)];
        let paths = scene(&mut pi, &leaves); // b is absent from the tree
        assert_eq!(
            attest_spend(&key(), &[a, b], |_| false, &params(&pi, &paths)).unwrap_err(),
            AttestError::CommitmentNotInTree { index: 1 },
        );
    }

    /// A spend declaring more inputs than the enclave was given would have the remaining
    /// nullifier slots vouched for without ever being bound or checked against the revoked set.
    #[test]
    fn attesting_fewer_notes_than_input_count_is_refused() {
        let a = make_note("111", "111111");
        let b = make_note("222", "222222");
        // pi declares TWO inputs...
        let mut pi = pi_with(&[nh_of(&a), nh_of(&b)]);
        let leaves = vec![commitment_of(&a), commitment_of(&b)];
        let paths = scene(&mut pi, &leaves);
        assert_eq!(pi[1], "2");

        // ...but only one note is offered for attestation.
        let err = attest_spend(&key(), &[a], |_| false, &params(&pi, &paths)).unwrap_err();
        match err {
            AttestError::Poseidon(m) => assert!(
                m.contains("unattested nullifier slots"),
                "wrong rejection reason: {m}"
            ),
            other => panic!("expected a coverage rejection, got {other:?}"),
        }
    }

    /// The mirror case: more notes than declared would attest slots the spend never uses.
    #[test]
    fn attesting_more_notes_than_input_count_is_refused() {
        let a = make_note("111", "111111");
        let b = make_note("222", "222222");
        let mut pi = pi_with(&[nh_of(&a)]); // declares ONE
        let leaves = vec![commitment_of(&a), commitment_of(&b)];
        let paths = scene(&mut pi, &leaves);
        assert!(attest_spend(&key(), &[a, b], |_| false, &params(&pi, &paths)).is_err());
    }

    /// THE decoy attack, end to end.
    ///
    /// Nullifiers are not unique across leaves — VaultKernel.deposit takes `precommitment`
    /// verbatim — so an attacker mints a second leaf under a CLEAN label carrying the SAME
    /// nullifier, and shows the enclave that one while the kernel spends the revoked note. Both
    /// satisfy Poseidon(nullifier) == pi[9]; both are genuine leaves. Only reconciling the sealed
    /// note against pi's own value/asset limbs stops it.
    #[test]
    fn a_cheap_decoy_note_sharing_a_nullifier_cannot_cover_for_a_revoked_note() {
        // The real note: revoked label, 1_000_000 units.
        let real = make_note("999999", "111111");
        // The decoy: clean label, SAME nullifier, worth 1 unit.
        let mut decoy = make_note("123456789", "111111");
        decoy.value = "1".into();

        // pi describes the REAL spend.
        let mut pi = pi_with(&[nh_of(&real)]);
        // Both leaves genuinely exist in the tree.
        let leaves = vec![commitment_of(&real), commitment_of(&decoy)];
        let paths = scene(&mut pi, &leaves);

        let err = attest_spend(
            &key(),
            &[decoy],
            |l| l == "999999", // only the real label is revoked
            &params(&pi, &paths),
        )
        .unwrap_err();

        // Refused on VALUE: the decoy is worth 1, the spend moves 1_000_000.
        assert!(
            matches!(err, AttestError::ValueMismatch { .. }),
            "the cheap decoy must be refused, got {err:?}",
        );
    }

    /// Making the decoy the same value removes the profit rather than the attack: the shared
    /// nullifier is burned by the spend, so the decoy is permanently stranded. Freeing X costs X.
    /// The enclave still refuses here because the decoy's label differs from the real note's, so
    /// its commitment must differ, and pi's nullifierHash pins which leaf is actually spent.
    #[test]
    fn an_equal_value_decoy_gains_nothing_and_is_still_asset_bound() {
        let real = make_note("999999", "111111");
        let mut decoy = make_note("123456789", "111111");
        decoy.asset_id = "42".into(); // a worthless token as the decoy asset
        let mut pi = pi_with(&[nh_of(&real)]);
        let leaves = vec![commitment_of(&real), commitment_of(&decoy)];
        let paths = scene(&mut pi, &leaves);

        let err = attest_spend(&key(), &[decoy], |l| l == "999999", &params(&pi, &paths)).unwrap_err();
        assert!(
            matches!(err, AttestError::AssetMismatch { .. }),
            "a decoy in a different asset must be refused, got {err:?}",
        );
    }

    #[test]
    fn a_value_that_does_not_conserve_is_refused() {
        let n = make_note("123456789", "111111");
        let mut pi = pi_with(&[nh_of(&n)]);
        let leaves = vec![commitment_of(&n)];
        let paths = scene(&mut pi, &leaves);
        let mut p = params(&pi, &paths);
        let inflated = vec![{
            let mut m = make_note("123456789", "111111");
            m.value = "999".into();
            m
        }];
        p.public_inputs = &pi;
        assert!(matches!(
            attest_spend(&key(), &inflated, |_| false, &p),
            Err(AttestError::ValueMismatch { .. })
        ));
    }

    #[test]
    fn the_signature_matches_what_the_hub_will_recompute() {
        let n = make_note("123456789", "111111");
        let mut pi = pi_with(&[nh_of(&n)]);
        let leaves = vec![commitment_of(&n)];
        let paths = scene(&mut pi, &leaves);
        let p = params(&pi, &paths);
        let k = key();
        let sig = attest_spend(&k, &[n], |_| false, &p).unwrap();

        let digest = freshness_digest(p.chain_id, p.hub, p.kernel, p.attester_epoch, pi_digest(&pi).unwrap(), p.expiry);
        let recid = k256::ecdsa::RecoveryId::from_byte(sig[64] - 27).unwrap();
        let s = k256::ecdsa::Signature::from_bytes(sig[..64].into()).unwrap();
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(&digest, &s, recid).unwrap();
        assert_eq!(
            address_from_verifying_key(&recovered),
            address_from_verifying_key(k.verifying_key()),
        );
    }

    /// `pi_digest` must equal `PublicInputs.commitDigest` byte-for-byte, or the enclave signs over
    /// a digest the hub never computes and every attested spend reverts as WrongAttester.
    /// Vector emitted by siphon-contracts-v2/evm/test/AttestDigestVector.t.sol.
    #[test]
    fn pi_digest_matches_solidity_commit_digest() {
        let pi: Vec<String> =
            (0..PUBLIC_WIDTH as u64).map(|i| (i * 1000 + 7).to_string()).collect();
        assert_eq!(
            hex::encode(pi_digest(&pi).unwrap()),
            "f13dde17178ab70675885d00f4f4fd41052da3c770f881d2b2dc0234243f558b",
            "pi_digest drifted from PublicInputs.commitDigest",
        );
    }

    #[test]
    fn pi_digest_rejects_a_malformed_public_encoding() {
        assert!(pi_digest(&vec!["0".to_string(); 24]).is_err());
        assert!(pi_digest(&[]).is_err());
        assert!(pi_digest(&vec!["0".to_string(); PUBLIC_WIDTH]).is_ok());
    }
}
