/**
 * localNoteStore — all note persistence in localStorage.
 *
 * Format A/B (localStorage):
 *   key: siphon-note-{chainId}-{SYMBOL}-{commitment}
 *   value: { enc_blob, iv, commitment, precommitment, nullifierHash, amount, asset, chainId, spent, owner }
 *   enc_blob = AES-GCM({ nullifier, secret, label })  — label sealed; never plaintext
 *
 * Migration: old format used separate nullifier_enc / secret_enc fields in "ivB64.ctB64" encoding.
 * migrateLegacyNoteKeys() rewrites these to Format A on wallet connect. Idempotent.
 *
 * Secrets never touch localStorage in plaintext. spent:'pending' pre-tx, 'false' on confirm, 'true' to quarantine.
 */
import { Signer, parseUnits } from 'ethers';
import { deriveEncKey, encryptBlob, decryptBlob } from './noteAuth';
import { reconstructLeaf } from './zkHandler';
import { getTokens } from './networks';
import { noteAmountToHuman, noteAmountToWei } from './noteAmount';

// ── Types ──────────────────────────────────────────────────────────────────

export interface StoredNote {
  nullifier:     string;
  secret:        string;
  commitment:    string;
  precommitment: string;
  nullifierHash: string;
  /** Hard ASP association label (required for dual-inclusion spends). */
  label?:        string;
  /** Vault generation identity, encrypted with the note secrets. */
  vaultAddress?: string;
  /** Vault generation id (plaintext, from vault_registry) — the balance-display generation filter. */
  vaultId?:      string;
  amount:        string;
  spent:         'false' | 'pending' | 'true';
  /** Supabase durability state: 'confirmed' = verified in the backup; 'pending' = not yet verified. */
  backup?:       'confirmed' | 'pending';
}

export interface NoteMeta {
  key:           string;
  commitment:    string;
  precommitment: string;
  nullifierHash: string;
  amount:        string;
  spent:         string;
  owner:         string;
  createdAt?:    number;
  vaultId?:      string;
  backup?:       'confirmed' | 'pending';
}

// ── Key helpers ────────────────────────────────────────────────────────────

export function noteKey(chainId: number, symbol: string, commitment: string): string {
  return `siphon-note-${chainId}-${symbol.toUpperCase()}-${commitment}`;
}

export function parseNoteKey(key: string): { chainId: number; symbol: string; commitment: string } | null {
  if (!key.startsWith('siphon-note-')) return null;
  const parts = key.split('-');
  if (parts.length < 5) return null;
  const chainId    = Number(parts[2]);
  const symbol     = parts[3];
  const commitment = parts.slice(4).join('-');
  if (!chainId || !symbol || !commitment) return null;
  return { chainId, symbol, commitment };
}

// ── Write ──────────────────────────────────────────────────────────────────

export async function writeNoteTyped(
  chainId: number,
  symbol: string,
  note: StoredNote,
  signer: Signer,
): Promise<void> {
  const encKey = await deriveEncKey(signer);
  const owner  = (await signer.getAddress()).toLowerCase();
  // Format B: enc_blob = AES-GCM({ nullifier, secret, label }) — label never plaintext
  const { enc_blob, iv } = await encryptBlob(encKey, {
    nullifier: note.nullifier,
    secret: note.secret,
    label: note.label ?? '',
    vaultAddress: note.vaultAddress ?? '',
  });
  const key = noteKey(chainId, symbol, note.commitment);
  let createdAt = Date.now();
  try {
    const existing = JSON.parse(localStorage.getItem(key) || "{}") as { createdAt?: number };
    if (typeof existing.createdAt === "number" && Number.isFinite(existing.createdAt)) {
      createdAt = existing.createdAt;
    }
  } catch { /* first write */ }
  // Preserve an already-'confirmed' backup state across a pending→false flip: re-reading `existing`
  // lets a later write keep the durability we already verified, unless the caller explicitly sets it.
  let priorBackup: 'confirmed' | 'pending' | undefined;
  let priorVaultId: string | undefined;
  try {
    const existing = JSON.parse(localStorage.getItem(key) || "{}") as { backup?: 'confirmed' | 'pending'; vaultId?: string };
    priorBackup = existing.backup;
    priorVaultId = existing.vaultId;
  } catch { /* first write */ }
  const row = {
    enc_blob,
    iv,
    commitment:    note.commitment,
    precommitment: note.precommitment,
    nullifierHash: note.nullifierHash,
    // plaintext label intentionally omitted
    amount:        note.amount,
    asset:         symbol.toUpperCase(),
    chainId,
    spent:         note.spent,
    owner,
    createdAt,
    vaultId:       note.vaultId ?? priorVaultId,
    backup:        note.backup ?? priorBackup,
  };
  localStorage.setItem(key, JSON.stringify(row));
}

