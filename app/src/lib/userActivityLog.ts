/**
 * Per-wallet activity log stored in localStorage on this device only.
 * Entries are keyed by wallet address — other users cannot read them from the app UI.
 */

export type UserActivityKind = "deposit" | "withdraw" | "strategy";

export type UserActivityEntry = {
  id: string;
  kind: UserActivityKind;
  timestamp: string;
  chainId?: number;
  token?: string;
  amount?: string | number;
  /** Original action hash (deposit / withdraw / strategy). */
  txHash?: string | null;
  /** Follow-up hash — ragequit tx when the deposit row is substituted. */
  relatedTxHash?: string | null;
  status?: string;
  label?: string;
  strategyId?: string;
  /** Local note key (siphon-note-…) so screening / ragequit can attach to this deposit. */
  noteKey?: string;
};

const STORAGE_PREFIX = "siphon-activity-v1:";
/** Cap retained history — less plaintext wallet activity on disk (M5). */
const MAX_ENTRIES = 100;

function storageKey(wallet: string): string {
  return `${STORAGE_PREFIX}${wallet.toLowerCase()}`;
}

function sameHash(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function uniqueHashes(...vals: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of vals) {
    if (!v) continue;
    if (!out.some((x) => sameHash(x, v))) out.push(v);
  }
  return out;
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function readRaw(wallet: string): UserActivityEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as UserActivityEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(wallet: string, entries: UserActivityEntry[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(storageKey(wallet), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

function notifyUpdated() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("siphon:userActivityUpdated"));
  }
}

/** Fold duplicate deposit+ragequit rows for the same note into one, keeping both hashes when they differ. */
function mergeRagequitGroup(group: UserActivityEntry[]): UserActivityEntry {
  const deposit = group.find((e) => e.kind === "deposit") ?? group[0];
  const newest = group.reduce((a, b) =>
    new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b,
  );
  const labeled =
    group.find((e) => e.status === "ragequit" && e.label) ?? newest;

  const hashes = uniqueHashes(
    deposit.relatedTxHash ? deposit.txHash : null,
    ...group.filter((e) => e.kind === "deposit").map((e) => e.txHash),
    ...group.map((e) => e.relatedTxHash),
    ...group.filter((e) => e.kind === "withdraw").map((e) => e.txHash),
    ...group.map((e) => e.txHash),
  );

  return {
    ...deposit,
    kind: "deposit",
    status: "ragequit",
    label: labeled.label ?? deposit.label,
    timestamp: newest.timestamp,
    txHash: hashes[0] ?? null,
    relatedTxHash: hashes[1] ?? null,
  };
}

function collapseRagequitDuplicates(entries: UserActivityEntry[]): UserActivityEntry[] {
  const ragequitKeys = new Set(
    entries.filter((e) => e.noteKey && e.status === "ragequit").map((e) => e.noteKey as string),
  );
  if (ragequitKeys.size === 0) return entries;

  const consumed = new Set<string>();
  const kept: UserActivityEntry[] = [];
  for (const e of entries) {
    if (!e.noteKey || !ragequitKeys.has(e.noteKey)) {
      kept.push(e);
      continue;
    }
    if (consumed.has(e.noteKey)) continue;
    consumed.add(e.noteKey);
    kept.push(mergeRagequitGroup(entries.filter((x) => x.noteKey === e.noteKey)));
  }
  return kept;
}

export function getUserActivities(wallet: string): UserActivityEntry[] {
  return collapseRagequitDuplicates(readRaw(wallet)).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

export function appendUserActivity(
  wallet: string,
  entry: Omit<UserActivityEntry, "id" | "timestamp"> & {
    id?: string;
    timestamp?: string;
  },
): UserActivityEntry {
  const row: UserActivityEntry = {
    id: entry.id ?? newId(),
    kind: entry.kind,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    chainId: entry.chainId,
    token: entry.token,
    amount: entry.amount,
    txHash: entry.txHash,
    relatedTxHash: entry.relatedTxHash,
    status: entry.status,
    label: entry.label,
    strategyId: entry.strategyId,
    noteKey: entry.noteKey,
  };

  const existing = readRaw(wallet);
  const deduped = existing.filter((e) => e.id !== row.id);
  writeRaw(wallet, [row, ...deduped]);
  notifyUpdated();
  return row;
}

/**
 * Replace the original deposit row with a ragequit (do not append a second row).
 * Keeps the deposit hash on `txHash` and stores the ragequit hash on `relatedTxHash`.
 */
export function markUserActivityRagequit(
  wallet: string,
  noteKey: string,
  opts: {
    label: string;
    ragequitTxHash: string;
    amount?: string | number;
    token?: string;
    chainId?: number;
  },
): void {
  if (!noteKey) return;
  const existing = readRaw(wallet);
  const matches = existing.filter((e) => e.noteKey === noteKey);
  const others = existing.filter((e) => e.noteKey !== noteKey);
  const now = new Date().toISOString();
  const rqHash = opts.ragequitTxHash;

  let row: UserActivityEntry;
  if (matches.length === 0) {
    row = {
      id: newId(),
      kind: "deposit",
      timestamp: now,
      chainId: opts.chainId,
      token: opts.token,
      amount: opts.amount,
      txHash: null,
      relatedTxHash: rqHash,
      status: "ragequit",
      label: opts.label,
      noteKey,
    };
  } else {
    const merged = mergeRagequitGroup(matches);
    const depositHash = uniqueHashes(merged.txHash, merged.relatedTxHash).find((h) => !sameHash(h, rqHash)) ?? null;
    row = {
      ...merged,
      kind: "deposit",
      timestamp: now,
      status: "ragequit",
      label: opts.label,
      txHash: depositHash,
      relatedTxHash: rqHash,
      amount: opts.amount ?? merged.amount,
      token: opts.token ?? merged.token,
      chainId: opts.chainId ?? merged.chainId,
    };
  }

  writeRaw(wallet, [row, ...others]);
  notifyUpdated();
}

export function exportUserActivitiesCsv(
  wallet: string,
  entries: UserActivityEntry[],
): void {
  const header = ["timestamp", "type", "token", "amount", "status", "tx_hash", "related_tx_hash", "label", "chain_id"];
  const rows = entries.map((e) => [
    e.timestamp,
    e.kind,
    e.token ?? "",
    e.amount != null ? String(e.amount) : "",
    e.status ?? "",
    e.txHash ?? "",
    e.relatedTxHash ?? "",
    e.label ?? "",
    e.chainId != null ? String(e.chainId) : "",
  ]);

  const escape = (v: string) => {
    if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };

  const csv = [header, ...rows].map((row) => row.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `siphon-activity-${wallet.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
