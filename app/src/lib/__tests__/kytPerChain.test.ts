/**
 * KYT clearance is per chain: each chain's ASP keeps its own entitlement, so a Base pass must not
 * read as cleared on Arbitrum (whose ASP then refuses the deposit after the approve was paid).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
beforeAll(() => {
  g.window = globalThis;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  g.dispatchEvent = () => true;
});
afterAll(() => {
  delete g.window;
  delete g.localStorage;
});

test("a Base KYT pass does not clear Arbitrum, and each chain keeps its own", async () => {
  const { isKytPassed, saveKytStatus } = await import("../kytStatus");
  const { setSelectedChainId } = await import("../networks");
  const wallet = "0x" + "ab".repeat(20);
  const pass = (chainId: number) =>
    saveKytStatus({ wallet, chainId, checkedAt: new Date().toISOString(), decision: "admit", reasons: [], source: "asp" });

  setSelectedChainId(8453);
  pass(8453);
  expect(isKytPassed(wallet)).toBe(true);
  setSelectedChainId(42161);
  expect(isKytPassed(wallet)).toBe(false);
  pass(42161);
  expect(isKytPassed(wallet)).toBe(true);
  setSelectedChainId(8453);
  expect(isKytPassed(wallet)).toBe(true); // Arbitrum's pass did not overwrite Base's
});

test("a pre-per-chain record still counts on the chain it was screened on — and only there", async () => {
  const { isKytPassed } = await import("../kytStatus");
  const { setSelectedChainId } = await import("../networks");
  const wallet = "0x" + "cd".repeat(20);
  store.set(`siphon-kyt-status:${wallet}`, JSON.stringify({
    version: 1, wallet, chainId: 8453, checkedAt: new Date().toISOString(), decision: "admit", reasons: [], source: "asp",
  }));
  setSelectedChainId(8453);
  expect(isKytPassed(wallet)).toBe(true);
  setSelectedChainId(42161);
  expect(isKytPassed(wallet)).toBe(false);
});

