// Runnable self-check for v3 note backup export/import — no test framework in this repo.
//   npx tsx src/lib/v3/noteBackupV3.check.ts
//
// The bug this file exists to catch: an import that "succeeds" and restores nothing usable. The v2
// path wrote imported notes under `siphon-note-…` while the v3 planner reads `siphon-v3note-…`, so
// the balance stayed zero with no error anywhere. Asserting "importV3NoteBackup returned 3" would
// NOT have caught that — it returned 3 too. So every assertion here is against what actually lands
// in the v3 keyspace, read back through the real reader.
//
// Runs against the REAL noteBackupV3 module with localStorage, crypto and the enc-key faked at the
// module boundary; a mirror implementation would prove nothing about the code that ships.

import assert from "node:assert";
import { webcrypto } from "node:crypto";

// ---- environment fakes (must be installed before the module under test loads) ---------------

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number): string | null {
    return Array.from(this.m.keys())[i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  snapshot(): Map<string, string> {
    return new Map(this.m);
  }
  restore(s: Map<string, string>): void {
    this.m = new Map(s);
  }
}

/** Nullifiers the fake chain reports as already used (as decimal strings). */
let spentNullifiers = new Set<string>();
let chainReachable = true;

/** Injected in place of the real NullifierSet.isUsed(hashNullifier(n)) call. */
const nullifierProbe = async (n: bigint): Promise<boolean> => {
  if (!chainReachable) throw new Error("rpc unavailable");
  return spentNullifiers.has(String(n));
};

const storage = new MemoryStorage();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = storage;
if (!g.crypto) g.crypto = webcrypto;
g.btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
g.atob = (s: string) => Buffer.from(s, "base64").toString("binary");

const CHAIN = 11155111;
const KERNEL = "0x586dFaa329D71de7368617C9f00395C040bCf84a";
const VAULT_ID = `v3-${KERNEL}`;
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// Distinct per wallet, so "wallet B cannot open wallet A's file" is a real cryptographic result
// and not an artefact of the fake.
async function keyForWallet(wallet: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`enc-key:${wallet}`);
  const digest = await webcrypto.subtle.digest("SHA-256", material);
  return webcrypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

let currentWallet = WALLET_A;
const signer = {
  getAddress: async () => currentWallet,
} as unknown as import("ethers").Signer;

// ---- module mocks ---------------------------------------------------------------------------

const savedNotes: Array<{ chainId: number; note: Record<string, unknown>; source: string }> = [];

/** Stand-in for the Supabase `commitments` table: commitment -> spent state. */
let serverRows: Array<{ commitment: string; spent: string; chainId: number }> = [];
let serverReachable = true;

async function installMocks() {
  const Module = await import("node:module");
  type Req = (id: string) => unknown;
  const req = Module.default.prototype.require as Req;

  const noteAuth = {
    deriveEncKey: async () => keyForWallet(currentWallet),
    encryptBlob: async (key: CryptoKey, payload: object) => {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ct = await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(payload)),
      );
      return {
        enc_blob: Buffer.from(ct).toString("base64"),
        iv: Buffer.from(iv).toString("base64"),
      };
    },
    decryptBlob: async (key: CryptoKey, enc_blob: string, iv: string) => {
      const pt = await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: Buffer.from(iv, "base64") },
        key,
        Buffer.from(enc_blob, "base64"),
      );
      return JSON.parse(new TextDecoder().decode(pt));
    },
  };

  const configV3 = {
    v3Config: (chainId: number) => (chainId === CHAIN ? { vaultKernel: KERNEL } : undefined),
    v3Deployed: (chainId: number) => chainId === CHAIN,
  };

  // The real saveV3Note, reduced to the one property under test: it writes a row into the v3
  // keyspace stamped with the CURRENT vaultId, which is precisely what the v2 path failed to do.
  const noteStoreV3 = {
    v3NoteKey: (chainId: number, symbol: string, commitment: string) =>
      `siphon-v3note-${chainId}-${symbol.toUpperCase()}-${commitment}`,
    // Mirrors the real one: flip the row's `spent` to "true" in place.
    markV3NoteSpent: async (chainId: number, commitment: string) => {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k || !k.startsWith(`siphon-v3note-${chainId}-`)) continue;
        if (!k.endsWith(`-${commitment}`)) continue;
        const row = JSON.parse(storage.getItem(k)!);
        row.spent = "true";
        storage.setItem(k, JSON.stringify(row));
      }
    },
    saveV3Note: async (
      chainId: number,
      note: Record<string, unknown>,
      _signer: unknown,
      source = "deposit",
    ) => {
      savedNotes.push({ chainId, note, source });
      const key = `siphon-v3note-${chainId}-${String(note.symbol).toUpperCase()}-${note.commitment}`;
      const enc = await noteAuth.encryptBlob(await keyForWallet(currentWallet), {
        nullifier: note.nullifier,
        secret: note.secret,
        label: note.label,
        assetId: note.assetId,
        value: String(note.value),
        precommitment: note.precommitment ?? "",
        nullifierHash: note.nullifierHash ?? "",
        depositTxHash: note.depositTxHash ?? "",
        userSalt: note.userSalt ?? "",
        depositTimestamp: note.depositTimestamp,
      });
      storage.setItem(
        key,
        JSON.stringify({
          enc_blob: enc.enc_blob,
          iv: enc.iv,
          commitment: note.commitment,
          value: String(note.value),
          vaultId: VAULT_ID,
          spent: "false",
          origin: source === "change" ? "change" : "deposit",
          createdAt: Date.now(),
        }),
      );
    },
  };

  Module.default.prototype.require = function (this: unknown, id: string) {
    if (id.endsWith("/noteAuth") || id.endsWith("../noteAuth")) return noteAuth;
    if (id.endsWith("/configV3") || id.endsWith("./configV3")) return configV3;
    if (id.endsWith("/noteStoreV3") || id.endsWith("./noteStoreV3")) return noteStoreV3;
    if (id.endsWith("/commitmentStore") || id.endsWith("../commitmentStore")) {
      return {
        fetchCommitments: async () => {
          if (!serverReachable) throw new Error("network down");
          return serverRows.map((r) => ({
            id: `id-${r.commitment}`,
            spent: r.spent,
            decrypted: { commitment: r.commitment, chainId: r.chainId },
          }));
        },
      };
    }
    return req.call(this, id);
  } as Req;
}

