/**
 * One shared, cached, de-duplicated source of ASP deposit screening.
 *
 * `listDepositScreening` issues one /api/asp-set/member request PER NOTE. That endpoint allows 30
 * requests per 60s per IP (ASP_SET_MEMBER_RATE_MAX, RATE_WINDOW_MS). Two components polling it
 * independently every 8s — the Activity Log for its rows, the dashboard for the In Review figure —
 * put a 5-note wallet at roughly 75 requests a minute against that 30. The limiter then answered
 * 429, aspMemberStatus turned every 429 into `null`, and null means "say nothing" — so the screening
 * list came back EMPTY. The visible symptom was the opposite of the truth: no In Review row and no
 * ragequit button, on a wallet whose notes were all pending.
 *
 * Same shape as the ethers 429 self-amplification bug: our own limiter, tripped by our own polling,
 * reported as missing data rather than as backpressure.
 *
 * So: one poller, one cache, one in-flight request shared by every caller. Refresh is TTL-based and
 * paced against the thing it actually tracks — the ~5 minute admit bus — not against a UI tick.
 */

import type { DepositScreening } from "../handler";
import { createTtlCache } from "./ttlCache";
import { getSelectedChainId, getTokens } from "../networks";
import { getSigner } from "../nexus";
import { v3Config, v3Deployed } from "./configV3";
import { noteAssetIdFor } from "./noteCryptoV3";
import { statusByLabelV3, type NoteStatusV3 } from "./noteStatusV3";
import { loadV3Notes, v3NoteKey } from "./noteStoreV3";
import { humanAmount } from "./depositScreeningV3";
import { noteRagequitGrace } from "./ragequitGraceV3";

/**
 * How long a screening read stays fresh.
 *
 * Budget check, which is the whole point of this number: a 6-note wallet costs 6 requests per
 * refresh, so 20s spends ~18/min against a 30/min allowance and leaves headroom for the arming
 * path, which hits the same bucket through checkAdmitted. Well inside the limit while still
 * resolving an admission (~1-3 min) within a couple of ticks.
 */
const TTL_MS = 20_000;

/** Backoff after a refresh that produced nothing, which is what a 429 storm looks like from here. */
const EMPTY_BACKOFF_MS = 60_000;

/**
 * Rows for every note that can only be ragequit — PENDING or REVOKED.
 *
 * Built on the same path the balance card already uses successfully (loadV3Notes over ALL notes,
 * then one membership lookup per unique LABEL), rather than listDepositScreening. Two reasons that
 * matters: listDepositScreening filters loadV3Notes by symbol, and a note filed under an asset
 * that is not a displayed symbol — a wrapped-ETH note, say — is then invisible; and it looks up
 * membership per NOTE rather than per label, which is what put the sweep over the /set/member
 * rate limit in the first place.
 */
async function fetchRows(): Promise<DepositScreening[]> {
  if (typeof window === "undefined") return [];
  const signer = getSigner();
  if (!signer) return [];
  const chainId = getSelectedChainId();
  if (!v3Deployed(chainId)) return [];
  const cfg = v3Config(chainId);
  if (!cfg?.aspUrl) return [];

  // No symbol filter — see above. Bucketing is by the note's own symbol.
  const notes = await loadV3Notes(chainId, signer);
  if (notes.length === 0) return [];

  const byLabel = await statusByLabelV3(cfg.aspUrl, "", notes.map((n) => n.label), chainId);
  const me = await signer.getAddress();
  const tokens = getTokens(chainId);

  // SpendNote carries assetId, not a symbol, so invert the token table the way balanceV3 does. An
  // ETH deposit is wrapped, so its note holds WETH's assetId — deriving from the displayed
  // 0xEeee… sentinel would match no note at all.
  const symbolByAssetId = new Map<string, { symbol: string; decimals: number }>();
  for (const [symbol, t] of Object.entries(tokens)) {
    try {
      symbolByAssetId.set(noteAssetIdFor(chainId, t.address).toString(), {
        symbol,
        decimals: t.decimals,
      });
    } catch { /* a token this chain cannot resolve simply has no rows */ }
  }

  return toScreeningRows({ chainId, notes, byLabel, symbolByAssetId, depositor: me });
}

/**
 * Turn notes plus their label statuses into the rows the UI renders a ragequit control for.
 *
 * Pure and exported: it decides which of a user's deposits are shown as recoverable, and getting
 * UNKNOWN wrong in either direction is harmful — treat it as pending and an admitted note offers a
 * privacy-destroying exit it does not need; treat it as admitted and a genuinely stuck note offers
 * no way out at all.
 */
