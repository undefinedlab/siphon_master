// Runnable self-check: executor write signatures are bound to the chain the app means (OVERLORD G-8).
//   npx tsx src/lib/writeChallengeChain.check.ts
//
// PoC being closed: the Arbitrum executor box (lower assurance) is compromised. Asked for a write
// challenge, it hands back a nonce it fetched from the BASE executor; the app signed
// `Siphon auth v1:write:<nonce>`, and the box replayed that to Base as the user. Now each executor
// only issues nonces for chains it serves, and the app signs `Siphon auth v2:write:<chain>:<nonce>`
// for the chain it is actually on — so a laundered Base nonce is refused here or useless there.
import assert from "node:assert";

const ARB = "https://arb-executor.test";
process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL = "https://base-executor.test";
process.env.NEXT_PUBLIC_V3_ARBITRUM_EXECUTOR_URL = ARB;

async function main() {
  const { fetchWriteChallenge, writeChallengeMessage } = await import("./walletAuthHeaders");
  const nonce = "ab".repeat(16);
  const calls: { url: string; body: unknown }[] = [];
  const reply = (body: unknown) => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  };

  reply({ nonce, chain_id: 42161 });
  assert.deepStrictEqual(await fetchWriteChallenge(42161), { nonce, expires_at: 0, boundChainId: 42161 });
  assert.deepStrictEqual(calls[0], { url: `${ARB}/auth/challenge`, body: { chain_id: 42161 } }, "the chain picks the host AND the binding");
  assert.strictEqual(writeChallengeMessage(42161, nonce), `Siphon auth v2:write:42161:${nonce}`);

  reply({ nonce, chain_id: 8453 }); // the laundered Base nonce
  await assert.rejects(fetchWriteChallenge(42161), /not bound to chain 42161/, "G-8 PoC: a Base-bound nonce was accepted for Arbitrum");
  // A pre-G-8 executor (no binding) gets the legacy v1 text — never v2 for a chain it did not bind.
  reply({ nonce });
  assert.strictEqual((await fetchWriteChallenge(42161)).boundChainId, null);
  assert.strictEqual(writeChallengeMessage(null, nonce), `Siphon auth v1:write:${nonce}`);
  reply({ nonce: "../../x", chain_id: 42161 });
  await assert.rejects(fetchWriteChallenge(42161), /missing nonce/);

  console.log("writeChallengeChain.check: OK — write challenges are fetched from and bound to the intended chain; laundered nonces are refused, unbound (pre-G-8) ones get the v1 text");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
