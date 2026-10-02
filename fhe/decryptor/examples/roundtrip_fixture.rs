//! Generate a live-round-trip fixture: a real ClientKey (same params as the fhe-engine:
//! PARAM_MESSAGE_2_CARRY_2_KS_PBS, 16 radix blocks) plus encrypted 1/0 result bits.
//! Used by scripts/live_roundtrip.mjs to verify the sealed upload + decrypt path end-to-end.
//! Output: JSON on stdout { client_key_hex, encrypted_one_hex, encrypted_zero_hex }.

use tfhe::integer::gen_keys_radix;
use tfhe::shortint::parameters::PARAM_MESSAGE_2_CARRY_2_KS_PBS;

fn main() {
    const NUM_BLOCKS: usize = 16; // matches fhe-engine core.rs
    let (cks, _sks) = gen_keys_radix(PARAM_MESSAGE_2_CARRY_2_KS_PBS, NUM_BLOCKS);
    let one = cks.encrypt(1u64);
    let zero = cks.encrypt(0u64);
    println!(
        "{}",
        serde_json::json!({
            "client_key_hex": hex::encode(bincode::serialize(&cks).unwrap()),
            "encrypted_one_hex": hex::encode(bincode::serialize(&one).unwrap()),
            "encrypted_zero_hex": hex::encode(bincode::serialize(&zero).unwrap()),
        })
    );
}