// ---- helpers ---------------------------------------------------------------------------------

/** Open a sealed backup the way the module does, so tests can inspect/rewrite its contents. */
async function noteAuthDecrypt(ciphertext: string, iv: string) {
  const pt = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(iv, "base64") },
    await keyForWallet(currentWallet),
    Buffer.from(ciphertext, "base64"),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as { notes: Array<Record<string, string>> };
}

async function noteAuthEncrypt(payload: object) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyForWallet(currentWallet),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { enc_blob: Buffer.from(ct).toString("base64"), iv: Buffer.from(iv).toString("base64") };
}

/** Nullifiers must be decimal strings: the real scan does BigInt(n.nullifier). */
function numericNullifier(commitment: string): string {
  let h = 0;
  for (const ch of commitment) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(1_000_000 + h);
}

async function seedNote(n: {
  symbol: string;
  commitment: string;
  value: string;
  label: string;
  assetId: string;
  vaultId?: string;
  spent?: string;
}) {
  const key = `siphon-v3note-${CHAIN}-${n.symbol}-${n.commitment}`;
  const encKey = await keyForWallet(currentWallet);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    encKey,
    new TextEncoder().encode(
      JSON.stringify({
        nullifier: numericNullifier(n.commitment),
        secret: `sec-${n.commitment}`,
        label: n.label,
        assetId: n.assetId,
        value: n.value,
        precommitment: `pre-${n.commitment}`,
        nullifierHash: `nh-${n.commitment}`,
        userSalt: `salt-${n.commitment}`,
      }),
    ),
  );
  storage.setItem(
    key,
    JSON.stringify({
      enc_blob: Buffer.from(ct).toString("base64"),
      iv: Buffer.from(iv).toString("base64"),
      commitment: n.commitment,
      value: n.value,
      vaultId: n.vaultId ?? VAULT_ID,
      spent: n.spent ?? "false",
      origin: "deposit",
      createdAt: Date.now(),
    }),
  );
}

