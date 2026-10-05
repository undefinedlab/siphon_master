// Runnable self-check: a paid-but-unverified compliance fee is retried, never paid twice.
//   npx tsx src/lib/complianceFeeRetry.check.ts
//
// Base, 2026-09-28: the app waited ONE block and verified at once; the ASP demands two, answered
// "fee transaction has 1/2 confirmations", and the next click paid the fee again. The strings below
// are the ASP's own FeeNotPaid texts (siphon-asp-v2 compliance_fee.py). Only the INVALID class may
// drop the remembered tx hash; everything else must keep it.
import assert from "node:assert";

async function main() {
  const { NOT_YET_CONFIRMED, PAYMENT_INVALID } = await import("./complianceFee");

  const notYet = ["fee transaction has 1/2 confirmations", "Transaction not found or not yet mined"];
  const transient = [
    "Cannot fetch transaction: HTTPSConnectionPool(host='mainnet.base.org'): Read timed out",
    "No RPC configured for chain 8453",
    "No compliance vault configured for chain 42161 (set ASP_COMPLIANCE_VAULT_42161)",
    "",
  ];
  const invalid = [
    "Transaction reverted",
    "Transaction sender 0x57fbc5c7… does not match wallet 0x0000dead…",
    "Transaction does not contain a valid fee payment of >=$0.50 to the compliance vault",
    "tx_hash already consumed for a KYT fee payment",
    "txHash must be 0x + 64 hex chars",
  ];

  for (const m of notYet) {
    assert.ok(NOT_YET_CONFIRMED.test(m), `should retry: ${m}`);
    assert.ok(!PAYMENT_INVALID.test(m), `must keep the paid tx: ${m}`);
  }
  for (const m of transient) assert.ok(!PAYMENT_INVALID.test(m), `must keep the paid tx on a blip: ${m}`);
  for (const m of invalid) {
    assert.ok(PAYMENT_INVALID.test(m), `may drop the tx: ${m}`);
    assert.ok(!NOT_YET_CONFIRMED.test(m), `must not spin on a final answer: ${m}`);
  }
  console.log(
    `complianceFeeRetry.check: OK — ${notYet.length} not-yet answers retry, ${transient.length} blips keep the paid tx, ` +
      `${invalid.length} invalid answers release it`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
