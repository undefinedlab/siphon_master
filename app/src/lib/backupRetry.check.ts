// Runnable self-check for the backup retry queue — no test framework in this repo.
//   npx tsx src/lib/backupRetry.check.ts
//
// Covers the two D-5 fixes, both of which fail SILENTLY in production:
//   1. an offline retry must not burn an attempt (at MAX_BACKUP_TRIES the entry is dropped from
//      the queue and the note has no off-device copy, forever);
//   2. markNoteBackupConfirmed must flip the flag for v3 notes too — it built only the v2 key, so
//      a v3 note whose backup succeeded on RETRY stayed `backup:'pending'` while safely stored.
//
// Neither surfaces as an error: the first looks like "the backup just never happened", the second
// like a stuck badge. Only a test catches them before a user loses a note.

import assert from "node:assert";

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

// Force the SUPABASE path. Without these, postCommitment falls through to the trade-executor and
// needs a real wallet signature (noteAuthHeaders) — a different code path from the one under test.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.NEXT_PUBLIC_COMMITMENTS_VIA_SUPABASE = "1";

const CHAIN = 11155111;
const QUEUE_KEY = `siphon-backup-pending-${CHAIN}`;

/** Controls what the fake server does. */
let mode: "ok" | "reject" | "offline" = "ok";
let postCalls = 0;

function setOnline(online: boolean) {
  // Node exposes `navigator` as a getter-only property, so plain assignment throws.
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: online },
    configurable: true,
    writable: true,
  });
}

async function installMocks() {
  const Module = await import("node:module");
  type Req = (id: string) => unknown;
  const req = Module.default.prototype.require as Req;

  Module.default.prototype.require = function (this: unknown, id: string) {
    if (id.endsWith("/tradeExecutorClient") || id.endsWith("./tradeExecutorClient")) {
      return { getTradeExecutorBaseUrl: () => "http://localhost:5005" };
    }
    return req.call(this, id);
  } as Req;

  // fetch drives postCommitment / confirmCommitmentPersisted.
  g.fetch = async (url: string, init?: { method?: string }) => {
    if (mode === "offline") throw new TypeError("Failed to fetch");
    const method = init?.method ?? "GET";
    if (method === "POST") {
      postCalls++;
      if (mode === "reject") return { ok: false, status: 400, text: async () => "bad row" };
      return { ok: true, status: 201, json: async () => ({ id: "row-1" }), text: async () => "" };
    }
    // PATCH drives markCommitmentSpent — it must honour `mode` too, or a "rejecting" server still
    // accepts every status update and the queue is never exercised.
    if (method === "PATCH") {
      if (mode === "reject") return { ok: false, status: 400, text: async () => "rejected" };
      return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
    }
    // read-back confirmation
    return { ok: true, status: 200, json: async () => [{ id: "row-1" }] };
  };
}

function seedQueue(tries?: number) {
  storage.setItem(QUEUE_KEY, JSON.stringify([
    {
      payload: {
        nullifier: "1", secret: "2", commitment: "0xc0ffee", amount: "1000",
        chainId: CHAIN, nullifierHash: "3", precommitment: "4",
      },
      asset: "ETH",
      source: "deposit",
      ts: Date.now(),
      ...(tries != null ? { tries } : {}),
    },
  ]));
}