/** Seed a v2-era row: `siphon-note-…`, Format B blob, plaintext decimal amount, no assetId. */
async function seedV2Note(n: { symbol: string; commitment: string; amount: string; label: string }) {
  const key = `siphon-note-${CHAIN}-${n.symbol}-${n.commitment}`;
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyForWallet(currentWallet),
    new TextEncoder().encode(
      JSON.stringify({
        nullifier: numericNullifier(n.commitment),
        secret: `sec-${n.commitment}`,
        label: n.label,
        vaultAddress: "0xoldvault",
      }),
    ),
  );
  storage.setItem(
    key,
    JSON.stringify({
      enc_blob: Buffer.from(ct).toString("base64"),
      iv: Buffer.from(iv).toString("base64"),
      commitment: n.commitment,
      amount: n.amount,
      asset: n.symbol,
      chainId: CHAIN,
      spent: "false",
    }),
  );
}

function v3Keys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(`siphon-v3note-${CHAIN}-`)) out.push(k);
  }
  return out;
}

// ---- the checks -------------------------------------------------------------------------------

async function main() {
  await installMocks();
  const mod = await import("./noteBackupV3");

  // ---- 1. round trip: export, wipe, import, and the notes are BACK IN THE v3 KEYSPACE --------
  storage.clear();
  savedNotes.length = 0;
  serverRows = [];
  serverReachable = true;
  spentNullifiers = new Set();
  chainReachable = true;
  currentWallet = WALLET_A;

  await seedNote({ symbol: "USDC", commitment: "c1", value: "1000", label: "LABEL-ONE", assetId: "a1" });
  await seedNote({ symbol: "USDC", commitment: "c2", value: "2500", label: "L2", assetId: "a1" });
  await seedNote({ symbol: "WETH", commitment: "c3", value: "77", label: "L3", assetId: "a2" });

  const built = await mod.buildV3NoteBackup(CHAIN, signer);
  assert.equal(built.noteCount, 3, "export should carry all three seeded notes");
  assert.equal(built.file.version, "siphon-backup-1");
  assert.equal(built.file.wallet, WALLET_A);
  assert.equal(
    built.file.contents.schemas.v3,
    3,
    "the header must count what is actually in the file",
  );
  assert.equal(built.file.contents.vaultIds[VAULT_ID], 3, "and which generations those notes are");

  // The payload must be genuinely sealed — the note secrets must not be readable in the file.
  // Checked here, BEFORE any import, so a plaintext export fails on this assertion rather than
  // being masked by a later decrypt error that reads like an unrelated bug.
  const serialized = JSON.stringify(built.file);
  const decodedCipher = Buffer.from(built.file.ciphertext, "base64").toString("binary");
  // Every marker must be long and distinctive. A short one like "L1" appears by chance in ~12% of
  // random base64 blobs, which makes the assertion flaky on the IV rather than on the code.
  for (const leak of ["sec-c1", numericNullifier("c1"), "pre-c1", "salt-c1", "LABEL-ONE"]) {
    assert.ok(!serialized.includes(leak), `SECRET LEAKED in file: ${leak} appears in plaintext`);
    assert.ok(
      !decodedCipher.includes(leak),
      `SECRET LEAKED in ciphertext: ${leak} is readable — the payload is not encrypted`,
    );
  }

  storage.clear();
  assert.equal(v3Keys().length, 0, "precondition: store is empty before import");

  const r1 = await mod.importV3NoteBackup(CHAIN, signer, serialized, { nullifierProbe });
  assert.equal(r1.imported, 3, `expected 3 imported, got ${r1.imported}`);
  assert.equal(r1.failed, 0, "no note should fail to import");

  // THE assertion. Not "did import report success" but "can the v3 reader see them".
  const restored = v3Keys();
  assert.equal(restored.length, 3, `notes must land in the v3 keyspace, got ${restored.length}`);
  assert.ok(
    restored.includes(`siphon-v3note-${CHAIN}-USDC-c1`),
    "imported note is not under the key v3 reads — this is the silent-zero-balance bug",
  );

  // Every restored row must carry the CURRENT vaultId, or loadV3Notes skips it.
  for (const k of restored) {
    const row = JSON.parse(storage.getItem(k)!);
    assert.equal(row.vaultId, VAULT_ID, `restored note ${k} has wrong vaultId ${row.vaultId}`);
  }

  // Full fidelity: the fields a spend needs must survive the round trip.
  const c1 = savedNotes.find((s) => s.note.commitment === "c1");
  assert.ok(c1, "c1 not passed to saveV3Note");
  assert.equal(c1!.note.label, "LABEL-ONE", "label lost in round trip — spend cannot prove ASP inclusion");
  assert.equal(c1!.note.assetId, "a1", "assetId lost in round trip");
  assert.equal(c1!.note.value, "1000", "value lost in round trip");
  assert.equal(c1!.note.precommitment, "pre-c1", "precommitment lost in round trip");
  assert.equal(c1!.note.nullifierHash, "nh-c1", "nullifierHash lost in round trip");
  assert.equal(c1!.note.userSalt, "salt-c1", "userSalt lost in round trip");

  // ---- 2. a different wallet CANNOT open the file --------------------------------------------
  currentWallet = WALLET_B;
  await assert.rejects(
    () => mod.importV3NoteBackup(CHAIN, signer, serialized, { nullifierProbe }),
    /different wallet/i,
    "wallet B must be refused wallet A's backup",
  );

  // ...and the refusal must not be only the plaintext hint: strip it and the SEAL must still hold.
  const stripped = JSON.stringify({ ...built.file, wallet: WALLET_B });
  await assert.rejects(
    () => mod.importV3NoteBackup(CHAIN, signer, stripped, { nullifierProbe }),
    /corrupt or belongs to another wallet/i,
    "SECURITY: the seal must reject a foreign wallet even when the plaintext hint is forged",
  );
  currentWallet = WALLET_A;

  // ---- 3. a tampered ciphertext is rejected (GCM authentication) ------------------------------
  const tampered = { ...built.file };
  const raw = Buffer.from(tampered.ciphertext, "base64");
  raw[raw.length - 20] ^= 0xff;
  tampered.ciphertext = raw.toString("base64");
  await assert.rejects(
    () => mod.importV3NoteBackup(CHAIN, signer, JSON.stringify(tampered), { nullifierProbe }),
    /corrupt/i,
    "a modified ciphertext must fail GCM authentication",
  );

  // ---- 4. notes from a RETIRED kernel are exported, but not restored as spendable -------------
  // A backup preserves secrets across generations (they cannot be regenerated), so the file is
  // accepted — but only current-generation notes may be written, or a spend would later fail with
  // "note not in state leaves". The count is reported so the user knows they exist.
  storage.clear();
  savedNotes.length = 0;
  serverRows = [];
  spentNullifiers = new Set();
  const mixed = JSON.parse(serialized) as typeof built.file;
  const inner = await noteAuthDecrypt(mixed.ciphertext, mixed.iv);
  inner.notes[0].vaultId = "v3-0x2631C72851c6300706E49DC2dCF70a8661B018c5"; // retired
  inner.notes[1].vaultId = "legacy"; // pre-tag row
  const resealed = await noteAuthEncrypt(inner);
  const mixedFile = JSON.stringify({ ...mixed, iv: resealed.iv, ciphertext: resealed.enc_blob });
  const rMixed = await mod.importV3NoteBackup(CHAIN, signer, mixedFile, { nullifierProbe });
  assert.equal(rMixed.skippedForeignVault, 2, "retired and legacy notes must be counted, not lost");
  assert.equal(rMixed.imported, 1, "only the current-generation note is restorable");
  assert.ok(
    !v3Keys().some((k) => k.endsWith("-c1")),
    "a retired-generation note must NOT be written into the current store",
  );

  // ---- 5. wrong chain is rejected -------------------------------------------------------------
  await assert.rejects(
    () => mod.importV3NoteBackup(CHAIN, signer, JSON.stringify({ ...built.file, chainId: 8453 }), { nullifierProbe }),
    /chain/i,
    "a backup for another chain must be refused",
  );

  // ---- 6. re-importing the same file is idempotent, not duplicated ----------------------------
  // Self-contained: restore from clean, then import the same file again.
  storage.clear();
  savedNotes.length = 0;
  serverRows = [];
  spentNullifiers = new Set();
  chainReachable = true;
  const rSeed = await mod.importV3NoteBackup(CHAIN, signer, serialized, { nullifierProbe });
  assert.equal(rSeed.imported, 3, "precondition: three notes restored before the re-import");
  const r2 = await mod.importV3NoteBackup(CHAIN, signer, serialized, { nullifierProbe });
  assert.equal(r2.imported, 0, "re-import must import nothing new");
  assert.equal(r2.skippedDuplicate, 3, "re-import must recognise all three as duplicates");
  assert.equal(v3Keys().length, 3, "re-import must not duplicate rows");

  // ---- 7. spent and foreign-vault notes are never exported ------------------------------------
  storage.clear();
  await seedNote({ symbol: "USDC", commitment: "ok", value: "1", label: "L", assetId: "a" });
  await seedNote({
    symbol: "USDC",
    commitment: "spent",
    value: "1",
    label: "L",
    assetId: "a",
    spent: "true",
  });
  await seedNote({
    symbol: "USDC",
    commitment: "old",
    value: "1",
    label: "L",
    assetId: "a",
    vaultId: "v3-0xdead",
  });
  const built2 = await mod.buildV3NoteBackup(CHAIN, signer);
  assert.equal(
    built2.noteCount,
    2,
    "export must keep retired-generation notes (secrets cannot be regenerated) and skip only spent ones",
  );
  const inner2 = await noteAuthDecrypt(built2.file.ciphertext, built2.file.iv);
  const oldNote = inner2.notes.find((n) => n.commitment === "old");
  assert.ok(oldNote, "the retired-generation note must be present in the export");
  assert.equal(oldNote.vaultId, "v3-0xdead", "each note must carry its OWN generation tag");

  // ---- 9. an unrelated JSON file is refused ---------------------------------------------------
  await assert.rejects(
    () => mod.importV3NoteBackup(CHAIN, signer, JSON.stringify({ hello: "world" }), { nullifierProbe }),
    /not a siphon notes backup/i,
  );
  await assert.rejects(() => mod.importV3NoteBackup(CHAIN, signer, "not json at all", { nullifierProbe }), /not a siphon/i);

  // ---- 10. a note already backed up on the SERVER is not re-inserted ------------------------
  // The real bug: postCommitment is a plain INSERT with a random uuid, so a re-import of a note
  // the server already holds appends a permanent duplicate row. The common case is a FRESH browser
  // (empty localStorage) whose server already has everything — local-only dedup misses it entirely.
  storage.clear();
  savedNotes.length = 0;
  serverReachable = true;
  chainReachable = true;
  spentNullifiers = new Set();
  serverRows = [
    { commitment: "c1", spent: "false", chainId: CHAIN },
    { commitment: "c2", spent: "false", chainId: CHAIN },
    { commitment: "c3", spent: "false", chainId: CHAIN },
  ];
  const r3 = await mod.importV3NoteBackup(CHAIN, signer, serialized, { nullifierProbe });
  assert.equal(
    r3.imported,
    0,
    "notes already on the server must not be re-imported — each one is a permanent duplicate row",
  );
  assert.equal(r3.skippedDuplicate, 3, "all three should be recognised from the server");
  assert.equal(savedNotes.length, 0, "saveV3Note must not be called for server-known notes");

  // ---- 11. the CHAIN decides spent-ness, not the server mirror -------------------------------
  // A strategy leg spent by the enclave never touches this browser AND never updates the Supabase
  // `spent` column, so the mirror still says "false" for a dead note. Only the nullifier set knows.
  storage.clear();
  savedNotes.length = 0;
  serverRows = [];
  spentNullifiers = new Set([numericNullifier("c1"), numericNullifier("c3")]);
  const r4 = await mod.importV3NoteBackup(CHAIN, signer, serialized, { nullifierProbe });
  assert.equal(r4.restoredSpent, 2, "notes nullified on-chain must be recorded as spent");
  assert.equal(r4.imported, 1, "only the genuinely unspent note counts as restored-spendable");

  // Restored either way — but the spent ones must be stored spent, so the planner never picks them
  // and a later re-import cannot resurrect them.
  const c1Row = JSON.parse(storage.getItem(`siphon-v3note-${CHAIN}-USDC-c1`)!);
  assert.equal(c1Row.spent, "true", "an on-chain-spent note must be stored spent, not spendable");
  const c2Row = JSON.parse(storage.getItem(`siphon-v3note-${CHAIN}-USDC-c2`)!);
  assert.equal(c2Row.spent, "false", "an unspent note must stay spendable");

  // ---- 11b. an unreachable CHAIN fails the import closed -------------------------------------
  // Importing blind would restore a spent note as spendable: the planner then builds a proof that
  // reverts with NullifierAlreadyUsed, which reads as a contract bug rather than a stale backup.
  storage.clear();
  spentNullifiers = new Set();
  chainReachable = false;
  await assert.rejects(
    () => mod.importV3NoteBackup(CHAIN, signer, serialized, { nullifierProbe }),
    /could not verify these notes against the chain/i,
    "an unreachable chain must cancel the import",
  );
  assert.equal(v3Keys().length, 0, "nothing may be written when the chain check cannot run");
  chainReachable = true;

  // ---- 12. an unreachable server fails the import CLOSED --------------------------------------
  // Guessing here writes duplicates that cannot be cleaned up, so refusing is the safe default.
  storage.clear();
  serverRows = [];
  spentNullifiers = new Set();
  serverReachable = false;
  await assert.rejects(
    () => mod.importV3NoteBackup(CHAIN, signer, serialized, { nullifierProbe }),
    /could not reach the note backup service/i,
    "an unreachable server must cancel the import, not import blind",
  );
  assert.equal(v3Keys().length, 0, "nothing may be written when the duplicate check cannot run");
  serverReachable = true;

  // ---- 13. v2-era notes are EXPORTED (secrets are irreplaceable) but never restored spendable --
  // The real store looked like this: every note under `siphon-note-…` with no assetId, a decimal
  // amount and no vaultId. Export must capture them or a localStorage clear loses them for good.
  storage.clear();
  savedNotes.length = 0;
  serverRows = [];
  spentNullifiers = new Set();
  chainReachable = true;

  await seedNote({ symbol: "USDC", commitment: "new1", value: "500", label: "LBL", assetId: "a1" });
  await seedV2Note({ symbol: "ETH", commitment: "old1", amount: "0.01", label: "OLDLABEL" });
  await seedV2Note({ symbol: "ETH", commitment: "old2", amount: "0.02", label: "OLDLABEL2" });

  const b3 = await mod.buildV3NoteBackup(CHAIN, signer);
  assert.equal(b3.noteCount, 3, "export must include v2-era notes alongside v3 ones");

  // THE header must not describe the app's config — it must describe the FILE. An earlier version
  // stamped the live kernel into a file holding only legacy v2 notes, so the header claimed they
  // were current-generation v3 notes. Nothing caught it because nothing asserted on the header.
  assert.equal(b3.file.contents.schemas.v2, 2, "header must count the v2 notes it actually holds");
  assert.equal(b3.file.contents.schemas.v3, 1, "header must count the v3 notes it actually holds");
  assert.equal(b3.file.contents.vaultIds.legacy, 2, "legacy notes must be visible in the header");

  const inner3 = await noteAuthDecrypt(b3.file.ciphertext, b3.file.iv);
  const v2note = inner3.notes.find((n) => n.commitment === "old1");
  assert.ok(v2note, "the v2 note must be in the export");
  assert.equal(v2note.schema, "v2", "a v2 note must be tagged so import can refuse it");
  assert.equal(v2note.value, "0.01", "v2 decimal amount is preserved verbatim, not guessed into wei");
  assert.equal(v2note.secret, "sec-old1", "the v2 secret — the irreplaceable part — must be present");

  // ...and importing that file must NOT resurrect them as spendable v3 notes.
  storage.clear();
  const r5 = await mod.importV3NoteBackup(CHAIN, signer, JSON.stringify(b3.file), { nullifierProbe });
  assert.equal(r5.imported, 1, "only the v3 note is restorable");
  assert.equal(r5.skippedForeignVault, 2, "v2 notes must be reported as needing migration");
  assert.ok(
    !v3Keys().some((k) => k.endsWith("-old1")),
    "a v2 note must never be written into the v3 keyspace — it would fail at proving time",
  );

  // ---- 14. a v2-ONLY export must not claim the live kernel ------------------------------------
  storage.clear();
  await seedV2Note({ symbol: "ETH", commitment: "solo", amount: "0.01", label: "L" });
  const b4 = await mod.buildV3NoteBackup(CHAIN, signer);
  assert.equal(b4.file.contents.schemas.v3, undefined, "a v2-only file must report NO v3 notes");
  assert.equal(b4.file.contents.schemas.v2, 1, "a v2-only file must report its v2 note");
  assert.equal(
    b4.file.contents.vaultIds[VAULT_ID],
    undefined,
    "a file holding only legacy notes must NOT be labelled with the live kernel generation",
  );

  console.log("noteBackupV3.check.ts — all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
