/**
 * Durable local state for one Devnet wallet: the API key, the Siphon account and every note secret.
 *
 * Note secrets are the ONLY way to spend what was deposited, so every write is atomic (tmp file +
 * rename, mode 0600) and lands BEFORE the transaction that depends on it is sent — the same rule
 * the SDK's `persist` callbacks enforce.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { solana } from "../../sdk-ts/src";

export type Note = solana.SolanaNote & {
  /** Set while an order or payout holds this note, so nothing else spends it. */
  reservedBy?: string;
  /** A change note that exists only once its spend lands — never counted until then. */
  pendingChange?: boolean;
};

export interface OrderRecord {
  /** Strategy id; "" until the API accepted the order. */
  id: string;
  kind: "swap" | "order";
  assetIn: "SOL" | "USDC";
  amountMinor: string;
  /** Secrets of the note the fill returns to the vault (opened by claimReturn). */
  ret: solana.PendingReturn;
  /** Commitments of the notes the order spends when it fires. */
  reserved: string[];
  status?: string;
  claimed?: boolean;
  createdAt: string;
}

export interface WalletState {
  version: 1;
  wallet: string;
  /** Only a key this server claimed itself; a SIPHON_API_KEY from the env is never written here. */
  apiKey?: string;
  accountId?: string;
  notes: Note[];
  /** Deposit secrets saved before sending, not yet seen in the vault tree. */
  pendingDeposits: solana.PendingSolanaDeposit[];
  orders: OrderRecord[];
  /** Commitments of notes that were spent (kept for the record). */
  spent: string[];
}

export class Store {
  state: WalletState;

  constructor(readonly file: string, wallet: string) {
    this.state = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as WalletState)
      : { version: 1, wallet, notes: [], pendingDeposits: [], orders: [], spent: [] };
    if (this.state.wallet !== wallet) throw new Error(`${file} belongs to wallet ${this.state.wallet}, not ${wallet}`);
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Unspent, unreserved notes of a mint. */
  free(mint: string): Note[] {
    return this.state.notes.filter((n) => n.token === mint && !n.reservedBy);
  }

  reserve(commitments: string[], by: string): void {
    for (const n of this.state.notes) if (commitments.includes(n.commitment)) n.reservedBy = by;
  }

  release(by: string): void {
    for (const n of this.state.notes) {
      if (n.reservedBy !== by) continue;
      delete n.reservedBy;
      delete n.pendingChange;
    }
  }

  markSpent(commitments: string[]): void {
    this.state.notes = this.state.notes.filter((n) => !commitments.includes(n.commitment));
    this.state.spent.push(...commitments);
  }

  addNote(note: Note): void {
    if (!this.state.notes.some((n) => n.commitment === note.commitment)) this.state.notes.push(note);
  }
}

/** One mutation at a time: the store is one file and two spends must never pick the same note. */
let tail: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
