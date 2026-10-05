/**
 * Encrypted local note store for the Solana Devnet ZK vault (chainId 900002).
 *
 * The ZK vault emits only `commitment + leaf_index` (no plaintext note PDA), so the note secrets
 * `{nullifier, secret, label, userSalt}` exist in exactly one place: here. Losing this store means
 * losing the funds, which is why a deposit persists its note BEFORE the tx is sent (as a pending
 * note with no `depositSig`) and why pending notes are excluded from balances and coin selection.
 *
 *   localStorage key : siphon-sol-note-900002-<programTag8>-<SYMBOL>-<commitmentHex>
 *   value            : { enc_blob, iv }   AES-GCM under the wallet's enc-key (noteAuth.ts)
 *   payload          : { wallet, note }   wallet is inside the blob so several Phantom accounts can
 *                                          share one origin; a foreign blob fails to decrypt and is
 *                                          skipped.
 *
 * Phantom is not an ethers Signer, but `deriveEncKey` only needs `getAddress()` and a deterministic
 * `signMessage()`. ed25519 signatures are deterministic, so a thin adapter over Phantom's
 * `signMessage` yields a stable per-wallet key with no new key-derivation scheme.
 */
import type { Signer } from "ethers";
import { NATIVE_MINT } from "@solana/spl-token";
import { decryptBlob, deriveEncKey, encryptBlob } from "@/lib/noteAuth";
import { SOLANA_DEVNET_CHAIN_ID } from "@/lib/chains/registry";
import { getPhantom } from "@/lib/chains/solanaWallet";
import { solanaZkProgramId } from "@/lib/chains/solanaZkProgram";
import { DEVNET_JITO_SOL_MINT, DEVNET_JL_USDC_MINT } from "@/lib/chains/solanaVaultOnchain";

// Scoped to the vault program: a note is a leaf of ONE program's tree. Changing
// NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID without this tag would hide every existing note.
const PROGRAM_TAG = solanaZkProgramId().slice(0, 8);
export const SOLANA_NOTE_PREFIX = `siphon-sol-note-${SOLANA_DEVNET_CHAIN_ID}-${PROGRAM_TAG}-`;
const RETURN_PREFIX = `siphon-sol-return-${SOLANA_DEVNET_CHAIN_ID}-${PROGRAM_TAG}-`;
export type SolanaNoteSymbol = "SOL" | "USDC" | "jlUSDC" | "JitoSOL";

/**
 * A spendable ZK note. Field elements are decimal strings and `value` is base units as a decimal
 * string (JSON cannot carry bigint) — the same shapes `PlannerNote` already consumes.
 */
export interface SolanaStoredNote {
  /** Field elements, decimal strings. */
  nullifier: string;
  secret: string;
  /** Salted deposit label (field element, decimal string). */
  label: string;
  /** BE field of the mint pubkey (decimal string) — `assetIdFromSolanaMint`. */
  assetId: string;
  /** SPL mint, base58. */
  mint: string;
  symbol: SolanaNoteSymbol;
  /** Commitment as a field element, decimal string (what the planner / leaf list compare against). */
  commitment: string;
  /** Commitment as the 32-byte LE limb the vault stores / emits, hex. Also the storage-key suffix. */
  commitmentHex: string;
  /** Base units, decimal string. */
  value: string;
  precommitment: string;
  /** The deposit userSalt — never on-chain, never logged. */
  userSalt: string;
  /** Present once the deposit is confirmed. Notes without it are pending and never spendable. */
  depositSig?: string;
  spent: boolean;
  leafIndex?: number;
  createdAt?: number;
}

type StoredBlob = { enc_blob: string; iv: string };
type Payload = { wallet: string; note: SolanaStoredNote };

export function solanaSymbolForMint(mint: string): SolanaNoteSymbol {
  if (mint === NATIVE_MINT.toBase58()) return "SOL";
  if (mint === DEVNET_JL_USDC_MINT.toBase58()) return "jlUSDC";
  if (mint === DEVNET_JITO_SOL_MINT.toBase58()) return "JitoSOL";
  return "USDC";
}

export function solanaDecimalsForSymbol(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s === "SOL" || s === "WSOL" || s === "JITOSOL" || s === "JITO_SOL") return 9;
  return 6;
}

/** Human label for notes / dashboards (jlUSDC / JitoSOL are yield/stake shares). */
export function solanaDisplaySymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s === "JLUSDC" || s === "JL_USDC") return "jlUSDC (Earn)";
  if (s === "JITOSOL" || s === "JITO_SOL") return "JitoSOL (Stake)";
  if (s === "SOL" || s === "WSOL") return "SOL";
  return "USDC";
}

export function solanaNoteKey(symbol: string, commitmentHex: string): string {
  return `${SOLANA_NOTE_PREFIX}${symbol.toUpperCase()}-${commitmentHex.toLowerCase()}`;
}

function hexOfBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ethers-`Signer` shaped adapter over Phantom — only what `deriveEncKey` touches. */
export function phantomEncSigner(walletPubkey: string): Signer {
  const phantom = getPhantom();
  if (!phantom?.signMessage) {
    throw new Error("Phantom must support signMessage to unlock the Solana private note store.");
  }
  const current = phantom.publicKey?.toString();
  if (current && current !== walletPubkey) {
    throw new Error("Phantom account changed — reconnect the wallet that owns these notes.");
  }
  const adapter = {
    getAddress: async () => walletPubkey,
    signMessage: async (message: string | Uint8Array) => {
      const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
      const { signature } = await phantom.signMessage!(bytes, "utf8");
      return hexOfBytes(signature);
    },
  };
  return adapter as unknown as Signer;
}

/** Override for tests / alternative wallets. Defaults to Phantom. */
let _signerFactory: (walletPubkey: string) => Signer = phantomEncSigner;
export function setSolanaNoteSigner(factory: ((walletPubkey: string) => Signer) | null): void {
  _signerFactory = factory ?? phantomEncSigner;
}

/** Derive (or fetch the cached) enc-key. Call BEFORE sending a deposit so a declined prompt fails early. */
export async function getSolanaNoteEncKey(walletPubkey: string): Promise<CryptoKey> {
  return deriveEncKey(_signerFactory(walletPubkey));
}

function storageOk(): boolean {
  return typeof localStorage !== "undefined";
}

/** Upsert a note (keyed by symbol + commitmentHex). */
export async function saveSolanaNote(walletPubkey: string, note: SolanaStoredNote): Promise<void> {
  if (!storageOk()) throw new Error("saveSolanaNote: localStorage unavailable");
  const key = await getSolanaNoteEncKey(walletPubkey);
  const payload: Payload = {
    wallet: walletPubkey,
    note: { ...note, createdAt: note.createdAt ?? Date.now() },
  };
  const blob = await encryptBlob(key, payload);
  localStorage.setItem(solanaNoteKey(note.symbol, note.commitmentHex), JSON.stringify(blob));
}

/**
 * Decrypt every note this wallet owns for the LIVE vault program (optionally one symbol).
 *
 * Foreign / corrupt entries are skipped. Notes under a different program-id tag are NEVER loaded
 * or rewritten here: a prior vault's commitments are not leaves of the live tree, and promoting
 * them caused withdraw to fail with "note … not in state leaves (stale index — resync)".
 */
export async function loadSolanaNotes(
  walletPubkey: string,
  symbol?: string,
): Promise<SolanaStoredNote[]> {
  if (!storageOk()) return [];
  const primary = symbol ? `${SOLANA_NOTE_PREFIX}${symbol.toUpperCase()}-` : SOLANA_NOTE_PREFIX;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(primary)) keys.push(k);
  }
  if (keys.length === 0) return [];

  const encKey = await getSolanaNoteEncKey(walletPubkey);
  const out: SolanaStoredNote[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    try {
      const blob = JSON.parse(localStorage.getItem(k) ?? "") as StoredBlob;
      const payload = await decryptBlob<Payload>(encKey, blob.enc_blob, blob.iv);
      if (payload.wallet !== walletPubkey || !payload.note) continue;
      const note = payload.note;
      if (symbol && note.symbol.toUpperCase() !== symbol.toUpperCase()) continue;
      const id = note.commitmentHex.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(note);
    } catch {
      /* another wallet's note, or a corrupt entry */
    }
  }
  return out;
}

/** Keep only notes whose stored commitment appears in `leaves` (current vault tree). */
export function filterNotesInLeaves(
  notes: SolanaStoredNote[],
  leaves: readonly bigint[],
): SolanaStoredNote[] {
  const set = new Set(leaves.map((l) => l.toString()));
  return notes.filter((n) => set.has(String(n.commitment)));
}

/**
 * Remove live-program notes that are not in the current tree. Call only after leaves have been
 * verified against the on-chain root — orphans from a prior program rewrite inflate balances.
 */
export function deleteSolanaNotesNotInLeaves(
  notes: SolanaStoredNote[],
  leaves: readonly bigint[],
): number {
  const keep = new Set(filterNotesInLeaves(notes, leaves).map((n) => n.commitmentHex.toLowerCase()));
  let removed = 0;
  for (const n of notes) {
    if (keep.has(n.commitmentHex.toLowerCase())) continue;
    deleteSolanaNote(n.symbol, n.commitmentHex);
    removed++;
  }
  return removed;
}

/** Flip `spent`. Idempotent; returns false when the note is not in this wallet's store. */
export async function markSolanaNoteSpent(
  walletPubkey: string,
  commitmentHex: string,
): Promise<boolean> {
  const want = commitmentHex.toLowerCase();
  const notes = await loadSolanaNotes(walletPubkey);
  const hit = notes.find((n) => n.commitmentHex.toLowerCase() === want);
  if (!hit) return false;
  if (!hit.spent) await saveSolanaNote(walletPubkey, { ...hit, spent: true });
  return true;
}

/** Undo a reservation: an armed order that never fired gives its input notes back. */
export async function unspendSolanaNote(walletPubkey: string, commitmentHex: string): Promise<boolean> {
  const want = commitmentHex.toLowerCase();
  const hit = (await loadSolanaNotes(walletPubkey)).find((n) => n.commitmentHex.toLowerCase() === want);
  if (!hit) return false;
  if (hit.spent) await saveSolanaNote(walletPubkey, { ...hit, spent: false });
  return true;
}

