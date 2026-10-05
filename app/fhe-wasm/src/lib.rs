//! In-browser FHE for Siphon.
//!
//! Compiled to WASM with wasm-bindgen. Generates the tfhe-rs radix keypair, encrypts
//! price bounds, and decrypts the trigger result — all client-side, so the client key
//! never leaves the browser.
//!
//! The scheme MUST stay byte-compatible with the Rust FHE engine (`fhe/`) and the
//! (now-deprecated) payload generator:
//!   - `tfhe` 0.5 integer radix
//!   - `PARAM_MESSAGE_2_CARRY_2_KS_PBS`, NUM_BLOCKS = 16
//!   - serialized with bincode 1.3, hex-encoded
//! Any drift here breaks cross-implementation interop.

use tfhe::integer::{
    gen_keys_radix, ClientKey as IntegerClientKey, CompressedServerKey, RadixCiphertext,
    RadixClientKey, ServerKey,
};
use tfhe::shortint::parameters::PARAM_MESSAGE_2_CARRY_2_KS_PBS;
// Deterministic keygen: seed the shortint engine so the same seed yields a byte-identical ClientKey.
use tfhe::core_crypto::commons::generators::DeterministicSeeder;
use tfhe::core_crypto::commons::math::random::Seed;
use tfhe::core_crypto::prelude::ActivatedRandomGenerator;
use tfhe::shortint::engine::ShortintEngine;
use serde::Serialize;
use wasm_bindgen::prelude::*;

const NUM_BLOCKS: usize = 16;

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize)]
struct KeyPair {
    #[serde(rename = "clientKey")]
    client_key: String,
    /// Compressed server (evaluation) key — bincode+hex of `CompressedServerKey`.
    /// Two orders of magnitude smaller than the expanded `ServerKey` (~MBs vs ~100MB),
    /// so it's feasible to POST from the browser. The engine decompresses it on receipt.
    #[serde(rename = "serverKey")]
    server_key: String,
}

fn to_hex<T: serde::Serialize>(value: &T) -> Result<String, JsError> {
    let bytes = bincode::serialize(value).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(hex::encode(bytes))
}

fn from_hex<T: for<'de> serde::Deserialize<'de>>(hex_str: &str) -> Result<T, JsError> {
    let bytes = hex::decode(hex_str).map_err(|e| JsError::new(&format!("hex decode: {e}")))?;
    bincode::deserialize(&bytes).map_err(|e| JsError::new(&format!("bincode: {e}")))
}

/// Generate a fresh FHE keypair. Returns `{ clientKey: hex, serverKey: hex }` where
/// serverKey is a *compressed* server key (the engine decompresses it before use).
/// Heavy: server-key generation is single-threaded on wasm.
#[wasm_bindgen]
pub fn generate_keys() -> Result<JsValue, JsError> {
    // We only need the client key from this pair; the expanded ServerKey is discarded
    // in favour of the compressed one below.
    let (client_key, _server_key): (RadixClientKey, ServerKey) =
        gen_keys_radix(PARAM_MESSAGE_2_CARRY_2_KS_PBS, NUM_BLOCKS);

    // RadixClientKey derefs to the inner integer ClientKey, which the compressed
    // server-key constructor expects.
    let compressed_server_key =
        CompressedServerKey::new_radix_compressed_server_key(client_key.as_ref());

    let pair = KeyPair {
        client_key: to_hex(&client_key)?,
        server_key: to_hex(&compressed_server_key)?,
    };
    serde_wasm_bindgen::to_value(&pair).map_err(|e| JsError::new(&e.to_string()))
}

/// DETERMINISTIC keygen. The same `seed_hex` always produces a BYTE-IDENTICAL ClientKey, so every
/// device / login / cleared-localStorage for one wallet regenerates the SAME client key — old
/// ciphertexts can never mismatch a re-synced key (the multi-device "Ca vs Cb" bug). fhe.ts derives
/// the seed from the wallet's deterministic ECDSA signature (keccak256(sig)); the first 16 bytes
/// become the u128 seed.
///
/// Returns ONLY the client-key hex. The server key is re-derived on demand (`derive_server_key`);
/// since any server key derived from a given client key validly evaluates that client's ciphertexts,
/// building a compressed server key here would just waste the multi-second (single-threaded on wasm)
/// derivation, and its caller (fhe.ts getOrCreateClientKey) discards it anyway.
#[wasm_bindgen]
pub fn generate_keys_from_seed(seed_hex: &str) -> Result<String, JsError> {
    let seed = seed_to_u128(seed_hex)?;
    let mut det_seeder = DeterministicSeeder::<ActivatedRandomGenerator>::new(Seed(seed));
    let mut engine = ShortintEngine::new_from_seeder(&mut det_seeder);
    let params = PARAM_MESSAGE_2_CARRY_2_KS_PBS
        .try_into()
        .map_err(|_| JsError::new("shortint param set conversion failed"))?;
    let shortint_ck = engine.new_client_key(params);
    let integer_ck: IntegerClientKey = shortint_ck.into();
    let client_key: RadixClientKey = (integer_ck, NUM_BLOCKS).into();
    to_hex(&client_key)
}

/// First 16 bytes of a hex seed (optionally `0x`-prefixed) as a big-endian u128.
fn seed_to_u128(seed_hex: &str) -> Result<u128, JsError> {
    let bytes = hex::decode(seed_hex.trim_start_matches("0x"))
        .map_err(|e| JsError::new(&format!("seed hex decode: {e}")))?;
    if bytes.len() < 16 {
        return Err(JsError::new("seed must be at least 16 bytes"));
    }
    let mut arr = [0u8; 16];
    arr.copy_from_slice(&bytes[..16]);
    Ok(u128::from_be_bytes(arr))
}

/// Derive the (compressed) server key from an existing client key. Deterministic, so the
/// browser only needs to persist the small client key and can re-derive the server key
/// whenever the backend needs it re-uploaded — avoids storing the ~20MB server key locally.
#[wasm_bindgen]
pub fn derive_server_key(client_key_hex: &str) -> Result<String, JsError> {
    let cks: RadixClientKey = from_hex(client_key_hex)?;
    let compressed = CompressedServerKey::new_radix_compressed_server_key(cks.as_ref());
    to_hex(&compressed)
}

/// Encrypt a price in cents (price * 100) with the given client key.
/// Returns the ciphertext as hex (bincode-serialized RadixCiphertext).
#[wasm_bindgen]
pub fn encrypt_price(price_cents: u64, client_key_hex: &str) -> Result<String, JsError> {
    let cks: RadixClientKey = from_hex(client_key_hex)?;
    let ct: RadixCiphertext = cks.encrypt(price_cents);
    to_hex(&ct)
}

/// Decrypt an engine-produced result ciphertext. The engine encodes the trigger as 1/0,
/// matching the original server-side `client_key.decrypt::<u64>(ct) == 1`.
#[wasm_bindgen]
pub fn decrypt_result(ciphertext_hex: &str, client_key_hex: &str) -> Result<bool, JsError> {
    let cks: RadixClientKey = from_hex(client_key_hex)?;
    let ct: RadixCiphertext = from_hex(ciphertext_hex)?;
    Ok(cks.decrypt::<u64>(&ct) == 1)
}