/** Flip an existing note's plaintext backup flag to 'confirmed' (no re-encryption needed). */
export async function markNoteBackupConfirmed(
  chainId: number,
  symbol: string,
  commitment: string,
): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  // BOTH keyspaces. This is called from the retry drain, which is shared by v2 and v3 notes, and
  // it used to build only the v2 key — so a v3 note whose backup succeeded on RETRY kept its
  // `backup:'pending'` flag forever. `saveV3Note` flips the flag itself on the happy path, so the
  // gap was invisible until a backup actually failed once and then recovered: the note was safely
  // on the server while the UI still reported it as unbacked.
  for (const key of [
    noteKey(chainId, symbol, commitment),
    `siphon-v3note-${chainId}-${symbol.toUpperCase()}-${commitment}`,
  ]) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const row = JSON.parse(raw) as Record<string, unknown>;
      row.backup = 'confirmed';
      localStorage.setItem(key, JSON.stringify(row));
    } catch { /* corrupt row — leave as-is */ }
  }
}

// ── Read ───────────────────────────────────────────────────────────────────

export async function readNoteTyped(
  chainId: number,
  symbol: string,
  commitment: string,
  signer: Signer,
): Promise<StoredNote | null> {
  const raw = localStorage.getItem(noteKey(chainId, symbol, commitment));
  if (!raw) return null;
  return _decodeRow(raw, commitment, signer);
}

export async function readNoteByKey(key: string, signer: Signer): Promise<StoredNote | null> {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const parsed = parseNoteKey(key);
  return _decodeRow(raw, parsed?.commitment ?? '', signer);
}

async function _decodeRow(raw: string, fallbackCommitment: string, signer: Signer): Promise<StoredNote | null> {
  let row: Record<string, unknown>;
  try { row = JSON.parse(raw); } catch { return null; }

  const encKey = await deriveEncKey(signer);

  // Format A/B: single enc_blob + iv
  if (row.enc_blob && row.iv) {
    try {
      const blob = await decryptBlob<{ nullifier: string; secret: string; label?: string; vaultAddress?: string }>(
        encKey, row.enc_blob as string, row.iv as string,
      );
      // Prefer encrypted label only — never fall back to plaintext row.label (HA-V-13).
      const sealedLabel = String(blob.label ?? "").trim();
      if (!sealedLabel || sealedLabel === "0") {
        if (row.label) {
          console.warn("[noteStore] refusing plaintext-only label — run purgePlaintextHints to re-seal");
        }
        return null;
      }
      return {
        nullifier: blob.nullifier,
        secret: blob.secret,
        commitment:    String(row.commitment   ?? fallbackCommitment),
        precommitment: String(row.precommitment ?? ''),
        nullifierHash: String(row.nullifierHash ?? ''),
        label:         sealedLabel,
        vaultAddress:  String(blob.vaultAddress ?? '') || undefined,
        vaultId:       row.vaultId != null ? String(row.vaultId) : undefined,
        amount:        String(row.amount        ?? '0'),
        spent:         (row.spent as 'false' | 'pending' | 'true') ?? 'false',
        backup:        row.backup === 'confirmed' ? 'confirmed' : row.backup === 'pending' ? 'pending' : undefined,
      };
    } catch { return null; }
  }

  // Legacy format: separate nullifier_enc + secret_enc — migrate-on-read when label is present.
  if (row.nullifier_enc && row.secret_enc) {
    try {
      const nullifier = await _decryptLegacyField(encKey, row.nullifier_enc as string);
      const secret = await _decryptLegacyField(encKey, row.secret_enc as string);
      const sealedLabel = String(row.label ?? '').trim();
      if (!sealedLabel || sealedLabel === '0') {
        console.warn('[noteStore] legacy note missing label — run migrateEncFormat or Import Notes');
        return null;
      }
      return {
        nullifier,
        secret,
        commitment:    String(row.commitment   ?? fallbackCommitment),
        precommitment: String(row.precommitment ?? ''),
        nullifierHash: String(row.nullifierHash ?? ''),
        label:         sealedLabel,
        amount:        String(row.amount        ?? '0'),
        spent:         (row.spent as 'false' | 'pending' | 'true') ?? 'false',
      };
    } catch {
      return null;
    }
  }

  return null;
}

