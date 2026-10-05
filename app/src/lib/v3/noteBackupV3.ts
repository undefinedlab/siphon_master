/**
 * v3 note backup — export every spendable note to a file, import it back.
 *
 * WHY THIS IS NOT THE v2 PATH. `commitmentStore.exportNotesFile` writes a `siphon-notes-v2` file
 * and its import writes through `writeNoteTyped`, which stores under `siphon-note-<chain>-<SYM>-<c>`.
 * v3 reads `siphon-v3note-…` (noteStoreV3.v3NoteKey) and refuses any row whose `vaultId` is not the
 * current kernel's. So a v2 import lands notes in a keyspace the v3 planner never scans: the file
 * restores "successfully", the balance stays zero, and nothing reports an error. This module writes
 * through `saveV3Note` instead, which is the only writer that produces a row v3 will select.
 *
 * SCOPE (deliberate): a backup is personal, not transferable. The file is sealed under the wallet's
 * enc-key — the AES-GCM key derived from a signature over `Siphon-Encryption-Key-v1` — so only the
 * wallet that exported it can open it. That is not a wrapper around a separate ownership check; it
 * IS the check. GCM is authenticated, so a different wallet's key fails to decrypt rather than
 * yielding plausible garbage. The plaintext `wallet` field exists only to tell "wrong wallet" apart
 * from "corrupt file" in the error message, and leaks nothing that is not already on-chain.
 *
 * This is not a new exposure surface: a compromised wallet can already re-derive the enc-key and
 * pull the same notes from the Supabase backup, so the file adds nothing an attacker did not have.
 */

import { Contract, type Signer } from "ethers";

import { deriveEncKey, encryptBlob, decryptBlob } from "../noteAuth";
import { fetchCommitments, type CommitmentSource } from "../commitmentStore";
import { v3Config, v3Deployed } from "./configV3";
import { markV3NoteSpent, saveV3Note, type StoredV3NoteInput } from "./noteStoreV3";

/** Typed exactly once so the export writer and the import reader cannot drift apart. */
export interface BackupNote {
  nullifier: string;
  secret: string;
  label: string;
  /** uint160(token). Absent on v2-era rows, which predate the D1 asset id. */
  assetId?: string;
  symbol: string;
  commitment: string;
  value: string;
  precommitment?: string;
  nullifierHash?: string;
  depositTxHash?: string;
  userSalt?: string;
  depositTimestamp?: number;
  source?: CommitmentSource;
  /** The generation this note was minted under, or "legacy" for rows written before the tag
   *  existed. Per-note, because one backup may span kernels; a later migration reads this. */
  vaultId: string;
  /** Which note schema this row came from. v2 notes CANNOT be restored as spendable v3 notes —
   *  they lack assetId, carry a human-decimal amount rather than wei, and use the older
   *  commitment scheme. They are exported so the secrets survive; migration is a separate job. */
  schema: "v3" | "v2";
}

export interface NoteBackupFile {
  /** File format version — the envelope, NOT the note schema. Notes carry their own `schema`. */
  version: "siphon-backup-1";
  /** Plaintext for diagnostics only — the seal, not this field, is what enforces ownership. */
  wallet: string;
  chainId: number;
  /**
   * What is actually inside, derived from the notes themselves — never from the app's current
   * config. An earlier version stamped the configured kernel here, so a file holding only legacy
   * v2 notes was labelled with the live v5 kernel: a reader (or a future migration) would conclude
   * they were current-generation notes and act on it.
   */
  contents: {
    /** Note count per schema, e.g. `{ v2: 27 }`. */
    schemas: Record<string, number>;
    /** Note count per generation tag, e.g. `{ legacy: 27 }`. */
    vaultIds: Record<string, number>;
  };
  /** The kernel this app was configured with at export time. Context only — says nothing about
   *  what the notes belong to; read `contents.vaultIds` for that. */
  exportedUnderVaultId: string;
  exported_at: string;
  iv: string;
  ciphertext: string;
}

export interface ImportResult {
  imported: number;
  /** Already known — present in this browser OR already backed up on the server. Not an error. */
  skippedDuplicate: number;
  /** Belongs to a retired kernel generation. Surfaced, never silent (see importV3NotesFile). */
  skippedForeignVault: number;
  /** Restored, but the chain says the nullifier is already used — stored as spent, not spendable. */
  restoredSpent: number;
  /** Present but unreadable — reported so a partial import is never mistaken for a clean one. */
  failed: number;
}

