// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { loadZkey } from "../v3/zkeyCache";

/**
 * A withdrawal re-downloaded its 144 MB proving key on every attempt despite S3 sending
 * `immutable, max-age=1y`: Chromium's HTTP disk cache refuses entries that large. Cache Storage
 * has no such per-entry cap, so the key is kept here instead.
 *
 * The property that matters most is the last one — no cache failure may block a withdrawal.
 */

function fakeCaches(opts: { putThrows?: boolean; openThrows?: boolean } = {}) {
  const store = new Map<string, Uint8Array>();
  let puts = 0;
  const cache = {
    async match(url: string) {
      const hit = store.get(url);
      return hit ? new Response(hit) : undefined;
    },
    async put(url: string, res: Response) {
      puts++;
      if (opts.putThrows) throw new Error("QuotaExceededError");
      store.set(url, new Uint8Array(await res.arrayBuffer()));
    },
  };
  return {
    caches: {
      async open() {
        if (opts.openThrows) throw new Error("no CacheStorage in this context");
        return cache;
      },
    } as unknown as CacheStorage,
    puts: () => puts,
    seed: (url: string, bytes: Uint8Array) => store.set(url, bytes),
  };
}

const URL_ = "https://cdn.example/ceremony/withdraw6/zkey_final.zkey";

function counted(body: Uint8Array, ok = true) {
  let calls = 0;
  const f = (async () => {
    calls++;
    return new Response(body, { status: ok ? 200 : 503 });
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => calls };
}

describe("loadZkey", () => {
  test("a cold key is fetched once and returned as bytes", async () => {
    const c = fakeCaches();
    const f = counted(new Uint8Array([1, 2, 3]));
    const got = await loadZkey(URL_, { caches: c.caches, fetch: f.fetch });
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got as Uint8Array)).toEqual([1, 2, 3]);
    expect(f.calls()).toBe(1);
  });

  test("the second withdrawal does not download it again — the whole point", async () => {
    const c = fakeCaches();
    const f = counted(new Uint8Array([9, 9]));
    await loadZkey(URL_, { caches: c.caches, fetch: f.fetch });
    const again = await loadZkey(URL_, { caches: c.caches, fetch: f.fetch });
    expect(f.calls()).toBe(1);
    expect(Array.from(again as Uint8Array)).toEqual([9, 9]);
  });

  test("a full quota falls back to the URL instead of failing the withdrawal", async () => {
    const c = fakeCaches({ putThrows: true });
    const f = counted(new Uint8Array([4]));
    expect(await loadZkey(URL_, { caches: c.caches, fetch: f.fetch })).toBe(URL_);
  });

  test("no Cache Storage at all is not an error — snarkjs fetches as before", async () => {
    const f = counted(new Uint8Array([4]));
    expect(await loadZkey(URL_, { caches: undefined, fetch: f.fetch })).toBe(URL_);
    expect(f.calls()).toBe(0);
  });

  test("an unopenable cache falls back to the URL", async () => {
    const c = fakeCaches({ openThrows: true });
    const f = counted(new Uint8Array([4]));
    expect(await loadZkey(URL_, { caches: c.caches, fetch: f.fetch })).toBe(URL_);
  });

  test("a failed download is not cached as if it were a key", async () => {
    const c = fakeCaches();
    const f = counted(new Uint8Array([]), false);
    expect(await loadZkey(URL_, { caches: c.caches, fetch: f.fetch })).toBe(URL_);
    expect(c.puts()).toBe(0);
  });
});