async function _decryptLegacyField(key: CryptoKey, blob: string): Promise<string> {
  const [ivB64, ctB64] = blob.split('.');
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ── Scan (no decryption) ───────────────────────────────────────────────────

export function scanNotes(chainId: number, symbol: string): NoteMeta[] {
  const prefix = `siphon-note-${chainId}-${symbol.toUpperCase()}-`;
  const results: NoteMeta[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    try {
      const row = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (!row.commitment || !row.amount) continue;
      // Must have either new-format enc_blob or legacy nullifier_enc to be a real note
      if (!row.enc_blob && !row.nullifier_enc) continue;
      results.push({
        key,
        commitment:    String(row.commitment),
        precommitment: String(row.precommitment ?? ''),
        nullifierHash: String(row.nullifierHash ?? ''),
        amount:        String(row.amount),
        spent:         String(row.spent ?? 'false'),
        owner:         String(row.owner ?? ''),
        createdAt:     typeof row.createdAt === 'number' ? row.createdAt : undefined,
        vaultId:       row.vaultId != null ? String(row.vaultId) : undefined,
        backup:        row.backup === 'confirmed' ? 'confirmed' : row.backup === 'pending' ? 'pending' : undefined,
      });
    } catch { /* skip corrupt */ }
  }
  return results;
}

export function scanAllNoteMeta(): NoteMeta[] {
  const results: NoteMeta[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('siphon-note-')) continue;
    try {
      const row = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (!row.commitment || !row.amount) continue;
      if (!row.enc_blob && !row.nullifier_enc) continue;
      results.push({
        key,
        commitment:    String(row.commitment),
        precommitment: String(row.precommitment ?? ''),
        nullifierHash: String(row.nullifierHash ?? ''),
        amount:        String(row.amount),
        spent:         String(row.spent ?? 'false'),
        owner:         String(row.owner ?? ''),
        createdAt:     typeof row.createdAt === 'number' ? row.createdAt : undefined,
        vaultId:       row.vaultId != null ? String(row.vaultId) : undefined,
        backup:        row.backup === 'confirmed' ? 'confirmed' : row.backup === 'pending' ? 'pending' : undefined,
      });
    } catch { /* skip */ }
  }
  return results;
}

// ── Mutate spent flag ──────────────────────────────────────────────────────

const SPENT_RANK: Record<string, number> = { 'false': 0, 'pending': 1, 'true': 2 };

export function markNoteSpentTyped(
  chainId: number,
  symbol: string,
  commitment: string,
  spent: 'false' | 'pending' | 'true' = 'true',
): void {
  markNoteSpentByKey(noteKey(chainId, symbol, commitment), spent);
}

export function markNoteSpentByKey(key: string, spent: 'false' | 'pending' | 'true' = 'true'): void {
  const raw = localStorage.getItem(key);
  if (!raw) return;
  try {
    const row = JSON.parse(raw);
    const currentRank = SPENT_RANK[String(row.spent)] ?? 0;
    const newRank     = SPENT_RANK[spent]             ?? 0;
    // One-directional: only advance, never revert
    if (newRank <= currentRank) return;
    localStorage.setItem(key, JSON.stringify({ ...row, spent }));
  } catch { /* best-effort */ }
}

// ── Migration: old key prefix ─────────────────────────────────────────────