function queue(): Array<{ tries?: number }> {
  try { return JSON.parse(storage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
}

async function main() {
  await installMocks();
  const { drainBackupRetryQueue } = await import("./commitmentStore");
  const { markNoteBackupConfirmed } = await import("./localNoteStore");
  // A REAL wallet: postCommitment derives the tag and enc-key from actual signatures
  // (deriveCommTag / deriveEncKey), so a stub without signMessage never reaches the network call.
  const { Wallet } = await import("ethers");
  const signer = new Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  ) as unknown as import("ethers").Signer;

  // ---- 1. OFFLINE must not burn an attempt ---------------------------------------------------
  // The failure this prevents: 8 drains during a flight and the note is dropped from the queue
  // permanently, leaving the only copy in this browser.
  storage.clear();
  setOnline(false);
  mode = "offline";
  seedQueue(0);
  for (let i = 0; i < 12; i++) await drainBackupRetryQueue(signer, CHAIN);
  const afterOffline = queue();
  assert.equal(afterOffline.length, 1, "an offline note must STAY queued — dropping it loses it");
  assert.ok(
    (afterOffline[0].tries ?? 0) === 0,
    `offline retries must not burn attempts, got tries=${afterOffline[0].tries}`,
  );

  // ---- 2. a real server REJECTION does burn attempts, and eventually gives up -----------------
  // The cap exists for a genuinely bad payload; being online is what makes a failure evidence.
  storage.clear();
  setOnline(true);
  mode = "reject";
  seedQueue(0);
  for (let i = 0; i < 12; i++) await drainBackupRetryQueue(signer, CHAIN);
  assert.equal(queue().length, 0, "a persistently rejected row must eventually be given up on");

  // ---- 3. success drains the queue ------------------------------------------------------------
  storage.clear();
  setOnline(true);
  mode = "ok";
  postCalls = 0;
  seedQueue(0);
  const n = await drainBackupRetryQueue(signer, CHAIN);
  assert.equal(n, 1, "a successful backup must be reported");
  assert.equal(queue().length, 0, "a confirmed note must leave the queue");
  assert.equal(postCalls, 1, "exactly one POST per queued note");

  // ---- 4. the flag flips for a v3 note, not just a v2 one -------------------------------------
  // markNoteBackupConfirmed built only the v2 key, so a v3 note stayed 'pending' after a
  // successful retry: safely backed up, but reported as unbacked forever.
  storage.clear();
  const v3Key = `siphon-v3note-${CHAIN}-ETH-0xc0ffee`;
  const v2Key = `siphon-note-${CHAIN}-ETH-0xc0ffee`;
  storage.setItem(v3Key, JSON.stringify({ commitment: "0xc0ffee", backup: "pending" }));
  storage.setItem(v2Key, JSON.stringify({ commitment: "0xc0ffee", backup: "pending" }));
  await markNoteBackupConfirmed(CHAIN, "ETH", "0xc0ffee");
  assert.equal(
    JSON.parse(storage.getItem(v3Key)!).backup,
    "confirmed",
    "a V3 note must be marked confirmed — this is the silent one",
  );
  assert.equal(
    JSON.parse(storage.getItem(v2Key)!).backup,
    "confirmed",
    "the v2 path must keep working",
  );

  // ---- 5. absent rows are a no-op, not a throw ------------------------------------------------
  storage.clear();
  await markNoteBackupConfirmed(CHAIN, "ETH", "0xnothing");

  // ---- 6. a failed SPENT update is queued, not lost -------------------------------------------
  // The divergence this prevents: local says spent, server says unspent, forever. On a second
  // device the note then counts as spendable AND its strategy shows — same funds, two buckets.
  const { enqueueSpentUpdate, drainSpentUpdateQueue, markCommitmentSpentDurable } = await import(
    "./commitmentStore"
  );
  const SPENT_KEY = `siphon-spent-pending-${CHAIN}`;
  storage.clear();
  setOnline(true);
  mode = "reject";
  const okReject = await markCommitmentSpentDurable(signer, "row-9", "pending", CHAIN);
  assert.equal(okReject, false, "a rejected update must report failure");
  assert.equal(JSON.parse(storage.getItem(SPENT_KEY)!).length, 1, "…and must be QUEUED, not lost");

  // ---- 7. the queue drains when the server recovers -------------------------------------------
  mode = "ok";
  const drained = await drainSpentUpdateQueue(signer, CHAIN);
  assert.equal(drained, 1, "a recovered server must drain the queued update");
  assert.equal(JSON.parse(storage.getItem(SPENT_KEY) || "[]").length, 0, "queue must be empty");

  // ---- 8. dedup keeps the HIGHEST status, never downgrades ------------------------------------
  // A queued `pending` superseded by a later `true` must not resurrect as a downgrade on drain.
  storage.clear();
  enqueueSpentUpdate(CHAIN, "row-1", "pending");
  enqueueSpentUpdate(CHAIN, "row-1", "true");
  enqueueSpentUpdate(CHAIN, "row-1", "pending");
  const q8 = JSON.parse(storage.getItem(SPENT_KEY)!);
  assert.equal(q8.length, 1, "same row must dedup to one entry");
  assert.equal(q8[0].status, "true", "dedup must keep the highest rank, never downgrade");

  // ---- 9. offline spent-updates do not burn attempts ------------------------------------------
  storage.clear();
  setOnline(false);
  mode = "offline";
  enqueueSpentUpdate(CHAIN, "row-2", "true");
  for (let i = 0; i < 12; i++) await drainSpentUpdateQueue(signer, CHAIN);
  const q9 = JSON.parse(storage.getItem(SPENT_KEY) || "[]");
  assert.equal(q9.length, 1, "an offline status update must stay queued");
  assert.equal(q9[0].tries ?? 0, 0, "offline must not burn attempts");
  setOnline(true);

  console.log("backupRetry.check.ts — all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