function activeVaultId(chainId: number): string | null {
  const cfg = v3Config(chainId);
  return cfg?.vaultKernel ? `v3-${cfg.vaultKernel}` : null;
}

/**
 * Read the raw v3 rows straight out of localStorage rather than via `loadV3Notes`.
 *
 * `loadV3Notes` returns SpendNote, which is shaped for the planner: it drops `symbol` (that lives
 * in the storage key, not the blob) and carries no `precommitment`/`nullifierHash`. Exporting from
 * it would silently write a file that cannot rebuild a complete note on the way back in.
 */
async function readAllV3Rows(
  chainId: number,
  signer: Signer,
): Promise<{ notes: BackupNote[]; unreadable: number }> {
  if (typeof localStorage === "undefined") return { notes: [], unreadable: 0 };

  const encKey = await deriveEncKey(signer);
  const vaultId = activeVaultId(chainId);
  const prefix = `siphon-v3note-${chainId}-`;
  const notes: BackupNote[] = [];
  let unreadable = 0;

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const raw = localStorage.getItem(k);
    if (!raw) continue;

    try {
      const row = JSON.parse(raw);
      // Spent notes are dead weight in a backup and dangerous to restore; see ImportResult.
      if (row.spent === "true") continue;
      if (!row.enc_blob || !row.iv) continue;
      // NO generation filter, deliberately. A backup preserves SECRETS, it does not judge
      // spendability: a note from a retired kernel is still the only copy of something that cannot
      // be regenerated, and the moment a user most needs a backup is precisely the kernel cutover
      // that would make it "foreign". Each note keeps its own vaultId below so a later migration
      // can tell the generations apart; import re-checks generation and asks the chain about
      // spent-ness, so nothing unspendable can return as spendable.

      const d = await decryptBlob<{
        nullifier: string;
        secret: string;
        label: string;
        assetId: string;
        value: string;
        precommitment?: string;
        nullifierHash?: string;
        depositTxHash?: string;
        userSalt?: string;
        depositTimestamp?: number;
      }>(encKey, row.enc_blob as string, row.iv as string);

      // The symbol is only in the key — `siphon-v3note-<chain>-<SYMBOL>-<commitment>` — and
      // saveV3Note needs it to rebuild the same key on the way back in.
      const rest = k.slice(prefix.length);
      const symbol = rest.slice(0, rest.indexOf("-"));
      if (!symbol) continue;

      notes.push({
        nullifier: String(d.nullifier),
        secret: String(d.secret),
        label: String(d.label ?? ""),
        assetId: String(d.assetId ?? row.assetId ?? ""),
        symbol,
        commitment: String(row.commitment),
        value: String(d.value ?? row.value ?? "0"),
        precommitment: d.precommitment || undefined,
        nullifierHash: d.nullifierHash || undefined,
        depositTxHash: d.depositTxHash || undefined,
        userSalt: d.userSalt || undefined,
        depositTimestamp: d.depositTimestamp,
        source: (row.origin === "change" ? "change" : "deposit") as CommitmentSource,
        // Rows written before the tag existed are marked "legacy" rather than guessed into the
        // current generation — assuming they are ours is what poisons a note store.
        vaultId: typeof row.vaultId === "string" && row.vaultId ? row.vaultId : "legacy",
        schema: "v3",
      });
    } catch {
      // Counted, not thrown: one corrupt row must not cost the user the rest of the backup.
      unreadable++;
    }
  }

  return { notes, unreadable };
}


/**
 * Read v2-era rows (`siphon-note-<chain>-<SYM>-<commitment>`) so their secrets are backed up too.
 *
 * These CANNOT be restored as spendable v3 notes: the blob carries no `assetId`, the amount is a
 * human decimal rather than wei, and the commitment scheme differs. They are captured because the
 * secrets are irreplaceable and a localStorage clear would lose them for good — the export is a
 * safe, and migration is the separate job that would make them spendable again.
 */