export function migrateLegacyNoteKeys(): number {
  const toMigrate: { oldKey: string; newKey: string; value: string }[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key.startsWith('siphon-')) continue;
    const parts = key.split('-');
    if (parts.length < 3) continue;
    const maybeChainId = Number(parts[0]);
    if (!Number.isInteger(maybeChainId) || maybeChainId < 1) continue;
    const maybeSymbol = parts[1];
    if (!maybeSymbol || maybeSymbol.length > 8) continue;
    try {
      const row = JSON.parse(localStorage.getItem(key) ?? '{}');
      if ((!row.nullifier_enc && !row.enc_blob) || !row.commitment) continue;
      toMigrate.push({ oldKey: key, newKey: `siphon-note-${key}`, value: localStorage.getItem(key)! });
    } catch { /* skip */ }
  }

  for (const { oldKey, newKey, value } of toMigrate) {
    try {
      localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    } catch { /* quota */ }
  }

  return toMigrate.length;
}

// ── Migration: old enc format (nullifier_enc/secret_enc → enc_blob) ───────

export async function migrateEncFormat(signer: Signer): Promise<number> {
  let migrated = 0;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('siphon-note-')) keys.push(k);
  }
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const row = JSON.parse(raw);
      // Already Format A
      if (row.enc_blob && row.iv) continue;
      // Legacy format: has nullifier_enc + secret_enc
      if (!row.nullifier_enc || !row.secret_enc) continue;
      const encKey   = await deriveEncKey(signer);
      const nullifier = await _decryptLegacyField(encKey, row.nullifier_enc as string);
      const secret    = await _decryptLegacyField(encKey, row.secret_enc as string);
      // Hard ASP spends require the label, and it must move inside the authenticated ciphertext.
      // A legacy row without a label cannot be made spendable safely; leave it for explicit import.
      const label = String(row.label ?? '').trim();
      if (!label || label === '0') continue;
      const { enc_blob, iv } = await encryptBlob(encKey, { nullifier, secret, label });
      const updated = { ...row, enc_blob, iv };
      delete updated.nullifier_enc;
      delete updated.secret_enc;
      delete updated.label;
      localStorage.setItem(key, JSON.stringify(updated));
      migrated++;
    } catch { /* skip — corrupt or wrong key, leave it for manual cleanup */ }
  }
  return migrated;
}

// ── Purge plaintext hints ─────────────────────────────────────────────────

export async function purgePlaintextHints(signer?: Signer): Promise<number> {
  const toRemove: string[] = [];
  const toReencrypt: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;

    // Always remove scratch keys from old consolidation/change-hint pattern
    if (key.startsWith('change-hint-') || key.startsWith('merge-hint-')) {
      toRemove.push(key);
      continue;
    }

    // Don't touch pending output notes — managed by resolvePendingOutputNotes
    if (key.startsWith('siphon-pending-output-')) continue;

    try {
      const raw = localStorage.getItem(key) ?? '{}';
      const row = JSON.parse(raw);

      // Plaintext nullifier/secret at top level — security violation
      if ((row.nullifier || row.secret) && !row.enc_blob) {
        if (signer && (row.nullifier || row.secret)) {
          toReencrypt.push(key);
        } else {
          toRemove.push(key);
        }
        continue;
      }

      // Old deposit hints with pending:true and plaintext nullifier
      if (row.pending === true && row.nullifier && !row.enc_blob) {
        toRemove.push(key);
        continue;
      }

      // New-format notes with no secrets at all (no enc_blob, no nullifier_enc) — stub entries
      if (key.startsWith('siphon-note-') && row.commitment && !row.enc_blob && !row.nullifier_enc) {
        toRemove.push(key);
        continue;
      }

      // Strip leftover plaintext label when sealed blob already carries secrets
      if (key.startsWith('siphon-note-') && row.enc_blob && row.iv && row.label != null) {
        try {
          const cleaned = { ...row };
          delete cleaned.label;
          localStorage.setItem(key, JSON.stringify(cleaned));
        } catch { /* ignore */ }
      }
    } catch { /* skip */ }
  }

  // Re-encrypt notes that have plaintext secrets
  if (signer && toReencrypt.length > 0) {
    try {
      const encKey = await deriveEncKey(signer);
      for (const key of toReencrypt) {
        try {
          const row = JSON.parse(localStorage.getItem(key) ?? '{}');
          if (!row.nullifier && !row.secret) continue;
          const { enc_blob, iv } = await encryptBlob(encKey, {
            nullifier: row.nullifier ?? '',
            secret:    row.secret    ?? '',
            label:     row.label ?? '',
          });
          const updated = { ...row, enc_blob, iv };
          delete updated.nullifier;
          delete updated.secret;
          delete updated.label;
          localStorage.setItem(key, JSON.stringify(updated));
        } catch { toRemove.push(key); } // if re-encrypt fails, remove it
      }
    } catch { toRemove.push(...toReencrypt); }
  } else {
    toRemove.push(...toReencrypt);
  }

  for (const key of toRemove) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  return toRemove.length;
}

