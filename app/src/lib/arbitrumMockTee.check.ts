// Runnable self-check: the Arbitrum executor host and the mock-TEE mode cannot leak across hosts.
//   npx tsx src/lib/arbitrumMockTee.check.ts
//
// Overlord 2026-09-28 on the Arbitrum/mock-TEE change. Arbitrum's executor runs on a separate,
// lower-assurance box, and the decryptor behind it (and, for now, Base's) is a MOCK — no TDX. So:
//   F-1  the static note-backup token must never reach that box in the form the Base executor
//        pinned (else: replay → /commitments/prune on api.siphon.money deletes a Base user's backups)
//   F-3  (in-app banner removed 2026-09-28 at the owner's request)
//   F-5  attestation and delivery must use ONE host
//   F-6  the zero `entrypoint` of a v3-only chain must not become an allowed eth_call target
// plus the mock acceptance rule itself: only with the flag on, only for a mock_kms reply with no
// quote, and only when its report_data binds its own pubkey.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const BASE_EXEC = "https://api.siphon.money";
const ARB_EXEC = "https://16-192-140-158.sslip.io";
process.env.NEXT_PUBLIC_TRADE_EXECUTOR_URL = BASE_EXEC;
process.env.NEXT_PUBLIC_V3_ARBITRUM_EXECUTOR_URL = ARB_EXEC;

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    if (fs.statSync(p).isDirectory()) srcFiles(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.check\.ts$|\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

async function main() {
  // ---- F-1: origin-scoped note token ---------------------------------------------------------
  const exec = await import("./tradeExecutorClient");
  const { _tokenForExecutor } = await import("./noteAuth");
  const RAW = "a".repeat(64); // the token the Base executor pinned via /auth/tag-bind

  assert.strictEqual(exec.isPerChainExecutor(BASE_EXEC), false, "the global executor is not per-chain");
  assert.strictEqual(exec.isPerChainExecutor(ARB_EXEC), true);
  assert.strictEqual(exec.isPerChainExecutor(`${ARB_EXEC}/`), true, "trailing slash is the same host");
  assert.strictEqual(exec.isPerChainExecutor("https://evil.example"), false, "unknown host is not trusted as per-chain");

  assert.strictEqual(await _tokenForExecutor(RAW, BASE_EXEC), RAW, "Base keeps its pinned token (no re-bind)");
  const arbTok = await _tokenForExecutor(RAW, ARB_EXEC);
  // The PoC: what the Arbitrum box receives must not be what api.siphon.money accepts.
  assert.notStrictEqual(arbTok, RAW, "F-1 PoC: the raw token reached the per-chain executor");
  assert.strictEqual(arbTok, sha256hex(`siphon-tag-token-v1|${ARB_EXEC}|${RAW}`));
  assert.match(arbTok, /^[0-9a-f]{64}$/, "executor tag-bind requires >= 32 chars; lowercased hex");
  assert.strictEqual(await _tokenForExecutor(RAW, ARB_EXEC), arbTok, "deterministic — the pin must survive reloads");

  // Every note-auth caller must pass the host it fetches, or a chain switch between resolving the
  // headers and the fetch re-opens F-1 (raw token computed for Base, sent to the Arbitrum box).
  for (const f of srcFiles(path.join(process.cwd(), "src"))) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/noteAuthHeaders\(([^)]*)\)/g)) {
      if (/export async function/.test(src.slice(Math.max(0, m.index! - 40), m.index!))) continue;
      assert.strictEqual(
        m[1].split(",").length, 3,
        `${path.relative(process.cwd(), f)}: noteAuthHeaders(${m[1]}) must pass the executor base it fetches`,
      );
    }
  }

  // ---- mock acceptance + F-5 (one host for attest + seal) --------------------------------------
  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const pub = Buffer.from(kp.publicKey).toString("hex");
  const mockAtt = {
    x25519_pubkey: pub,
    report_data_hex: sha256hex(`siphon-decryptor:${pub}`),
    quote: null,
    mock_kms: true,
  };

  const att = await import("./decryptorAttestation");
  delete process.env.NEXT_PUBLIC_ALLOW_MOCK_TEE;
  await assert.rejects(att.verifyDecryptorAttestation(mockAtt), /no TDX quote/, "flag off → mock refused");

  process.env.NEXT_PUBLIC_ALLOW_MOCK_TEE = "true";
  assert.strictEqual(await att.verifyDecryptorAttestation(mockAtt), pub, "flag on → mock pubkey accepted");
  await assert.rejects(
    att.verifyDecryptorAttestation({ ...mockAtt, mock_kms: false }),
    /no TDX quote/,
    "a quote-less reply that does not claim mock_kms is still refused",
  );
  await assert.rejects(
    att.verifyDecryptorAttestation({ ...mockAtt, report_data_hex: "00".repeat(32) }),
    /does not bind/,
    "report_data must bind the pubkey",
  );

  // F-5: attestAndSeal must fetch the attestation from the host it was given — not the selected
  // chain's (no window here → the global one) — and the blob must open with THAT host's key.
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    fetched.push(String(url));
    return new Response(JSON.stringify(mockAtt), { status: 200 });
  }) as typeof fetch;
  try {
    const sealed = await att.attestAndSeal("deadbeef", ARB_EXEC);
    assert.deepStrictEqual(fetched, [`${ARB_EXEC}/decryptorAttestation`], "F-5: attested a different host");
    const opened = sodium.crypto_box_seal_open(Buffer.from(sealed, "hex"), kp.publicKey, kp.privateKey);
    assert.strictEqual(Buffer.from(opened).toString("hex"), "deadbeef");
    // Cache is per host: a second host is attested on its own, never served the first one's key.
    await att.attestAndSeal("deadbeef", BASE_EXEC);
    assert.deepStrictEqual(fetched, [`${ARB_EXEC}/decryptorAttestation`, `${BASE_EXEC}/decryptorAttestation`]);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ---- F-6: zero entrypoint is not an allowed call target ---------------------------------------
  const { rpcContractAllowlist } = await import("./rpcHttpGuard");
  const allow = rpcContractAllowlist(42161, {} as NodeJS.ProcessEnv);
  assert.ok(!allow.has("0x0000000000000000000000000000000000000000"), "F-6: 0x0 allowlisted on 42161");
  assert.ok(allow.has("0xaf88d065e77c8cc2239327c5edb3a432268e5831"), "Arbitrum USDC still allowed");

  console.log(
    "arbitrumMockTee.check: OK — per-chain executor gets an origin-scoped note token (Base keeps its pin), " +
      "all note-auth callers pin one host, mock TEE accepted only with the flag + a binding report_data, " +
      "attestation is per host, and 0x0 is not an eth_call target",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
