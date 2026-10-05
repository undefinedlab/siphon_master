/**
 * Chainalysis OFAC sanctions-oracle addresses.
 *
 * These live in their own module because TWO places need them and neither may import the other:
 * `sanctionsScreen.ts` calls the oracle (and pulls in the browser read-provider), while
 * `rpcHttpGuard.ts` runs in the Node route handler and must ALLOW that call through the /api/rpc
 * proxy. Duplicating the addresses in the guard would let the allowlist drift away from the
 * contract actually being called — and the failure mode of that drift is a fail-closed deposit
 * block, i.e. the whole product stops, so the two must come from one definition.
 */

/** Chainalysis' canonical deployment, used on every supported chain except where overridden. */
export const ORACLE_DEFAULT = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";

/** Chains where Chainalysis deployed the oracle at a different address. */
export const ORACLE_BY_CHAIN: Record<number, string> = {
  8453: "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B",
};

/** Chains that have an oracle at all. Anything else screens as "not sanctioned" (no oracle). */
export const ORACLE_CHAINS = new Set([1, 8453, 42161, 10, 137, 43114, 56, 250, 42220, 81457]);

/** The oracle address to call for `chainId` (the default deployment unless overridden). */
export function oracleAddressFor(chainId: number): string {
  return ORACLE_BY_CHAIN[chainId] ?? ORACLE_DEFAULT;
}
