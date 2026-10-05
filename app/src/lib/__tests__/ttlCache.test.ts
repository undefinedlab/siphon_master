// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { createTtlCache } from "../v3/ttlCache";

/**
 * Two components polled /api/asp-set/member independently every 8s. It answers ONE label per
 * request and allows 30 per 60s per IP, so a handful of notes put us over; the limiter answered
 * 429, and every 429 surfaced as "no data" — which the UI rendered as "nothing pending", the exact
 * inverse of the truth, hiding the ragequit control on wallets that had pending notes.
 *
 * These pin the three properties that keep that from recurring.
 */

function harness(opts?: { ttlMs?: number; backoffMs?: number }) {
  let clock = 1_000_000;
  let calls = 0;
  let next: string[] = ["a"];
  let fail = false;
  let resolveGate: (() => void) | null = null;

  const cache = createTtlCache<string[]>({
    fetcher: async () => {
      calls++;
      if (resolveGate) await new Promise<void>((r) => { resolveGate = r; });
      if (fail) throw new Error("429 Too Many Requests");
      return next;
    },
    ttlMs: opts?.ttlMs ?? 20_000,
    backoffMs: opts?.backoffMs ?? 60_000,
    initial: [],
    suspicious: (n, prev) => n.length === 0 && prev.length > 0,
    now: () => clock,
  });

  return {
    cache,
    advance: (ms: number) => { clock += ms; },
    calls: () => calls,
    setNext: (v: string[]) => { next = v; },
    setFail: (v: boolean) => { fail = v; },
  };
}

describe("createTtlCache", () => {
  test("a cold read fetches, and get() reflects it without fetching again", async () => {
    const h = harness();
    expect(h.cache.get()).toEqual([]);
    await h.cache.refresh();
    expect(h.cache.get()).toEqual(["a"]);
    expect(h.calls()).toBe(1);
    h.cache.get();
    expect(h.calls()).toBe(1);
  });

  test("reads inside the TTL are served from cache", async () => {
    const h = harness({ ttlMs: 20_000 });
    await h.cache.refresh();
    h.advance(19_999);
    await h.cache.refresh();
    await h.cache.refresh();
    expect(h.calls()).toBe(1);
  });

  test("a read past the TTL fetches again", async () => {
    const h = harness({ ttlMs: 20_000 });
    await h.cache.refresh();
    h.advance(20_001);
    await h.cache.refresh();
    expect(h.calls()).toBe(2);
  });

  test("concurrent callers share ONE request", async () => {
    // The dedupe that stops two components doubling the rate against a per-IP limiter.
    const h = harness();
    await Promise.all([h.cache.refresh(), h.cache.refresh(), h.cache.refresh()]);
    expect(h.calls()).toBe(1);
  });

  test("force bypasses the TTL — used right after a ragequit", async () => {
    const h = harness();
    await h.cache.refresh();
    await h.cache.refresh({ force: true });
    expect(h.calls()).toBe(2);
  });

  test("invalidate makes the next read fetch", async () => {
    const h = harness();
    await h.cache.refresh();
    h.cache.invalidate();
    await h.cache.refresh();
    expect(h.calls()).toBe(2);
  });

  test("a failed read keeps the last value instead of going empty", async () => {
    // This is the whole bug: a 429 must not read as "nothing pending".
    const h = harness();
    await h.cache.refresh();
    h.setFail(true);
    await h.cache.refresh({ force: true });
    expect(h.cache.get()).toEqual(["a"]);
  });

  test("a failed read backs off instead of retrying immediately", async () => {
    const h = harness({ backoffMs: 60_000 });
    await h.cache.refresh();
    h.setFail(true);
    await h.cache.refresh({ force: true });
    const after = h.calls();
    h.advance(59_000);
    await h.cache.refresh();
    expect(h.calls()).toBe(after);
    h.advance(2_000);
    await h.cache.refresh();
    expect(h.calls()).toBe(after + 1);
  });

  test("going suspiciously empty also backs off", async () => {
    const h = harness({ backoffMs: 60_000 });
    await h.cache.refresh();           // ["a"]
    h.setNext([]);                     // looks exactly like every lookup being limited
    await h.cache.refresh({ force: true });
    const after = h.calls();
    h.advance(30_000);
    await h.cache.refresh();
    expect(h.calls()).toBe(after);
  });

  test("a legitimately empty first result does not back off", async () => {
    // Nothing pending on a clean wallet is normal and must not wedge the cache.
    const h = harness({ ttlMs: 20_000, backoffMs: 60_000 });
    h.setNext([]);
    await h.cache.refresh();
    h.advance(20_001);
    await h.cache.refresh();
    expect(h.calls()).toBe(2);
  });

  test("subscribers are notified on change and stop after unsubscribe", async () => {
    const h = harness();
    let hits = 0;
    const off = h.cache.subscribe(() => { hits++; });
    await h.cache.refresh();
    expect(hits).toBe(1);
    off();
    await h.cache.refresh({ force: true });
    expect(hits).toBe(1);
  });

  test("a throwing subscriber does not stop the others", async () => {
    const h = harness();
    let good = 0;
    h.cache.subscribe(() => { throw new Error("render blew up"); });
    h.cache.subscribe(() => { good++; });
    await h.cache.refresh();
    expect(good).toBe(1);
  });

  test("reset returns it to the initial value", async () => {
    const h = harness();
    await h.cache.refresh();
    h.cache.reset();
    expect(h.cache.get()).toEqual([]);
  });
});
