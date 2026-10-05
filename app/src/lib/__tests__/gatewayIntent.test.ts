/**
 * Parity for the gateway's v2 wallet intent.
 *
 * The GOLDEN messages below were produced by this builder and verified byte-for-byte against
 * api-gateway/app/deps/wallet_sig.py::canonical_intent_message. That is the only invariant that
 * matters here: the gateway recovers an address from its OWN re-encoding of the parsed body, so a
 * one-character drift rejects every fund-moving request and presents as a wallet problem rather
 * than a protocol mismatch. Regenerate deliberately, changing both sides together.
 *
 * The mirror of this file is api-gateway/tests/security/test_intent_parity.py, which pins the same
 * strings from the Python side — either side alone can drift without noticing.
 */
import { describe, expect, it } from "bun:test";
import { buildIntentMessage, deliveryKeySha256, newDeliveryKey } from "../apiKeys";

const PURCHASE_BODY = {
  tx_hash: "0x" + "ab".repeat(32),
  pack_id: "starter",
  chain_id: 8453,
  delivery_key_sha256: "c".repeat(64),
};

describe("canonical v2 intent", () => {
  it("matches the gateway's builder for a real purchase", async () => {
    expect(
      await buildIntentMessage({
        chainId: 8453,
        timestamp: "1788364442",
        nonce: "n-1",
        method: "post",
        path: "/v1/keys/purchase",
        body: PURCHASE_BODY,
      }),
    ).toBe(
      "Siphon API v2\n" +
        "chain_id:8453\n" +
        "timestamp:1788364442\n" +
        "nonce:n-1\n" +
        "method:POST\n" +
        "path:/v1/keys/purchase\n" +
        "body_sha256:9f446710acac8d3312c70f45bda719ad61fef6db88aec0387da8b7a506760fdb",
    );
  });

  it("sorts keys at every level, not just the top", async () => {
    // Python's json.dumps(sort_keys=True) is recursive; JSON.stringify preserves insertion order,
    // so a top-level-only sort passes the simple case above and fails on anything nested.
    expect(
      await buildIntentMessage({
        chainId: 11155111,
        timestamp: "1700000000",
        nonce: "zz",
        method: "POST",
        path: "/v1/keys/purchase",
        body: { z: 1, a: { d: [3, 2, { y: "ü", x: null }], c: true }, b: "sé" },
      }),
    ).toBe(
      "Siphon API v2\n" +
        "chain_id:11155111\n" +
        "timestamp:1700000000\n" +
        "nonce:zz\n" +
        "method:POST\n" +
        "path:/v1/keys/purchase\n" +
        "body_sha256:3509fcdb61e191239e6f361d7c5af5cedf0d3b57693f0f532e4c573dda1638c4",
    );
  });

  it("key order in the body cannot change the message", async () => {
    const args = { chainId: 8453, timestamp: "1", nonce: "n", method: "POST", path: "/p" };
    const a = await buildIntentMessage({ ...args, body: { b: 2, a: 1 } });
    const b = await buildIntentMessage({ ...args, body: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it("hashes the delivery key over raw bytes, not the hex string", async () => {
    // key_delivery.py does bytes.fromhex(raw[2:]) before hashing. Hashing the hex text instead
    // yields a value the gateway rejects with "does not match delivery_key_sha256".
    expect(await deliveryKeySha256("0x" + "00".repeat(32))).toBe(
      "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
    );
  });

  it("mints a 32-byte delivery key in the shape the gateway accepts", () => {
    // key_delivery.py::_KEY_RE
    expect(newDeliveryKey()).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(newDeliveryKey()).not.toBe(newDeliveryKey());
  });
});