export function toScreeningRows(p: {
  chainId: number;
  notes: readonly {
    label: string;
    value: bigint;
    assetId: string;
    commitment: string;
    depositTimestamp?: number;
    createdAt?: number;
    /** Set only on an original deposit — the discriminator for "has a Deposited event". */
    depositTxHash?: string;
  }[];
  byLabel: Map<string, NoteStatusV3>;
  symbolByAssetId: Map<string, { symbol: string; decimals: number }>;
  depositor: string;
  nowMs?: number;
}): DepositScreening[] {
  const out: DepositScreening[] = [];
  for (const note of p.notes) {
    const status = p.byLabel.get(note.label) ?? "UNKNOWN";
    // UNKNOWN means the ASP could not be reached. That is not a verdict, and claiming one is the
    // exact failure this path exists to avoid.
    if (status === "UNKNOWN") continue;
    // The grace window is five minutes after a DEPOSIT, so only a deposit can have one. A change
    // note minted by a swap/merge/strategy leg has no Deposited event, so /set/revoke can never
    // issue it an exit ticket and the circuit's revoked branch stays unreachable — the Ragequit
    // button on one is guaranteed to fail. It was reachable because noteRagequitGrace falls back
    // to createdAt, which every note has, so every swap's change note opened a fresh window.
    // depositTxHash rides inside the encrypted note and is written only by depositV3; prefer it
    // over the plaintext `origin` tag, which is absent on older rows and reads as "not change".
    const isDeposit = typeof note.depositTxHash === "string" && note.depositTxHash.length > 0;
    const grace = isDeposit
      ? noteRagequitGrace({
          depositTimestampSeconds: note.depositTimestamp,
          createdAtMs: note.createdAt,
          nowMs: p.nowMs,
        })
      : { known: false as const, active: false as const, deadlineMs: undefined };
    const phase =
      status === "REVOKED"
        ? "flagged"
        : grace.known
          ? grace.active
            ? "checking"
            : null
          : status === "PENDING"
            ? "checking"
            : null;
    if (!phase) continue;
    const meta = p.symbolByAssetId.get(String(note.assetId));
    if (!meta) continue; // an asset we do not display; nothing actionable to show for it
    out.push({
      noteKey: v3NoteKey(p.chainId, meta.symbol, note.commitment),
      token: meta.symbol,
      amount: humanAmount(note.value, meta.decimals),
      phase,
      admitted: status === "ADMITTED",
      graceDeadlineMs: phase === "checking" ? grace.deadlineMs : undefined,
      // v3 notes decrypt only for their owner, so a note that loaded here is this wallet's.
      isOriginal: true,
      depositor: p.depositor,
    });
  }
  return out;
}

const cache = createTtlCache<DepositScreening[]>({
  fetcher: fetchRows,
  ttlMs: TTL_MS,
  backoffMs: EMPTY_BACKOFF_MS,
  initial: [],
  // An empty result is ambiguous: everything admitted and clean, or every lookup rate limited.
  // Both look identical from here, so treat "was non-empty, now empty" as suspicious and wait
  // rather than asking again through a window we may already have filled.
  suspicious: (next, prev) => next.length === 0 && prev.length > 0,
});

/** Current rows without triggering a fetch. Safe to call during render. */
export function getScreeningRows(): DepositScreening[] {
  return cache.get();
}

/** Fetch if stale, otherwise serve the cache. Concurrent callers share one request. */
export function refreshScreening(opts?: { force?: boolean }): Promise<DepositScreening[]> {
  return cache.refresh(opts);
}

/** Drop the cache — call after an action that changes membership, e.g. a ragequit. */
export function invalidateScreening(): void {
  cache.invalidate();
}

/**
 * Subscribe to screening updates. The poller runs only while someone is listening; every
 * subscriber shares the same cache, and the TTL — not the timer — decides what costs a request.
 */
export function subscribeScreening(listener: () => void): () => void {
  const off = cache.subscribe(listener);
  void cache.refresh();
  const timer = setInterval(() => void cache.refresh(), TTL_MS);
  return () => {
    off();
    clearInterval(timer);
  };
}

/** Reset everything. Tests and wallet/chain switches only. */
export function resetScreening(): void {
  cache.reset();
}
