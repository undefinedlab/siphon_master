/**
 * v3 note store (Phase 1) — D1 asset-bound privacy note persistence.
 *
 * v3 notes carry {label, assetId, nullifier, secret, commitment, value}.
 * Encrypts secrets + label + assetId + value in AES-GCM via noteAuth.ts.
 * Reuses the durability system: local storage + Supabase write-then-verify confirmation queue (commitmentStore.ts).
 *
 * Enforces fail-closed rules: if v3 is not deployed (v3Deployed(chainId) === false), load/sync return empty/no-op.
 */

import { Contract, Signer } from "ethers";
import { v3Deployed, v3Config } from "./configV3";
import { deriveEncKey, encryptBlob, decryptBlob } from "../noteAuth";
import { noteAmountToWei } from "../noteAmount";
import { getTokens } from "../networks";
import {
  backupNoteWithConfirmation,
  fetchCommitments,
  markCommitmentSpentByCommitment,
  drainBackupRetryQueue,
  type CommitmentPayload,
  type CommitmentSource,
} from "../commitmentStore";
import type { SpendNote } from "./spendActionsV3";

export interface StoredV3Note {
  nullifier: string;
  secret: string;
  label: string;
  assetId: string;
  commitment: string;
  value: string;
  precommitment?: string;
  nullifierHash?: string;
  depositTxHash?: string;
  userSalt?: string;
  depositTimestamp?: number;
  spent: "false" | "pending" | "true";
  backup?: "confirmed" | "pending";
}

export interface StoredV3NoteInput {
  nullifier: string;
  secret: string;
  label: string;
  /** uint160(token) — the D1 crypto asset id (kept inside the note; NOT the storage key). */
  assetId: string;
  /** Uppercased token symbol (e.g. "USDC") — the canonical storage key + Supabase `asset` column,
   *  matching the v2 store convention so save/sync dedup correctly. */
  symbol: string;
  commitment: string;
  value: bigint | string;
  precommitment?: string;
  nullifierHash?: string;
  /** Original deposit receipt hash; only set for deposit-origin notes. */
  depositTxHash?: string;
  /** Deposit label salt; encrypted with the note, never stored in plaintext columns. */
  userSalt?: string;
  /** Unix timestamp of the mined deposit block; encrypted with the note. */
  depositTimestamp?: number;
  spent?: "false" | "pending" | "true";
  /** Where the note came from. Screening shows change notes with different copy, and only an
   *  original deposit is a "deposit" row. Absent on notes written before this tag existed. */
  origin?: "deposit" | "change";
}

const SPENT_RANK_V3: Record<string, number> = { false: 0, pending: 1, true: 2 };

