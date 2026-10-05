import { Signer } from 'ethers';
import { getSelectedChainId } from './networks';
import { deriveCommTag, deriveEncKey, noteAuthHeaders, encryptBlob, decryptBlob } from './noteAuth';
import { getTradeExecutorBaseUrl } from './tradeExecutorClient';
import { assetSymbolForToken } from './leafIndexClient';

/**
 * The note-backup table.
 *
 * Stays `commitments`. v5 gets a clean slate by ARCHIVING and emptying this table rather than
 * pointing at a new one: the executor writes here too (through NOTE_DB_URI, in its own code, not
 * config), so a second table would have the app reading one and the executor writing the other —
 * an empty balance with no error anywhere.
 *
 * The pre-v5 rows live in `commitments_legacy`, verified byte-identical (1,759 rows, zero
 * differences on id/enc_blob/iv/tag/spent) with matching grants and RLS so they stay readable.
 * Migration back is still owed — see fixes_tbd.md #4.
 */
const COMMITMENTS_TABLE = 'commitments';

/** Fail closed if a commitments REST URL is missing the wallet tag filter (RLS belt-and-suspenders).
 *  NOTE-01 / OMEGA-03: Browser anon-key path is opt-in via NEXT_PUBLIC_COMMITMENTS_VIA_SUPABASE=1.
 *  Real isolation is Supabase RLS — audit policies before enabling.
 */
export function assertCommitmentsTagScoped(url: string): void {
  if (!/([?&])tag=eq\./.test(url)) {
    throw new Error("supabase commitments query missing tag=eq filter");
  }
  // Empty tag=eq. would match oddly — reject.
  if (/([?&])tag=eq\.(?:&|$)/.test(url) || /([?&])tag=eq\.%20/.test(url)) {
    throw new Error("supabase commitments query has empty tag=eq filter");
  }
}

/** Prefer trade-executor note API unless Supabase is explicitly opted in (OMEGA-03). */
export function commitmentsViaSupabase(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  const optIn = (env.NEXT_PUBLIC_COMMITMENTS_VIA_SUPABASE || "").trim() === "1";
  return optIn;
}

export interface CommitmentPayload {
  nullifier:     string;
  secret:        string;
  commitment:    string;
  amount:        string;
  chainId:       number;
  nullifierHash: string;
  precommitment: string;
  /** Hard ASP association label (sealed in enc_blob with secrets). */
  label?:        string;
  /** Original v3 deposit transaction, sealed with the note for pre-admit exit tickets. */
  depositTxHash?: string;
  /** Salt used to derive the original v3 deposit label, sealed with the note. */
  userSalt?:     string;
  /** Timestamp of the mined v3 deposit block, sealed with the note. */
  depositTimestamp?: number;
  /** Vault generation identity (sealed; used to distinguish future migrations). */
  vaultAddress?: string;
  /** Vault generation id (written as a plaintext column, from vault_registry). */
  vaultId?:     string;
}

export interface DecryptedCommitment {
  id:         string;
  tag:        string;
  asset:      string;
  spent:      string;
  source:     string;
  created_at: string;
  updated_at: string;
  /** Plaintext generation column (null for legacy rows before the vault_id backfill). */
  vault_id?:  string | null;
  decrypted:  CommitmentPayload;
}

