/**
 * Durable cache for the Solana ZK vault's PUBLIC state-tree leaves.
 *
 * Private note secrets live in encrypted localStorage (`solanaNoteStore`) — that is never the
 * RPC problem. Withdraw / strategy prove also need the ordered commitment list to build Merkle
 * paths; that list is public and should come from solasp's DB (or a shared server rebuild), not
 * from every browser walking vault history on public Devnet RPC.
 *
 * This module keeps a verified snapshot in memory + localStorage keyed by program + on-chain root
 * so a refresh / second withdraw does not re-fetch, and a program-id flip cannot reuse another
 * vault's leaf list.
 */
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";
import { solanaZkProgramId } from "@/lib/chains/solanaZkProgram";

const PROGRAM_TAG = solanaZkProgramId().slice(0, 8);
const LS_PREFIX = `siphon-sol-leaves-${SOLANA_DEVNET_CHAIN_ID}-${PROGRAM_TAG}-`;

export type SolLeavesSnapshot = {
  rootHex: string;
  nextIndex: number;
  leaves: string[];
};

function lsKey(rootHex: string): string {
  return `${LS_PREFIX}${rootHex}`;
}

export function readSolLeavesLocal(rootHex: string, nextIndex: number): bigint[] | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(lsKey(rootHex));
    if (!raw) return null;
    const snap = JSON.parse(raw) as SolLeavesSnapshot;
    if (snap.rootHex !== rootHex || snap.nextIndex !== nextIndex) return null;
    if (!Array.isArray(snap.leaves) || snap.leaves.length !== nextIndex) return null;
    return snap.leaves.map((x) => BigInt(x));
  } catch {
    return null;
  }
}

export function writeSolLeavesLocal(rootHex: string, nextIndex: number, leaves: bigint[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    const snap: SolLeavesSnapshot = {
      rootHex,
      nextIndex,
      leaves: leaves.map((x) => x.toString()),
    };
    localStorage.setItem(lsKey(rootHex), JSON.stringify(snap));
    // Drop older roots so the origin does not accumulate every historical tree.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX) && k !== lsKey(rootHex)) localStorage.removeItem(k);
    }
  } catch {
    /* quota / private mode — memory cache still helps this session */
  }
}
