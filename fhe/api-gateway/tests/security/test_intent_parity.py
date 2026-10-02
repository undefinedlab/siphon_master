"""The v2 intent message, pinned against the browser's builder.

Mirror of siphon-app/src/lib/__tests__/gatewayIntent.test.ts. The GOLDEN strings below were
produced by that TS builder and are byte-compared here.

Why this matters more than a normal test: the gateway recovers a signer from its OWN re-encoding
of the parsed body. If the two canonicalisers disagree by one byte, every fund-moving request from
the browser 401s with "Wallet signature does not match this request" — which reads like a wallet or
a user problem, not a protocol mismatch. That is exactly how /v1/keys/purchase was broken: the
client was signing `Siphon API v1:...` with no nonce at a route that requires this message.

Regenerate deliberately, changing both files together. Never edit a golden to make a test pass.
"""
from app.deps.wallet_sig import canonical_body_sha256, canonical_intent_message

PURCHASE_BODY = {
    "tx_hash": "0x" + "ab" * 32,
    "pack_id": "starter",
    "chain_id": 8453,
    "delivery_key_sha256": "c" * 64,
}


def test_purchase_intent_matches_the_browser():
    assert canonical_intent_message(
        chain_id=8453,
        timestamp="1788364442",
        nonce="n-1",
        method="post",
        path="/v1/keys/purchase",
        body=PURCHASE_BODY,
    ) == (
        "Siphon API v2\n"
        "chain_id:8453\n"
        "timestamp:1788364442\n"
        "nonce:n-1\n"
        "method:POST\n"
        "path:/v1/keys/purchase\n"
        "body_sha256:9f446710acac8d3312c70f45bda719ad61fef6db88aec0387da8b7a506760fdb"
    )


def test_nested_keys_sort_at_every_level():
    """json.dumps(sort_keys=True) is recursive. A JS canonicaliser that sorts only the top level
    passes the flat case above and silently diverges here, which is the harder failure to find."""
    assert canonical_intent_message(
        chain_id=11155111,
        timestamp="1700000000",
        nonce="zz",
        method="POST",
        path="/v1/keys/purchase",
        body={"z": 1, "a": {"d": [3, 2, {"y": "ü", "x": None}], "c": True}, "b": "sé"},
    ) == (
        "Siphon API v2\n"
        "chain_id:11155111\n"
        "timestamp:1700000000\n"
        "nonce:zz\n"
        "method:POST\n"
        "path:/v1/keys/purchase\n"
        "body_sha256:3509fcdb61e191239e6f361d7c5af5cedf0d3b57693f0f532e4c573dda1638c4"
    )


def test_body_key_order_cannot_change_the_message():
    a = canonical_body_sha256({"b": 2, "a": 1})
    b = canonical_body_sha256({"a": 1, "b": 2})
    assert a == b


def test_absent_body_hashes_as_empty_object():
    assert canonical_body_sha256(None) == canonical_body_sha256({})