/** Drop a note that never reached the chain (an unfired order's change note). */
export function deleteSolanaNote(symbol: string, commitmentHex: string): void {
  if (storageOk()) localStorage.removeItem(solanaNoteKey(symbol, commitmentHex));
}

/**
 * An armed Devnet order's RETURN note, before it exists: the executor deposits the swap output
 * under `precommitment` when the order fires, and these secrets are the only way to spend it — so
 * they are stored (encrypted, like notes) before the order is created, and turned into a note once
 * the executor reports the deposit. Keyed by the order proof's binder (unique per arm).
 */
export interface SolanaPendingReturn {
  id: string;
  strategyId?: string;
  legIndex?: number;
  nullifier: string;
  secret: string;
  userSalt: string;
  precommitment: string;
  mintOut: string;
  /** What the order spends, base units (a re-proof spends exactly this again). */
  amountBaseUnits: string;
  /** Input notes reserved (marked spent) for this order; restored if it never fires. */
  inputCommitmentHexes: string[];
  inputSymbol: SolanaNoteSymbol;
  /** The spend's change note, saved pending; promoted when the order fires, dropped if not. */
  changeCommitmentHex?: string;
  /**
   * PIPELINE only: hop-0 return secrets for browser re-proof when hop 0 hits NEEDS_REPROOF.
   * The top-level nullifier/secret/precommitment are the FINAL hop (adopted on resolve).
   */
  pipelineHop0Return?: {
    nullifier: string;
    secret: string;
    userSalt: string;
    precommitment: string;
  };
  createdAt: number;
}

export async function saveSolanaPendingReturn(walletPubkey: string, r: SolanaPendingReturn): Promise<void> {
  if (!storageOk()) throw new Error("saveSolanaPendingReturn: localStorage unavailable");
  const blob = await encryptBlob(await getSolanaNoteEncKey(walletPubkey), { wallet: walletPubkey, r });
  localStorage.setItem(RETURN_PREFIX + r.id, JSON.stringify(blob));
}

export async function loadSolanaPendingReturns(walletPubkey: string): Promise<SolanaPendingReturn[]> {
  if (!storageOk()) return [];
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(RETURN_PREFIX)) keys.push(k);
  }
  if (!keys.length) return [];
  const encKey = await getSolanaNoteEncKey(walletPubkey);
  const out: SolanaPendingReturn[] = [];
  for (const k of keys) {
    try {
      const blob = JSON.parse(localStorage.getItem(k) ?? "") as StoredBlob;
      const p = await decryptBlob<{ wallet: string; r: SolanaPendingReturn }>(encKey, blob.enc_blob, blob.iv);
      if (p.wallet === walletPubkey && p.r) out.push(p.r);
    } catch {
      /* another wallet's record */
    }
  }
  return out;
}

export function deleteSolanaPendingReturn(id: string): void {
  if (storageOk()) localStorage.removeItem(RETURN_PREFIX + id);
}

/** Confirmed (has `depositSig`) and not spent — the only notes that count and can be selected. */
export function isSpendableSolanaNote(n: SolanaStoredNote): boolean {
  return !n.spent && !!n.depositSig;
}

/**
 * Private balance from local notes (no RPC).
 *   - with `mint`: base units for that mint
 *   - without: base units per mint (summing across mints in one number would be meaningless)
 */
export async function sumUnspentPrivateBalance(
  walletPubkey: string,
  mint: string,
): Promise<bigint>;
export async function sumUnspentPrivateBalance(
  walletPubkey: string,
): Promise<Record<string, bigint>>;
export async function sumUnspentPrivateBalance(
  walletPubkey: string,
  mint?: string,
): Promise<bigint | Record<string, bigint>> {
  const notes = (await loadSolanaNotes(walletPubkey)).filter(isSpendableSolanaNote);
  if (mint) {
    return notes.filter((n) => n.mint === mint).reduce((a, n) => a + BigInt(n.value), 0n);
  }
  const by: Record<string, bigint> = {};
  for (const n of notes) by[n.mint] = (by[n.mint] ?? 0n) + BigInt(n.value);
  return by;
}

/** Same sum, in the `{ SOL: 1.5, USDC: 20 }` human shape the dashboard's balance card consumes. */
export async function sumUnspentPrivateBalancesBySymbol(
  walletPubkey: string,
): Promise<Record<string, number>> {
  const notes = (await loadSolanaNotes(walletPubkey)).filter(isSpendableSolanaNote);
  const raw: Record<string, bigint> = {};
  for (const n of notes) raw[n.symbol] = (raw[n.symbol] ?? 0n) + BigInt(n.value);
  const out: Record<string, number> = {};
  for (const [sym, v] of Object.entries(raw)) {
    const human = Number(v) / 10 ** solanaDecimalsForSymbol(sym);
    if (Number.isFinite(human) && human > 0) out[sym] = human;
  }
  return out;
}
