/**
 * Spare precommitment pool.
 *
 * Before any withdrawal or merge proof is generated, a pool of (nullifier, secret,
 * precommitment) triples is maintained in the `precommitments` DB table. At proof time
 * `claimFromPool` atomically marks one entry `in_use` and returns its secrets. After the
 * tx confirms the caller resolves it to the full commitment via `resolvePrecommitment`.
 *
 * This ensures change/merge note secrets survive a tab-close between proof generation and
 * tx confirmation — the secrets are in DB before the tx is even submitted.
 *
 * Pool entries use asset='POOL' / chainId=0 as a sentinel — they are asset-agnostic.
 * Callers must not read asset/chainId from claimed pool entries.
 */
// Lazy: circomlibjs carries ~1.3 MB of Poseidon tables; a static import put them on every page load.
const buildPoseidon = async () => (await import("circomlibjs")).buildPoseidon();
import type { Signer } from 'ethers';
import {
  postPrecommitment,
  fetchPendingPrecommitments,
  claimPrecommitment,
  reapStaleClaims,
} from './precommitmentStore';
import type { DecryptedPrecommitment } from './precommitmentStore';

/**
 * Pool entries share the precommitments table with strategy-output precommitments
 * (asset=ETH/USDC, posted by createVaultOutputNote — the executor deposits against
 * those). Claiming one of THOSE as a change note would put the same nullifier/secret
 * behind two on-chain commitments. Only sentinel entries are claimable.
 */
function isPoolEntry(p: DecryptedPrecommitment): boolean {
  return p.decrypted?.asset === 'POOL';
}
import { modField } from './zkHandler';

const POOL_MIN = 3;

// ── Crypto ────────────────────────────────────────────────────────────────────

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return modField(BigInt('0x' + hex));
}

// ── Internal: generate one triple and post it ─────────────────────────────────

async function _generateAndPost(signer: Signer): Promise<{ id: string; nullifier: string; secret: string; precommitment: string }> {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const nullifier    = randomFieldElement();
  const secret       = randomFieldElement();
  const precommitment = BigInt(F.toObject(poseidon([nullifier, secret])));

  const id = await postPrecommitment(signer, {
    nullifier:     nullifier.toString(),
    secret:        secret.toString(),
    precommitment: precommitment.toString(),
    asset:         'POOL',
    chainId:       0,
  });

  return { id, nullifier: nullifier.toString(), secret: secret.toString(), precommitment: precommitment.toString() };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ensure at least POOL_MIN pending precommitments exist in the DB.
 * Generates the shortfall. Safe to call frequently — only posts if needed.
 * Always resolves (never throws) so callers can fire-and-forget.
 */
export async function ensurePool(signer: Signer): Promise<void> {
  try {
    // Recover claim orphans first so they count toward (and replenish) the pool.
    await reapStaleClaims(signer);
    // Count only POOL sentinel entries — the table also holds strategy-output
    // precommitments, which must not satisfy (or inflate) the pool minimum.
    const pending = await fetchPendingPrecommitments(signer);
    const count = pending.filter(isPoolEntry).length;
    const shortfall = POOL_MIN - count;
    if (shortfall <= 0) return;
    await Promise.all(
      Array.from({ length: shortfall }, () => _generateAndPost(signer)),
    );
  } catch (e) {
    console.warn('[sparePool] ensurePool failed (best-effort):', e);
  }
}

/**
 * Claim one precommitment from the pool for use as a change or merge output note.
 *
 * Atomically marks the entry `in_use` on the server. Retries on concurrent-claim
 * races (409). Falls back to on-the-fly generation if the pool is empty.
 *
 * After the tx confirms, call `resolvePrecommitment(signer, claimed.id)`.
 */
export async function claimFromPool(signer: Signer): Promise<{
  id: string;
  nullifier: string;
  secret: string;
  precommitment: string;
}> {
  // Fetch all pending entries and try to claim one atomically.
  // POOL sentinels only — never claim a strategy-output precommitment (see isPoolEntry).
  const pending = (await fetchPendingPrecommitments(signer)).filter(isPoolEntry);

  for (const entry of pending) {
    const claimed = await claimPrecommitment(signer, entry.id);
    if (claimed) {
      // Successfully marked in_use — return secrets.
      const d = entry.decrypted;
      // Kick off pool refill in the background.
      ensurePool(signer);
      return { id: entry.id, nullifier: d.nullifier, secret: d.secret, precommitment: d.precommitment };
    }
    // 409 — another tab claimed this entry; try the next one.
  }

  // Pool was empty (or all entries were raced away). Generate on-the-fly.
  console.warn('[sparePool] pool empty — generating on-the-fly (adds latency)');
  const fresh = await _generateAndPost(signer);
  // Claim it immediately so the server marks it in_use.
  const claimed = await claimPrecommitment(signer, fresh.id);
  if (!claimed) {
    // Extremely unlikely: another tab grabbed our freshly-posted entry in the microsecond
    // window between post and claim. Generate a second one — no retry loop risk since each
    // iteration creates a new UUID.
    const fresh2 = await _generateAndPost(signer);
    await claimPrecommitment(signer, fresh2.id);
    ensurePool(signer);
    return fresh2;
  }
  // Refill background — pool is now at 0.
  ensurePool(signer);
  return fresh;
}
