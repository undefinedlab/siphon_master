// Runnable self-check for v3 leg-secret sealing — no test framework in this repo.
//   npx tsx src/lib/v3/sealLegSecretsV3.check.ts
//
// Covers the two things that are expensive to get wrong:
//   1. validation — a malformed payload must be refused at ARMING. If it slips through, the failure
//      surfaces hours later when the trigger fires, after the arming fee is paid and the slice
//      notes are minted, and the strategy silently never executes.
//   2. the seal itself — an actual crypto_box_seal round-trip against a locally generated keypair,
//      proving the payload is recoverable ONLY with the enclave secret key and that no plaintext
//      survives in the sealed blob.
import assert from "node:assert";
import _sodium from "libsodium-wrappers";
import {
  assertLegSecretsComplete,
  encodeLegSecrets,
  type LegSecretsV3,
} from "./sealLegSecretsV3";

const input = (over: Partial<LegSecretsV3["inputs"][0]> = {}) => ({
  value: "1000000",
  nullifier: "111111",
  secret: "222222",
  label: "123456789",
  assetId: "1461501637330902918203684832716283019655932542975",
  stateLeafIndex: 0,
  ...over,
});

const swap = (over: Partial<LegSecretsV3> = {}): LegSecretsV3 => ({
  action: 2,
  inputs: [input()],
  outNullifier: "333333",
  outSecret: "444444",
  destNullifier: "555555",
  destSecret: "666666",
  labelSalt: "777777",
  ...over,
});

function rejects(s: unknown, re: RegExp, why: string) {
  assert.throws(() => assertLegSecretsComplete(s as LegSecretsV3), re, why);
}

async function main() {
  // ---- accepted shapes ------------------------------------------------------------------------
  assert.doesNotThrow(() => assertLegSecretsComplete(swap()), "a well-formed swap leg must pass");

  // COMPLIANCE_CIRCUIT_SPLIT: a missing or zero salt used to survive arming and only fail at fire
  // time, after the fee was spent — both must be caught here.
  rejects(swap({ labelSalt: undefined as unknown as string }), /labelSalt/, "missing labelSalt");
  rejects(swap({ labelSalt: "0" }), /labelSalt/, "zero labelSalt");
  rejects(swap({ labelSalt: "00" }), /labelSalt/, "zero-padded labelSalt");
  rejects(swap({ labelSalt: "0x1f" }), /labelSalt/, "hex labelSalt");
  assert.doesNotThrow(
    () => assertLegSecretsComplete({ ...swap(), action: 0, destNullifier: undefined, destSecret: undefined }),
    "withdraw needs no destination secrets",
  );
  assert.doesNotThrow(
    () =>
      assertLegSecretsComplete({
        ...swap(),
        action: 1,
        inputs: [input(), input({ nullifier: "999", stateLeafIndex: 1 })],
      }),
    "merge with 2 inputs must pass",
  );

  // ---- arity ----------------------------------------------------------------------------------
  rejects({ ...swap(), action: 7 }, /action must be/, "an unknown action has no circuit");
  rejects({ ...swap(), inputs: [] }, /at least one input/, "a leg with no inputs cannot be proved");
  rejects({ ...swap(), action: 1 }, /merge requires/, "merge with 1 input has no verifier");
  rejects(
    { ...swap(), inputs: Array.from({ length: 7 }, (_, i) => input({ nullifier: String(i), stateLeafIndex: i })) },
    /at most 6 inputs/,
    "arity 7 has no deployed verifier — must fail here, not on-chain as InvalidZKProof",
  );

  // ---- field hygiene --------------------------------------------------------------------------
  for (const field of ["value", "nullifier", "secret", "label", "assetId"] as const) {
    rejects({ ...swap(), inputs: [input({ [field]: "0xdeadbeef" })] }, new RegExp(field), `${field} must be decimal, not hex`);
    rejects({ ...swap(), inputs: [input({ [field]: undefined })] }, new RegExp(field), `${field} must be present`);
  }
  rejects({ ...swap(), inputs: [input({ stateLeafIndex: -1 })] }, /stateLeafIndex/, "negative leaf index");
  rejects({ ...swap(), inputs: [input({ stateLeafIndex: 1.5 })] }, /stateLeafIndex/, "fractional leaf index");
  rejects({ ...swap(), outNullifier: "" }, /outNullifier/, "change-note secrets are mandatory");
  rejects({ ...swap(), destNullifier: undefined }, /destNullifier/, "swap must bind outputPrecommitment");

  // Spending one note twice in a leg burns a single nullifier and drops the other's value.
  rejects(
    { ...swap(), action: 1, inputs: [input(), input({ stateLeafIndex: 1 })] },
    /duplicate input nullifier/,
    "the same note must not appear twice in one leg",
  );

  // ---- real seal round-trip -------------------------------------------------------------------
  await _sodium.ready;
  const enclave = _sodium.crypto_box_keypair();
  const secrets = swap();
  const payloadHex = encodeLegSecrets(secrets);

  const sealed = _sodium.crypto_box_seal(
    Uint8Array.from(payloadHex.match(/../g)!.map((h) => parseInt(h, 16))),
    enclave.publicKey,
  );

  // Only the enclave secret key opens it.
  const opened = _sodium.crypto_box_seal_open(sealed, enclave.publicKey, enclave.privateKey);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(opened)),
    secrets,
    "the enclave must recover exactly what was sealed",
  );

  // A different keypair must not open it — otherwise the seal is decorative.
  const other = _sodium.crypto_box_keypair();
  assert.throws(
    () => _sodium.crypto_box_seal_open(sealed, other.publicKey, other.privateKey),
    "a foreign keypair must NOT open the sealed blob",
  );

  // No plaintext secret survives in the ciphertext.
  const sealedHex = Buffer.from(sealed).toString("hex");
  for (const needle of [secrets.inputs[0].nullifier, secrets.inputs[0].secret, secrets.outSecret]) {
    assert.ok(
      !sealedHex.includes(Buffer.from(needle, "utf8").toString("hex")),
      `plaintext ${needle} leaked into the sealed blob`,
    );
  }
  assert.ok(sealed.length > payloadHex.length / 2, "sealed blob must carry the seal overhead");

  console.log("sealLegSecretsV3.check: OK — validation fails closed, seal opens only in the enclave");
}

main().catch((e) => {
  console.error("sealLegSecretsV3.check FAILED:", e.message);
  process.exit(1);
});
