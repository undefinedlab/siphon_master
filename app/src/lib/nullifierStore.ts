/**
 * nullifierStore — Supabase-backed spent nullifier registry.
 *
 * Uses HMAC-SHA256(nullifierHash, walletEncKey) as the lookup key so raw
 * nullifier hashes are never stored server-side.
 *
 * Table: nullifier_registry
 *   nullifier_hmac text PK
 *   commitment_id  text nullable (FK → commitments.id)
 *   status         varchar  ('false' | 'pending' | 'spent')
 *   claimed_at     timestamp
 */
import type { Signer } from 'ethers';
import { deriveEncKeyRaw } from './noteAuth';

const SUPABASE_URL = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function supabaseHeaders() {
  const key = SUPABASE_KEY()!;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function _hmac(nullifierHash: string, signer: Signer): Promise<string> {
  const rawKey = await deriveEncKeyRaw(signer);
  const hmacKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const data = new TextEncoder().encode(nullifierHash);
  const sig  = await crypto.subtle.sign('HMAC', hmacKey, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function writeNullifier(
  signer:       Signer,
  nullifierHash: string,
  commitmentId?: string,
): Promise<void> {
  const url = SUPABASE_URL();
  const key = SUPABASE_KEY();
  if (!url || !key) return;

  const hmac = await _hmac(nullifierHash, signer);
  const res = await fetch(`${url}/rest/v1/nullifier_registry`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      nullifier_hmac: hmac,
      commitment_id:  commitmentId ?? null,
      status:         'spent',
      claimed_at:     new Date().toISOString(),
    }),
  });
  if (res.status === 409) {
    // Row already exists — PATCH to ensure status is 'spent' (may have been inserted with wrong status)
    const patch = await fetch(
      `${url}/rest/v1/nullifier_registry?nullifier_hmac=eq.${encodeURIComponent(hmac)}`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'spent' }),
      },
    );
    if (!patch.ok) throw new Error(`writeNullifier patch failed: ${patch.status}`);
    return;
  }
  if (!res.ok) {
    throw new Error(`writeNullifier failed: ${res.status}`);
  }
}

/**
 * Check which of the given nullifier hashes are already spent.
 * Returns the set of raw nullifier hashes that are spent.
 */
export async function checkNullifiersSpent(
  signer:          Signer,
  nullifierHashes: string[],
): Promise<Set<string>> {
  const url = SUPABASE_URL();
  const key = SUPABASE_KEY();
  if (!url || !key || nullifierHashes.length === 0) return new Set();

  // Build hmac→original map so we can return raw hashes
  const hmacToHash = new Map<string, string>();
  await Promise.all(nullifierHashes.map(async h => {
    hmacToHash.set(await _hmac(h, signer), h);
  }));

  const inClause = Array.from(hmacToHash.keys()).map(h => encodeURIComponent(h)).join(',');
  const res = await fetch(
    `${url}/rest/v1/nullifier_registry?nullifier_hmac=in.(${inClause})&status=eq.spent&select=nullifier_hmac`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`checkNullifiersSpent failed: ${res.status}`);

  const rows: { nullifier_hmac: string }[] = await res.json();
  const spent = new Set<string>();
  for (const row of rows) {
    const original = hmacToHash.get(row.nullifier_hmac);
    if (original) spent.add(original);
  }
  return spent;
}