// ── Delete ─────────────────────────────────────────────────────────────────

export function deleteNote(chainId: number, symbol: string, commitment: string): void {
  try { localStorage.removeItem(noteKey(chainId, symbol, commitment)); } catch { /* ignore */ }
}

// ── Server sync (Supabase → localStorage) ─────────────────────────────────

/**
 * Pull all Supabase commitments for this wallet and merge into localStorage.
 * - New notes (not in localStorage): write as Format A
 * - Existing notes: apply one-directional spent rank (server > local → update local; local > server → push up)
 * - Skip zero-amount rows
 * - Validates reconstructLeaf() before writing (poison guard)
 * Returns count of newly written notes.
 */
export async function syncFromServer(signer: Signer): Promise<number> {
  try {
    const { fetchCommitments, markCommitmentSpent } = await import('./commitmentStore');
    // Fetch ALL rows (no spent filter) so cross-device spends are delivered
    const commits = await fetchCommitments(signer);
    let written = 0;
    const pendingSpentPushes: Promise<void>[] = [];

    for (const c of commits) {
      const d = c.decrypted;
      if (!d?.commitment || !d.nullifier || !d.secret) continue;
      // v3 commitments share the backup table but use an asset-bound Poseidon3 leaf and their own
      // `siphon-v3note-` store. Feeding them through this legacy Poseidon2 recovery can never match
      // and produced one false "recovered leaf ≠ commitment — corrupt row" warning per note on
      // every dashboard refresh. syncV3FromServer owns these rows.
      if (String(c.vault_id ?? "").toLowerCase().startsWith("v3-")) continue;

      // …and the same for rows with NO vault_id at all. The prefix test above only catches rows
      // that were TAGGED; a v3 note written through the v2 `postCommitment` path (reconcileNotesUp,
      // the retry queue) carries vault_id NULL, slipped through, and got written into the v2
      // keyspace as `siphon-note-…` — a note the v3 planner will never select, sitting next to the
      // `siphon-v3note-` entries it should have been. It also failed the leaf check on every
      // refresh, which is where the "recovered leaf ≠ commitment" warnings came from.
      //
      // The chain decides: on a v3 chain there is no such thing as a legitimate v2 note to
      // recover, so an untagged row is v3-or-unknown and belongs to syncV3FromServer either way.
      // Writing a WRONG note is worse than writing none — a wrong one is invisible until a spend
      // fails against it.
      if (!c.vault_id) {
        const { v3Deployed } = await import('./v3/configV3');
        if (v3Deployed(Number(d.chainId))) continue;
      }
      // precommitment + nullifierHash are pure Poseidon functions of (nullifier, secret). Normal
      // deposits store them on the server row, but slice-notes minted by split() (DCA/TWAP) were
      // saved WITHOUT them — which stranded any unspent slice invisibly. Recover them from the
      // secret material instead of dropping the note; verify the recovered precommitment reproduces
      // the stored on-chain leaf first (poison guard — a mismatch means a corrupt row, skip it).
      let precommitment = d.precommitment as string | undefined;
      let nullifierHash = d.nullifierHash as string | undefined;
      if (!precommitment || !nullifierHash) {
        try {
          const rsym = String(c.asset ?? '').toUpperCase();
          const decimals = getTokens(Number(d.chainId))[rsym]?.decimals ?? 18;
          // `amount` is a human decimal on v2 rows and wei on v3 ones — see noteAmount.ts. Reading
          // a v3 row with parseUnits() inflated it by 1e18, so reconstructLeaf disagreed with the
          // stored commitment and a perfectly good note was thrown away as a "corrupt row".
          const amountWei = noteAmountToWei({ amount: d.amount, vault_id: c.vault_id }, decimals);
          if (amountWei === null) {
            console.warn('[noteStore] syncFromServer: unparseable amount — skipping', d.commitment);
            continue;
          }
          const label = d.label != null && String(d.label).trim() !== '' ? BigInt(d.label) : null;
          if (label === null) {
            console.warn('[noteStore] syncFromServer: missing Hard ASP label — skipping', d.commitment);
            continue;
          }
          const r = await reconstructLeaf(BigInt(d.nullifier), BigInt(d.secret), amountWei, label);
          if (r.leaf.toString() !== String(d.commitment)) {
            console.warn('[noteStore] syncFromServer: recovered leaf ≠ commitment — skipping corrupt row', d.commitment);
            continue;
          }
          precommitment = r.precommitment.toString();
          nullifierHash = r.nullifierHash.toString();
          console.log('[noteStore] syncFromServer: recovered precommitment/nullifierHash for slice-note', d.commitment);
        } catch (e) {
          console.warn('[noteStore] syncFromServer: could not recover precommitment/nullifierHash', d.commitment, e);
          continue;
        }
      }
      const sym = String(c.asset ?? '').toUpperCase();
      const cid = Number(d.chainId);
      if (!sym || !cid) continue;

      const amt = noteAmountToHuman(
        { amount: d.amount, vault_id: c.vault_id },
        getTokens(cid)[sym]?.decimals ?? 18,
      );
      if (!Number.isFinite(amt) || amt <= 0) continue;

      const newKey = noteKey(cid, sym, d.commitment);
      const existingRaw = localStorage.getItem(newKey);
      // Prefer server spent unless local already advanced further (plaintext spent survives
      // even when secrets are unreadable due to a missing Hard ASP sealed label).
      let winningSpent: 'false' | 'pending' | 'true' =
        c.spent === 'true' ? 'true' : c.spent === 'pending' ? 'pending' : 'false';

      if (existingRaw) {
        // Note already local — check if it's a scannable stub with no enc_blob (unspendable),
        // or an encrypted row that fails to decrypt (corrupt / missing sealed label).
        let isStub = false;
        let isUnreadable = false;
        let localSpent: string | undefined;
        try {
          const localParsed = JSON.parse(existingRaw);
          localSpent = localParsed.spent != null ? String(localParsed.spent) : undefined;
          isStub = !localParsed.enc_blob && !localParsed.nullifier_enc;
          if (!isStub) {
            isUnreadable = !(await readNoteByKey(newKey, signer));
          }
        } catch {
          isStub = true;
        }

        // Apply one-directional spent rank even for label-unreadable rows — otherwise a
        // local spent=true is wiped when sync rewrites secrets from the server.
        if (localSpent !== undefined) {
          try {
            const localRank  = SPENT_RANK[localSpent] ?? 0;
            const serverRank = SPENT_RANK[String(c.spent)] ?? 0;

            // Server 'false' beats local 'pending': pending is a pre-tx placeholder;
            // if the server confirmed the note as spendable, trust that over the local hint.
            // Only 'true' (spent on-chain) is truly irreversible.
            const serverBeatsLocal = serverRank > localRank ||
              (localSpent === 'pending' && c.spent === 'false');
            if (serverBeatsLocal) {
              const local = JSON.parse(existingRaw);
              localStorage.setItem(newKey, JSON.stringify({ ...local, spent: c.spent }));
              winningSpent = c.spent === 'true' ? 'true' : c.spent === 'pending' ? 'pending' : 'false';
            } else if (localRank > serverRank) {
              winningSpent = localSpent === 'true' ? 'true' : localSpent === 'pending' ? 'pending' : 'false';
              // Awaited below so callers (and tests) see the push before sync returns.
              pendingSpentPushes.push(
                markCommitmentSpent(signer, c.id, winningSpent).catch((e) => {
                  console.warn(
                    '[noteStore] syncFromServer: could not push local spent=%s to server for %s — local/server will diverge:',
                    winningSpent, c.id, e,
                  );
                }),
              );
            }
          } catch { /* skip */ }
        }

        if (!isStub && !isUnreadable) {
          continue;
        }
        // Stub or unreadable local copy — fall through to writeNoteTyped with server secrets
      }

      // New note — write to localStorage as Format A
      try {
        await writeNoteTyped(cid, sym, {
          nullifier:     d.nullifier,
          secret:        d.secret,
          commitment:    d.commitment,
          precommitment: precommitment!,
          nullifierHash: nullifierHash!,
          label:         d.label != null ? String(d.label) : undefined,
          vaultAddress:  d.vaultAddress,
          amount:        d.amount,
          spent:         winningSpent,
        }, signer);
        written++;
      } catch (e) {
        console.warn('[noteStore] syncFromServer: failed to write note', d.commitment, e);
      }
    }

    if (pendingSpentPushes.length) {
      await Promise.allSettled(pendingSpentPushes);
    }

    // UP-SYNC: push any unspent local note that is NOT in the server set. This is the missing
    // direction that closes the no-note-loss gap — a note whose initial backup failed (Supabase
    // down at creation) is re-backed-up here on the next sync, before localStorage could be cleared.
    try {
      const serverCommitments = new Set(
        commits.map((c) => String(c.decrypted?.commitment ?? '')).filter(Boolean),
      );
      await reconcileNotesUp(signer, serverCommitments);
    } catch (e) {
      console.warn('[noteStore] up-sync reconcile failed (non-blocking):', e);
    }

    return written;
  } catch (e) {
    console.warn('[noteStore] syncFromServer failed:', e);
    return 0;
  }
}

