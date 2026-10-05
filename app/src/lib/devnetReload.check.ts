// Runnable self-check: a Devnet pick does not survive a reload on a mainnet build.
//   npx tsx src/lib/devnetReload.check.ts
//
// The dashboard's Devnet toggle stores chain 900002, but the product chain always reloads onto the
// home vault. Honoring the stale 900002 left the header on Mainnet over a Devnet chain id (legacy
// deposit path, signer pinned to Devnet) until the user clicked Mainnet.
import assert from "node:assert";

const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.window = Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
  dispatchEvent: () => true,
});
delete process.env.NEXT_PUBLIC_CLUSTER; // prod: mainnet build

async function main() {
  const n = await import("./networks");
  store.set("siphon.homeChainId", "solana-mainnet"); // bridged Base home
  store.set("siphon.selectedChainId", "900002"); // left behind by an earlier load's Devnet toggle
  assert.equal(n.getSelectedChainId(), 8453, `a stale Devnet pick must fall back to the home chain`);

  n.setSelectedChainId(900002); // this load picks Devnet
  assert.equal(n.getSelectedChainId(), 900002, "the load that picked Devnet keeps it");
  n.setSelectedChainId(8453);
  assert.equal(n.getSelectedChainId(), 8453);
  console.log("devnetReload.check: OK — a stale Devnet pick reloads onto the home vault; a fresh one sticks");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
