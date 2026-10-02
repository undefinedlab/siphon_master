use tfhe::integer::{IntegerCiphertext, RadixCiphertext, ServerKey};

const NUM_BLOCKS: usize = 16;
// Results are 0/1 booleans — one block carries them. Bounds/prices stay NUM_BLOCKS wide,
// but widening the comparison's BooleanBlock back to 16 blocks (the old if_then_else) cost
// ~16 bootstraps for zero information, and made every tree AND/OR 16x more expensive.
const RESULT_BLOCKS: usize = 1;

/// Performs a homomorphic comparison and returns an encrypted 1-block integer
/// (1 for true, 0 for false). Wire type stays RadixCiphertext — decryptor and browser
/// infer block count from the ciphertext, so old 16-block stored results still decrypt.
/// current_price_cents is u64 to support asset prices above $42k (u32 overflows at ~$42.9M cents).
pub fn homomorphic_check(
    sks: &ServerKey,
    encrypted_trigger_price: &RadixCiphertext,
    condition: &str,
    current_price_cents: u64,
) -> Result<RadixCiphertext, String> {
    let encrypted_bool_result = match condition {
        "GTE" => sks.scalar_le_parallelized(encrypted_trigger_price, current_price_cents),
        "LTE" => sks.scalar_ge_parallelized(encrypted_trigger_price, current_price_cents),
        _ => return Err(format!("Invalid condition: {}", condition)),
    };

    Ok(encrypted_bool_result.into_radix(RESULT_BLOCKS, sks))
}

pub fn homomorphic_or(
    sks: &ServerKey,
    a: &RadixCiphertext,
    b: &RadixCiphertext,
) -> RadixCiphertext {
    sks.bitor_parallelized(a, b)
}

pub fn homomorphic_and(
    sks: &ServerKey,
    a: &RadixCiphertext,
    b: &RadixCiphertext,
) -> RadixCiphertext {
    sks.bitand_parallelized(a, b)
}

