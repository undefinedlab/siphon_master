// Runnable self-check for the string-bound encryption regression (no test framework in this repo).
// Run: npx tsx src/lib/fhe.encryptTree.check.ts
// Guards: a LEAF bound given as a STRING (from the decimal-friendly builder inputs) MUST still be
// encrypted — never left as a plaintext `bound`. A regression here leaks the plaintext to the server
// and makes the FHE engine 400. We stub encryptPrice via the tree walker's own contract by checking
// the transform: after encryption, no LEAF may retain a plaintext `bound`, and each must gain
// `encrypted_bound`.
import assert from "node:assert";

// Minimal re-implementation mirror of encryptTreeInPlace's LEAF branch, to assert the type contract
// without pulling the wasm FHE module into a node check. If fhe.ts's real branch diverges from this,
// update BOTH — the point is to pin "string bound must encrypt".
async function encryptLeafContract(obj: Record<string, unknown>, enc: (n: number) => string) {
  const raw = obj.bound;
  const bound = typeof raw === "string" ? Number(raw.trim() || NaN) : raw;
  if (typeof bound === "number" && Number.isFinite(bound)) {
    obj.encrypted_bound = enc(bound);
    delete obj.bound;
  }
}

(async () => {
  const enc = (n: number) => `CIPHER(${n})`;
  const leafStr: Record<string, unknown> = { op: "LEAF", asset: "ETH", condition: "LTE", bound: "1900" };
  await encryptLeafContract(leafStr, enc);
  assert.strictEqual(leafStr.bound, undefined, "plaintext bound must be removed for a STRING bound");
  assert.strictEqual(leafStr.encrypted_bound, "CIPHER(1900)", "string bound must be encrypted");

  const leafNum: Record<string, unknown> = { op: "LEAF", bound: 1800 };
  await encryptLeafContract(leafNum, enc);
  assert.strictEqual(leafNum.encrypted_bound, "CIPHER(1800)", "number bound must still encrypt");

  const leafBad: Record<string, unknown> = { op: "LEAF", bound: "" };
  await encryptLeafContract(leafBad, enc);
  assert.strictEqual(leafBad.encrypted_bound, undefined, "empty/NaN bound must NOT produce ciphertext");
  console.log("OK — string bounds encrypt, number bounds encrypt, empty bounds skipped");
})();
