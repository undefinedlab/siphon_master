// Runnable self-check for pending-deposit recovery — no test framework in this repo.
//   npx tsx src/lib/v3/recoverPendingDepositV3.check.ts
//
// This code path runs ONLY after a crash between a mined deposit and saveV3Note. Nobody will
// exercise it by hand, and by the time a user needs it their funds are already stranded — so a test
// is the only thing that will ever run it before it matters.
//
// Uses the REAL noteCryptoV3 (Poseidon over BN254), so the commitment match below is the same
// arithmetic the vault and the circuits perform. A mirror would prove nothing: the entire point is
// that the rebuilt commitment equals the one the chain minted.

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
const TOKEN = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14"; // WETH sepolia

/** Deposited events the fake chain will return. */
let chainEvents: Array<{
  args: { depositor: string; token: string; amount: bigint; commitment: bigint; depositNonce: bigint; stateRootAfter: bigint };
  blockNumber: number;
  transactionHash: string;
}> = [];
let chainReachable = true;
/** Fails queryFilter only — getBlockNumber still succeeds, so the per-stash catch is reached. */
let queryFails = false;
const savedNotes: Array<Record<string, unknown>> = [];

async function installMocks() {
  const Module = await import("node:module");
  type Req = (id: string) => unknown;
  const req = Module.default.prototype.require as Req;

  Module.default.prototype.require = function (this: unknown, id: string) {
    if (id === "ethers") {
      const real = req.call(this, id) as Record<string, unknown>;
      return {
        ...real,
        Contract: class {
          filters = { Deposited: () => ({}) };
          async queryFilter() {
            if (!chainReachable) throw new Error("rpc unavailable");
            if (queryFails) throw new Error("log query failed mid-scan");
            return chainEvents;
          }
        },
      };
    }
    if (id.endsWith("/configV3") || id.endsWith("./configV3")) {
      return {
        v3Config: (c: number) => (c === CHAIN ? { vaultKernel: KERNEL } : undefined),
        v3Deployed: (c: number) => c === CHAIN,
      };
    }
    if (id.endsWith("/noteStoreV3") || id.endsWith("./noteStoreV3")) {
      return {
        saveV3Note: async (chainId: number, note: Record<string, unknown>) => {
          savedNotes.push(note);
          storage.setItem(
            `siphon-v3note-${chainId}-${String(note.symbol).toUpperCase()}-${note.commitment}`,
            JSON.stringify({ commitment: note.commitment, spent: "false", vaultId: `v3-${KERNEL}` }),
          );
        },
      };
    }
    if (id.endsWith("/leafIndexClient") || id.endsWith("../leafIndexClient")) {
      return { assetSymbolForToken: () => "ETH" };
    }
    return req.call(this, id);
  } as Req;
}

const signer = {
  getAddress: async () => "0xd5720ed6e70a128c025d0c284874cd1e33b39688",
  provider: {
    getBlockNumber: async () => {
      if (!chainReachable) throw new Error("rpc unavailable");
      return 11_640_000;
    },
    getBlock: async () => ({ timestamp: 1_788_000_000 }),
  },
} as unknown as import("ethers").Signer;

/** What the user ASKED to deposit. The vault credits `AMOUNT`, which is deliberately smaller. */
const REQUESTED = "10000000000000000";

function stash(nullifier: string, secret: string, userSalt: string, kernel = KERNEL) {
  const pre = "placeholder"; // key only needs to be unique; the module recomputes the real one
  storage.setItem(`v3-pending-deposit:${CHAIN}:${pre}-${nullifier}`, JSON.stringify({
    nullifier, secret, userSalt, token: TOKEN, amount: REQUESTED,
    vaultKernel: kernel, chainId: CHAIN, ts: Date.now(),
  }));
}

function stashKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith("v3-pending-deposit:")) out.push(k);
  }
  return out;
}

