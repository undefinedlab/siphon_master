//! Host-side packing bisect for withdraw1 Groth16.
//! Fixtures from: node scripts/host-verify-withdraw1.mjs
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};
use siphon_vault_zk::verify::{
    negate_proof_a_be, publics_le_to_be, verify_proof, NR_PUBLIC_INPUTS, VK_ACCOUNT_BYTES,
};

fn fixtures_dir() -> std::path::PathBuf {
    let here = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.join("../../target/deploy/host-verify-fixtures")
}

fn load(name: &str) -> Vec<u8> {
    let p = fixtures_dir().join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("missing {}: {e}", p.display()))
}

fn try_verify(vk_raw: &[u8], proof: &[u8], publics_le_flat: &[u8], negate_a: bool) -> Result<(), String> {
    assert!(vk_raw.len() >= VK_ACCOUNT_BYTES);
    let mut alpha = [0u8; 64];
    alpha.copy_from_slice(&vk_raw[8..72]);
    let mut beta = [0u8; 128];
    beta.copy_from_slice(&vk_raw[72..200]);
    let mut gamma = [0u8; 128];
    gamma.copy_from_slice(&vk_raw[200..328]);
    let mut delta = [0u8; 128];
    delta.copy_from_slice(&vk_raw[328..456]);
    let mut ic = [[0u8; 64]; 26];
    for (i, slot) in ic.iter_mut().enumerate() {
        let start = 456 + i * 64;
        slot.copy_from_slice(&vk_raw[start..start + 64]);
    }
    let vk = Groth16Verifyingkey {
        nr_pubinputs: NR_PUBLIC_INPUTS,
        vk_alpha_g1: alpha,
        vk_beta_g2: beta,
        vk_gamme_g2: gamma,
        vk_delta_g2: delta,
        vk_ic: &ic,
    };

    let mut publics_le = [[0u8; 32]; NR_PUBLIC_INPUTS];
    for i in 0..NR_PUBLIC_INPUTS {
        publics_le[i].copy_from_slice(&publics_le_flat[i * 32..(i + 1) * 32]);
    }
    let publics = publics_le_to_be(&publics_le);

    let mut a = [0u8; 64];
    let mut b = [0u8; 128];
    let mut c = [0u8; 64];
    a.copy_from_slice(&proof[0..64]);
    b.copy_from_slice(&proof[64..192]);
    c.copy_from_slice(&proof[192..256]);
    if negate_a {
        a = negate_proof_a_be(&a);
    }

    let mut verifier = Groth16Verifier::<NR_PUBLIC_INPUTS>::new(&a, &b, &c, &publics, &vk)
        .map_err(|e| format!("new: {e:?}"))?;
    verifier.verify().map_err(|e| format!("verify: {e:?}"))
}

#[test]
fn e2e_via_verify_proof_api() {
    if !fixtures_dir().join("e2e.proof.c1.bin").exists() {
        eprintln!("skip: no e2e dump");
        return;
    }
    let vk = load("e2e.vk.c1.bin");
    let proof_vec = load("e2e.proof.c1.bin");
    let publics_flat = load("e2e.publics.le.bin");
    let mut proof = [0u8; 256];
    proof.copy_from_slice(&proof_vec);
    let mut publics = [[0u8; 32]; NR_PUBLIC_INPUTS];
    for i in 0..NR_PUBLIC_INPUTS {
        publics[i].copy_from_slice(&publics_flat[i * 32..(i + 1) * 32]);
    }
    verify_proof(&vk, &proof, &publics).expect("verify_proof API must accept e2e dump");
    eprintln!("verify_proof API OK");
}

#[test]
fn e2e_dumped_proof_bisect() {
    let dir = fixtures_dir();
    if !dir.join("e2e.proof.c1.bin").exists() || !dir.join("e2e.vk.c0.bin").exists() {
        eprintln!("skip: incomplete e2e dump");
        return;
    }
    let publics = load("e2e.publics.le.bin");
    let cases = [
        ("e2e.vk.c1", "e2e.proof.c1", true),
        ("e2e.vk.c1", "e2e.proof.c1", false),
        ("e2e.vk.c1", "e2e.proof.c0", true),
        ("e2e.vk.c1", "e2e.proof.c0", false),
        ("e2e.vk.c0", "e2e.proof.c1", true),
        ("e2e.vk.c0", "e2e.proof.c1", false),
        ("e2e.vk.c0", "e2e.proof.c0", true),
        ("e2e.vk.c0", "e2e.proof.c0", false),
    ];
    let mut ok = Vec::new();
    for (vk_name, proof_name, neg) in cases {
        let vk = load(&format!("{vk_name}.bin"));
        let proof = load(&format!("{proof_name}.bin"));
        match try_verify(&vk, &proof, &publics, neg) {
            Ok(()) => {
                println!("PASS {vk_name} + {proof_name} negate_a={neg}");
                ok.push(format!("{vk_name}+{proof_name}+neg={neg}"));
            }
            Err(e) => println!("FAIL {vk_name} + {proof_name} negate_a={neg}: {e}"),
        }
    }
    eprintln!("e2e working variants: {ok:?}");
    assert!(!ok.is_empty(), "e2e dump: no packing variant verified");
}

#[test]
fn bisect_withdraw1_packing() {
    if !fixtures_dir().join("proof.c1.bin").exists() {
        eprintln!("skip: run host-verify-withdraw1.mjs first");
        return;
    }
    let publics = load("publics.le.bin");
    let cases = [
        ("vk.c1", "proof.c1", true),
        ("vk.c1", "proof.c1", false),
        ("vk.c1", "proof.c0", true),
        ("vk.c1", "proof.c0", false),
        ("vk.c0", "proof.c1", true),
        ("vk.c0", "proof.c1", false),
        ("vk.c0", "proof.c0", true),
        ("vk.c0", "proof.c0", false),
    ];
    let mut ok = Vec::new();
    for (vk_name, proof_name, neg) in cases {
        let vk = load(&format!("{vk_name}.bin"));
        let proof = load(&format!("{proof_name}.bin"));
        match try_verify(&vk, &proof, &publics, neg) {
            Ok(()) => {
                println!("PASS {vk_name} + {proof_name} negate_a={neg}");
                ok.push(format!("{vk_name}+{proof_name}+neg={neg}"));
            }
            Err(e) => println!("FAIL {vk_name} + {proof_name} negate_a={neg}: {e}"),
        }
    }
    assert!(
        !ok.is_empty(),
        "no packing variant verified; got zero passes"
    );
    eprintln!("working variants: {ok:?}");
}
