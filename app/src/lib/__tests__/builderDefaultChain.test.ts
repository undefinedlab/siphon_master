/**
 * The AI builder defaults deposit + withdraw to the SELECTED chain. A load-time default of Arbitrum
 * built Base-home strategies on Arbitrum, and RUN then switched the wallet there.
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

test("default deposit and withdraw chains follow the selected chain", async () => {
  const { setSelectedChainId } = await import("../networks");
  const { createDefaultParsed } = await import("../../builder_agent/parsedDefaults");
  setSelectedChainId(8453);
  expect(createDefaultParsed("x")).toMatchObject({ depositChain: "Base", withdrawChain: "Base" });
  setSelectedChainId(42161);
  expect(createDefaultParsed("x")).toMatchObject({ depositChain: "Arbitrum", withdrawChain: "Arbitrum" });
});