/**
 * Push unspent local notes missing from Supabase up to the backup, and drain the retry queue.
 * The catch-all for the no-note-loss invariant: after this runs, every unspent local note is either
 * confirmed in Supabase or (if the push failed) queued for the next attempt.
 *
 * `serverCommitments` is the set of commitments already known to Supabase (passed in by syncFromServer
 * to avoid a second fetch). When called standalone, pass an empty set to force a re-push of everything
 * unspent (the backup dedupes by commitment, so this is safe).
 */
export async function reconcileNotesUp(
  signer: Signer,
  serverCommitments: Set<string>,
): Promise<number> {
  if (typeof localStorage === 'undefined') return 0;
  const { backupNoteWithConfirmation, drainBackupRetryQueue } = await import('./commitmentStore');
  let pushed = 0;
  const chainsSeen = new Set<number>();

  // Group unspent local notes by chain so we can drain each chain's retry queue once.
  const { v3Deployed } = await import('./v3/configV3');
  for (const meta of scanNoteMeta('')) {
    if (meta.spent === 'true') continue;
    const parsedChain = parseNoteKey(meta.key);
    // Never push a v2-keyspace note from a v3 chain. Those notes should not exist: they are the
    // residue of the down-sync writing untagged server rows into `siphon-note-…` (fixed above), and
    // re-uploading them is what made the cycle self-sustaining — down-sync creates one, up-sync
    // pushes it back with vault_id NULL, down-sync sees it again. On a v3 chain the real notes live
    // under `siphon-v3note-` and syncV3FromServer owns their backup, so there is nothing here worth
    // pushing and everything here worth not re-creating.
    if (parsedChain && v3Deployed(parsedChain.chainId)) continue;
    const parsed = parseNoteKey(meta.key);
    if (!parsed) continue;
    chainsSeen.add(parsed.chainId);
    if (serverCommitments.has(meta.commitment)) continue; // already backed up
    // Reconstruct the payload from the encrypted note (needs the secrets).
    const note = await readNoteByKey(meta.key, signer);
    if (!note) continue; // unreadable (missing sealed label) — cannot re-encrypt a backup
    const res = await backupNoteWithConfirmation(
      signer,
      {
        nullifier:     note.nullifier,
        secret:        note.secret,
        commitment:    note.commitment,
        amount:        note.amount,
        chainId:       parsed.chainId,
        nullifierHash: note.nullifierHash,
        precommitment: note.precommitment,
        label:         note.label,
        vaultAddress:  note.vaultAddress,
        vaultId:       note.vaultId ?? meta.vaultId,
      },
      parsed.symbol,
      'deposit',
    );
    if (res.ok) {
      pushed++;
      await markNoteBackupConfirmed(parsed.chainId, parsed.symbol, note.commitment);
    }
  }

  for (const chainId of chainsSeen) {
    try { await drainBackupRetryQueue(signer, chainId); } catch { /* best-effort */ }
  }
  return pushed;
}

