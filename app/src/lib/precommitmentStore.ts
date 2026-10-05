/**
 * Precommitment store — Supabase-backed backup for vault-mode swap output notes.
 *
 * A precommitment is created when the user submits a vault-mode strategy.
 * It holds the nullifier + secret for the output note whose commitment isn't
 * known yet (the executor will deposit with this precommitment, and the amount
 * depends on swap slippage). Once the swap lands on-chain and the commitment is
 * resolved, the precommitment is marked resolved and a full commitment is written.
 */
import { Signer } from 'ethers';
import { derivePrecommTag, deriveEncKey, noteAuthHeaders, encryptBlob, decryptBlob } from './noteAuth';
import { getTradeExecutorBaseUrl } from './tradeExecutorClient';

export interface PrecommitmentPayload {
  nullifier:     string;
  secret:        string;
  precommitment: string;
  asset:         string;
  chainId:       number;
}

export interface DecryptedPrecommitment {
  id:         string;
  tag:        string;
  status:     string;
  created_at: string;
  decrypted:  PrecommitmentPayload;
}

export async function postPrecommitment(
  signer: Signer,
  payload: PrecommitmentPayload,
): Promise<string> {
  const tag               = await derivePrecommTag(signer);
  const key               = await deriveEncKey(signer);
  const { enc_blob, iv }  = await encryptBlob(key, payload);

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (SUPABASE_URL && SUPABASE_KEY) {
    const id = crypto.randomUUID();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/precommitments`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      // plaintext precommitment stored for lookup without decryption
      body: JSON.stringify({ id, tag, enc_blob, iv, precommitment: payload.precommitment, status: 'pending', created_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`postPrecommitment (Supabase) failed: ${res.status}`);
    return id;
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  const res = await fetch(`${executorBase}/precommitments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ enc_blob, iv }),
  });
  if (!res.ok) throw new Error(`postPrecommitment failed: ${res.status}`);
  const json = await res.json();
  return json.id as string;
}