async function main() {
  await installMocks();
  const crypto3 = await import("./noteCryptoV3");
  const mod = await import("./recoverPendingDepositV3");

  const NULLIFIER = "12345678901234567890";
  const SECRET = "98765432109876543210";
  const SALT = "5555555555555555";
  const NONCE = 7n;
  const AMOUNT = 9_970_000_000_000_000n; // measured: less than REQUESTED (fee-on-transfer)

  // Build the commitment the way the VAULT would, so recovery has a real event to find.
  const assetId = crypto3.assetIdFromToken(TOKEN);
  const label = await crypto3.deriveDepositLabel({
    chainId: CHAIN, vaultAddress: KERNEL, depositNonce: NONCE, userSalt: BigInt(SALT),
  });
  const commitment = await crypto3.hashCommitment(
    AMOUNT, label, assetId, BigInt(NULLIFIER), BigInt(SECRET),
  );

  const realEvent = {
    args: { depositor: "0xd5720ed6e70a128c025d0c284874cd1e33b39688", token: TOKEN,
            amount: AMOUNT, commitment, depositNonce: NONCE, stateRootAfter: 1n },
    blockNumber: 11_635_700,
    transactionHash: "0xdeadbeef",
  };

  // ---- 1. the crash case: mined deposit, note never written -> recovered --------------------
  storage.clear(); savedNotes.length = 0; chainReachable = true;
  chainEvents = [realEvent];
  stash(NULLIFIER, SECRET, SALT);

  const r1 = await mod.recoverPendingDeposits(CHAIN, signer);
  assert.equal(r1.recovered, 1, `expected 1 recovered, got ${JSON.stringify(r1)}`);
  assert.equal(savedNotes.length, 1, "the note must actually be written");
  assert.equal(savedNotes[0].commitment, commitment.toString(), "must store the MINTED commitment");
  assert.equal(savedNotes[0].label, label.toString(), "label must come from the event's depositNonce");
  // The stash records the REQUESTED amount; the event carries what the vault actually credited.
  // They differ for a fee-on-transfer or rebasing token, and the note must match the leaf — so this
  // asserts against a value that is deliberately NOT the stashed one.
  assert.notEqual(AMOUNT, BigInt(REQUESTED), "fixture must distinguish requested from measured");
  assert.equal(savedNotes[0].value, AMOUNT, "value must be the MEASURED amount, not the requested one");
  assert.equal(savedNotes[0].depositTxHash, "0xdeadbeef", "must record the real deposit tx");
  assert.equal(stashKeys().length, 0, "a recovered stash must be cleared");

  // ---- 2. idempotent: running again does nothing ---------------------------------------------
  savedNotes.length = 0;
  stash(NULLIFIER, SECRET, SALT); // stash reappears (e.g. a second tab wrote it)
  const r2 = await mod.recoverPendingDeposits(CHAIN, signer);
  assert.equal(r2.alreadyPresent, 1, "an existing note must be detected, not rewritten");
  assert.equal(savedNotes.length, 0, "saveV3Note must not be called for an existing note");
  assert.equal(stashKeys().length, 0, "the redundant stash must still be cleared");

  // ---- 3. a stash with NO on-chain deposit is discarded, never turned into a phantom note -----
  // The tx reverted or was never sent. Writing a note here would show a balance the vault does
  // not have, and the spend would fail as "note not in state leaves".
  storage.clear(); savedNotes.length = 0;
  chainEvents = [];
  stash(NULLIFIER, SECRET, SALT);
  const r3 = await mod.recoverPendingDeposits(CHAIN, signer);
  assert.equal(r3.noDeposit, 1, "a stash with no matching deposit must be discarded");
  assert.equal(savedNotes.length, 0, "NO note may be written without an on-chain deposit");
  assert.equal(stashKeys().length, 0, "the dead stash must be cleared");

  // ---- 4. WRONG secrets must not match someone else's deposit --------------------------------
  // The commitment binds nullifier+secret, so a stash that does not derive the event's commitment
  // cannot claim it. This is what stops a stale stash from stealing an unrelated leaf.
  storage.clear(); savedNotes.length = 0;
  chainEvents = [realEvent];
  stash("11111111111111111111", "22222222222222222222", SALT);
  const r4 = await mod.recoverPendingDeposits(CHAIN, signer);
  assert.equal(r4.recovered, 0, "wrong secrets must NOT match an unrelated deposit");
  assert.equal(savedNotes.length, 0, "no note may be written from non-matching secrets");

  // ---- 5. wrong userSalt also fails (label is salt-derived) ----------------------------------
  storage.clear(); savedNotes.length = 0;
  chainEvents = [realEvent];
  stash(NULLIFIER, SECRET, "9999999999999999");
  const r5 = await mod.recoverPendingDeposits(CHAIN, signer);
  assert.equal(r5.recovered, 0, "a wrong userSalt derives a different label -> no match");

  // ---- 6. a stash from a RETIRED kernel is discarded ------------------------------------------
  storage.clear(); savedNotes.length = 0;
  chainEvents = [realEvent];
  stash(NULLIFIER, SECRET, SALT, "0x2631C72851c6300706E49DC2dCF70a8661B018c5");
  const r6 = await mod.recoverPendingDeposits(CHAIN, signer);
  assert.equal(r6.noDeposit, 1, "a stash from a previous kernel must not be rebuilt here");
  assert.equal(savedNotes.length, 0, "its leaf lives in the old tree — the note would be unspendable");

  // ---- 7. an unreachable chain DEFERS, and must never delete a stash --------------------------
  // Clearing an unverifiable stash destroys the only copy of the secrets.
  storage.clear(); savedNotes.length = 0;
  chainEvents = [realEvent];
  stash(NULLIFIER, SECRET, SALT);
  chainReachable = false;
  const r7 = await mod.recoverPendingDeposits(CHAIN, signer);
  assert.equal(r7.deferred, 1, "an unreachable chain must defer");
  assert.equal(r7.recovered, 0, "nothing may be recovered without the chain");
  assert.equal(stashKeys().length, 1, "SECRETS MUST SURVIVE: an unverified stash may not be deleted");
  chainReachable = true;

  // ---- 7b. a failure INSIDE the loop also defers, and still may not delete the stash ---------
  // Distinct from 7: there getBlockNumber fails and the function returns early. Here the scan
  // starts and dies mid-way, which is the path that actually reaches the per-stash catch.
  storage.clear(); savedNotes.length = 0;
  chainEvents = [realEvent];
  stash(NULLIFIER, SECRET, SALT);
  queryFails = true;
  const r7b = await mod.recoverPendingDeposits(CHAIN, signer);
  queryFails = false;
  assert.equal(r7b.deferred, 1, "a mid-scan failure must defer");
  assert.equal(r7b.recovered, 0, "nothing may be recovered from a failed scan");
  assert.equal(stashKeys().length, 1, "SECRETS MUST SURVIVE a mid-scan failure");

  // ---- 8. no stashes at all is a cheap no-op --------------------------------------------------
  storage.clear();
  const r8 = await mod.recoverPendingDeposits(CHAIN, signer);
  assert.deepEqual(r8, { recovered: 0, alreadyPresent: 0, noDeposit: 0, deferred: 0 });

  console.log("recoverPendingDepositV3.check.ts — all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
