//! Cross-language check: unseal a libsodium crypto_box_seal blob produced by the browser lib.
//! Usage: unseal_check <secret_key_hex> <sealed_hex>  → prints the unsealed plaintext.
fn main() {
    let mut args = std::env::args().skip(1);
    let sk_hex = args.next().expect("secret_key_hex");
    let sealed_hex = args.next().expect("sealed_hex");
    let sk_bytes: [u8; 32] = hex::decode(sk_hex).unwrap().try_into().unwrap();
    let sk = crypto_box::SecretKey::from(sk_bytes);
    let plain = sk.unseal(&hex::decode(sealed_hex).unwrap()).expect("unseal failed");
    println!("{}", String::from_utf8(plain).unwrap());
}
