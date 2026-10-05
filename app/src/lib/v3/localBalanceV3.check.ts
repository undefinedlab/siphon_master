// Runnable self-check for the instant local balance — no test framework in this repo.
//   npx tsx src/lib/v3/localBalanceV3.check.ts
//
// This computes MONEY and it is the number a user judges the whole product by, so every rule that
// could over- or under-state it is asserted here. The failure mode that matters most is silent:
// a balance that is confidently wrong is worse than one that says "verifying".
//
// The cross-checks from BALANCE_DISPLAY_PLAN §4 live at the bottom: PRIVATE and IN STRATEGY must be
// disjoint, and nothing may be double-counted between them.

import assert from "node:assert";
import { webcrypto } from "node:crypto";

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number): string | null { return Array.from(this.m.keys())[i] ?? null; }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
}

const storage = new MemoryStorage();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = storage;
if (!g.crypto) g.crypto = webcrypto;

const CHAIN = 11155111;
const KERNEL = "0x586dFaa329D71de7368617C9f00395C040bCf84a";
const VAULT_ID = `v3-${KERNEL}`;
const WALLET = "0xd5720ed6e70a128c025d0c284874cd1e33b39688";

async function encKey(): Promise<CryptoKey> {
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode("enc"));
  return webcrypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function installMocks() {
  const Module = await import("node:module");
  type Req = (id: string) => unknown;
  const req = Module.default.prototype.require as Req;
  Module.default.prototype.require = function (this: unknown, id: string) {
    if (id.endsWith("/noteAuth") || id.endsWith("../noteAuth")) {
      return {
        deriveEncKey: async () => encKey(),
        decryptBlob: async (key: CryptoKey, blob: string, iv: string) => {
          const pt = await webcrypto.subtle.decrypt(
            { name: "AES-GCM", iv: Buffer.from(iv, "base64") },
            key,
            Buffer.from(blob, "base64"),
          );
          return JSON.parse(new TextDecoder().decode(pt));
        },
      };
    }
    if (id.endsWith("/configV3") || id.endsWith("./configV3")) {
      return { v3Config: (c: number) => (c === CHAIN ? { vaultKernel: KERNEL } : undefined) };
    }
    return req.call(this, id);
  } as Req;
}

const signer = { getAddress: async () => WALLET } as unknown as import("ethers").Signer;

async function seed(n: {
  symbol: string;
  commitment: string;
  value: string;
  spent?: string;
  vaultId?: string;
  corrupt?: boolean;
  owner?: string;
}) {
  const key = `siphon-v3note-${CHAIN}-${n.symbol}-${n.commitment}`;
  if (n.corrupt) {
    storage.setItem(key, JSON.stringify({ commitment: n.commitment, spent: "false", vaultId: VAULT_ID }));
    return;
  }
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encKey(),
    new TextEncoder().encode(JSON.stringify({ value: n.value, nullifier: "1", secret: "2" })),
  );
  storage.setItem(key, JSON.stringify({
    enc_blob: Buffer.from(ct).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    commitment: n.commitment,
    value: n.value,
    spent: n.spent ?? "false",
    vaultId: n.vaultId ?? VAULT_ID,
    ...(n.owner ? { owner: n.owner } : {}),
  }));
}