/** Resolve the generation carried by a backup without guessing across a vault cutover. */
export function backupV3VaultId(row: {
  vaultId?: string | null;
  vaultAddress?: string | null;
}): string | null {
  const explicit = String(row.vaultId ?? "").trim();
  if (explicit) return explicit.toLowerCase().startsWith("v3-") ? explicit : null;
  const address = String(row.vaultAddress ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? `v3-${address}` : null;
}

export function sameV3VaultId(left: string | null, right: string): boolean {
  return !!left && left.toLowerCase() === right.toLowerCase();
}

/** Key by SYMBOL (uppercased), matching v2's `siphon-note-<chain>-<SYMBOL>-<commitment>` so that
 *  saveV3Note and syncV3FromServer (which reads the server's uppercased `asset`) agree on one key. */
export function v3NoteKey(chainId: number, symbol: string, commitment: string): string {
  return `siphon-v3note-${chainId}-${symbol.toUpperCase()}-${commitment}`;
}

export function parseV3NoteKey(
  key: string,
): { chainId: number; symbol: string; commitment: string } | null {
  if (!key.startsWith("siphon-v3note-")) return null;
  const parts = key.split("-");
  if (parts.length < 5) return null;
  const chainId = Number(parts[2]);
  const symbol = parts[3];
  const commitment = parts.slice(4).join("-");
  if (!chainId || !symbol || !commitment) return null;
  return { chainId, symbol, commitment };
}

/**
 * Save a v3 note locally with AES-GCM encryption and back it up to Supabase with read-back confirmation.
 */
export async function saveV3Note(
  chainId: number,
  note: StoredV3NoteInput,
  signer: Signer,
  source: CommitmentSource = "deposit",
): Promise<void> {
  const cfg = v3Config(chainId);
  const vaultId = cfg?.vaultKernel ? `v3-${cfg.vaultKernel}` : `v3-${chainId}`;
  const owner = (await signer.getAddress()).toLowerCase();
  const valueStr = String(note.value);
  const spentStatus: "false" | "pending" | "true" = note.spent ?? "false";

  const encKey = await deriveEncKey(signer);
  const { enc_blob, iv } = await encryptBlob(encKey, {
    nullifier: note.nullifier,
    secret: note.secret,
    label: note.label,
    assetId: note.assetId,
    value: valueStr,
    precommitment: note.precommitment ?? "",
    nullifierHash: note.nullifierHash ?? "",
    depositTxHash: note.depositTxHash ?? "",
    userSalt: note.userSalt ?? "",
    depositTimestamp: note.depositTimestamp,
  });

  const symbol = note.symbol.toUpperCase();
  const key = v3NoteKey(chainId, symbol, note.commitment);
  let createdAt = Date.now();
  let priorBackup: "confirmed" | "pending" | undefined;
  let priorOrigin: "deposit" | "change" | undefined;
  if (typeof localStorage !== "undefined") {
    try {
      const existing = JSON.parse(localStorage.getItem(key) || "{}") as {
        createdAt?: number;
        backup?: "confirmed" | "pending";
        origin?: "deposit" | "change";
      };
      if (typeof existing.createdAt === "number" && Number.isFinite(existing.createdAt)) {
        createdAt = existing.createdAt;
      }
      priorBackup = existing.backup;
      priorOrigin = existing.origin;
    } catch {
      /* ignore */
    }
  }

  const row = {
    enc_blob,
    iv,
    commitment: note.commitment,
    precommitment: note.precommitment ?? "",
    nullifierHash: note.nullifierHash ?? "",
    assetId: note.assetId,
    value: valueStr,
    chainId,
    spent: spentStatus,
    owner,
    createdAt,
    vaultId,
    backup: priorBackup ?? "pending",
    // Never let a re-save downgrade a known origin to undefined.
    origin: note.origin ?? priorOrigin,
  };

  if (typeof localStorage !== "undefined") {
    localStorage.setItem(key, JSON.stringify(row));
  }

  // Backup to Supabase with write-then-verify confirmation.
  const payload: CommitmentPayload = {
    nullifier: note.nullifier,
    secret: note.secret,
    commitment: note.commitment,
    // WEI, deliberately — do not "align" this with v2's human decimal. `vaultId` below is what
    // tells every reader which unit this is (noteAmount.ts). Writing human decimals here would
    // make new v3 rows indistinguishable from the wei ones already stored under the same
    // `v3-` vaultId, destroying the discriminator rather than removing the ambiguity.
    amount: valueStr,
    chainId,
    nullifierHash: note.nullifierHash ?? "",
    precommitment: note.precommitment ?? "",
    label: note.label,
    depositTxHash: note.depositTxHash,
    userSalt: note.userSalt,
    depositTimestamp: note.depositTimestamp,
    vaultAddress: cfg?.vaultKernel,
    vaultId,
  };

  const backupRes = await backupNoteWithConfirmation(signer, payload, symbol, source);
  if (backupRes.ok && typeof localStorage !== "undefined") {
    try {
      const updated = JSON.parse(localStorage.getItem(key) || "{}");
      updated.backup = "confirmed";
      localStorage.setItem(key, JSON.stringify(updated));
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Load all spendable (unspent) v3 notes for a given chain (and optional assetId).
 * Fails closed when !v3Deployed(chainId), returning an empty array.
 */
/**
 * Drop notes the chain has already nullified, and remember that locally.
 *
 * A v3 strategy is spent by the ENCLAVE at fire time, not by this browser, so nothing here ever
 * learns the input note was consumed — `spent` stays "false" forever. The note then keeps counting
 * toward the private balance and, worse, gets selected by the next TWAP/DCA, whose SPLIT reverts
 * on-chain with `NullifierAlreadyUsed`. That is a wasted proof, gas, and a dead-end error the user
 * cannot act on. `NullifierSet.isUsed` is the authoritative answer and costs one eth_call per
 * unspent note; once marked, a note is never re-checked.
 *
 * Fails OPEN: an RPC blip must not hide funds. Keeping a spent note degrades to exactly today's
 * behaviour (a loud on-chain revert), while dropping a live one shows the user a smaller balance
 * than they have.
 */
async function dropUsedNullifiers(
  chainId: number,
  signer: Signer,
  notes: SpendNote[],
): Promise<SpendNote[]> {
  const cfg = v3Config(chainId);
  if (!cfg?.vaultKernel || notes.length === 0) return notes;

  try {
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

    // Deadline the whole reconcile. This sits in front of every arm, before any progress is
    // logged, so a rate-limited provider stalls the UI with nothing on screen — and ethers retries
    // a 429 internally a dozen times per call, so N notes can hang for minutes. Failing open here
    // is already the designed behaviour on error; a slow answer is just a slow error.
    const RECONCILE_MS = 10_000;
    const used = await Promise.race([
      Promise.all(
        notes.map(async (n) => {
          try {
            return (await set.isUsed(await hashNullifier(BigInt(n.nullifier)))) as boolean;
          } catch {
            return false; // fail open, per the note above
          }
        }),
      ),
      new Promise<boolean[]>((_, reject) =>
        setTimeout(() => reject(new Error(`nullifier reconcile timed out after ${RECONCILE_MS}ms`)), RECONCILE_MS),
      ),
    ]);

    const live: SpendNote[] = [];
    for (let i = 0; i < notes.length; i++) {
      if (!used[i]) {
        live.push(notes[i]);
        continue;
      }
      console.log(`[noteStoreV3] note ${notes[i].commitment.slice(0, 18)}… already nullified on-chain — marking spent`);
      // Best-effort: the filter above is what protects this load, and a failure here only means
      // the same eth_call happens again next time.
      void markV3NoteSpent(chainId, notes[i].commitment, signer).catch(() => {});
    }
    return live;
  } catch (e) {
    console.warn("[noteStoreV3] nullifier reconcile unavailable — keeping all notes:", e);
    return notes;
  }
}

export async function loadV3Notes(
  chainId: number,
  signer: Signer,
  symbol?: string,
): Promise<SpendNote[]> {
  if (!v3Deployed(chainId)) {
    return [];
  }

  if (typeof localStorage === "undefined") return [];

  const encKey = await deriveEncKey(signer);
  const prefix = `siphon-v3note-${chainId}-${symbol ? `${symbol.toUpperCase()}-` : ""}`;
  const notes: SpendNote[] = [];

  // Only notes belonging to the CURRENTLY configured kernel are spendable. Keys are scoped by
  // chain + symbol + commitment, not by vault, so after a kernel cutover the retired generation's
  // notes sit in the same keyspace — and buildV3Multi picks by exact value, so it happily selected
  // one and tried to split it. The spend then failed with "note <c> not in state leaves", because
  // that leaf lives in the previous kernel's tree and never appears in this one's.
  const cfg = v3Config(chainId);
  const activeVaultId = cfg?.vaultKernel ? `v3-${cfg.vaultKernel}` : null;

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;

    const raw = localStorage.getItem(k);
    if (!raw) continue;

    try {
      const row = JSON.parse(raw);
      if (row.spent === "true") continue;
      if (!row.enc_blob || !row.iv) continue;
      // A row with no vaultId predates the tag; treat it as foreign rather than assume it is ours.
      // Being wrong the other way costs a failed spend after the arming fee is already paid.
      if (activeVaultId && row.vaultId !== activeVaultId) continue;

      const decrypted = await decryptBlob<{
        nullifier: string;
        secret: string;
        label: string;
        assetId: string;
        value: string;
        depositTxHash?: string;
        userSalt?: string;
        depositTimestamp?: number;
      }>(encKey, row.enc_blob as string, row.iv as string);

      const noteAsset = decrypted.assetId ?? row.assetId;

      notes.push({
        commitment: String(row.commitment),
        value: BigInt(decrypted.value ?? row.value ?? "0"),
        label: String(decrypted.label ?? ""),
        assetId: String(noteAsset),
        nullifier: String(decrypted.nullifier),
        secret: String(decrypted.secret),
        depositTxHash: decrypted.depositTxHash || undefined,
        userSalt: decrypted.userSalt || undefined,
        depositTimestamp: decrypted.depositTimestamp,
        createdAt: typeof row.createdAt === "number" ? row.createdAt : undefined,
      });
    } catch (e) {
      console.warn(`[noteStoreV3] skipping unreadable note key ${k}:`, e);
    }
  }

  return dropUsedNullifiers(chainId, signer, notes);
}

/**
 * Mark a v3 note as spent locally and on the server.
 * Uses one-directional status progression ('false' < 'pending' < 'true').
 */
export async function markV3NoteSpent(
  chainId: number,
  commitment: string,
  signer?: Signer,
): Promise<void> {
  if (typeof localStorage === "undefined") return;

  // Search matching keys in localStorage
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(`siphon-v3note-${chainId}-`)) continue;
    if (!k.endsWith(`-${commitment}`)) continue;

    const raw = localStorage.getItem(k);
    if (!raw) continue;

    try {
      const row = JSON.parse(raw);
      const curRank = SPENT_RANK_V3[String(row.spent)] ?? 0;
      if (curRank < SPENT_RANK_V3["true"]) {
        row.spent = "true";
        localStorage.setItem(k, JSON.stringify(row));
      }
    } catch {
      /* ignore */
    }
  }

  if (signer) {
    try {
      await markCommitmentSpentByCommitment(signer, commitment);
    } catch (e) {
      // markCommitmentSpentByCommitment resolves the row id itself and queues per-row on failure
      // (markCommitmentSpentDurable), so this catch only covers the LOOKUP failing — the update
      // itself is already durable.
      console.warn(`[noteStoreV3] markV3NoteSpent server sync failed for ${commitment}:`, e);
    }
  }
}

/**
 * Sync v3 notes from server (Supabase / trade-executor) to local storage.
 * Fails closed when !v3Deployed(chainId), returning 0.
 */
export async function syncV3FromServer(signer: Signer, chainId: number): Promise<number> {
  if (!v3Deployed(chainId)) {
    return 0;
  }

  try {
    const commits = await fetchCommitments(signer);
    let written = 0;
    const cfg = v3Config(chainId);
    const expectedVaultId = cfg?.vaultKernel ? `v3-${cfg.vaultKernel}` : `v3-${chainId}`;

    const encKey = await deriveEncKey(signer);
    /** Commitments of the CURRENT generation — drives the down-sync's local writes. */
    const serverCommitments = new Set<string>();
    /**
     * Every commitment the server holds, whatever its generation.
     *
     * The up-sync's question is "has this note been backed up?", which is NOT the same as "is this
     * note the current generation?" — and using one set for both is what made this loop:
     * the trade-executor's POST /commitments never stores vault_id, so every server row comes back
     * NULL, fails sameV3VaultId, and `continue`s BEFORE serverCommitments.add. The set stayed
     * empty, the up-sync concluded no local note had ever been backed up, and re-posted all of
     * them — a fresh uuid each time, with no unique constraint to stop it. Twenty "deposit" rows
     * from a handful of real deposits, growing on every tab focus and balance poll.
     */
    const allServerCommitments = new Set<string>();

    for (const c of commits) {
      const d = c.decrypted;
      if (!d?.commitment || !d.nullifier || !d.secret) continue;
      if (d.chainId && Number(d.chainId) !== chainId) continue;

      // Recorded BEFORE the generation gate below: it answers "is it on the server", and a row
      // being the wrong generation does not make it absent.
      allServerCommitments.add(d.commitment);

      const noteAsset = c.asset ?? "";
      const key = v3NoteKey(chainId, noteAsset, d.commitment);
      const existingRaw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
      const sourceVaultId = backupV3VaultId({
        vaultId: c.vault_id,
        vaultAddress: d.vaultAddress,
      });

      if (!sameV3VaultId(sourceVaultId, expectedVaultId)) {
        // Older code accepted EVERY `v3-*` server row, then stamped it with the CURRENT vault id.
        // That resurrected notes from retired kernels and the withdraw planner selected commitments
        // which cannot exist in the current state tree. Repair already-poisoned local metadata from
        // the authoritative backup generation, then leave the note available to migration tooling.
        if (existingRaw && sourceVaultId) {
          try {
            const localParsed = JSON.parse(existingRaw);
            localParsed.vaultId = sourceVaultId;
            localStorage.setItem(key, JSON.stringify(localParsed));
          } catch {
            /* corrupt local row remains unreadable and unselected */
          }
        }
        continue;
      }

      serverCommitments.add(d.commitment);

      let winningSpent: "false" | "pending" | "true" =
        c.spent === "true" ? "true" : c.spent === "pending" ? "pending" : "false";

      if (existingRaw) {
        try {
          const localParsed = JSON.parse(existingRaw);
          // Canonicalise casing and repair rows written before the local generation tag existed.
          localParsed.vaultId = expectedVaultId;
          const localRank = SPENT_RANK_V3[String(localParsed.spent)] ?? 0;
          const serverRank = SPENT_RANK_V3[String(c.spent)] ?? 0;

          if (serverRank > localRank || (localParsed.spent === "pending" && c.spent === "false")) {
            localParsed.spent = c.spent;
            localStorage.setItem(key, JSON.stringify(localParsed));
          } else if (localRank > serverRank) {
            winningSpent =
              localParsed.spent === "true"
                ? "true"
                : localParsed.spent === "pending"
                  ? "pending"
                  : "false";
          }
        } catch {
          /* overwrite corrupt local row */
        }
        continue;
      }

      // Missing locally — re-encrypt and store Format A
      if (typeof localStorage !== "undefined") {
        try {
          const owner = (await signer.getAddress()).toLowerCase();
          // `amount` is wei on v3 rows and a human decimal on v2 ones (see noteAmount.ts). Taking
          // it verbatim treated a v2-written row as wei and produced a note worth 1e18x too little.
          const decimals = getTokens(chainId)[String(noteAsset).toUpperCase()]?.decimals ?? 18;
          // chainId included so an UNTAGGED row (vault_id NULL) is still read as wei on a v3 chain.
          // Without it parseUnits ran over an already-wei amount and a 0.01 USDC note displayed
          // as 5000 USDC.
          // isV3: this IS the v3 sync, so the row belongs to the v3 store whether or not the
          // server tagged it. Without this an untagged row was read as a human decimal and
          // re-scaled by 10^decimals.
          const valueWei = noteAmountToWei(
            { amount: d.amount, vault_id: c.vault_id, isV3: true },
            decimals,
          );
          if (valueWei === null) {
            console.warn("[noteStoreV3] syncV3FromServer: unparseable amount — skipping", d.commitment);
            continue;
          }
          const { enc_blob, iv } = await encryptBlob(encKey, {
            nullifier: d.nullifier,
            secret: d.secret,
            label: d.label ?? "",
            assetId: noteAsset,
            value: valueWei.toString(),
            precommitment: d.precommitment ?? "",
            nullifierHash: d.nullifierHash ?? "",
            depositTxHash: d.depositTxHash ?? "",
            userSalt: d.userSalt ?? "",
            depositTimestamp: d.depositTimestamp,
          });

          const row = {
            enc_blob,
            iv,
            commitment: d.commitment,
            precommitment: d.precommitment ?? "",
            nullifierHash: d.nullifierHash ?? "",
            assetId: noteAsset,
            value: valueWei.toString(),
            chainId,
            spent: winningSpent,
            owner,
            // A note re-materialised from the server was NOT created now. Stamping Date.now()
            // here restarted its five-minute ragequit window on every re-sync, so an old deposit
            // kept showing "exit window open" after each reload — and re-opened a public exit for
            // a note whose window closed long ago. Use the real deposit time when the server has
            // it; otherwise leave it unset so the window reads as unknown (closed) rather than
            // fresh. createdAt feeds nothing but that window.
            createdAt:
              typeof d.depositTimestamp === "number" && d.depositTimestamp > 0
                ? d.depositTimestamp * 1_000
                : undefined,
            vaultId: expectedVaultId,
            backup: "confirmed",
          };

          localStorage.setItem(key, JSON.stringify(row));
          written++;
        } catch (e) {
          console.warn("[noteStoreV3] syncV3FromServer: failed writing note", d.commitment, e);
        }
      }
    }

    // Up-sync any unspent local v3 note missing from server
    if (typeof localStorage !== "undefined") {
      const prefix = `siphon-v3note-${chainId}-`;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;

        try {
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          const row = JSON.parse(raw);
          if (row.spent === "true") continue;
          // Do not rewrite a retired/unknown-generation note into the current generation merely
          // because it is absent from the current server subset. That was the other half of the
          // cross-vault resurrection bug.
          if (!sameV3VaultId(backupV3VaultId({ vaultId: row.vaultId }), expectedVaultId)) continue;
          // allServerCommitments, not serverCommitments: a note already backed up must not be
          // re-posted just because its row lost the vault_id tag in transit.
          if (allServerCommitments.has(row.commitment)) continue;

          const decrypted = await decryptBlob<{
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
          }>(encKey, row.enc_blob, row.iv);

          const payload: CommitmentPayload = {
            nullifier: decrypted.nullifier,
            secret: decrypted.secret,
            commitment: row.commitment,
            amount: decrypted.value ?? row.value,
            chainId,
            nullifierHash: decrypted.nullifierHash ?? row.nullifierHash ?? "",
            precommitment: decrypted.precommitment ?? row.precommitment ?? "",
            label: decrypted.label,
            depositTxHash: decrypted.depositTxHash,
            userSalt: decrypted.userSalt,
            depositTimestamp: decrypted.depositTimestamp,
            vaultAddress: cfg?.vaultKernel,
            vaultId: expectedVaultId,
          };

          const res = await backupNoteWithConfirmation(
            signer,
            payload,
            row.assetId ?? decrypted.assetId,
            // The note's own origin. Hardcoding "deposit" relabelled change notes and
            // vault-outputs on every re-upload, so the table's `source` column stopped meaning
            // anything.
            (row.origin === "change" ? "change" : "deposit"),
          );

          if (res.ok) {
            row.backup = "confirmed";
            localStorage.setItem(k, JSON.stringify(row));
          }
        } catch {
          /* ignore */
        }
      }
    }

    // Drain retry queue
    try {
      await drainBackupRetryQueue(signer, chainId);
    } catch {
      /* best-effort */
    }

    return written;
  } catch (e) {
    console.warn("[noteStoreV3] syncV3FromServer failed:", e);
    return 0;
  }
}
