/**
 * getCachedWalletAuthHeaders must not hand out a stale read signature while a session key exists.
 * The cache keeps entries 24h; the executor rejects read signatures older than 300s — that gap was
 * the "GET /hasClientKey 401" on every background sync after the first five minutes.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Wallet, verifyMessage } from "ethers";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const g = globalThis as Record<string, unknown>;
beforeAll(() => {
  g.window = globalThis;
  g.sessionStorage = memStorage();
  g.localStorage = memStorage();
});
afterAll(() => {
  delete g.window;
  delete g.sessionStorage;
  delete g.localStorage;
});

test("a live session signs a fresh read message instead of returning the stale cache", async () => {
  const { getCachedWalletAuthHeaders } = await import("../walletAuthHeaders");
  const { SESSION_HEADER } = await import("../sessionKey");
  const wallet = Wallet.createRandom().address.toLowerCase();
  const session = Wallet.createRandom();
  const now = Math.floor(Date.now() / 1000);

  // A two-hour-old wallet-signed entry: inside the cache's 24h window, far outside the server's 300s.
  localStorage.setItem(`siphon-note-auth-${wallet}`, JSON.stringify({ timestamp: String(now - 7200), signature: "0xstale" }));
  expect(getCachedWalletAuthHeaders(wallet)["X-Timestamp"]).toBe(String(now - 7200)); // no session: cache as before

  sessionStorage.setItem(`siphon:sesskey:${wallet}`, JSON.stringify({
    sessionAddress: session.address, wallet, chainId: 8453, domain: "www.siphon.money",
    issuedAt: now, expiresAt: now + 3600, nonce: "n", signature: "0xdeleg", privateKey: session.privateKey,
  }));
  const h = getCachedWalletAuthHeaders(wallet);
  expect(Math.abs(Number(h["X-Timestamp"]) - now)).toBeLessThan(5);
  expect(verifyMessage(`Siphon auth v1:${h["X-Timestamp"]}`, h["X-Signature"])).toBe(session.address);
  expect(JSON.parse(h[SESSION_HEADER]).sessionAddress).toBe(session.address);
  expect(JSON.parse(h[SESSION_HEADER]).privateKey).toBeUndefined();
});