/**
 * Repair unreadable local notes: migrate legacy format, then pull decryptable copies from Supabase.
 * Safe to call before withdraw proof generation.
 */
export async function repairNoteSecrets(signer: Signer): Promise<number> {
  await migrateEncFormat(signer);
  return syncFromServer(signer);
}

/**
 * Called on wallet connect. Runs the full startup note-hygiene sequence.
 */
export async function recoverPendingHints(signer: Signer): Promise<void> {
  migrateLegacyNoteKeys();
  await migrateEncFormat(signer);
  await purgePlaintextHints(signer);
  await syncFromServer(signer);
}

// ── Backward-compatible shims ──────────────────────────────────────────────
// Keep until zkHandler / noteConsolidator / outputNoteResolver are updated.

export function scanNoteMeta(prefix: string): NoteMeta[] {
  const newPrefix = `siphon-note-${prefix}`;
  const results: NoteMeta[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(newPrefix)) continue;
    try {
      const row = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (!row.commitment || !row.amount) continue;
      if (!row.enc_blob && !row.nullifier_enc) continue;
      results.push({
        key,
        commitment:    String(row.commitment),
        precommitment: String(row.precommitment ?? ''),
        nullifierHash: String(row.nullifierHash ?? ''),
        amount:        String(row.amount),
        spent:         String(row.spent ?? 'false'),
        owner:         String(row.owner ?? ''),
        createdAt:     typeof row.createdAt === 'number' ? row.createdAt : undefined,
        vaultId:       row.vaultId != null ? String(row.vaultId) : undefined,
        backup:        row.backup === 'confirmed' ? 'confirmed' : row.backup === 'pending' ? 'pending' : undefined,
      });
    } catch { /* skip */ }
  }
  return results;
}

