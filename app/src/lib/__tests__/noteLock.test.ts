/**
 * Arming and ragequit must not both take the same note: ragequit's exit ticket revokes the label
 * before its transaction, so an arm landing in between strands that strategy under a revoked label.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
beforeAll(() => {
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterAll(() => {
  delete g.localStorage;
});

test("each side refuses while the other holds the note, and locks expire", async () => {
  const { lockNote, unlockNote, noteLockHolder, ARM_LOCK_MS, RAGEQUIT_LOCK_MS } = await import("../v3/noteLockV3");
  const t0 = 1_000_000;

  lockNote("111", "arm", ARM_LOCK_MS, t0);
  expect(() => lockNote("111", "ragequit", RAGEQUIT_LOCK_MS, t0 + 1)).toThrow(/funding a strategy/);
  lockNote("111", "arm", ARM_LOCK_MS, t0 + 1); // the holder may refresh
  unlockNote("111", "ragequit"); // a non-holder cannot release it
  expect(noteLockHolder("111", t0 + 2)).toBe("arm");
  // Still held after the five-minute ragequit window, gone once it expires.
  expect(noteLockHolder("111", t0 + 6 * 60_000)).toBe("arm");
  expect(noteLockHolder("111", t0 + 1 + ARM_LOCK_MS)).toBeNull();
  lockNote("111", "ragequit", RAGEQUIT_LOCK_MS, t0 + 1 + ARM_LOCK_MS);

  lockNote("222", "ragequit", RAGEQUIT_LOCK_MS);
  expect(() => lockNote("222", "arm", ARM_LOCK_MS)).toThrow(/being ragequit/);
  unlockNote("222", "ragequit");
  expect(noteLockHolder("222")).toBeNull();
  lockNote("222", "arm", ARM_LOCK_MS);
});

test("ragequit refuses an armed note before it asks the ASP to revoke anything", async () => {
  const { lockNote, ARM_LOCK_MS } = await import("../v3/noteLockV3");
  const { ragequitByNoteKeyV3 } = await import("../v3/spendRouterV3");
  lockNote("333", "arm", ARM_LOCK_MS);
  // A signer that throws on any use proves nothing past the lock ran (no note load, no exit ticket).
  const signer = new Proxy({}, { get: () => { throw new Error("signer touched"); } });
  const err = await ragequitByNoteKeyV3({
    noteKey: "siphon-v3note-8453-USDC-333",
    recipient: "0x" + "ab".repeat(20),
    signer: signer as never,
  }).catch((e: Error) => e);
  expect(String((err as Error).message)).toMatch(/funding a strategy/);
  // friendlyTxError keeps only the text before "(" and 140 chars — the whole message must survive.
  expect((err as Error).message.length).toBeLessThanOrEqual(140);
  expect((err as Error).message).not.toContain("(");
});