export async function fetchPendingPrecommitments(signer: Signer): Promise<DecryptedPrecommitment[]> {
  const tag = await derivePrecommTag(signer);
  const key = await deriveEncKey(signer);

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (SUPABASE_URL && SUPABASE_KEY) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/precommitments?tag=eq.${encodeURIComponent(tag)}&status=eq.pending&select=id,tag,enc_blob,iv,status,created_at`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) throw new Error(`fetchPendingPrecommitments (Supabase) failed: ${res.status}`);
    const rows: { id: string; tag: string; enc_blob: string; iv: string; status: string; created_at: string }[] = await res.json();
    const settled = await Promise.allSettled(rows.map(async p => ({
      id:         p.id,
      tag:        p.tag,
      status:     p.status,
      created_at: p.created_at,
      decrypted:  await decryptBlob<PrecommitmentPayload>(key, p.enc_blob, p.iv),
    })));
    return settled
      .filter((r): r is PromiseFulfilledResult<DecryptedPrecommitment> => {
        if (r.status === 'rejected') { console.warn('[precommitmentStore] skipping corrupt row:', r.reason); return false; }
        return true;
      })
      .map(r => r.value);
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  const res = await fetch(`${executorBase}/precommitments?status=pending`, { headers });
  if (!res.ok) throw new Error(`fetchPendingPrecommitments failed: ${res.status}`);
  const { precommitments } = await res.json();

  const settled2 = await Promise.allSettled(
    precommitments.map(async (p: { id: string; tag: string; enc_blob: string; iv: string; status: string; created_at: string }) => ({
      id:         p.id,
      tag:        p.tag,
      status:     p.status,
      created_at: p.created_at,
      decrypted:  await decryptBlob<PrecommitmentPayload>(key, p.enc_blob, p.iv),
    })),
  );
  return settled2
    .filter((r): r is PromiseFulfilledResult<DecryptedPrecommitment> => {
      if (r.status === 'rejected') { console.warn('[precommitmentStore] skipping corrupt row:', r.reason); return false; }
      return true;
    })
    .map(r => r.value);
}

/**
 * Fetch the precommitment record for a specific precommitment VALUE, regardless of status
 * (pending / in_use / resolved). Used to repair a spendable note whose local copy carries
 * secret material that no longer reproduces its on-chain leaf (a stale artifact from an older
 * resolve): the precommitment row is written once at strategy-creation time with the
 * authoritative nullifier/secret and is never mutated, so it's the ground truth even after the
 * note was marked resolved (and thus excluded from the `?status=pending` list).
 */
export async function fetchPrecommitmentByValue(
  signer: Signer,
  precommitment: string,
): Promise<DecryptedPrecommitment | null> {
  const tag = await derivePrecommTag(signer);
  const key = await deriveEncKey(signer);

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (SUPABASE_URL && SUPABASE_KEY) {
    // Use plaintext precommitment column for O(1) lookup — no need to decrypt all rows
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/precommitments?tag=eq.${encodeURIComponent(tag)}&precommitment=eq.${encodeURIComponent(precommitment)}&select=id,tag,enc_blob,iv,status,created_at&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) throw new Error(`fetchPrecommitmentByValue (Supabase) failed: ${res.status}`);
    const rows: Array<{ id: string; tag: string; enc_blob: string; iv: string; status: string; created_at: string }> = await res.json();
    if (!rows.length) return null;
    const p = rows[0];
    try {
      const decrypted = await decryptBlob<PrecommitmentPayload>(key, p.enc_blob, p.iv);
      return { id: p.id, tag: p.tag, status: p.status, created_at: p.created_at, decrypted };
    } catch { return null; }
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  const res = await fetch(`${executorBase}/precommitments`, { headers });
  if (!res.ok) throw new Error(`fetchPrecommitmentByValue failed: ${res.status}`);
  const { precommitments } = await res.json();

  for (const p of precommitments as Array<{ id: string; tag: string; enc_blob: string; iv: string; status: string; created_at: string }>) {
    try {
      const decrypted = await decryptBlob<PrecommitmentPayload>(key, p.enc_blob, p.iv);
      if (decrypted.precommitment === precommitment) {
        return { id: p.id, tag: p.tag, status: p.status, created_at: p.created_at, decrypted };
      }
    } catch { /* skip rows this key can't decrypt */ }
  }
  return null;
}

// Precommitments stuck in `in_use` beyond this window are orphans (tab closed between claim
// and tx confirm). getPoolCount reaps them back to `pending` — mirrors the executor's logic.
const STALE_IN_USE_MS = 30 * 60 * 1000;

/** Conditional status transition via PostgREST. Returns the number of rows that transitioned. */
async function _patchStatus(
  tag: string,
  id: string,
  fromStatuses: string[],
  toStatus: string,
): Promise<number> {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return 0;
  // status filter makes the transition atomic: a concurrent claimer's PATCH matches 0 rows.
  // return=representation lets us count how many rows actually flipped.
  const statusFilter = fromStatuses.length === 1
    ? `status=eq.${encodeURIComponent(fromStatuses[0])}`
    : `status=in.(${fromStatuses.map(encodeURIComponent).join(',')})`;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/precommitments?id=eq.${encodeURIComponent(id)}&tag=eq.${encodeURIComponent(tag)}&${statusFilter}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ status: toStatus, claimed_at: toStatus === 'in_use' ? new Date().toISOString() : null }),
    },
  );
  if (!res.ok) throw new Error(`precommitment ${fromStatuses.join('|')}→${toStatus} failed: ${res.status}`);
  const rows: unknown[] = await res.json();
  return rows.length;
}

function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Atomically claim a precommitment from the pool (pending → in_use).
 * Returns false if the entry was already claimed by another tab.
 */
export async function claimPrecommitment(signer: Signer, id: string): Promise<boolean> {
  const tag = await derivePrecommTag(signer);

  if (supabaseConfigured()) {
    try {
      return (await _patchStatus(tag, id, ['pending'], 'in_use')) > 0;
    } catch {
      return false;
    }
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  const res = await fetch(`${executorBase}/precommitments/${id}/claim`, {
    method: 'PATCH',
    headers,
  });
  return res.ok; // false on 409 (already claimed)
}

export async function resolvePrecommitment(signer: Signer, id: string): Promise<void> {
  const tag = await derivePrecommTag(signer);

  if (supabaseConfigured()) {
    // Both pool entries (claimed → in_use) and strategy-output precommitments
    // (never claimed, still pending) get resolved here.
    await _patchStatus(tag, id, ['pending', 'in_use'], 'resolved');
    return;
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  await fetch(`${executorBase}/precommitments/${id}/resolve`, {
    method: 'PATCH',
    headers,
  });
}

export async function releasePrecommitment(signer: Signer, id: string): Promise<void> {
  const tag = await derivePrecommTag(signer);

  if (supabaseConfigured()) {
    await _patchStatus(tag, id, ['in_use'], 'pending');
    return;
  }

  // Fallback: trade executor
  const executorBase = getTradeExecutorBaseUrl();
  const headers = await noteAuthHeaders(signer, tag, executorBase);
  await fetch(`${executorBase}/precommitments/${id}/release`, {
    method: 'PATCH',
    headers,
  });
}

/**
 * Reap stale in_use orphans (tab closed between claim and tx confirm) back to pending,
 * so the pool self-heals instead of bleeding entries. Best-effort, never throws.
 * Only meaningful on the Supabase path — the executor reaps server-side in pool-count.
 */
export async function reapStaleClaims(signer: Signer): Promise<void> {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const tag = await derivePrecommTag(signer);
    const cutoff = new Date(Date.now() - STALE_IN_USE_MS).toISOString();
    await fetch(
      `${SUPABASE_URL}/rest/v1/precommitments?tag=eq.${encodeURIComponent(tag)}&status=eq.in_use&claimed_at=lt.${encodeURIComponent(cutoff)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status: 'pending', claimed_at: null }),
      },
    );
  } catch { /* best-effort */ }
}