/// Logical NOT on a 0/1-valued ciphertext: flips the low bit (1 XOR x).
/// The trivial 1 must match the operand's width (results are 1-block now).
pub fn homomorphic_not(sks: &ServerKey, a: &RadixCiphertext) -> RadixCiphertext {
    let one = sks.create_trivial_radix(1u64, a.blocks().len());
    sks.bitxor_parallelized(a, &one)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tfhe::integer::gen_keys_radix;
    use tfhe::shortint::parameters::PARAM_MESSAGE_2_CARRY_2_KS_PBS;

    // Round-trip a comparison with a GUARANTEED-MATCHED keypair, in this exact build
    // (patched concrete-fft + aarch64-unix). If these asserts fail, the engine's PBS/FFT is
    // broken (build problem). If they pass, the engine logic is correct and any live 0-results
    // are a server-key mismatch, not an engine bug.
    #[test]
    fn homomorphic_check_roundtrip() {
        let (cks, sks) = gen_keys_radix(PARAM_MESSAGE_2_CARRY_2_KS_PBS, NUM_BLOCKS);

        // GTE arm == scalar_le(trigger, scalar) == (trigger <= scalar). (0 <= 100) -> 1
        let enc0 = cks.encrypt(0u64);
        let r = homomorphic_check(&sks, &enc0, "GTE", 100).unwrap();
        let v: u64 = cks.decrypt(&r);
        println!("ROUNDTRIP (0<=100)->{} (expect 1)", v);
        assert_eq!(v, 1, "(0<=100) must be 1");

        // (0 <= 0) -> 1
        let r2 = homomorphic_check(&sks, &enc0, "GTE", 0).unwrap();
        let v2: u64 = cks.decrypt(&r2);
        assert_eq!(v2, 1, "(0<=0) must be 1");

        // enc(500): (500 <= 100) -> 0
        let enc500 = cks.encrypt(500u64);
        let r3 = homomorphic_check(&sks, &enc500, "GTE", 100).unwrap();
        let v3: u64 = cks.decrypt(&r3);
        assert_eq!(v3, 0, "(500<=100) must be 0");

        // enc(60): (60 <= 4808) -> 1  (a real TWAP leg-1 scenario)
        let enc60 = cks.encrypt(60u64);
        let r4 = homomorphic_check(&sks, &enc60, "GTE", 4808).unwrap();
        let v4: u64 = cks.decrypt(&r4);
        assert_eq!(v4, 1, "(60<=4808) must be 1");
    }

    // Phase B proof: results are 1-block now. The 16-block RadixClientKey must still decrypt
    // them (this is exactly what the browser wasm decrypt_result and the TEE decryptor's
    // decrypt_radix do — both infer block count from the ciphertext), and AND/OR/NOT must
    // compose 1-block results. Serialization round-trips like the production wire format.
    #[test]
    fn one_block_results_decrypt_and_compose() {
        let (cks, sks) = gen_keys_radix(PARAM_MESSAGE_2_CARRY_2_KS_PBS, NUM_BLOCKS);

        let enc500 = cks.encrypt(500u64);
        let t = homomorphic_check(&sks, &enc500, "GTE", 1000).unwrap(); // 500<=1000 -> 1
        let f = homomorphic_check(&sks, &enc500, "GTE", 100).unwrap();  // 500<=100  -> 0
        assert_eq!(t.blocks().len(), 1, "result must be exactly 1 block");

        // 16-block client key decrypts the 1-block result (block count inferred from ct)
        let vt: u64 = cks.decrypt(&t);
        let vf: u64 = cks.decrypt(&f);
        assert_eq!((vt, vf), (1, 0));

        // Wire round-trip (bincode -> bytes -> bincode), as the executor/browser see it
        let bytes = bincode::serialize(&t).unwrap();
        let t2: RadixCiphertext = bincode::deserialize(&bytes).unwrap();
        let v2: u64 = cks.decrypt(&t2);
        assert_eq!(v2, 1);

        // Tree logic over 1-block results
        let and = homomorphic_and(&sks, &t, &f);
        let or = homomorphic_or(&sks, &t, &f);
        let not_f = homomorphic_not(&sks, &f);
        let va: u64 = cks.decrypt(&and);
        let vo: u64 = cks.decrypt(&or);
        let vn: u64 = cks.decrypt(&not_f);
        assert_eq!((va, vo, vn), (0, 1, 1), "AND/OR/NOT on 1-block results");
    }

    // Exercise the EXACT production server-key path: browser derives a CompressedServerKey from
    // the client key, serializes it; the engine deserializes + ServerKey::from(compressed). The
    // decompression rebuilds bootstrap keys (FFT) — if the concrete-fft patch corrupts that, this
    // fails while the expanded-key test above still passes. This is what the live flow uses.
    #[test]
    fn compressed_server_key_roundtrip() {
        use tfhe::integer::CompressedServerKey;
        let (cks, _expanded) = gen_keys_radix(PARAM_MESSAGE_2_CARRY_2_KS_PBS, NUM_BLOCKS);

        let compressed = CompressedServerKey::new_radix_compressed_server_key(cks.as_ref());
        // serialize -> deserialize, mirroring browser->engine transport
        let bytes = bincode::serialize(&compressed).unwrap();
        let compressed2: CompressedServerKey = bincode::deserialize(&bytes).unwrap();
        let sks = ServerKey::from(compressed2);

        let enc0 = cks.encrypt(0u64);
        let r = homomorphic_check(&sks, &enc0, "GTE", 100).unwrap();
        let v: u64 = cks.decrypt(&r);
        println!("COMPRESSED (0<=100)->{} (expect 1)", v);
        assert_eq!(v, 1, "(0<=100) with decompressed CompressedServerKey must be 1");

        let enc60 = cks.encrypt(60u64);
        let r2 = homomorphic_check(&sks, &enc60, "GTE", 4808).unwrap();
        let v2: u64 = cks.decrypt(&r2);
        assert_eq!(v2, 1, "(60<=4808) with decompressed server key must be 1");
    }

    // Consume the EXACT wasm-generated bytes (captured via /debugEval) and run them on native.
    // Run with: `cargo test --release wasm_keys_on_native -- --nocapture`
    // Skips cleanly if the capture files aren't present.
    #[test]
    fn wasm_keys_on_native() {
        use std::fs;
        use tfhe::integer::{CompressedServerKey, RadixClientKey};
        let dir = "testdata";
        let ck_hex = match fs::read_to_string(format!("{dir}/st_client.hex")) { Ok(s) => s, Err(_) => { eprintln!("SKIP wasm_keys_on_native: no testdata"); return; } };
        let sk_hex = fs::read_to_string(format!("{dir}/st_server.hex")).expect("st_server.hex");
        let ct_hex = fs::read_to_string(format!("{dir}/st_ct.hex")).expect("st_ct.hex");

        let de = |h: &str| hex::decode(h.trim()).expect("hex");
        let cks: RadixClientKey = bincode::deserialize(&de(&ck_hex)).expect("client key deser");
        let ct: RadixCiphertext = bincode::deserialize(&de(&ct_hex)).expect("ct deser");

        // 1) Does the wasm CLIENT key decrypt its own wasm CIPHERTEXT? (expect fire_time 0)
        let fire: u64 = cks.decrypt(&ct);
        println!("WASMNATIVE client-key decrypts ct (fire_time) = {fire} (expect 0)");

        // 2) Decompress the wasm COMPRESSED server key on native, then evaluate.
        let compressed: CompressedServerKey = bincode::deserialize(&de(&sk_hex)).expect("compressed server key deser");
        let sks = ServerKey::from(compressed);
        let r = homomorphic_check(&sks, &ct, "GTE", 100).unwrap();
        let v: u64 = cks.decrypt(&r);
        println!("WASMNATIVE (fire_time<=100) result = {v} (expect 1)");

        // 3) Control: native-derived server key from the SAME wasm client key.
        let native_compressed = CompressedServerKey::new_radix_compressed_server_key(cks.as_ref());
        let native_sks = ServerKey::from(native_compressed);
        let r2 = homomorphic_check(&native_sks, &ct, "GTE", 100).unwrap();
        let v2: u64 = cks.decrypt(&r2);
        println!("WASMNATIVE native-derived-server-key result = {v2} (expect 1)");
    }
}