async function readAllV2Rows(
  chainId: number,
  signer: Signer,
): Promise<{ notes: BackupNote[]; unreadable: number }> {
  if (typeof localStorage === "undefined") return { notes: [], unreadable: 0 };

  const encKey = await deriveEncKey(signer);
  const prefix = `siphon-note-${chainId}-`;
  const notes: BackupNote[] = [];
  let unreadable = 0;

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // Must not also match `siphon-v3note-…`; that prefix is handled by readAllV3Rows.
    if (!k || !k.startsWith(prefix)) continue;
    const raw = localStorage.getItem(k);
    if (!raw) continue;

    try {
      const row = JSON.parse(raw);
      if (row.spent === "true") continue;
      if (!row.enc_blob || !row.iv) continue;

      // Format B blob: { nullifier, secret, label, vaultAddress }.
      const d = await decryptBlob<{
        nullifier: string;
        secret: string;
        label?: string;
        vaultAddress?: string;
      }>(encKey, row.enc_blob as string, row.iv as string);

      const rest = k.slice(prefix.length);
      const symbol = rest.slice(0, rest.indexOf("-"));
      if (!symbol) continue;

      notes.push({
        nullifier: String(d.nullifier),
        secret: String(d.secret),
        label: String(d.label ?? ""),
        symbol,
        commitment: String(row.commitment),
        // v2 stores a human decimal (e.g. "0.01"); kept verbatim rather than converted, so a
        // migration reads the original and this file never claims a wei value it did not have.
        value: String(row.amount ?? row.value ?? "0"),
        precommitment: row.precommitment || undefined,
        nullifierHash: row.nullifierHash || undefined,
        vaultId: typeof row.vaultId === "string" && row.vaultId ? row.vaultId : "legacy",
        schema: "v2",
      });
    } catch {
      unreadable++;
    }
  }

  return { notes, unreadable };
}

/**
 * Serialize every spendable note for `chainId`, sealed under the wallet's enc-key.
 * @returns the file contents and a suggested filename; the caller performs the download.
 */
export async function buildV3NoteBackup(
  chainId: number,
  signer: Signer,
): Promise<{ file: NoteBackupFile; filename: string; noteCount: number; unreadable: number }> {
  const wallet = (await signer.getAddress()).toLowerCase();
  const v3 = await readAllV3Rows(chainId, signer);
  const v2 = await readAllV2Rows(chainId, signer);
  const notes = [...v3.notes, ...v2.notes];
  const unreadable = v3.unreadable + v2.unreadable;
  if (notes.length === 0) {
    throw new Error("No spendable notes to export");
  }

  const encKey = await deriveEncKey(signer);
  const { enc_blob, iv } = await encryptBlob(encKey, { notes });

  // Summarise what is really in the file, so the header can never contradict the payload.
  const schemas: Record<string, number> = {};
  const vaultIds: Record<string, number> = {};
  for (const n of notes) {
    schemas[n.schema] = (schemas[n.schema] ?? 0) + 1;
    vaultIds[n.vaultId] = (vaultIds[n.vaultId] ?? 0) + 1;
  }

  const file: NoteBackupFile = {
    version: "siphon-backup-1",
    wallet,
    chainId,
    contents: { schemas, vaultIds },
    exportedUnderVaultId: activeVaultId(chainId) ?? "",
    exported_at: new Date().toISOString(),
    iv,
    ciphertext: enc_blob,
  };

  const stamp = file.exported_at.replace(/[:.]/g, "-");
  return {
    file,
    filename: `siphon-notes-${chainId}-${wallet.slice(0, 8)}-${stamp}.json`,
    noteCount: notes.length,
    unreadable,
  };
}


/**
 * Ask the chain which of these nullifiers have already been spent.
 *
 * The chain is the only authority worth trusting here. localStorage cannot know about a spend made
 * on another device, and the Supabase mirror cannot know about one made by the ENCLAVE at strategy
 * fire time — that path never touches this browser, so the backup row still reads `spent:false`
 * long after the note is dead. Importing such a note as spendable puts it back in the planner,
 * which then builds a proof that reverts with NullifierAlreadyUsed: wasted gas on an error the
 * user cannot act on.
 *
 * Fails CLOSED, unlike the same check in `dropUsedNullifiers`. That one runs on every load, where
 * hiding funds on an RPC blip is the worse error. This one runs once, on an explicit user action,
 * and writes durable rows — so an unverified import is worse than a retry.
 *
 * @returns commitment -> true when the note is already spent on-chain.
 */
export type NullifierProbe = (nullifier: bigint) => Promise<boolean>;

