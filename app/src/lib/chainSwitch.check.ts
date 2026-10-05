// Runnable self-check: clicking a chain the app already has selected still moves the WALLET there.
//   npx tsx src/lib/chainSwitch.check.ts
//
// 2026-09-28: the Arbitrum button was highlighted (stored chain = 42161) while MetaMask sat on
// Base, and clicking it did nothing — selectChainAndSwitchWallet returned early on "already
// selected" without asking the wallet. The stored chain is the app's belief; only eth_chainId is
// the wallet's.
import assert from "node:assert";

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
  dispatchEvent: () => true,
};

async function main() {
  const n = await import("./networks");
  const { setActiveEvmProvider } = await import("./activeEvmProvider");

  let walletChain = 8453;
  const calls: string[] = [];
  setActiveEvmProvider({
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === "eth_chainId") return "0x" + walletChain.toString(16);
      if (method === "wallet_switchEthereumChain") {
        walletChain = parseInt((params as [{ chainId: string }])[0].chainId, 16);
        return null;
      }
      throw new Error(`unexpected ${method}`);
    },
  });

  n.setSelectedChainId(42161); // app believes Arbitrum; wallet is on Base
  assert.deepStrictEqual(await n.selectChainAndSwitchWallet(42161), { ok: true, chainId: 42161 });
  assert.ok(calls.includes("wallet_switchEthereumChain"), "already-selected chain must still prompt a wallet on another network");
  assert.strictEqual(walletChain, 42161);

  // Both agree → no prompt.
  calls.length = 0;
  await n.selectChainAndSwitchWallet(42161);
  assert.deepStrictEqual(calls, ["eth_chainId"], "no wallet prompt when the wallet is already there");

  console.log("chainSwitch.check: OK — a selected-but-unswitched chain prompts the wallet; an agreed one does not");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
