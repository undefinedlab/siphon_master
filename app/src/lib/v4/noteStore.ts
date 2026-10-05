/**
 * Minimal localStorage note store for the v4 demo. Self-contained (the v3 note store is coupled to
 * the v3 vault/tree). Notes hold the secrets needed to spend a shielded balance — losing them
 * strands the funds, same trust model as the rest of Siphon.
 *
 * ponytail: plaintext-in-localStorage for the demo only. Production must reuse the app's
 * wallet-derived AES encryption (see noteAuth.ts) — the v3 path already does.
 */
const KEY = "siphon.v4.notes";

export interface V4Note {
  token: string;
  value: string; // wei
  nullifier: string;
  secret: string;
  commitment: string;
  spent: boolean;
  /** Immutable deployment identity. Missing means the pre-fee LEGACY_V4 deployment. */
  vault?: string;
  tree?: string;
  hook?: string;
  deployBlock?: number;
}

function read(): V4Note[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function write(notes: V4Note[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(notes));
}

export function addNote(note: V4Note) {
  const notes = read();
  if (notes.some((n) => n.commitment === note.commitment)) return; // idempotent
  notes.push(note);
  write(notes);
}

export function markSpent(commitment: string) {
  const notes = read();
  const n = notes.find((x) => x.commitment === commitment);
  if (n) {
    n.spent = true;
    write(notes);
  }
}

/** Unspent notes, optionally filtered by token. */
export function listNotes(token?: string): V4Note[] {
  const notes = read().filter((n) => !n.spent);
  return token ? notes.filter((n) => n.token.toLowerCase() === token.toLowerCase()) : notes;
}

/**
 * Human-readable totals for the real Sepolia WETH/USDC v4 vault. Keep WETH distinct from native
 * ETH: they live in different vaults and adding them under an "ETH" label made a legacy 0.10 ETH
 * note plus a v4 0.05 WETH note look like a nonexistent 0.15 ETH note.
 */
export function getRealV4NoteTotals(opts: { weth: string; usdc: string }): Record<"WETH" | "USDC", number> {
  const totals = { WETH: 0, USDC: 0 };
  const weth = opts.weth.toLowerCase();
  const usdc = opts.usdc.toLowerCase();
  for (const note of listNotes()) {
    const token = note.token.toLowerCase();
    if (token === weth) totals.WETH += Number(note.value) / 1e18;
    else if (token === usdc) totals.USDC += Number(note.value) / 1e6;
  }
  return totals;
}

/* ------------------------------------------------------------------ pending swap outputs */
// A strategy-leg swap is submitted by the EXECUTOR later, so the output note's amount (amountOut) is
// unknown at build time. We persist its SECRETS here; a reconciler fills the amount from the
// on-chain ShieldedSwap event and promotes it to a real note. Losing these strands the output.
const PENDING_KEY = "siphon.v4.pendingOutputs";

export interface V4PendingOutput {
  token: string;
  nullifier: string;
  secret: string;
  precommitment: string;
  vault?: string;
  tree?: string;
  hook?: string;
  deployBlock?: number;
}

function readPending(): V4PendingOutput[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
  } catch {
    return [];
  }
}

function writePending(list: V4PendingOutput[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
}

export function addPendingOutput(o: V4PendingOutput) {
  const list = readPending();
  if (list.some((x) => x.precommitment === o.precommitment)) return; // idempotent
  list.push(o);
  writePending(list);
}

export function listPendingOutputs(): V4PendingOutput[] {
  return readPending();
}

export function removePendingOutput(precommitment: string) {
  writePending(readPending().filter((x) => x.precommitment !== precommitment));
}
