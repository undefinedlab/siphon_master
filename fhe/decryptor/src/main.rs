//! Siphon decryptor — runs inside a Phala TDX enclave (dstack).
//!
//! Responsibility (intentionally tiny TCB):
//!   - hold each user's tfhe `ClientKey` IN MEMORY (received sealed to the enclave's attested key)
//!   - decrypt ONLY the fhe-engine's encrypted *result bit* → return { triggered: true|false }
//!
//! It must NEVER expose decrypted strategy inputs. The host/operator only ever sees ciphertext
//! and the boolean. See ../docs/PHALA_TEE_DECRYPTOR.md.

mod attester;
mod pipeline;
mod spend;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tfhe::integer::{ClientKey, RadixCiphertext};
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// userId -> ClientKey, held only in enclave memory.
type KeyStore = Arc<RwLock<HashMap<String, ClientKey>>>;

/// Directory on the dstack ENCRYPTED persistent volume where uploaded ClientKeys are mirrored,
/// so a CVM redeploy/restart doesn't strand every armed strategy (keys are otherwise memory-only).
/// Empty/unset => persistence disabled (pure in-memory, prior behavior).
fn key_dir() -> Option<PathBuf> {
    let d = std::env::var("DECRYPTOR_KEY_DIR").unwrap_or_else(|_| "/data/keys".into());
    if d.is_empty() { return None; }
    Some(PathBuf::from(d))
}

/// A userId (0x-address) is safe as a filename; sanitize defensively anyway.
fn key_path(dir: &PathBuf, user_id: &str, ext: &str) -> PathBuf {
    let safe: String = user_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == 'x').collect();
    dir.join(format!("{safe}.{ext}"))
}

/// Reseal-at-rest key, derived deterministically from the dstack KMS (app-scoped, so it
/// survives reboots AND replicas — unlike the per-boot x25519 upload-sealing key). With it,
/// persisted ClientKeys are XChaCha20-Poly1305 `.sealed` files that are useless without the
/// enclave, even to someone holding the decrypted volume. None => local dev (no KMS socket):
/// fall back to plaintext-hex persistence, as before.
#[derive(Clone)]
struct StorageSeal(chacha20poly1305::Key);

const SEALED_NONCE_LEN: usize = 24; // XChaCha20 nonce, prepended to each .sealed file

impl StorageSeal {
    async fn from_kms() -> Option<Self> {
        use sha2::Digest;
        let raw = crate::attester::kms_key("siphon-decryptor/storage-seal", "encrypt").await?;
        // Domain-separate the KMS material before using it as an AEAD key.
        let key: [u8; 32] = sha2::Sha256::new()
            .chain_update(b"siphon-decryptor-storage-seal:")
            .chain_update(&raw)
            .finalize()
            .into();
        Some(Self(key.into()))
    }

    fn encrypt(&self, plaintext: &[u8]) -> Option<Vec<u8>> {
        use chacha20poly1305::aead::{Aead, AeadCore, KeyInit};
        let cipher = chacha20poly1305::XChaCha20Poly1305::new(&self.0);
        let nonce = chacha20poly1305::XChaCha20Poly1305::generate_nonce(&mut rand_core::OsRng);
        let ct = cipher.encrypt(&nonce, plaintext).ok()?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        Some(out)
    }

    fn decrypt(&self, blob: &[u8]) -> Option<Vec<u8>> {
        use chacha20poly1305::aead::{Aead, KeyInit};
        if blob.len() <= SEALED_NONCE_LEN { return None; }
        let cipher = chacha20poly1305::XChaCha20Poly1305::new(&self.0);
        cipher.decrypt(blob[..SEALED_NONCE_LEN].into(), &blob[SEALED_NONCE_LEN..]).ok()
    }
}

/// Persist one uploaded key (best-effort — a write failure must never break the upload).
/// Sealed (`.sealed`) when the KMS seal is available; plaintext hex (`.hex`) only in local dev.
fn persist_key(user_id: &str, client_key_bytes: &[u8], seal: Option<&StorageSeal>) {
    let Some(dir) = key_dir() else { return };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[Decryptor] persist: mkdir {dir:?} failed: {e}");
        return;
    }
    let result = match seal {
        Some(s) => match s.encrypt(client_key_bytes) {
            Some(blob) => std::fs::write(key_path(&dir, user_id, "sealed"), blob),
            None => { eprintln!("[Decryptor] persist: seal failed for user"); return; }
        },
        None => std::fs::write(key_path(&dir, user_id, "hex"), hex::encode(client_key_bytes)),
    };
    if let Err(e) = result {
        eprintln!("[Decryptor] persist: write for user failed: {e}");
    }
}

