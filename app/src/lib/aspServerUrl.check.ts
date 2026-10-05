// Runnable self-check: a chain with its own ASP gets its own origin and ONLY its own tokens.
//   npx tsx src/lib/aspServerUrl.check.ts
//
// Arbitrum's ASP runs on a different host from Base's. Falling back to the global token for it
// would send Base's ASP credential to that host, so the fallback must stop at the chain boundary.
import assert from "node:assert";

process.env.ASP_URL = "https://base-asp.example/aspv5/";
process.env.ASP_SCREEN_TOKEN = "base-screen";
process.env.ASP_POSTMAN_TOKEN = "base-postman";
delete process.env.ASP_URL_42161;
delete process.env.ASP_SCREEN_TOKEN_42161;
delete process.env.ASP_POSTMAN_TOKEN_42161;

async function main() {
  const m = await import("./aspServerUrl");
  const auth = (url: string, chain?: number | string | null) =>
    m.aspProxyHeaders(url, {}, chain).Authorization;

  // No per-chain ASP configured: every chain uses the global one (today's Base behaviour).
  assert.strictEqual(m.aspBaseUrl(8453), "https://base-asp.example/aspv5");
  assert.strictEqual(m.aspBaseUrl(42161), "https://base-asp.example/aspv5");
  assert.strictEqual(auth("https://base-asp.example/aspv5", 8453), "Bearer base-screen");

  // Arbitrum gets its own ASP but its tokens are not set yet: NO token, never Base's.
  process.env.ASP_URL_42161 = "https://arb-asp.example/aspv5";
  assert.strictEqual(m.aspBaseUrl(42161), "https://arb-asp.example/aspv5");
  assert.strictEqual(m.aspBaseUrl("42161"), "https://arb-asp.example/aspv5", "query-string chain ids");
  assert.strictEqual(auth("https://arb-asp.example/aspv5", 42161), undefined);
  assert.strictEqual(m.aspPostmanToken(42161), "");
  assert.strictEqual(m.aspPostmanProxyHeaders(undefined, 42161)["X-Asp-Postman-Token"], undefined);

  process.env.ASP_SCREEN_TOKEN_42161 = "arb-screen";
  process.env.ASP_POSTMAN_TOKEN_42161 = "arb-postman";
  assert.strictEqual(auth("https://arb-asp.example/aspv5", 42161), "Bearer arb-screen");
  assert.strictEqual(m.aspPostmanToken(42161), "arb-postman");

  // Base is untouched by Arbitrum's config, and junk chain ids fall back to the global ASP.
  assert.strictEqual(m.aspBaseUrl(8453), "https://base-asp.example/aspv5");
  assert.strictEqual(auth("https://base-asp.example/aspv5", 8453), "Bearer base-screen");
  assert.strictEqual(m.aspPostmanToken(8453), "base-postman");
  for (const junk of [null, undefined, "", "abc", "42161x"]) {
    assert.strictEqual(m.aspBaseUrl(junk), "https://base-asp.example/aspv5", String(junk));
  }

  console.log(
    "aspServerUrl.check: OK — per-chain ASP origin resolves, a chain with its own ASP never receives the global tokens, Base unchanged",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
