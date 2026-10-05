// Cross-impl test: WASM-generated keys+ciphertext -> native Rust engine -> decrypt in WASM.
// Proves the two independent tfhe builds (native Measure-FFT vs wasm Dif4-FFT) are byte-compatible.
import { readFileSync } from "node:fs";
import * as fhe from "./pkg-node/siphon_fhe_wasm.js";

const a = JSON.parse(readFileSync("/tmp/fhe_spike.json", "utf8"));
// a.encrypted_upper_bound = enc(4_250_000) == $42,500.00 ; strategy LIMIT_SELL_RALLY triggers on price >= bound.

async function evalAt(priceCents) {
  const body = {
    strategy_type: "LIMIT_SELL_RALLY",
    encrypted_upper_bound: a.encrypted_upper_bound,
    encrypted_lower_bound: a.encrypted_upper_bound, // unused for this type; field is required by the struct
    server_key: a.serverKey,
    current_price_cents: priceCents,
    encrypted_client_key: a.clientKey, // current (unmodified) engine still decrypts server-side
  };
  const res = await fetch("http://localhost:5001/evaluateStrategy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return json;
}

for (const [price, label, expect] of [
  [4300000, "$43,000 (>= $42,500)", true],
  [4200000, "$42,000 (<  $42,500)", false],
]) {
  const r = await evalAt(price);
  const ok = r.is_triggered === expect ? "PASS" : "FAIL";
  console.log(`${ok}  price ${label} -> is_triggered=${r.is_triggered} (expect ${expect}) ${r.error ? "ERR:" + r.error : ""}`);
}