/// Load persisted keys back into memory on startup. Best-effort: a corrupt/incompatible file is
/// skipped (the browser re-uploads), never fatal. Legacy plaintext `.hex` files are migrated to
/// `.sealed` (and removed) the first time a KMS seal is available.
fn load_persisted_keys(seal: Option<&StorageSeal>) -> HashMap<String, ClientKey> {
    let mut map = HashMap::new();
    let Some(dir) = key_dir() else { return map };
    let Ok(entries) = std::fs::read_dir(&dir) else { return map };
    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let Some(user_id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else { continue };
        let plain: Vec<u8> = match ext {
            "sealed" => {
                let Ok(blob) = std::fs::read(&path) else { continue };
                match seal.and_then(|s| s.decrypt(&blob)) {
                    Some(p) => p,
                    None => { eprintln!("[Decryptor] load: cannot unseal {path:?} (KMS key changed?)"); continue; }
                }
            }
            "hex" => {
                let Ok(hex_str) = std::fs::read_to_string(&path) else { continue };
                let Ok(bytes) = hex::decode(hex_str.trim()) else {
                    eprintln!("[Decryptor] load: skip {path:?}: bad hex");
                    continue;
                };
                bytes
            }
            _ => continue,
        };
        match bincode::deserialize::<ClientKey>(&plain) {
            Ok(ck) => {
                // Migrate legacy plaintext-at-rest to sealed the first boot we have the seal.
                if ext == "hex" {
                    if let Some(s) = seal {
                        persist_key(&user_id, &plain, Some(s));
                        if std::fs::remove_file(&path).is_ok() {
                            println!("[Decryptor] migrated {user_id} .hex -> .sealed");
                        }
                    }
                }
                map.insert(user_id, ck);
            }
            Err(e) => eprintln!("[Decryptor] load: skip {path:?}: {e}"),
        }
    }
    println!("[Decryptor] loaded {} persisted client key(s) from disk", map.len());
    map
}

/// Enclave x25519 identity, generated fresh each boot and held only in enclave memory.
/// The browser seals the ClientKey to `public` (libsodium sealed box) after verifying that
/// the TDX quote's report_data binds this exact pubkey. Ephemeral is fine: keys at rest live
/// on the TDX-encrypted volume (see `persist_key`), not under this keypair.
struct EnclaveIdentity {
    secret: crypto_box::SecretKey,
    public_hex: String,
}

impl EnclaveIdentity {
    fn generate() -> Self {
        let secret = crypto_box::SecretKey::generate(&mut rand_core::OsRng);
        let public_hex = hex::encode(secret.public_key().as_bytes());
        Self { secret, public_hex }
    }

    /// Domain-separated binding of the quote to this boot's pubkey (mirrors the
    /// order-signer's `sha256("siphon-order-signer:" + address)` pattern).
    fn report_data(&self) -> [u8; 32] {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(format!("siphon-decryptor:{}", self.public_hex).as_bytes());
        h.finalize().into()
    }
}

/// Armed legs live beside the ClientKeys but in their own subdir, so a leg file can never be
/// mistaken for a `<userId>.sealed` ClientKey by `load_persisted_keys`.
fn leg_dir() -> Option<PathBuf> {
    key_dir().map(|d| d.join("legs"))
}

/// Persist one armed leg. Sealed whenever the KMS key is available; refused outright otherwise —
/// unlike a ClientKey, a leg is directly spendable, so plaintext-at-rest is never an acceptable
/// dev fallback here.
fn persist_leg(key: &str, leg: &spend::ArmedLeg, seal: Option<&StorageSeal>) -> Result<(), String> {
    let Some(dir) = leg_dir() else { return Ok(()) };
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    let Some(seal) = seal else {
        return Err("refusing to persist an armed leg without the KMS storage-seal key".into());
    };
    let plain = serde_json::to_vec(leg).map_err(|e| format!("serialize leg: {e}"))?;
    let blob = seal.encrypt(&plain).ok_or("seal armed leg failed")?;
    std::fs::write(dir.join(format!("{key}.leg")), blob).map_err(|e| format!("write leg: {e}"))
}

fn forget_leg(key: &str) {
    if let Some(dir) = leg_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{key}.leg")));
    }
}

/// Restore armed legs on boot. Best-effort per file: one unreadable leg must not stop the others.
fn load_persisted_legs(seal: Option<&StorageSeal>) -> HashMap<String, spend::ArmedLeg> {
    let mut map = HashMap::new();
    let Some(dir) = leg_dir() else { return map };
    let Ok(entries) = std::fs::read_dir(&dir) else { return map };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("leg") { continue }
        let Some(key) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else { continue };
        let Ok(blob) = std::fs::read(&path) else { continue };
        let Some(plain) = seal.and_then(|s| s.decrypt(&blob)) else {
            eprintln!("[Decryptor] leg: cannot unseal {path:?} (KMS key changed?)");
            continue;
        };
        match serde_json::from_slice::<spend::ArmedLeg>(&plain) {
            Ok(leg) => { map.insert(key, leg); }
            Err(e) => eprintln!("[Decryptor] leg: skip {path:?}: {e}"),
        }
    }
    println!("[siphon-decryptor] restored {} armed leg(s)", map.len());
    map
}