async function scanSpentOnChain(
  chainId: number,
  notes: Array<{ commitment: string; nullifier: string }>,
  probe?: NullifierProbe,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (notes.length === 0) return out;

  const cfg = v3Config(chainId);
  if (!cfg?.vaultKernel) throw new Error("v3 vault kernel not configured — cannot verify notes");

  // Injected in tests. Production builds the real probe here, so the shipped path is the default
  // rather than something only the test exercises.
  let isSpent = probe;
  if (!isSpent) {
    const { getReadProvider } = await import("../zkHandler");
    const { hashNullifier } = await import("./noteCryptoV3");
    const provider = getReadProvider(chainId);

    const kernel = new Contract(
      cfg.vaultKernel,
      ["function nullifiers() view returns (address)"],
      provider,
    );
    const set = new Contract(
      await kernel.nullifiers(),
      ["function isUsed(uint256) view returns (bool)"],
      provider,
    );
    isSpent = async (n: bigint) => (await set.isUsed(await hashNullifier(n))) as boolean;
  }

  // Sequential, in small batches: a restore can carry dozens of notes, and firing them all at once
  // rate-limits the provider — which ethers retries internally, turning a 429 into a long stall.
  const BATCH = 8;
  for (let i = 0; i < notes.length; i += BATCH) {
    const slice = notes.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (n) => {
        // No try/catch: one unanswered call means we cannot classify that note, and guessing
        // "unspent" is exactly the wrong way to be wrong. Let it reject the whole import.
        const used = await isSpent!(BigInt(n.nullifier));
        return [n.commitment, used] as const;
      }),
    );
    for (const [c, used] of results) out.set(c, used);
  }
  return out;
}

/**
 * Restore notes from a backup file.
 *
 * Every note goes through `saveV3Note`, which stamps the CURRENT `vaultId`, encrypts under the
 * enc-key and re-backs it to Supabase — so an imported note is indistinguishable from one this
 * browser created, and the planner selects it. Writing rows directly would reproduce the v2 bug.
 *
 * @throws before importing anything when the file is not this wallet's, not this chain's, or not
 *         this kernel generation's. Failing whole is the point: a partial restore that silently
 *         drops the notes the user actually needed reads as "my funds are gone".
 */
