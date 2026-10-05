// Real Groth16 proofs through the SDK's Prover, on the circuit team's v5 vector.
//   npx tsx packages/sdk-ts/src/v5/prove.check.ts        (Node; downloads ~60 MB once)
// Dev-beacon keys (chain 11155111) match the vector's test circuit build.
import assert from "node:assert";
import { Prover } from "./prover";
import { vec, vectorWorld } from "./testVector";

async function main() {
  const { plan, built } = await vectorWorld();
  const prover = new Prover({ cacheDir: process.env.SIPHON_SDK_ZK_CACHE || `${process.env.TMPDIR || "/tmp"}/siphon-zk-cache` });
  let t = Date.now();
  const proof = await prover.prove(11155111, "withdraw3", built.input, built.expectedPublics);
  assert.strictEqual(proof.length, 8);
  console.log(`withdraw3 proved + verified in ${Date.now() - t} ms`);
  t = Date.now();
  const half = await prover.proveCompliance({
    chainId: 11155111,
    labels: plan.selected.map((n) => BigInt(n.label)),
    compliance: built.compliance,
    salt: built.labelCommitSalt,
    expectedCommit: BigInt(built.expectedPublics[24]),
  });
  assert.deepStrictEqual(half.publicInputs, vec.expectedCompliancePublic);
  console.log(`compliance3 proved + verified in ${Date.now() - t} ms`);
  // A tampered witness must not produce a proof that passes the publics gate.
  await assert.rejects(prover.prove(11155111, "withdraw3", built.input, built.expectedPublics.map((v, i) => (i === 5 ? "751" : v))), /limb 5/);
  console.log("prove.check: OK — withdraw3 + compliance3 prove locally, verify, and bind to the vector's publics");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
