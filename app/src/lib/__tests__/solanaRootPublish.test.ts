import { afterEach, describe, expect, test } from "bun:test";

import type { AspRootFreshness } from "../aspRootFreshness";
import {
  publishSolanaComplianceRoots,
  resetSolanaRootPublishForTests,
  solanaPublishCatchUp,
} from "../solanaRootPublish";

afterEach(() => {
  resetSolanaRootPublishForTests();
});

function checkReturning(...answers: AspRootFreshness[]): typeof import("../aspRootFreshness").verifyAspRootsCurrent {
  let i = 0;
  return (async () => {
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return answer;
  }) as typeof import("../aspRootFreshness").verifyAspRootsCurrent;
}

describe("solana compliance root catch-up", () => {
  test("a root the PDA already has is served without publishing", async () => {
    let publishes = 0;
    const result = await solanaPublishCatchUp(
      "900002",
      { admittedRoot: "1" },
      {
        check: checkReturning({ ok: true }),
        publish: async () => {
          publishes += 1;
          return { ok: true };
        },
      },
    );
    expect(result).toEqual({ action: "serve" });
    expect(publishes).toBe(0);
  });

  test("an EVM publish_pending is not a Solana postman call", async () => {
    let publishes = 0;
    const result = await solanaPublishCatchUp(
      "8453",
      { admittedRoot: "1" },
      {
        check: checkReturning({ ok: false, error: "publish_pending" }),
        publish: async () => {
          publishes += 1;
          return { ok: true };
        },
      },
    );
    expect(result).toEqual({ action: "deny", error: "publish_pending" });
    expect(publishes).toBe(0);
  });

  test("Solana skew publishes once and then serves the same roots", async () => {
    let publishes = 0;
    const result = await solanaPublishCatchUp(
      "900002",
      { admittedRoot: "9" },
      {
        check: checkReturning({ ok: false, error: "publish_pending" }, { ok: true }),
        publish: async () => {
          publishes += 1;
          return { ok: true };
        },
      },
    );
    expect(result).toEqual({ action: "serve" });
    expect(publishes).toBe(1);
  });

  test("a publish that moves past these roots asks the caller to reload", async () => {
    const result = await solanaPublishCatchUp(
      "900002",
      { admittedRoot: "9" },
      {
        check: checkReturning(
          { ok: false, error: "publish_pending" },
          { ok: false, error: "publish_pending" },
        ),
        publish: async () => ({ ok: true }),
      },
    );
    expect(result).toEqual({ action: "reload" });
  });

  test("a postman failure stays publish_pending and names the reason", async () => {
    const result = await solanaPublishCatchUp(
      "900002",
      { admittedRoot: "9" },
      {
        check: checkReturning({ ok: false, error: "publish_pending" }),
        publish: async () => ({ ok: false, detail: "SOLANA_POSTMAN_KEYPAIR required" }),
      },
    );
    expect(result).toEqual({
      action: "deny",
      error: "publish_pending (SOLANA_POSTMAN_KEYPAIR required)",
    });
  });

  test("overlapping publishes share one request", async () => {
    let calls = 0;
    const request = () =>
      new Promise<{ ok: boolean }>((resolve) => {
        calls += 1;
        setTimeout(() => resolve({ ok: true }), 20);
      });
    const [a, b] = await Promise.all([
      publishSolanaComplianceRoots("900002", request),
      publishSolanaComplianceRoots("900002", request),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(calls).toBe(1);
  });
});
