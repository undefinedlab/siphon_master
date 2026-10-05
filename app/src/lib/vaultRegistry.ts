/**
 * Vault generation registry.
 *
 * Maps a per-generation `vault_id` (shared across chains, disambiguated by chainId) to the vault
 * contract addresses of that generation. This is what lets the client answer, from LOCAL/Supabase
 * data alone, "is this note the current generation?" — replacing the indexer's leaf-set as the
 * balance-display generation filter (see getSpendableVaultBalance).
 *
 * Source of truth is the Supabase `vault_registry` table (read-open, write-locked to service_role).
 * The hardcoded SEED below is the on-chain-verified fallback used when the fetch is unavailable, so a
 * Supabase blip can never break vault_id resolution for a new deposit.
 *
 * Convention (decided 2026-08-23): `vault_id` is a generation number shared across chains —
 * `1` = legacy pre-ASP generation, `2` = current Hard-ASP generation on BOTH Base and Sepolia. The
 * chainId (carried by every note in localStorage) disambiguates which chain's generation-2 a note is.
 * `vault_id === '1'` is the legacy/mixed bucket: trusted-from-backup, ASP checks skipped.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export interface VaultRegistryRow {
  chain_id: number;
  vault_id: string;
  asset: string;          // 'ETH' | 'USDC'
  vault_address: string;
  is_current: boolean;
}

/**
 * On-chain-verified fallback seed. Addresses resolved via entrypoint.getVault() 2026-08-22/23.
 * Keep in sync with the Supabase vault_registry table.
 */
const SEED: VaultRegistryRow[] = [
  // Base gen 1 — legacy "base-soft-era" (entrypoint 0x5433995f…)
  { chain_id: 8453, vault_id: '1', asset: 'ETH',  vault_address: '0x83A22415864782830dfa3078F0c574E226E741cC', is_current: false },
  { chain_id: 8453, vault_id: '1', asset: 'USDC', vault_address: '0x3F92B94131Df4F8B26a1fB61A3C49FC82679aF33', is_current: false },
  // Base gen 2 — current Hard-ASP R2 (entrypoint 0xA8AD713e…)
  { chain_id: 8453, vault_id: '2', asset: 'ETH',  vault_address: '0xBf30FcEa7a35C7f20fcfd7db5673F26F7a396036', is_current: true },
  { chain_id: 8453, vault_id: '2', asset: 'USDC', vault_address: '0xd7030f84D6A49465a2C5c60e3581848bAF38686F', is_current: true },
  // Sepolia gen 2 — current round-2 deploy (entrypoint 0x6Ae9D276…)
  { chain_id: 11155111, vault_id: '2', asset: 'ETH',  vault_address: '0x942eD538d77C4ED6B3E7B552F172A1de289c171C', is_current: true },
  { chain_id: 11155111, vault_id: '2', asset: 'USDC', vault_address: '0x44f2B0c2D43f44a06A11f51baCE1A214B4e76c26', is_current: true },
];

let cache: VaultRegistryRow[] | null = null;
let cachePromise: Promise<VaultRegistryRow[]> | null = null;

/** Fetch the registry from Supabase once, cache it, fall back to SEED on any failure. */
async function loadRegistry(): Promise<VaultRegistryRow[]> {
  if (cache) return cache;
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/vault_registry?select=chain_id,vault_id,asset,vault_address,is_current`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
        );
        if (res.ok) {
          const rows = (await res.json()) as VaultRegistryRow[];
          if (Array.isArray(rows) && rows.length > 0) {
            cache = rows.map((r) => ({ ...r, chain_id: Number(r.chain_id) }));
            return cache;
          }
        }
      } catch (e) {
        console.warn('[vaultRegistry] Supabase fetch failed, using seed:', e);
      }
    }
    cache = SEED;
    return cache;
  })();
  return cachePromise;
}

/** Force a re-fetch on next access (e.g. after a new generation is added). */
export function invalidateVaultRegistry(): void {
  cache = null;
  cachePromise = null;
}

const norm = (a: string) => a.trim().toLowerCase();

/** The vault_id of the CURRENT generation for (chainId, asset), or null if none is marked current. */
export async function currentVaultId(chainId: number, asset: string): Promise<string | null> {
  const rows = await loadRegistry();
  const sym = asset.toUpperCase();
  const hit = rows.find((r) => r.chain_id === chainId && r.asset === sym && r.is_current);
  return hit ? hit.vault_id : null;
}

/** The vault_id owning a given vault address on (chainId, asset), or null if unregistered. */
export async function vaultIdForAddress(
  chainId: number,
  asset: string,
  address: string,
): Promise<string | null> {
  if (!address) return null;
  const rows = await loadRegistry();
  const sym = asset.toUpperCase();
  const target = norm(address);
  const hit = rows.find(
    (r) => r.chain_id === chainId && r.asset === sym && norm(r.vault_address) === target,
  );
  return hit ? hit.vault_id : null;
}