export async function importV3NoteBackup(
  chainId: number,
  signer: Signer,
  fileText: string,
  opts: { nullifierProbe?: NullifierProbe } = {},
): Promise<ImportResult> {
  let parsed: Partial<NoteBackupFile>;
  try {
    parsed = JSON.parse(fileText) as Partial<NoteBackupFile>;
  } catch {
    throw new Error("Not a Siphon notes backup file");
  }
  if (parsed.version !== "siphon-backup-1") {
    throw new Error("Not a Siphon notes backup file");
  }
  if (!parsed.iv || !parsed.ciphertext) {
    throw new Error("Backup file is missing its encrypted payload");
  }

  const wallet = (await signer.getAddress()).toLowerCase();
  // Checked before decrypting purely so the message can be specific. The seal is what actually
  // stops another wallet reading this file — a wrong enc-key fails GCM authentication below.
  if (parsed.wallet && parsed.wallet.toLowerCase() !== wallet) {
    throw new Error(
      `This backup belongs to a different wallet (${parsed.wallet.slice(0, 10)}…). ` +
        `Connect that wallet to restore it.`,
    );
  }
  if (parsed.chainId != null && Number(parsed.chainId) !== chainId) {
    throw new Error(
      `This backup is for chain ${parsed.chainId}, but you are connected to ${chainId}.`,
    );
  }

  const vaultId = activeVaultId(chainId);
  if (!vaultId) throw new Error("v3 vault kernel not configured — cannot import");
  // NOTE: no file-level generation check. Export now preserves notes from retired kernels (each
  // tagged with its own vaultId), so one file may legitimately span generations — refusing the
  // whole file would throw away the notes the user still CAN restore. The per-note check below
  // does the filtering instead.

  const encKey = await deriveEncKey(signer);
  let payload: { notes?: BackupNote[] };
  try {
    payload = await decryptBlob<{ notes?: BackupNote[] }>(encKey, parsed.ciphertext, parsed.iv);
  } catch {
    // GCM authentication failure: wrong enc-key, or the file was altered.
    throw new Error("Could not decrypt this backup — it is corrupt or belongs to another wallet");
  }
  if (!Array.isArray(payload.notes)) {
    throw new Error("Backup file contains no notes");
  }

  const result: ImportResult = {
    imported: 0,
    skippedDuplicate: 0,
    skippedForeignVault: 0,
    restoredSpent: 0,
    failed: 0,
  };

  // Dedup against BOTH stores, and the server is the one that matters.
  //
  // `postCommitment` is a plain INSERT keyed by a fresh `crypto.randomUUID()` — there is no upsert
  // and no unique constraint on the commitment, so every re-import of an already-backed-up note
  // appends another Supabase row. Local-only dedup does not prevent that: the common case is a
  // fresh browser (which is WHY the user is importing) where localStorage is empty but the server
  // already holds every note from `syncV3FromServer`. Checking only localStorage there would
  // duplicate the entire backup on the server, permanently, on the very first restore.
  const existing = new Set<string>();

  if (typeof localStorage !== "undefined") {
    const prefix = `siphon-v3note-${chainId}-`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const dash = rest.indexOf("-");
      if (dash >= 0) existing.add(rest.slice(dash + 1));
    }
  }

  // The server pass is for DEDUP ONLY. Its `spent` column is a mirror that the enclave's fire-time
  // spends never update, so it cannot decide spent-ness — the chain does, in scanSpentOnChain below.
  try {
    for (const c of await fetchCommitments(signer)) {
      const commitment = c.decrypted?.commitment;
      if (!commitment) continue;
      if (c.decrypted?.chainId != null && Number(c.decrypted.chainId) !== chainId) continue;
      existing.add(String(commitment));
    }
  } catch (e) {
    // Fail CLOSED on the duplicate question: without the server list we cannot tell a genuine
    // restore from a re-import, and guessing wrong writes permanent duplicate rows.
    throw new Error(
      "Could not reach the note backup service to check for existing notes — " +
        "import cancelled so nothing is duplicated. Try again when back online." +
        (e instanceof Error ? ` (${e.message})` : ""),
    );
  }

  // Classify every candidate against the chain BEFORE writing any of them, so a restore is
  // all-or-nothing on verification rather than half-verified when the RPC gives out midway.
  const candidates = payload.notes.filter(
    (n) =>
      n?.commitment &&
      n.nullifier &&
      n.secret &&
      n.symbol &&
      n.assetId &&
      n.schema !== "v2" &&
      !existing.has(String(n.commitment)) &&
      (n.vaultId ?? "legacy").toLowerCase() === vaultId.toLowerCase(),
  );
  let spentOnChain: Map<string, boolean>;
  try {
    spentOnChain = await scanSpentOnChain(chainId, candidates, opts.nullifierProbe);
  } catch (e) {
    throw new Error(
      "Could not verify these notes against the chain — import cancelled so no note is restored " +
        "as spendable when it has already been spent." +
        (e instanceof Error ? ` (${e.message})` : ""),
    );
  }

  for (const n of payload.notes) {
    if (!n?.commitment || !n.nullifier || !n.secret) {
      result.failed++;
      continue;
    }
    if (existing.has(String(n.commitment))) {
      result.skippedDuplicate++;
      continue;
    }
    // MUST precede the assetId check: a v2 note legitimately has no assetId, so testing that first
    // reports these as "failed" (reads as data corruption) instead of "needs migration".
    if (n.schema === "v2") {
      result.skippedForeignVault++;
      continue;
    }
    if (!n.symbol || !n.assetId) {
      result.failed++;
      continue;
    }
    // Only notes from the CURRENT generation can be spent here: a retired kernel's leaf lives in
    // its own tree, so restoring one would fail at proving time as "note not in state leaves".
    // Counted and reported, never silently dropped — the user is told the notes exist and are
    // waiting on migration rather than concluding they are lost. ("legacy" = pre-tag row.)
    if ((n.vaultId ?? "legacy").toLowerCase() !== vaultId.toLowerCase()) {
      result.skippedForeignVault++;
      continue;
    }

    const input: StoredV3NoteInput = {
      nullifier: String(n.nullifier),
      secret: String(n.secret),
      label: String(n.label ?? ""),
      assetId: String(n.assetId),
      symbol: String(n.symbol).toUpperCase(),
      commitment: String(n.commitment),
      value: String(n.value ?? "0"),
      precommitment: n.precommitment,
      nullifierHash: n.nullifierHash,
      depositTxHash: n.depositTxHash,
      userSalt: n.userSalt,
      depositTimestamp: n.depositTimestamp,
    };

    try {
      await saveV3Note(chainId, input, signer, n.source ?? "deposit");
      existing.add(String(n.commitment));
      // Restore it either way, then record the truth. Keeping a spent note (rather than dropping
      // it) means a later re-import cannot resurrect it, and the user can still see the history.
      if (spentOnChain.get(String(n.commitment))) {
        await markV3NoteSpent(chainId, String(n.commitment), signer);
        result.restoredSpent++;
      } else {
        result.imported++;
      }
    } catch {
      // Per-note: a Supabase write failure on one note must not abandon the rest of the restore.
      result.failed++;
    }
  }

  return result;
}