// ---------------------------------------------------------------------------
// POST /spend/arm   { strategyId, legIndex, sealedSecrets, public }
// Unseal the browser payload, validate it, and hold it until the trigger fires.
// ---------------------------------------------------------------------------
/// POST /pipeline/unseal-hop — return one hop's note secrets from a sealed PipelineNoteBundle.
/// Called only by the executor (auth token), never by the browser.
async fn pipeline_unseal_hop(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<pipeline::UnsealHopReq>,
) -> Json<serde_json::Value> {
    if let Err(e) = check_auth(&st, &headers) {
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    match pipeline::unseal_hop(&req.sealed_bundle, req.hop_index, &st.identity.secret) {
        Ok(hop) => Json(serde_json::json!({ "ok": true, "hop": hop })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn arm_leg(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<spend::ArmReq>,
) -> Json<serde_json::Value> {
    if let Err(e) = check_auth(&st, &headers) {
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    let secrets = match spend::unseal_and_validate(&req.sealed_secrets, &st.identity.secret) {
        Ok(s) => s,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };

    let key = spend::leg_key(&req.strategy_id, req.leg_index);
    let leg = spend::ArmedLeg { secrets, public: req.public };

    // Persist BEFORE acknowledging: an ack the browser trusts, followed by a restart that loses the
    // leg, is a strategy that silently never fires after the arming fee is already paid.
    if let Err(e) = persist_leg(&key, &leg, (*st.storage_seal).as_ref()) {
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    st.legs.write().await.insert(key.clone(), leg);
    Json(serde_json::json!({ "ok": true, "legKey": key }))
}

// ---------------------------------------------------------------------------
// POST /spend/prove  { strategyId, legIndex }
// Fire time: sync the ASP, derive paths locally, assemble the witness, prove.
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProveReq {
    strategy_id: String,
    leg_index: u32,
    // The caller no longer supplies roots. It used to pass `onchainAdmittedRoot` /
    // `onchainRevokedRoot`, on the reasoning that a liar gained nothing because a wrong root would
    // fail the snapshot check or revert on-chain. That was true under `spend()`, which re-checked
    // the root; it is NOT true under `spendAttested`, which accepts any once-published revoked
    // root. And the check was circular anyway — the caller could read the same roots off
    // /set/leaves and echo them back. Freshness now comes from the ASP's own signed, timestamped
    // snapshot (see spend::verify_snapshot).
}

/// Prove a caller-supplied PROTOCOL witness. No arming, no attestation — just the prover.
///
/// This exists because the browser cannot do it in reasonable time. The zkey a spend needs is
/// chosen by its input count and ranges from 23MB (withdraw1) to 144MB (withdraw6/merge6), and
/// which one is needed is not known until the user picks an amount — so it cannot be prefetched,
/// and a slow connection pays a multi-minute download before proving even starts. rapidsnark in
/// here works against keys already resident on disk.
///
/// A caller CANNOT steer the circuit: prove-witness.cjs derives it from (action, inputCount)
/// inside the witness itself, never from a parameter, so a lying caller gets a proof for the
/// circuit its witness actually describes or none at all. The proof is verified against that
/// circuit's own verification key before it is returned.
///
/// PRIVACY — read before widening access. The witness holds note secrets in the clear. This is
/// the same enclave that already holds every user's FHE ClientKey and already sees the secrets of
/// every armed strategy leg, so it is not a NEW trust party; but it is a WIDER SET OF USERS,
/// because someone who never armed a strategy previously never sent this enclave anything. The
/// in-browser prover is still there and is what the app falls back to, so this must stay a
/// performance choice the client makes, never the only path.
///
/// Unlike `/spend/prove` this needs no snapshot policy: user-initiated spends go to `spend()`,
/// which re-checks the roots on-chain, not to `spendAttested()`.
async fn prove(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(witness): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    if let Err(e) = check_auth(&st, &headers) {
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }

    // try_acquire, never acquire: queueing here would hold the witness — and its note secrets — in
    // enclave memory for as long as the queue is deep, to deliver a proof slower than the browser
    // would have. Refusing immediately hands it back to the fallback.
    let Ok(_permit) = st.prove_slots.clone().try_acquire_owned() else {
        return Json(serde_json::json!({
            "ok": false, "error": "prover busy", "retryable": true
        }));
    };

    // spawn_blocking: prove_witness shells out and blocks for seconds. On a 2-vCPU CVM the runtime
    // has few worker threads, and blocking one of them stalls the trigger-decrypt loop that shares
    // it — the exact starvation this endpoint must not cause.
    let cfg = st.spend_cfg.clone();
    let result = tokio::task::spawn_blocking(move || spend::prove_witness(&cfg, &witness))
        .await
        .unwrap_or_else(|e| Err(format!("prover task failed: {e}")));

    match result {
        Ok(r) => Json(serde_json::json!({
            "ok": true,
            "circuit": r.circuit,
            "backend": r.backend,
            "proveMs": r.prove_ms,
            "proof": r.proof,
            "publicSignals": r.public_signals,
            // COMPLIANCE_CIRCUIT_SPLIT §2.2 — null only for ragequit. The caller MUST pass both
            // halves to VaultKernel.spend; sending the spend half alone reverts.
            "complianceProof": r.compliance.as_ref().map(|c| c.proof.clone()),
            "compliancePublicSignals": r.compliance.as_ref().map(|c| c.public_signals.clone()),
            "complianceCircuit": r.compliance.as_ref().map(|c| c.circuit.clone()),
            "complianceProveMs": r.compliance.as_ref().map(|c| c.prove_ms),
        })),
        // Retryable: a missing artifact or a spawn failure is an enclave problem, not a bad
        // witness, and the client should fall back to the browser rather than tell the user their
        // withdrawal is invalid.
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e, "retryable": true })),
    }
}

async fn prove_leg(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ProveReq>,
) -> Json<serde_json::Value> {
    if let Err(e) = check_auth(&st, &headers) {
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    let key = spend::leg_key(&req.strategy_id, req.leg_index);
    let Some(leg) = st.legs.read().await.get(&key).cloned() else {
        return Json(serde_json::json!({ "ok": false, "error": format!("no armed leg {key}") }));
    };

    let Some(policy) = st.spend_cfg.snapshot.as_ref() else {
        // Refusing beats proving against a snapshot nothing vouches for: without a policy the
        // enclave cannot tell a current revoked set from a replayed one.
        return Json(serde_json::json!({
            "ok": false,
            "error": "snapshot policy unconfigured (SNAPSHOT_CHAIN_ID / COMPLIANCE_HUB / ASP_POSTMAN_ADDRESS)",
        }));
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let snap = match spend::fetch_verified_snapshot(
        &st.spend_cfg.asp_base,
        &st.spend_cfg.screen_token,
        policy,
        now,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e, "retryable": true })),
    };

    let witness = match spend::build_witness(&leg, &snap) {
        Ok(w) => w,
        // A root mismatch means the tree the enclave rebuilt disagrees with the roots the ASP
        // served. That is transient whenever the snapshot moved between the fetch and the path
        // derivation, and the leg is still armed and still valid — so it must NOT burn a leg the
        // user paid an arming fee for. (It is also what a builder-side bug looks like, in which
        // case it retries, gives up, and the log names the error either way.)
        Err(e) => {
            let retryable = matches!(
                e,
                spend::SpendError::AspRootMismatch | spend::SpendError::RevokedRootMismatch
            );
            return Json(serde_json::json!({
                "ok": false, "error": e.to_string(), "retryable": retryable
            }));
        }
    };

    let proved = match spend::prove_witness(&st.spend_cfg, &witness) {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };

    // The proof alone cannot say "not revoked NOW": it proves non-inclusion in whatever revoked
    // root it was built against, and the hub accepts any once-published root. The attestation is
    // what supplies that freshness — so a leg without one is unspendable via spendAttested, and
    // returning the proof unattested would just move the failure on-chain after gas is paid.
    let attestation = match attest_proved_leg(&st, &leg, &snap, &proved).await {
        Ok(a) => a,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };

    Json(serde_json::json!({
        "ok": true,
        "circuit": proved.circuit,
        "backend": proved.backend,
        "proveMs": proved.prove_ms,
        "proof": proved.proof,
        "publicSignals": proved.public_signals,
        "complianceProof": proved.compliance.as_ref().map(|c| c.proof.clone()),
        "compliancePublicSignals": proved.compliance.as_ref().map(|c| c.public_signals.clone()),
        // The executor holds no part of the leg's public half, so it cannot derive these itself.
        "rawPayee": attestation.raw_payee,
        "splitCommitments": attestation.split_commitments,
        "attestationExpiry": attestation.expiry,
        "attesterSig": attestation.sig,
    }))
}

/// The address governance must register via `ComplianceHub.setAttester`.
///
/// Read-only and unauthenticated on purpose: it is a public key's address, and an operator has to
/// be able to fetch it before the enclave has ever attested anything. Deriving it here rather than
/// hand-copying it is what stops a registration typo, which would fail closed on every leg.
///
/// Reminder for whoever registers it: this address proves the key came from THIS app_id, not from
/// the reviewed build — dstack derives KMS keys per app_id, not per measurement. Check the quote
/// separately before trusting it.
async fn attester_address(State(st): State<AppState>) -> Json<serde_json::Value> {
    match attester_key_or_err(&st).await {
        Ok(key) => {
            let addr = crate::attester::address_from_verifying_key(key.verifying_key());
            // chainId / hub / kernel are the OTHER three inputs to ComplianceHub.freshnessDigest.
            // Publishing them is safe — they are public chain data, and the compose file already
            // says so — and without them a digest mismatch is undiagnosable from outside: the
            // signature simply recovers to some unrelated address and the hub says WrongAttester,
            // naming neither the value it disagreed with nor the one the enclave used.
            let policy = st.spend_cfg.snapshot.as_ref();
            Json(serde_json::json!({
                "ok": true,
                "attester": format!("0x{}", hex::encode(addr)),
                "keyPath": crate::attester::ATTESTER_KEY_PATH,
                "attesterEpoch": st.spend_cfg.attester_epoch,
                "attestationTtlSecs": st.spend_cfg.attestation_ttl_secs,
                "chainId": policy.map(|p| p.chain_id),
                "hub": policy.map(|p| format!("0x{}", hex::encode(p.hub))),
                "kernel": st.spend_cfg.kernel.map(|k| format!("0x{}", hex::encode(k))),
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

struct SpendAttestation {
    raw_payee: String,
    split_commitments: Vec<String>,
    expiry: u64,
    sig: String,
}

/// Decide whether to vouch for a freshly-proved leg, and sign if so.
///
/// Every input here is one the enclave derived or holds sealed — the notes come from the sealed
/// arm payload, the paths and roots from the witness the enclave just built, and the revoked set
/// from the postman-signed snapshot. Nothing is taken from the caller.
async fn attest_proved_leg(
    st: &AppState,
    leg: &spend::ArmedLeg,
    snap: &spend::AspSnapshot,
    proved: &spend::ProofResult,
) -> Result<SpendAttestation, String> {
    use crate::attester::{attest_spend, AttestNote, AttestParams};

    let policy = st.spend_cfg.snapshot.as_ref().ok_or("snapshot policy unconfigured")?;
    let kernel = st.spend_cfg.kernel.ok_or("VAULT_KERNEL unset — cannot bind the attestation")?;
    let key = attester_key_or_err(st).await?;

    let public_inputs: Vec<String> = proved
        .public_signals
        .as_array()
        .ok_or("prover returned non-array publicSignals")?
        .iter()
        .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
        .collect();

    let state_paths = spend::state_paths_from_public(&leg.public).map_err(|e| e.to_string())?;

    let notes: Vec<AttestNote> = leg
        .secrets
        .inputs
        .iter()
        .map(|i| AttestNote {
            value: i.value.clone(),
            label: i.label.clone(),
            asset_id: i.asset_id.clone(),
            nullifier: i.nullifier.clone(),
            secret: i.secret.clone(),
        })
        .collect();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ttl = st.spend_cfg.attestation_ttl_secs;

    let sig = attest_spend(
        &key,
        &notes,
        |label| snap.is_revoked(label),
        &AttestParams {
            chain_id: policy.chain_id,
            hub: policy.hub,
            kernel,
            attester_epoch: st.spend_cfg.attester_epoch,
            expiry: now + ttl,
            now,
            max_age: ttl,
            public_inputs: &public_inputs,
            state_paths: &state_paths,
        },
    )
    .map_err(|e| e.to_string())?;

    let raw_payee = leg
        .public
        .get("rawPayeeHex")
        .and_then(|v| v.as_str())
        .unwrap_or("00".repeat(20).as_str())
        .trim_start_matches("0x")
        .to_string();

    let split_commitments = leg
        .public
        .get("splitCommitments")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(|v| v.as_str().unwrap_or("0").to_string()).collect())
        .unwrap_or_default();

    Ok(SpendAttestation {
        raw_payee,
        split_commitments,
        expiry: now + ttl,
        sig: hex::encode(sig),
    })
}

/// Derive the attester key once and keep it for the process lifetime.
///
/// It is deterministic per app_id, so re-deriving per request would be a KMS round trip for the
/// same 32 bytes — on a 2-vCPU CVM that is latency a firing leg cannot spare.
async fn attester_key_or_err(st: &AppState) -> Result<k256::ecdsa::SigningKey, String> {
    if let Some(k) = st.attester_key.read().await.as_ref() {
        return Ok(k.clone());
    }
    let key = crate::attester::attester_key_from_kms()
        .await
        .ok_or("spend-attester key unavailable (no dstack KMS — refusing to attest)")?;
    *st.attester_key.write().await = Some(key.clone());
    Ok(key)
}

// ---------------------------------------------------------------------------
// POST /spend/disarm  { strategyId, legIndex }
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisarmReq {
    strategy_id: String,
    leg_index: u32,
}

async fn disarm_leg(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DisarmReq>,
) -> Json<serde_json::Value> {
    if let Err(e) = check_auth(&st, &headers) {
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    let key = spend::leg_key(&req.strategy_id, req.leg_index);
    let existed = st.legs.write().await.remove(&key).is_some();
    forget_leg(&key);
    Json(serde_json::json!({ "ok": true, "removed": existed }))
}

#[derive(Clone)]
struct AppState {
    keys: KeyStore,
    identity: Arc<EnclaveIdentity>,
    /// KMS-derived reseal-at-rest key (None in local dev — plaintext-hex persistence).
    storage_seal: Arc<Option<StorageSeal>>,
    /// Shared secret required on the state-changing / secret-revealing routes (/clientKey,
    /// /decrypt). The trade-executor sends it as `X-Decryptor-Token`. None => not enforced
    /// (legacy behavior), so it can be rolled out by setting DECRYPTOR_AUTH_TOKEN on both sides.
    auth_token: Arc<Option<String>>,
    /// `strategyId:legIndex` -> armed leg, awaiting its trigger. Mirrored to the encrypted volume
    /// under the same KMS storage-seal key as the ClientKeys: arming and firing can be hours apart,
    /// and a CVM restart in between must not strand the strategy.
    legs: Arc<RwLock<HashMap<String, spend::ArmedLeg>>>,
    /// KMS-derived spend-freshness signing key, cached for the process lifetime. Deterministic
    /// per app_id, so re-deriving per request would be a KMS round trip for the same 32 bytes —
    /// latency a firing leg cannot spare on a 2-vCPU CVM.
    attester_key: Arc<RwLock<Option<k256::ecdsa::SigningKey>>>,
    spend_cfg: Arc<spend::SpendConfig>,
    /// Concurrency budget for USER-initiated proving (`/prove`) only.
    ///
    /// This CVM has 2 vCPUs, and rapidsnark on a 144MB key is CPU- and RAM-hungry. Two of those at
    /// once starve the trigger-decrypt loop and can OOM the process that holds every ClientKey.
    ///
    /// Deliberately NOT applied to `/spend/prove`: a firing strategy leg is time-critical, has a
    /// paid-for arming fee behind it and has no fallback, whereas a user prove can always be
    /// answered in the browser. So when the enclave is busy, user proves are the ones that yield.
    prove_slots: Arc<tokio::sync::Semaphore>,
}

/// Gate a request on the shared decryptor token. No-op when the token isn't configured.
/// Without this, anyone who can reach the enclave and knows a victim's userId (a public address)
/// could call /decrypt to learn the private trigger bit, or overwrite a user's key via /clientKey.
fn check_auth(st: &AppState, headers: &HeaderMap) -> Result<(), String> {
    let Some(expected) = (&*st.auth_token).as_ref() else { return Ok(()) };
    let got = headers
        .get("x-decryptor-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // Length-aware constant-time-ish compare (token is high-entropy; avoids trivial timing leak).
    if got.len() == expected.len()
        && got
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
    {
        Ok(())
    } else {
        Err("unauthorized: invalid or missing X-Decryptor-Token".into())
    }
}

fn deserialize_hex<T: for<'de> serde::Deserialize<'de>>(hex_str: &str, label: &str) -> Result<T, String> {
    let bytes = hex::decode(hex_str).map_err(|e| format!("hex decode failed for {label}: {e}"))?;
    bincode::deserialize(&bytes).map_err(|e| format!("bincode deserialize failed for {label}: {e}"))
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "service": "siphon-decryptor", "status": "healthy" }))
}

// ---------------------------------------------------------------------------
// GET /attestation
// Returns the dstack/TDX quote with report_data = sha256("siphon-decryptor:" + pubkey_hex).
// The browser verifies the quote (signature chain via a DCAP verifier, compose-hash pin via
// the event log) and the report_data binding, then seals the ClientKey to `x25519_pubkey`.
// Outside a CVM (local dev, no guest socket) the quote is null — pubkey still returned so
// the sealed upload path itself can be exercised without attestation.
// ---------------------------------------------------------------------------
async fn attestation(State(st): State<AppState>) -> Json<serde_json::Value> {
    let rd = st.identity.report_data();
    let base = serde_json::json!({
        "x25519_pubkey": st.identity.public_hex,
        "report_data_hex": hex::encode(rd),
        "report_data_preimage": format!("siphon-decryptor:{}", st.identity.public_hex),
        "mock_kms": cfg!(feature = "mock-kms"),
    });
    let mut out = base;
    // A mock-KMS build has no TDX to quote from. Say so plainly instead of reporting an error:
    // the executor turns `error` into a 502, and the browser's mock mode keys on `mock_kms`.
    if cfg!(feature = "mock-kms") {
        out["quote"] = serde_json::Value::Null;
        return Json(out);
    }
    match dstack_sdk::dstack_client::DstackClient::new(None).get_quote(rd.to_vec()).await {
        Ok(q) => {
            out["quote"] = serde_json::json!(q.quote);
            out["event_log"] = serde_json::json!(q.event_log);
        }
        Err(e) => {
            eprintln!("[Decryptor] attestation: dstack get_quote failed: {e}");
            out["quote"] = serde_json::Value::Null;
            out["error"] = serde_json::json!(format!("attestation unavailable: {e}"));
        }
    }
    Json(out)
}

// ---------------------------------------------------------------------------
// POST /clientKey   { userId, clientKey }
// The ClientKey is sealed (libsodium sealed box / crypto_box_seal) to the enclave's attested
// x25519 pubkey by the browser, so it is never visible to the host or the executor proxy.
// For local dev (no enclave) a plain hex-encoded ClientKey is accepted behind a dev flag.
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct ClientKeyReq {
    user_id: String,
    /// hex(crypto_box_seal(bincode(ClientKey), enclave_pubkey)) — or plain hex(bincode(ClientKey))
    /// when SIPHON_DEV_PLAINTEXT_KEY=1 (local dev only).
    client_key: String,
}

#[derive(Serialize)]
struct OkResp {
    ok: bool,
    error: Option<String>,
}

async fn has_client_key(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(user_id): Path<String>,
) -> Json<serde_json::Value> {
    if let Err(e) = check_auth(&st, &headers) {
        return Json(serde_json::json!({ "has_key": false, "error": e }));
    }
    let has = st.keys.read().await.contains_key(&user_id);
    Json(serde_json::json!({ "has_key": has }))
}

async fn set_client_key(State(st): State<AppState>, headers: HeaderMap, Json(req): Json<ClientKeyReq>) -> Json<OkResp> {
    if let Err(e) = check_auth(&st, &headers) {
        return Json(OkResp { ok: false, error: Some(e) });
    }
    // Sealed path first: hex(crypto_box_seal(bincode(ClientKey), enclave_pubkey)). The browser
    // only seals after verifying the attestation quote binds our pubkey, so a successful unseal
    // means the key was released to *this* boot's enclave identity.
    //
    // The plaintext fallback (SIPHON_DEV_PLAINTEXT_KEY=1) exists ONLY for local dev where there is
    // no enclave to seal to. It is compiled OUT of release builds: in a Phala CVM the runtime env
    // is host-supplied, so if this branch shipped, the host could set the flag and harvest every
    // ClientKey in plaintext. In release `dev_plain` is a hard `false` the optimizer removes.
    #[cfg(debug_assertions)]
    let dev_plain = std::env::var("SIPHON_DEV_PLAINTEXT_KEY").as_deref() == Ok("1");
    #[cfg(not(debug_assertions))]
    let dev_plain = false;

    let sealed_attempt: Result<(ClientKey, Vec<u8>), String> = (|| {
        let blob = hex::decode(&req.client_key).map_err(|e| format!("hex decode failed: {e}"))?;
        let plain = st.identity.secret.unseal(&blob).map_err(|_| "sealed-box unseal failed (wrong enclave pubkey or corrupt blob)".to_string())?;
        let ck: ClientKey = bincode::deserialize(&plain).map_err(|e| format!("bincode deserialize failed after unseal: {e}"))?;
        Ok((ck, plain))
    })();

    // Persistence takes the raw bincode bytes; at rest they are AEAD-sealed under the KMS
    // storage key (see StorageSeal) — NOT under the per-boot upload keypair, which couldn't
    // re-open its own blobs after a reboot.
    let (ck, plain_bytes): (ClientKey, Vec<u8>) = match sealed_attempt {
        Ok(pair) => pair,
        Err(seal_err) if dev_plain => match deserialize_hex(&req.client_key, "client_key") {
            Ok(k) => match hex::decode(&req.client_key) {
                Ok(b) => (k, b),
                Err(e) => return Json(OkResp { ok: false, error: Some(format!("hex decode failed: {e}")) }),
            },
            Err(e) => return Json(OkResp { ok: false, error: Some(format!("{seal_err}; dev plaintext fallback also failed: {e}")) }),
        },
        Err(seal_err) => return Json(OkResp { ok: false, error: Some(seal_err) }),
    };

    // Insert into the in-memory map FIRST — that alone makes the key usable this boot — then persist
    // to the encrypted volume in the BACKGROUND. The persist is a synchronous fs::write, and on a
    // wedged/slow persistent volume that write can HANG; doing it inline once left the handler never
    // replying, so the dstack gateway dropped the connection (RemoteDisconnected / 500) even though
    // unseal+deserialize had already succeeded. Off the response path, a stuck disk can no longer
    // hang an upload: the key works now, and just won't survive a redeploy until the next successful
    // persist. spawn_blocking keeps the blocking write off the async runtime; the timeout stops us
    // awaiting a wedged write (the blocking thread drains on its own once the volume recovers).
    let user_id = req.user_id.clone();
    st.keys.write().await.insert(req.user_id, ck);
    let seal = Arc::clone(&st.storage_seal);
    tokio::spawn(async move {
        let done = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::task::spawn_blocking(move || {
                persist_key(&user_id, &plain_bytes, seal.as_ref().as_ref())
            }),
        )
        .await;
        if done.is_err() {
            eprintln!("[Decryptor] persist timed out (volume slow/wedged) — key held in memory only");
        }
    });
    Json(OkResp { ok: true, error: None })
}

// ---------------------------------------------------------------------------
// POST /decrypt   { userId, encryptedResultHex } -> { triggered }
// The ONLY decryption path. Decrypts the engine's 0/1 result RadixCiphertext to a bool.
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct DecryptReq {
    user_id: String,
    /// hex(bincode(RadixCiphertext)) — the engine's encrypted 0/1 result.
    encrypted_result: String,
}

#[derive(Serialize)]
struct DecryptResp {
    triggered: Option<bool>,
    error: Option<String>,
}

async fn decrypt(State(st): State<AppState>, headers: HeaderMap, Json(req): Json<DecryptReq>) -> Json<DecryptResp> {
    if let Err(e) = check_auth(&st, &headers) {
        return Json(DecryptResp { triggered: None, error: Some(e) });
    }
    let keys = st.keys.read().await;
    let ck = match keys.get(&req.user_id) {
        Some(k) => k,
        None => return Json(DecryptResp { triggered: None, error: Some("no client key for user (upload it after attestation)".into()) }),
    };

    let ct: RadixCiphertext = match deserialize_hex(&req.encrypted_result, "encrypted_result") {
        Ok(c) => c,
        Err(e) => return Json(DecryptResp { triggered: None, error: Some(e) }),
    };

    // The engine encodes the result as a radix integer 1 (true) / 0 (false). NUM_BLOCKS in the
    // engine is 16; decrypt_radix infers from the ciphertext. Non-zero => triggered.
    let value: u64 = ck.decrypt_radix(&ct);
    // Do NOT log the decrypted value or the triggered bit: that is exactly the private result the
    // enclave exists to protect, and container stdout is visible to the host. Log only that a
    // decrypt happened, and flag the key-mismatch case (result should be 0/1) without the value.
    let uid_tail = &req.user_id[req.user_id.len().saturating_sub(6)..];
    if value > 1 {
        // A boolean result can only be 0 or 1. Anything else means this enclave's ClientKey does
        // NOT match the ServerKey the engine evaluated under (stale/regenerated key) — the true
        // result is UNKNOWN. FAIL CLOSED: never fire a trade on a garbage decrypt. (Previously this
        // returned `value != 0` → almost always `true` → false executions.)
        eprintln!("[Decryptor] decrypt user=…{uid_tail}: non-boolean result — ClientKey/ServerKey mismatch, failing closed");
        return Json(DecryptResp {
            triggered: None,
            error: Some("client key mismatch (non-boolean result); re-upload the current client key".into()),
        });
    }
    Json(DecryptResp { triggered: Some(value == 1), error: None })
}

fn siphon_env_name() -> String {
    std::env::var("SIPHON_ENV")
        .or_else(|_| std::env::var("APP_ENV"))
        .unwrap_or_default()
        .to_lowercase()
}

fn is_production_env() -> bool {
    matches!(siphon_env_name().as_str(), "prod" | "production")
}

fn require_auth_token_in_production() {
    let token = std::env::var("DECRYPTOR_AUTH_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    if is_production_env() && token.is_none() {
        eprintln!(
            "[siphon-decryptor] FATAL: DECRYPTOR_AUTH_TOKEN must be set when SIPHON_ENV/APP_ENV is production"
        );
        std::process::exit(1);
    }
}

fn build_cors_layer() -> CorsLayer {
    let mut origin_values: Vec<HeaderValue> = Vec::new();
    const DEFAULTS: &[&str] = &[
        "https://siphon.money",
        "https://www.siphon.money",
        "https://siphon-app.vercel.app",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ];
    for origin in DEFAULTS {
        if let Ok(v) = HeaderValue::from_str(origin) {
            origin_values.push(v);
        }
    }
    if let Ok(extra) = std::env::var("CORS_ALLOWED_ORIGINS") {
        for part in extra.split(',') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(v) = HeaderValue::from_str(trimmed) {
                origin_values.push(v);
            }
        }
    }
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origin_values))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            HeaderName::from_static("x-decryptor-token"),
        ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The browser-side sealing (libsodium crypto_box_seal) must round-trip through
    /// `EnclaveIdentity.secret.unseal`, and a blob sealed to a different pubkey must fail.
    #[test]
    fn sealed_box_roundtrip() {
        let id = EnclaveIdentity::generate();
        let msg = b"not-a-real-clientkey";
        let sealed = id.secret.public_key().seal(&mut rand_core::OsRng, msg).unwrap();
        assert_eq!(id.secret.unseal(&sealed).unwrap(), msg);

        let other = EnclaveIdentity::generate();
        assert!(other.secret.unseal(&sealed).is_err());
    }

    #[test]
    fn storage_seal_roundtrip() {
        use sha2::Digest;
        let key: [u8; 32] = sha2::Sha256::digest(b"test-material").into();
        let seal = StorageSeal(key.into());
        let msg = b"persisted-clientkey-bytes";
        let blob = seal.encrypt(msg).unwrap();
        assert_eq!(seal.decrypt(&blob).unwrap(), msg);

        // Tampered ciphertext and wrong key must both fail.
        let mut bad = blob.clone();
        bad[SEALED_NONCE_LEN] ^= 1;
        assert!(seal.decrypt(&bad).is_none());
        let other_key: [u8; 32] = sha2::Sha256::digest(b"other").into();
        assert!(StorageSeal(other_key.into()).decrypt(&blob).is_none());
    }

    #[test]
    fn report_data_binds_pubkey() {
        use sha2::Digest;
        let id = EnclaveIdentity::generate();
        let expect: [u8; 32] =
            sha2::Sha256::digest(format!("siphon-decryptor:{}", id.public_hex).as_bytes()).into();
        assert_eq!(id.report_data(), expect);
    }

    #[test]
    fn production_env_detection() {
        std::env::set_var("SIPHON_ENV", "production");
        assert!(super::is_production_env());
        std::env::set_var("SIPHON_ENV", "dev");
        assert!(!super::is_production_env());
    }
}

#[tokio::main]
async fn main() {
    require_auth_token_in_production();
    // Restore keys persisted on the encrypted volume so a redeploy doesn't strand armed strategies.
    let identity = EnclaveIdentity::generate();
    println!("[siphon-decryptor] enclave x25519 pubkey: {}", identity.public_hex);
    if cfg!(feature = "mock-kms") {
        eprintln!("[siphon-decryptor] MOCK-KMS BUILD: keys derive from MOCK_KMS_SEED. This host is NOT a TEE.");
    }
    let storage_seal = StorageSeal::from_kms().await;
    println!(
        "[siphon-decryptor] at-rest persistence: {}",
        if storage_seal.is_some() { "SEALED (KMS-derived key)" } else { "plaintext hex (local dev — no KMS)" }
    );
    let auth_token = std::env::var("DECRYPTOR_AUTH_TOKEN").ok().filter(|s| !s.is_empty());
    println!(
        "[siphon-decryptor] /clientKey + /decrypt auth: {}",
        if auth_token.is_some() { "ENFORCED (X-Decryptor-Token)" } else { "OPEN (set DECRYPTOR_AUTH_TOKEN to enforce)" }
    );
    let spend_cfg = spend::SpendConfig::from_env();
    println!(
        "[siphon-decryptor] fire-time prover: backend={} asp={} artifacts={}",
        spend_cfg.backend,
        if spend_cfg.asp_base.is_empty() { "UNSET (/spend/prove will fail)" } else { &spend_cfg.asp_base },
        spend_cfg.artifacts_dir,
    );
    let storage_seal_ref = storage_seal.as_ref().map(|s| s.clone());
    let storage_seal_ref = storage_seal_ref.as_ref();
    let state = AppState {
        keys: Arc::new(RwLock::new(load_persisted_keys(storage_seal.as_ref()))),
        identity: Arc::new(identity),
        storage_seal: Arc::new(storage_seal),
        auth_token: Arc::new(auth_token),
        legs: Arc::new(RwLock::new(load_persisted_legs(storage_seal_ref))),
        spend_cfg: Arc::new(spend_cfg),
        attester_key: Arc::new(RwLock::new(None)),
        prove_slots: Arc::new(tokio::sync::Semaphore::new(
            std::env::var("PROVE_MAX_CONCURRENCY")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|n| *n >= 1)
                .unwrap_or(1),
        )),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/attestation", get(attestation))
        .route("/hasClientKey/:user_id", get(has_client_key))
        .route("/clientKey", post(set_client_key))
        .route("/decrypt", post(decrypt))
        .route("/spend/arm", post(arm_leg))
        .route("/spend/prove", post(prove_leg))
        .route("/prove", post(prove))
        .route("/spend/disarm", post(disarm_leg))
        .route("/spend/attester", get(attester_address))
        .route("/pipeline/unseal-hop", post(pipeline_unseal_hop))
        .layer(build_cors_layer())
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "5002".into());
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("[siphon-decryptor] listening on {addr}");
    axum::serve(listener, app).await.expect("serve");
}