async function main() {
  await installMocks();
  const { getLocalBalance, getStrategyBalance } = await import("./localBalanceV3");

  // ---- 1. sums spendable notes, with ZERO network available ----------------------------------
  // The whole point: no fetch is defined in this file, so any network call would throw.
  storage.clear();
  await seed({ symbol: "ETH", commitment: "a", value: "1000" });
  await seed({ symbol: "ETH", commitment: "b", value: "2500" });
  await seed({ symbol: "USDC", commitment: "c", value: "777" });
  const b1 = getLocalBalance(CHAIN);
  assert.equal(b1.bySymbol.ETH, 3500n, "ETH must sum both notes");
  assert.equal(b1.bySymbol.USDC, 777n, "USDC must be tracked separately");
  assert.equal(b1.noteCount, 3);

  // ---- 1b. another wallet's notes on the same browser are not this wallet's balance ------------
  storage.clear();
  await seed({ symbol: "ETH", commitment: "mine", value: "5", owner: "0xAAA" });
  await seed({ symbol: "ETH", commitment: "theirs", value: "100", owner: "0xbbb" });
  assert.equal(getLocalBalance(CHAIN, "0xaaa").bySymbol.ETH, 5n, "only the connected wallet's notes count");
  assert.equal(getLocalBalance(CHAIN, "0xccc").bySymbol.ETH, undefined, "a wallet with no notes here has none");

  // ---- 2. spent AND pending are excluded ------------------------------------------------------
  // `pending` is a strategy reservation: the enclave holds a proof for that note. Counting it as
  // spendable lets the planner pick a note about to be consumed -> NullifierAlreadyUsed.
  storage.clear();
  await seed({ symbol: "ETH", commitment: "live", value: "100" });
  await seed({ symbol: "ETH", commitment: "spent", value: "500", spent: "true" });
  await seed({ symbol: "ETH", commitment: "resv", value: "900", spent: "pending" });
  const b2 = getLocalBalance(CHAIN);
  assert.equal(b2.bySymbol.ETH, 100n, "only the unspent note counts");
  assert.equal(b2.noteCount, 1, "spent and pending must both be excluded");

  // ---- 3. a retired-generation note is excluded ------------------------------------------------
  // Its leaf is in a previous kernel's tree, so it can never be spent here; showing it overstates
  // what the user can actually withdraw.
  storage.clear();
  await seed({ symbol: "ETH", commitment: "now", value: "10" });
  await seed({ symbol: "ETH", commitment: "old", value: "999", vaultId: "v3-0xdead" });
  const b3 = getLocalBalance(CHAIN);
  assert.equal(b3.bySymbol.ETH, 10n, "a retired-kernel note must not be counted as spendable");

  // ---- 4. an UNPARSEABLE row is COUNTED as unreadable, not silently dropped -------------------
  // Silently ignoring it understates the balance with no explanation, which is the failure mode
  // this whole design exists to avoid.
  storage.clear();
  await seed({ symbol: "ETH", commitment: "ok", value: "50" });
  storage.setItem(`siphon-v3note-${CHAIN}-ETH-broken`, "{not json at all");
  const b4 = getLocalBalance(CHAIN);
  assert.equal(b4.bySymbol.ETH, 50n);
  assert.equal(b4.unreadable, 1, "an unparseable note must be reported so the UI can say so");

  // ---- 4b. a row with NO enc_blob still counts — a balance needs no decryption -----------------
  // `value` is plaintext on the row. Requiring the enc-key here meant a WALLET SIGNATURE before
  // the first paint, which is what left the card sitting on "Checking for notes…".
  storage.clear();
  storage.setItem(`siphon-v3note-${CHAIN}-ETH-plain`, JSON.stringify({
    commitment: "plain", value: "1234", spent: "false", vaultId: VAULT_ID,
  }));
  const b4b = getLocalBalance(CHAIN);
  assert.equal(b4b.bySymbol.ETH, 1234n, "plaintext value must be readable without the enc-key");
  assert.equal(b4b.unreadable, 0, "a blob-less row is not unreadable — nothing needed decrypting");

  // ---- 5. no notes is a real answer, not a failure ---------------------------------------------
  storage.clear();
  const b5 = getLocalBalance(CHAIN);
  assert.deepEqual(b5.bySymbol, {}, "empty must be empty, not an error");
  assert.equal(b5.noteCount, 0);

  // ---- 6. IN STRATEGY counts only ACTIVE strategies --------------------------------------------
  const strat = getStrategyBalance([
    { status: "PENDING", amount: 1.5, asset_in: "ETH" },
    { status: "ARMED", amount: 0.5, asset_in: "ETH" },
    { status: "EXECUTED", amount: 9, asset_in: "ETH" },
    { status: "ABORTED", amount: 9, asset_in: "ETH" },
    { status: "PARTIALLY_EXECUTED", amount: 9, asset_in: "ETH" },
    { status: "FAILED", amount: 9, asset_in: "ETH" },
    { status: "EXPIRED", amount: 9, asset_in: "ETH" },
  ]);
  assert.equal(strat.ETH, 2, "only PENDING + ARMED count");

  // PARTIALLY_EXECUTED is the subtle one: its unfired legs hold REAL on-chain slice-notes, already
  // counted in the local balance. Adding strategy.amount here would double-count them.
  const partial = getStrategyBalance([{ status: "PARTIALLY_EXECUTED", amount: 5, asset_in: "ETH" }]);
  assert.deepEqual(partial, {}, "PARTIALLY_EXECUTED must contribute nothing — its legs are real notes");

  // ---- 7. CROSS-CHECK: PRIVATE and IN STRATEGY are disjoint ------------------------------------
  // A note reserved for a strategy is marked pending/true locally, so it leaves PRIVATE. If that
  // marking ever failed, the same funds would appear in BOTH buckets.
  storage.clear();
  await seed({ symbol: "ETH", commitment: "free", value: "1000" });
  await seed({ symbol: "ETH", commitment: "held", value: "2000", spent: "pending" });
  const priv = getLocalBalance(CHAIN);
  const inStrat = getStrategyBalance([{ status: "ARMED", amount: 2000, asset_in: "ETH" }]);
  assert.equal(priv.bySymbol.ETH, 1000n, "the reserved note must NOT be in PRIVATE");
  assert.equal(inStrat.ETH, 2000, "…and must be in IN STRATEGY");
  assert.equal(
    Number(priv.bySymbol.ETH) + inStrat.ETH,
    3000,
    "buckets must sum to the total with no double-count and nothing lost",
  );

  // ---- 8. another chain's notes are not counted ------------------------------------------------
  storage.clear();
  await seed({ symbol: "ETH", commitment: "mine", value: "42" });
  storage.setItem(`siphon-v3note-8453-ETH-other`, JSON.stringify({
    commitment: "other", value: "99999", spent: "false", vaultId: VAULT_ID,
  }));
  const b8 = getLocalBalance(CHAIN);
  assert.equal(b8.bySymbol.ETH, 42n, "another chain's notes must not leak into this balance");

  console.log("localBalanceV3.check.ts — all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