export async function postCommitment(
  signer: Signer,
  payload: CommitmentPayload,
  asset: string,
  source: 'deposit' | 'change' | 'vault-output' | 'merge' = 'deposit',
): Promise<string> {
  const tag     = await deriveCommTag(signer);
  const key     = await deriveEncKey(signer);
  const { enc_blob, iv } = await encryptBlob(key, payload);

  if (commitmentsViaSupabase()) {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
    const id = crypto.randomUUID();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${COMMITMENTS_TABLE}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ id, tag, enc_blob, iv, asset: normaliseBackupAsset(asset), source, spent: 'false', vault_id: payload.vaultId ?? null, updated_at: new Date().toISOString(), created_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`postCommitment (Supabase) failed: ${res.status} ${err}`);
    }
    return id;
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  let res = await fetch(`${executorBase}/commitments`, {
    method: 'POST',
    headers,
    // vault_id travels on BOTH branches. Omitting it here meant every note written through the
    // executor came back untagged, and syncV3FromServer — which uses this field to tell a
    // current-generation note from a retired one — rejected all of them and re-posted the local
    // store on every sync.
    body: JSON.stringify({ enc_blob, iv, asset: normaliseBackupAsset(asset), source, vault_id: payload.vaultId ?? null }),
  });
  if (res.status === 401) {
    const { invalidateTagBind } = await import('./noteAuth');
    invalidateTagBind(tag);
    const retryHeaders = await noteAuthHeaders(signer, tag, executorBase);
    res = await fetch(`${executorBase}/commitments`, {
      method: 'POST',
      headers: retryHeaders,
      body: JSON.stringify({ enc_blob, iv, asset: normaliseBackupAsset(asset), source }),
    });
  }
  if (!res.ok) throw new Error(`postCommitment failed: ${res.status}`);
  const json = await res.json();
  return json.id as string;
}

// ── No-note-loss: write-then-verify + durable retry queue ────────────────────
//
// Every note MUST reach Supabase (the durable recovery source) or localStorage-only funds are lost
// on a storage clear / device switch. postCommitment is best-effort; these wrap it with a read-back
// confirmation and a persistent retry queue that self-heals on the next sync.

export type CommitmentSource = 'deposit' | 'change' | 'vault-output' | 'merge';

const BACKUP_QUEUE_PREFIX = 'siphon-backup-pending-';

/**
 * `commitments.asset` is `varchar(10)`, so an address-shaped asset is a guaranteed 500.
 *
 * Notes minted before assetSymbolForToken() knew about WETH were filed under the raw 42-char
 * address, and every one of them poisoned the retry queue: the insert can never succeed, so the
 * queue replayed it on every sync forever. Normalise here so already-queued entries heal instead
 * of looping, and clamp as a last resort so a bad value degrades to a wrong-but-storable tag
 * rather than an infinite error.
 */
export function normaliseBackupAsset(asset: string, chainId?: number): string {
  const raw = (asset || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    const sym = assetSymbolForToken(raw, chainId);
    if (sym) return sym.toUpperCase();
  }
  return raw.toUpperCase().slice(0, 10);
}

interface QueuedBackup {
  payload: CommitmentPayload;
  asset:   string;
  source:  CommitmentSource;
  ts:      number;
  /** Failed drain attempts. Absent on entries queued before this field existed. */
  tries?:  number;
}

/**
 * Give up replaying a backup after this many failed drains.
 *
 * The queue previously retried every entry forever with no counter, so one permanently-failing
 * payload (an address-shaped asset against `varchar(10)`) re-POSTed on every single sync and
 * spammed 500s indefinitely. The local note is authoritative and is never dropped — only the
 * off-device copy is abandoned, and only after the failure is clearly not transient.
 */
const MAX_BACKUP_TRIES = 8;

function backupQueueKey(chainId: number): string {
  return `${BACKUP_QUEUE_PREFIX}${chainId}`;
}

