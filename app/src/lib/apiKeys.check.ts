// Runnable self-check: a paid-but-uncredited API purchase must survive, and must be retried for
// the right reasons only.
//   npx tsx src/lib/apiKeys.check.ts
//
// The purchase is two steps — send USDC, then claim the credit — and the second one FAILED BY
// DESIGN on the first try: ethers' tx.wait() resolves at 1 confirmation, the gateway requires 2.
// The tx hash was a local const, so that guaranteed failure discarded it: the USDC was gone and the
// only record was a toast. Harmless on Sepolia; real money on Base.
//
// Two things have to hold. The receipt must round-trip through storage so the claim can be retried
// without paying twice, and the retry classifier must wait out ONLY the transient answers — the
// strings below are the gateway's own, so this fails loudly if someone rewords one.
import assert from "node:assert";

// jsdom-free localStorage stand-in; apiKeys only uses get/set/removeItem.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

async function main() {
  const m = await import("./apiKeys");

  // --- transient: worth waiting out --------------------------------------------------------
  // Verbatim from api-gateway/app/services/key_purchase.py and confirmations.py.
  const TRANSIENT: [string, number | undefined][] = [
    ["Payment transaction is missing, failed, or not yet confirmed.", 400],
    ["Could not reach the chain to verify your payment. The payment itself is unaffected — retry in a moment.", 503],
    ["Downstream unavailable", 503],
  ];
  for (const [msg, status] of TRANSIENT) {
    assert.ok(
      m.isRetryablePurchaseError(msg, status),
      `must be retried, not surfaced as a lost payment: ${msg.slice(0, 60)}`,
    );
  }

  // --- final: retrying only hides the real answer -------------------------------------------
  const FINAL: [string, number | undefined][] = [
    ["Payment transaction failed on-chain.", 400],
    ["Payment transaction not found on this chain.", 400],
    ["No matching USDC transfer to the Siphon API credit collector was found in this transaction.", 400],
    ["Unsupported chain_id for API credit purchase: 1", 400],
    ["Signature is stale", 401],
  ];
  for (const [msg, status] of FINAL) {
    assert.ok(
      !m.isRetryablePurchaseError(msg, status),
      `must fail fast, not spin: ${msg.slice(0, 60)}`,
    );
  }

  // "failed on-chain" contains "failed" and must NOT be caught by the "missing, failed, or not
  // yet" pattern — the two differ by a few words and mean opposite things about the user's money.
  assert.ok(!m.isRetryablePurchaseError("Payment transaction failed on-chain.", 400));

  // --- the receipt survives ------------------------------------------------------------------
  const WALLET = "0x57fBC5C7e1A40134eC3cE2fe06EBD26d9C7267A2";
  const receipt = {
    chainId: 8453,
    packId: "custom",
    usdcMinor: 1_000_000,
    txHash: "0x" + "ab".repeat(32),
    idempotencyKey: "11111111-2222-3333-4444-555555555555",
    ts: Date.now(),
  };
  m.savePendingPurchase(WALLET, receipt);

  // Case-insensitive on the wallet: the address the panel reads back is not always the same
  // casing as the one that paid, and a miss here looks exactly like a lost payment.
  assert.deepStrictEqual(m.loadPendingPurchase(8453, WALLET.toLowerCase()), receipt);
  assert.deepStrictEqual(m.loadPendingPurchase(8453, WALLET.toUpperCase().replace("0X", "0x")), receipt);

  // Scoped per chain, so a Sepolia receipt is never claimed against Base.
  assert.strictEqual(m.loadPendingPurchase(11155111, WALLET), null, "receipts must not cross chains");

  m.clearPendingPurchase(8453, WALLET);
  assert.strictEqual(m.loadPendingPurchase(8453, WALLET), null, "cleared receipt must not come back");

  // Garbage must read as "nothing pending", never throw into the panel's mount effect.
  store.set("siphon-api-pending-purchase-8453-" + WALLET.toLowerCase(), "{not json");
  assert.strictEqual(m.loadPendingPurchase(8453, WALLET), null, "corrupt receipt must be ignored");

  console.log(
    `apiKeys.check: OK — ${TRANSIENT.length} transient failures retry, ${FINAL.length} final ones ` +
      `fail fast, and the receipt round-trips per chain and case-insensitively`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
