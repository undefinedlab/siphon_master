// Runnable self-check: a quota 429 and a throughput 429 must not be treated alike.
//   npx tsx src/lib/rpcQuota.check.ts
//
// /api/rpc retries the SAME upstream 5 times with 200*2^n backoff before falling through. That is
// correct for a throughput burst, which clears in milliseconds. It is wrong for an exhausted plan,
// which does not clear until the billing cycle rolls over: every request then pays
// 200+400+800+1600+3200 = 6.2s before reaching a working node. The arming path makes many
// eth_calls, so the client times out first and ethers reports "missing revert data" — a message
// that points at the contract, not at the key. A real Base outage was diagnosed this way.
//
// The classifier is a substring match because no provider returns a machine-readable code for it,
// so it is exactly the kind of thing that silently stops matching when a provider reworks its error
// copy. These are the real strings, kept verbatim.
import assert from "node:assert";

const QUOTA_EXHAUSTED =
  /monthly|capacity limit|usage limit|current plan|quota|credits?\s+exceeded|balance exceeded|billing|upgrade here/i;
const PROVIDER_REFUSAL_CODES = new Set([-32001, -32005, -32029]);

/** Mirrors route.ts. A 2xx body can still be a refusal rather than an answer. */
function isProviderRefusal(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).some((e) => {
    const err = (e as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (!err) return false;
    if (typeof err.code === "number" && PROVIDER_REFUSAL_CODES.has(err.code)) return true;
    return typeof err.message === "string" && QUOTA_EXHAUSTED.test(err.message);
  });
}

// Verbatim bodies seen from real providers on this project.
const PERMANENT = [
  // Alchemy, Base mainnet — the one that produced "missing revert data" during a Base arm.
  '{"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service."}}',
  // dRPC, same project, different wording.
  '{"id":0,"jsonrpc":"2.0","error":{"message":"User balance exceeded","code":10}}',
  '{"error":{"message":"monthly quota exceeded"}}',
  '{"error":{"message":"compute units quota exceeded"}}',
];

// Transient bursts — these MUST keep the retry, or a good key gets surrendered on a hiccup and the
// fallbacks (publicnode 403s archive, drpc rejects batches > 3) break batched archive scans.
const TRANSIENT = [
  '{"jsonrpc":"2.0","error":{"code":429,"message":"Too Many Requests"}}',
  '{"jsonrpc":"2.0","error":{"code":429,"message":"rate limit exceeded"}}',
  '{"error":{"message":"request rate exceeded, please slow down"}}',
  "429 Too Many Requests",
  // Alchemy method-throughput limit — HTTP 200 with code 429. Must NOT be returned to the browser.
  '{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"},"id":"d4d760cf-8f70-4acc-973d-bb405ed721de"}',
];

function isTransientRpcThrottle(text: string): boolean {
  if (QUOTA_EXHAUSTED.test(text)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return /too many requests/i.test(text);
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).some((e) => {
    const err = (e as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (!err) return false;
    if (typeof err.code === "number" && err.code === 429) return true;
    return typeof err.message === "string" && /too many requests|rate.?limit|request rate exceeded/i.test(err.message);
  });
}

function main() {
  for (const body of PERMANENT) {
    assert.ok(
      QUOTA_EXHAUSTED.test(body),
      `should be treated as PERMANENT (skip upstream now): ${body.slice(0, 80)}`,
    );
  }
  for (const body of TRANSIENT) {
    assert.ok(
      !QUOTA_EXHAUSTED.test(body),
      `should be treated as TRANSIENT (keep retrying): ${body.slice(0, 80)}`,
    );
  }

  // "rate limit exceeded" contains "exceeded" but must NOT match: the pattern requires it to follow
  // quota/credits/balance. If someone loosens this to a bare /exceeded/, every transient burst
  // starts surrendering the good key — the opposite failure, and a quieter one.
  assert.ok(!QUOTA_EXHAUSTED.test("rate limit exceeded"), "bare 'exceeded' must not match");

  // --- a 2xx body can still be a refusal ---------------------------------------------------
  // 1rpc serves its quota message as HTTP 200 with a JSON-RPC error, so a status-only check waves
  // it through and the caller gets a refusal shaped like a result. Verbatim from 1rpc.io/base.
  const ONE_RPC =
    '{"jsonrpc":"2.0","error":{"code":-32001,"message":"You\'ve reached the usage limit for your ' +
    'current plan. To continue with higher limits and uninterrupted access, please upgrade here: ' +
    'https://www.1rpc.io/#pricing"},"id":null}';
  assert.ok(isProviderRefusal(ONE_RPC), "1rpc's HTTP-200 quota error must be caught");

  // ethers batches eth_calls, so the refusal arrives as an ARRAY. A naive body.error lookup misses
  // it — which is exactly how this reached the browser as "state leaves unavailable".
  assert.ok(isProviderRefusal(`[${ONE_RPC}]`), "batched refusal must be caught");

  // dRPC, HTTP 403 — caught by message even though its code (10) is not in the refusal set.
  assert.ok(
    isProviderRefusal('{"id":0,"jsonrpc":"2.0","error":{"message":"User balance exceeded","code":10}}'),
    "dRPC's balance error must be caught",
  );

  // An eth_call REVERT is the chain answering and must be returned verbatim, never treated as a
  // refusal — conflating them would hide real contract errors behind an RPC fallback.
  assert.ok(
    !isProviderRefusal('{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0xa29c4986"}}'),
    "an eth_call revert must NOT be treated as a provider refusal",
  );
  // A normal result obviously passes through.
  assert.ok(!isProviderRefusal('{"jsonrpc":"2.0","id":1,"result":"0x3046703"}'), "a result is not a refusal");
  assert.ok(!isProviderRefusal("not json"), "unparseable body is not a refusal");

  // Alchemy's method-specific throttle must be treated as transient (retry/fallback), never as a
  // successful answer and never as a 10-minute quota cooldown.
  const ALCHEMY_METHOD =
    '{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"},"id":"d4d760cf-8f70-4acc-973d-bb405ed721de"}';
  assert.ok(isTransientRpcThrottle(ALCHEMY_METHOD), "Alchemy method 429 must throttle-retry");
  assert.ok(!isProviderRefusal(ALCHEMY_METHOD), "Alchemy method 429 must NOT permanent-cool the key");
  assert.ok(
    isProviderRefusal(PERMANENT[0]),
    "Alchemy monthly capacity 429 must still permanent-cool the key",
  );

  console.log(
    `rpcQuota.check: OK — ${PERMANENT.length} quota bodies skip the upstream, ` +
      `${TRANSIENT.length} burst bodies keep retrying, and a 2xx refusal is not an answer`,
  );
}

main();
