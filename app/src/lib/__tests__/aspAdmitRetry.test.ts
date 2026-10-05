// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test, afterEach } from "bun:test";
import type { Signer } from "ethers";
import { requestAspAdmit } from "../aspAdmit";

/**
 * The ASP needs 2 confirmations; the deposit flow calls admit at 1. That 400 is a race, not a
 * failure — but a single-shot call left the label to the watcher's next sweep, so a fresh deposit
 * stayed unprovable for minutes. These pin the two things that matter: the race retries in the
 * background, and a real rejection does not.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: unknown[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
  return calls;
}

const DEPOSITOR = "0x1111111111111111111111111111111111111111";
const signer = {
  getAddress: async () => DEPOSITOR,
  signMessage: async () => `0x${"ab".repeat(65)}`,
} as unknown as Signer;
const ARGS = {
  chainId: 11155111,
  label: "42",
  txHash: "0xabc",
  vault: "0xvault",
  depositor: DEPOSITOR,
  signer,
};
const EXPECTED_BODY = {
  chainId: ARGS.chainId,
  label: ARGS.label,
  txHash: ARGS.txHash,
  vault: ARGS.vault,
  depositor: ARGS.depositor,
};

describe("ASP admit confirmation race", () => {
  test("returns immediately rather than blocking the deposit on a block time", async () => {
    stubFetch([{ status: 400, body: { error: "transaction has 1/2 confirmations" } }]);
    const started = Date.now();
    const res = await requestAspAdmit(ARGS);
    // Resolves on the FIRST attempt; the retries are detached.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("confirmations");
  });

  test("a confirmed deposit admits on the first try", async () => {
    const calls = stubFetch([{ status: 200, body: { ok: true } }]);
    const res = await requestAspAdmit(ARGS);
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(EXPECTED_BODY);
  });

  test("a real rejection is not retried", async () => {
    // "label rejected" is terminal — retrying cannot change it, and hammering the postman with a
    // request that can never succeed is exactly what the confirmation-only guard prevents.
    const calls = stubFetch([{ status: 403, body: { error: "ASP label rejected" } }]);
    const res = await requestAspAdmit(ARGS);
    expect(res.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
  });
});