function readBackupQueue(chainId: number): QueuedBackup[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(backupQueueKey(chainId));
    const arr = raw ? (JSON.parse(raw) as QueuedBackup[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeBackupQueue(chainId: number, queue: QueuedBackup[]): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(backupQueueKey(chainId), JSON.stringify(queue)); } catch { /* quota */ }
}

/**
 * Failed spent-flag updates, queued so the two stores cannot diverge permanently.
 *
 * `markCommitmentSpent` throws on failure and every caller swallows it — `Promise.allSettled` in
 * strategyNoteReservation, `.catch(log)` in noteConsolidator / localNoteStore / noteStoreV3. So a
 * failed status write was simply lost: local said spent, the server said unspent, forever. On a
 * SECOND device that reads the server faithfully, the note then counts as spendable while the
 * strategy that reserved it also shows — the same funds in two buckets, and a planner free to
 * select a note the enclave holds a proof for.
 *
 * Replay is safe in any order: the server filter `spent=lt.<status>` makes the write monotonic, so
 * a stale `pending` replayed after a `true` is a no-op rather than a downgrade.
 */
interface QueuedSpentUpdate {
  id: string;
  status: 'true' | 'pending' | 'false';
  ts: number;
  tries?: number;
}

const SPENT_QUEUE_PREFIX = 'siphon-spent-pending-';

function spentQueueKey(chainId: number): string {
  return `${SPENT_QUEUE_PREFIX}${chainId}`;
}

function readSpentQueue(chainId: number): QueuedSpentUpdate[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(spentQueueKey(chainId));
    const arr = raw ? (JSON.parse(raw) as QueuedSpentUpdate[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeSpentQueue(chainId: number, queue: QueuedSpentUpdate[]): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(spentQueueKey(chainId), JSON.stringify(queue)); } catch { /* quota */ }
}

const SPENT_RANK_QUEUE: Record<string, number> = { 'false': 0, 'pending': 1, 'true': 2 };

/**
 * Queue a failed spent-flag update.
 *
 * Deduped by row id, keeping the HIGHEST-ranked pending status: a queued `pending` superseded by a
 * later `true` must not resurrect as a downgrade when the queue drains.
 */
export function enqueueSpentUpdate(
  chainId: number,
  id: string,
  status: 'true' | 'pending' | 'false',
): void {
  if (!id) return;
  const queue = readSpentQueue(chainId);
  const existing = queue.find((q) => q.id === id);
  if (existing) {
    const cur = SPENT_RANK_QUEUE[existing.status] ?? 0;
    const next = SPENT_RANK_QUEUE[status] ?? 0;
    if (next > cur) existing.status = status;
    writeSpentQueue(chainId, queue);
    return;
  }
  queue.push({ id, status, ts: Date.now() });
  writeSpentQueue(chainId, queue);
}

/** Retry every queued spent-flag update for a chain. Safe to call repeatedly. */
export async function drainSpentUpdateQueue(signer: Signer, chainId: number): Promise<number> {
  const queue = readSpentQueue(chainId);
  if (queue.length === 0) return 0;
  const remaining: QueuedSpentUpdate[] = [];
  let confirmed = 0;
  for (const q of queue) {
    let ok = false;
    // Same offline rule as the backup queue: being unreachable is not evidence the update is bad,
    // and burning attempts on it is what silently abandons the write.
    let reachedServer = true;
    try {
      await markCommitmentSpent(signer, q.id, q.status);
      ok = true;
    } catch {
      ok = false;
      reachedServer = typeof navigator === 'undefined' || navigator.onLine !== false;
    }
    if (ok) {
      confirmed++;
    } else if (!reachedServer) {
      remaining.push(q);
    } else {
      const tries = (q.tries ?? 0) + 1;
      if (tries >= MAX_BACKUP_TRIES) {
        console.warn(
          `[spent] giving up on status update for row ${q.id} after ${tries} attempts — ` +
          'the local flag is authoritative on this device but other devices may disagree',
        );
      } else {
        remaining.push({ ...q, tries });
      }
    }
  }
  writeSpentQueue(chainId, remaining);
  return confirmed;
}

/**
 * `markCommitmentSpent` + durable retry. Prefer this at every call site: the bare function throws
 * into a `.catch(log)` and the divergence is then permanent.
 */
export async function markCommitmentSpentDurable(
  signer: Signer,
  id: string,
  status: 'true' | 'pending' | 'false',
  chainId?: number,
): Promise<boolean> {
  try {
    await markCommitmentSpent(signer, id, status);
    return true;
  } catch (e) {
    console.warn('[spent] update failed; queued for retry:', e);
    // The queue is per-chain only so the drainer can find it; row ids are globally unique, so the
    // selected chain is a safe default and callers need not thread one through.
    const cid = chainId ?? getSelectedChainId();
    enqueueSpentUpdate(cid, id, status);
    return false;
  }
}

/** Persist a failed backup for later retry (dedup by commitment). */
export function enqueueBackupRetry(payload: CommitmentPayload, asset: string, source: CommitmentSource): void {
  const chainId = payload.chainId;
  const queue = readBackupQueue(chainId);
  if (queue.some((q) => q.payload.commitment === payload.commitment)) return;
  queue.push({ payload, asset, source, ts: Date.now() });
  writeBackupQueue(chainId, queue);
}

/** Read-back confirmation: prove the row is actually persisted, not merely accepted. Supabase-path only;
 *  the executor path returns an id only after a transactional write, so it is trusted. */
async function confirmCommitmentPersisted(id: string): Promise<boolean> {
  if (!commitmentsViaSupabase()) return true; // executor id implies persisted
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
  const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${COMMITMENTS_TABLE}?id=eq.${encodeURIComponent(id)}&select=id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{ id: string }>;
    return Array.isArray(rows) && rows.length === 1;
  } catch { return false; }
}

/** Back a note up to Supabase with confirmation. Returns { ok } — on failure the note is queued for
 *  retry, so the caller marks its localStorage note backup:'pending' rather than losing it. */
export async function backupNoteWithConfirmation(
  signer: Signer,
  payload: CommitmentPayload,
  asset: string,
  source: CommitmentSource,
): Promise<{ ok: boolean; id?: string }> {
  try {
    const id = await postCommitment(signer, payload, asset, source);
    if (await confirmCommitmentPersisted(id)) return { ok: true, id };
  } catch (e) {
    console.warn('[backup] postCommitment failed; queuing for retry:', e);
  }
  enqueueBackupRetry(payload, asset, source);
  return { ok: false };
}

/** Retry every queued backup for a chain. On success, drops it from the queue and flips the note's
 *  localStorage backup flag to 'confirmed'. Called from the sync/reconcile path. */
export async function drainBackupRetryQueue(signer: Signer, chainId: number): Promise<number> {
  const queue = readBackupQueue(chainId);
  if (queue.length === 0) return 0;
  const remaining: QueuedBackup[] = [];
  let confirmed = 0;
  for (const q of queue) {
    let ok = false;
    // Distinguish "the server said no" from "we never reached the server". Only the former is
    // evidence the payload is bad; being offline says nothing about it, and counting it toward
    // MAX_BACKUP_TRIES is what silently abandons a note after a flight or a bad wifi spell.
    let reachedServer = true;
    try {
      const id = await postCommitment(signer, q.payload, q.asset, q.source);
      ok = await confirmCommitmentPersisted(id);
    } catch {
      ok = false;
      reachedServer = typeof navigator === 'undefined' || navigator.onLine !== false;
    }
    if (ok) {
      confirmed++;
      try {
        const { markNoteBackupConfirmed } = await import('./localNoteStore');
        await markNoteBackupConfirmed(chainId, q.asset, q.payload.commitment);
      } catch { /* best-effort flag flip */ }
    } else if (!reachedServer) {
      // Offline: requeue WITHOUT burning an attempt. Dropping a note here is unrecoverable —
      // Supabase is the durable copy, so "gave up" means the only copy is this browser.
      remaining.push(q);
    } else {
      const tries = (q.tries ?? 0) + 1;
      if (tries >= MAX_BACKUP_TRIES) {
        console.warn(
          `[backup] giving up on commitment ${q.payload.commitment} after ${tries} attempts — ` +
          'the local note is intact but has no off-device copy',
        );
      } else {
        remaining.push({ ...q, tries });
      }
    }
  }
  writeBackupQueue(chainId, remaining);
  return confirmed;
}

export async function fetchCommitments(signer: Signer): Promise<DecryptedCommitment[]> {
  const tag = await deriveCommTag(signer);
  const key = await deriveEncKey(signer);

  if (commitmentsViaSupabase()) {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
    // No spent filter — fetch ALL rows so syncFromServer can detect cross-device spends
    const listUrl =
      `${SUPABASE_URL}/rest/v1/${COMMITMENTS_TABLE}?tag=eq.${encodeURIComponent(tag)}&select=id,tag,asset,enc_blob,iv,spent,source,vault_id,created_at,updated_at`;
    assertCommitmentsTagScoped(listUrl);
    const res = await fetch(listUrl, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`fetchCommitments (Supabase) failed: ${res.status}`);
    const rows: { id: string; tag: string; asset: string; enc_blob: string; iv: string; spent: string; source: string; vault_id?: string | null; created_at: string; updated_at: string }[] = await res.json();
    const settled = await Promise.allSettled(rows.map(async c => ({
      id:         c.id,
      tag:        c.tag,
      asset:      c.asset,
      spent:      c.spent,
      source:     c.source,
      vault_id:   c.vault_id ?? null,
      created_at: c.created_at,
      updated_at: c.updated_at,
      decrypted:  await decryptBlob<CommitmentPayload>(key, c.enc_blob, c.iv),
    })));
    return settled
      .filter((r) => {
        if (r.status === 'rejected') { console.warn('[commitmentStore] skipping corrupt row:', r.reason); return false; }
        return true;
      })
      .map(r => (r as PromiseFulfilledResult<DecryptedCommitment>).value);
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  let res = await fetch(`${executorBase}/commitments`, { headers });
  if (res.status === 401) {
    const { invalidateTagBind } = await import('./noteAuth');
    invalidateTagBind(tag);
    const retryHeaders = await noteAuthHeaders(signer, tag, executorBase);
    res = await fetch(`${executorBase}/commitments`, { headers: retryHeaders });
  }
  if (!res.ok) throw new Error(`fetchCommitments failed: ${res.status}`);
  const { commitments } = await res.json();
  const settled2 = await Promise.allSettled(
    commitments.map(async (c: { id: string; tag: string; asset: string; enc_blob: string; iv: string; spent: string; source: string; created_at: string; updated_at: string }) => ({
      id:         c.id,
      tag:        c.tag,
      asset:      c.asset,
      spent:      c.spent,
      source:     c.source,
      created_at: c.created_at,
      updated_at: c.updated_at,
      decrypted:  await decryptBlob<CommitmentPayload>(key, c.enc_blob, c.iv),
    })),
  );
  return settled2
    .filter((r): r is PromiseFulfilledResult<DecryptedCommitment> => {
      if (r.status === 'rejected') { console.warn('[commitmentStore] skipping corrupt row:', r.reason); return false; }
      return true;
    })
    .map(r => r.value);
}

/**
 * Sum of the user's NON-spent Supabase-backed notes, per asset, for a chain. This is the
 * "withdrawable per your encrypted backup" figure — used as a resilient balance fallback when the
 * on-chain reconcile (leaf scan + nullifier checks) can't run because RPC is throttled/down. It is
 * DISPLAY-only and deliberately server-authoritative: it may slightly over-count (a note the chain
 * would reveal as spent-but-not-yet-flagged, or old-vault dust), but the withdraw path still does
 * full on-chain verification + self-heal, so showing this can never spend anything that isn't
 * really there — whereas collapsing to "No funds" on an RPC hiccup wrongly looks like fund loss.
 *
 * Dedupes by commitment (a commitment can appear as both a 'deposit' and a 'change'/'vault-output'
 * row) so nothing is double-counted. Returns { ETH: n, USDC: n } (human units).
 */
export async function getServerBackedVaultTotals(
  signer: Signer,
  chainId: number,
): Promise<Record<string, number>> {
  const commits = await fetchCommitments(signer);
  const totals: Record<string, number> = {};
  const seen = new Set<string>();
  for (const c of commits) {
    if (c.spent === 'true' || c.spent === 'pending') continue; // spent or in-flight
    const d = c.decrypted;
    if (!d?.commitment || !d.amount) continue;
    if ((d.chainId ?? chainId) !== chainId) continue;
    const sym = String(c.asset || '').toUpperCase();
    if (sym !== 'ETH' && sym !== 'USDC') continue;
    const dedupeKey = `${sym}:${d.commitment}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    // Cross-check localStorage — if the note is already marked spent locally, don't count it.
    // This handles the case where a withdrawal marked it spent locally but Supabase wasn't
    // updated yet (e.g. markCommitmentSpent failed or the key format mismatch bug).
    if (typeof window !== 'undefined') {
      const newKey    = `siphon-note-${chainId}-${sym}-${d.commitment}`;
      const legacyKey = `${chainId}-${sym}-${d.commitment}`;
      const raw = localStorage.getItem(newKey) || localStorage.getItem(legacyKey);
      if (raw) {
        try {
          const local = JSON.parse(raw);
          if (local.spent === true || local.spent === 'true') continue;
        } catch { /* skip */ }
      }
    }
    const amt = Number(d.amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    totals[sym] = (totals[sym] ?? 0) + amt;
  }
  return totals;
}

/**
 * Mark EVERY Supabase commitment row for a given commitment value as spent, by looking it up via
 * the decrypted commitment (the rows are keyed by opaque id and the commitment lives inside the
 * encrypted blob, so we must fetch+decrypt+match). Used after a confirmed withdraw so a spent note
 * can never re-hydrate or inflate the Supabase-backed balance — even when the caller never had the
 * row's id (a re-hydrated/synced note has no serverCommitmentId mapping). Best-effort; never throws.
 * Returns the number of rows marked.
 */
export async function markCommitmentSpentByCommitment(
  signer: Signer,
  commitment: string,
): Promise<number> {
  try {
    const commits = await fetchCommitments(signer);
    const target = String(commitment);
    const matches = commits.filter(c => String(c.decrypted?.commitment) === target && c.spent !== 'true');
    let n = 0;
    for (const m of matches) {
      // Durable: a swallowed failure here is exactly how the two stores diverge.
      if (await markCommitmentSpentDurable(signer, m.id, 'true')) n++;
    }
    return n;
  } catch (e) {
    console.warn('[commitment] markCommitmentSpentByCommitment failed:', e);
    return 0;
  }
}

const SPENT_RANK_COMM: Record<string, number> = { 'false': 0, 'pending': 1, 'true': 2 };

export async function markCommitmentSpent(
  signer: Signer,
  id: string,
  status: 'true' | 'pending' | 'false' = 'pending',
): Promise<void> {
  if (commitmentsViaSupabase()) {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
    // Scope PATCH by wallet tag so a stolen row id cannot flip another wallet's spent flag
    // even if RLS were misconfigured (belt-and-suspenders with assertCommitmentsTagScoped).
    const tag = await deriveCommTag(signer);
    const patchUrl =
      `${SUPABASE_URL}/rest/v1/${COMMITMENTS_TABLE}?id=eq.${encodeURIComponent(id)}` +
      `&tag=eq.${encodeURIComponent(tag)}&spent=lt.${encodeURIComponent(status)}`;
    assertCommitmentsTagScoped(patchUrl);
    // Enforce one-directional spent state atomically: PATCH only fires when existing rank < new rank.
    // 'false' < 'pending' < 'true' sort lexicographically, so `lt` filter is correct without a read.
    const res = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ spent: status, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`markCommitmentSpent (Supabase) failed: ${res.status}`);
    return;
  }

  // Fallback: trade executor
  const tag     = await deriveCommTag(signer);
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  await fetch(`${executorBase}/commitments/${id}/spent`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status }),
  });
}

/**
 * Prune fully-spent commitments to keep the table small.
 *
 * Only deletes rows that are `spent='true'` AND older than `olderThanDays` (default 7). Such a row
 * is dead weight: every spend path filters `spent==='true'` out, and if a leaf were ever rediscovered
 * the on-chain nullifier check ([zkHandler] vault.nullifiers) re-marks it spent — the secret is never
 * needed again once withdrawn. The age buffer leaves time for any mis-flag to be noticed first.
 * NEVER touches `'false'` (spendable) or `'pending'` (reserved) rows. Best-effort; returns count.
 */
export async function pruneSpentCommitments(signer: Signer, olderThanDays = 7): Promise<number> {
  const tag = await deriveCommTag(signer);

  if (commitmentsViaSupabase()) {
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
    // The public anon key is RLS-restricted to INSERT/UPDATE/SELECT — DELETE returns 401. Pruning a
    // hosted Supabase therefore runs server-side via pg_cron (see supabase/prune_spent_commitments.sql),
    // not from the client. Skip here to avoid a guaranteed-401 every cycle.
    return 0;
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  const res = await fetch(`${executorBase}/commitments/prune`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ older_than_days: olderThanDays }),
  });
  if (!res.ok) return 0;
  const json = await res.json().catch(() => ({}));
  return Number(json?.deleted ?? 0);
}

// ── Notes backup file (export / import) ──────────────────────────────────────
// Replaces the old trade-executor /notes/export path. The file holds DECRYPTED
// payloads (like a Tornado-style note file): it restores on any device with the
// same wallet, independent of the AES key that encrypted the DB rows. Treat the
// file itself as secret material.

interface NotesFileEntry {
  asset:   string;
  spent:   string;
  source:  string;
  payload: CommitmentPayload;
}

interface NotesFile {
  version:     'siphon-notes-v2' | 'siphon-notes-v2-sealed';
  exported_at: string;
  warning:     string;
  notes?:      NotesFileEntry[];
  /** PBKDF2+AES-GCM sealed backup (when version is siphon-notes-v2-sealed). */
  salt_b64?:   string;
  iv_b64?:     string;
  ciphertext_b64?: string;
  kdf?:        'PBKDF2-SHA256';
  iterations?: number;
}

const EXPORT_CONFIRM_PHRASE = 'I UNDERSTAND THIS FILE CAN SPEND MY FUNDS';
const EXPORT_MIN_PASSPHRASE = 12;

function plaintextExportAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.VERCEL_ENV || env.SIPHON_ENV || env.NODE_ENV || "").trim().toLowerCase();
  if (v === "production" || v === "prod") return false;
  return (env.NEXT_PUBLIC_ALLOW_PLAINTEXT_NOTE_EXPORT || "").trim() === "1";
}

function b64FromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function bytesFromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveExportKey(passphrase: string, salt: BufferSource, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Export note secrets for backup.
 * - Requires `confirmed: true` (UI must collect EXPORT_CONFIRM_PHRASE).
 * - Prefer a passphrase (min 12): file is sealed (siphon-notes-v2-sealed).
 * - Plaintext export is disabled in production (NOTE-03); requires
 *   NEXT_PUBLIC_ALLOW_PLAINTEXT_NOTE_EXPORT=1 off-prod only.
 */
export async function exportNotesFile(
  signer: Signer,
  opts: {
    confirmed: boolean;
    passphrase?: string;
    allowPlaintext?: boolean;
  },
): Promise<void> {
  if (!opts?.confirmed) {
    throw new Error(`Export requires confirmation (type: ${EXPORT_CONFIRM_PHRASE})`);
  }
  const commits = await fetchCommitments(signer);
  const inner: NotesFile = {
    version:     'siphon-notes-v2',
    exported_at: new Date().toISOString(),
    warning:     'This file contains the secrets to your Siphon funds. Anyone with it can withdraw them. Store it safely.',
    notes: commits.map(c => ({
      asset:   c.asset,
      spent:   c.spent,
      source:  c.source,
      payload: c.decrypted,
    })),
  };

  const wallet = await signer.getAddress();
  let blob: Blob;
  let filename: string;

  if (opts.passphrase && opts.passphrase.length >= EXPORT_MIN_PASSPHRASE) {
    const iterations = 210_000;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveExportKey(opts.passphrase, salt, iterations);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(inner)),
    );
    const sealed: NotesFile = {
      version: 'siphon-notes-v2-sealed',
      exported_at: inner.exported_at,
      warning: inner.warning,
      kdf: 'PBKDF2-SHA256',
      iterations,
      salt_b64: b64FromBytes(salt),
      iv_b64: b64FromBytes(iv),
      ciphertext_b64: b64FromBytes(ct),
    };
    blob = new Blob([JSON.stringify(sealed, null, 2)], { type: 'application/json' });
    filename = `siphon-notes-${wallet.slice(0, 8)}-${Date.now()}.siphon-backup.json`;
  } else if (opts.allowPlaintext && plaintextExportAllowed()) {
    blob = new Blob([JSON.stringify(inner, null, 2)], { type: 'application/json' });
    filename = `siphon-notes-${wallet.slice(0, 8)}-${Date.now()}.json`;
  } else if (opts.allowPlaintext) {
    throw new Error('Plaintext note export is disabled — use a passphrase (min 12 characters)');
  } else {
    throw new Error(`Passphrase required (min ${EXPORT_MIN_PASSPHRASE} characters)`);
  }

  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { EXPORT_CONFIRM_PHRASE, EXPORT_MIN_PASSPHRASE };

/**
 * Import a notes backup file: re-encrypts each payload under the CURRENT wallet key,
 * posts missing rows to the commitments table, and writes them to localStorage.
 * Dedupes by commitment value against existing server rows. Returns count imported.
 */
export async function importNotesFile(
  signer: Signer,
  file: File,
  opts?: { passphrase?: string },
): Promise<number> {
  const text = await file.text();
  let parsed = JSON.parse(text) as Partial<NotesFile>;

  if (parsed.version === 'siphon-notes-v2-sealed') {
    if (!opts?.passphrase) throw new Error('Passphrase required for sealed backup');
    if (!parsed.salt_b64 || !parsed.iv_b64 || !parsed.ciphertext_b64) {
      throw new Error('Sealed backup missing ciphertext fields');
    }
    const iterations = parsed.iterations || 210_000;
    const key = await deriveExportKey(
      opts.passphrase,
      bytesFromB64(parsed.salt_b64),
      iterations,
    );
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytesFromB64(parsed.iv_b64) },
        key,
        bytesFromB64(parsed.ciphertext_b64),
      );
      parsed = JSON.parse(new TextDecoder().decode(pt)) as Partial<NotesFile>;
    } catch {
      throw new Error('Wrong passphrase or corrupt sealed backup');
    }
  }

  if (!Array.isArray(parsed.notes)) throw new Error('Not a Siphon notes backup file');

  const existing = await fetchCommitments(signer);
  const known = new Set(existing.map(c => String(c.decrypted?.commitment)));

  const { writeNoteTyped } = await import('./localNoteStore');
  let imported = 0;

  for (const n of parsed.notes) {
    const p = n.payload;
    if (!p?.commitment || !p.nullifier || !p.secret) continue;
    if (known.has(String(p.commitment))) continue;
    // Never resurrect spent or in-flight notes as spendable (NOTE-03).
    if (n.spent === 'true' || n.spent === 'pending') continue;
    const source = (['deposit', 'change', 'vault-output', 'merge'] as const).includes(
      n.source as 'deposit' | 'change' | 'vault-output' | 'merge',
    ) ? (n.source as 'deposit' | 'change' | 'vault-output' | 'merge') : 'deposit';
    try {
      await postCommitment(signer, p, n.asset, source);
      if (p.chainId) {
        await writeNoteTyped(Number(p.chainId), n.asset, {
          nullifier:     p.nullifier,
          secret:        p.secret,
          commitment:    p.commitment,
          precommitment: p.precommitment ?? '',
          nullifierHash: p.nullifierHash ?? '',
          label:         p.label != null ? String(p.label) : undefined,
          vaultAddress:  p.vaultAddress,
          amount:        p.amount,
          spent:         'false',
        }, signer);
      }
      known.add(String(p.commitment));
      imported++;
    } catch (e) {
      console.warn('[importNotesFile] failed to import note', p.commitment, e);
    }
  }
  return imported;
}