export async function readNote(key: string, signer: Signer): Promise<StoredNote | null> {
  return readNoteByKey(key, signer);
}

/**
 * Count unspent notes on a chain explicitly flagged backup:'pending' — a note whose initial Supabase
 * backup FAILED and is queued for retry. Only these are surfaced as "backing up" in the dashboard.
 *
 * Deliberately does NOT count notes with no backup flag: those PREDATE the feature and are healed by the
 * up-sync reconcile (syncFromServer → reconcileNotesUp), so flagging them all would show a false scary
 * count on first load. A missing flag means "unknown, will be reconciled", not "at risk".
 */
export function countPendingBackups(chainId: number): number {
  if (typeof localStorage === 'undefined') return 0;
  let n = 0;
  for (const meta of scanNoteMeta(`${chainId}-`)) {
    if (meta.spent === 'true') continue;
    if (meta.backup === 'pending') n += 1;
  }
  return n;
}

export function markNoteSpent(key: string, spent: boolean | 'false' | 'pending' | 'true' = true): void {
  const s: 'false' | 'pending' | 'true' = spent === true ? 'true' : spent === false ? 'false' : spent;
  markNoteSpentByKey(key, s);
}

export async function writeNote(
  key: string,
  note: Omit<StoredNote, 'spent'> & { spent: boolean | 'false' | 'pending' | 'true' },
  signer: Signer,
): Promise<void> {
  const s: 'false' | 'pending' | 'true' =
    note.spent === true ? 'true' : note.spent === false ? 'false' : note.spent;

  const parsed = parseNoteKey(key);
  if (parsed) {
    return writeNoteTyped(parsed.chainId, parsed.symbol, { ...note, spent: s }, signer);
  }

  // Legacy key: "{chainId}-{SYMBOL}-{commitment}"
  const parts = key.split('-');
  if (parts.length >= 3) {
    const chainId = Number(parts[0]);
    const symbol  = parts[1];
    if (chainId && symbol) {
      return writeNoteTyped(chainId, symbol, { ...note, spent: s }, signer);
    }
  }
  throw new Error(`[noteStore] writeNote: cannot parse key "${key}"`);
}

// syncWalletNotesFromServer alias
export { syncFromServer as syncWalletNotesFromServer };
