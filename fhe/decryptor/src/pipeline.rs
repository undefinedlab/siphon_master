//! Private multi-hop pipeline: unseal a browser-sealed PipelineNoteBundle hop.
//!
//! The browser seals `{ version, hops: [{ nullifier, secret, userSalt, precommitment }, …] }`
//! to the enclave's attested x25519 identity. At hop-advance time the executor asks for one hop
//! (never the full plaintext bundle) so intermediate note secrets stay inside the TEE/MPC boundary.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineHopSecrets {
    pub nullifier: String,
    pub secret: String,
    pub user_salt: String,
    pub precommitment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineNoteBundle {
    pub version: u32,
    pub hops: Vec<PipelineHopSecrets>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsealHopReq {
    pub sealed_bundle: String,
    pub hop_index: u32,
}

pub fn unseal_hop(
    sealed_hex: &str,
    hop_index: u32,
    secret: &crypto_box::SecretKey,
) -> Result<PipelineHopSecrets, String> {
    use crypto_box::aead::OsRng as _OsRng;
    let _ = &_OsRng;

    let blob = hex::decode(sealed_hex).map_err(|e| format!("sealedBundle is not hex: {e}"))?;
    let plain = secret
        .unseal(&blob)
        .map_err(|_| "sealedBundle did not unseal — sealed to a different enclave boot?".to_string())?;
    let bundle: PipelineNoteBundle = serde_json::from_slice(&plain)
        .map_err(|e| format!("sealed payload is not PipelineNoteBundle JSON: {e}"))?;
    if bundle.version != 1 {
        return Err(format!("unsupported pipeline bundle version {}", bundle.version));
    }
    let hop = bundle
        .hops
        .get(hop_index as usize)
        .ok_or_else(|| format!("hop_index {hop_index} out of range ({} hops)", bundle.hops.len()))?;
    if hop.nullifier.is_empty()
        || hop.secret.is_empty()
        || hop.user_salt.is_empty()
        || hop.precommitment.is_empty()
    {
        return Err(format!("pipeline hop {hop_index} is missing note secrets"));
    }
    Ok(hop.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto_box::aead::OsRng;

    #[test]
    fn sealed_pipeline_hop_round_trips() {
        let secret = crypto_box::SecretKey::generate(&mut OsRng);
        let bundle = PipelineNoteBundle {
            version: 1,
            hops: vec![
                PipelineHopSecrets {
                    nullifier: "1".into(),
                    secret: "2".into(),
                    user_salt: "3".into(),
                    precommitment: "4".into(),
                },
                PipelineHopSecrets {
                    nullifier: "5".into(),
                    secret: "6".into(),
                    user_salt: "7".into(),
                    precommitment: "8".into(),
                },
            ],
        };
        let json = serde_json::to_vec(&bundle).unwrap();
        let sealed = hex::encode(secret.public_key().seal(&mut OsRng, &json).unwrap());
        let hop = unseal_hop(&sealed, 1, &secret).unwrap();
        assert_eq!(hop.nullifier, "5");
        assert_eq!(hop.precommitment, "8");
    }

    #[test]
    fn wrong_enclave_refuses() {
        let a = crypto_box::SecretKey::generate(&mut OsRng);
        let b = crypto_box::SecretKey::generate(&mut OsRng);
        let bundle = PipelineNoteBundle {
            version: 1,
            hops: vec![PipelineHopSecrets {
                nullifier: "1".into(),
                secret: "2".into(),
                user_salt: "3".into(),
                precommitment: "4".into(),
            }],
        };
        let sealed =
            hex::encode(a.public_key().seal(&mut OsRng, &serde_json::to_vec(&bundle).unwrap()).unwrap());
        assert!(unseal_hop(&sealed, 0, &b).is_err());
    }
}
