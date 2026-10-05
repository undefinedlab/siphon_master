// Spike: time keygen and verify encrypt/decrypt roundtrip + sizes.
import * as fhe from "./pkg-node/siphon_fhe_wasm.js";

const t0 = performance.now();
const keys = fhe.generate_keys();
const t1 = performance.now();
console.log(`generate_keys(): ${((t1 - t0) / 1000).toFixed(2)}s`);
console.log(`  clientKey hex bytes: ${(keys.clientKey.length / 2 / 1024).toFixed(1)} KB`);
console.log(`  serverKey hex bytes: ${(keys.serverKey.length / 2 / 1024 / 1024).toFixed(2)} MB`);

const priceCents = 4250000n; // $42,500.00
const t2 = performance.now();
const ctHex = fhe.encrypt_price(priceCents, keys.clientKey);
const t3 = performance.now();
console.log(`encrypt_price(): ${(t3 - t2).toFixed(0)}ms, ct ${(ctHex.length / 2 / 1024).toFixed(1)} KB`);

// We can't run a homomorphic comparison here (needs server key ops), but we can verify
// the client-side decrypt path: re-encrypt 1 by encrypting cents and checking decrypt==value.
// For the trigger path, decrypt_result expects an engine result (1/0). Cross-impl test is separate.
// Here just sanity check decrypt of a known ciphertext of value 1.
const oneHex = fhe.encrypt_price(1n, keys.clientKey);
console.log(`decrypt_result(enc(1)) -> ${fhe.decrypt_result(oneHex, keys.clientKey)} (expect true)`);
const zeroHex = fhe.encrypt_price(0n, keys.clientKey);
console.log(`decrypt_result(enc(0)) -> ${fhe.decrypt_result(zeroHex, keys.clientKey)} (expect false)`);

// Persist artifacts for the cross-impl test against the Rust engine.
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/fhe_spike.json", JSON.stringify({
  serverKey: keys.serverKey,
  clientKey: keys.clientKey,
  encrypted_upper_bound: ctHex,   // enc(4_250_000)
  price_cents_plain: priceCents.toString(),
}));
console.log("wrote /tmp/fhe_spike.json for engine cross-check");
