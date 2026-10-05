/**
 * v3 note status classification (Phase 4) — admit-epoch aware pending/checking UX.
 *
 * v3 uses a 5-minute admit epoch (PROTOCOL §2.6.2): a note cannot private-spend until its label is
 * in the PUBLISHED admittedRoot. Before that it is "pending" (ragequit-only). A revoked label is
 * "flagged". This maps onto the dashboard's Private / In-Review / Flagged balance split:
 *
 *   ADMITTED  → label ∈ published admittedRoot, ∉ revokedRoot   → private-spendable ("Private")
 *   PENDING   → label ∉ published admittedRoot yet, ∉ SMT        → ragequit-only ("In Review")
 *   REVOKED   → label ∈ revokedRoot                              → ragequit-only ("Flagged")
 *
 * The gate is cryptographic (the circuit enforces ASP inclusion + SMT non-inclusion); this display
 * classification just tells the user which bucket each note is in.
 */

import { aspMemberStatus, fetchComplianceRoots } from "./aspClientV3";

export type NoteStatusV3 = "ADMITTED" | "PENDING" | "REVOKED" | "UNKNOWN";

export interface LabeledNote {
  label: string;
  value: bigint;
  assetId: string;
}

export interface StatusMembership {
  admitted: boolean;
  revoked: boolean;
}

/**
 * ASP `/set/member?label=` via same-origin proxy (OVERLORD F-8).
 *
 * Delegates to aspMemberStatus so this path shares the per-label TTL cache instead of re-issuing
 * a request per label per sweep. aspMemberStatus documents itself as the single entry point every
 * consumer routes through — but this function used to build its own fetch, so the busiest caller
 * of all (statusByLabelV3, which the screening store polls every 20s for the dashboard AND the
 * Activity Log) was the one consumer skipping the cache. An ADMITTED label only changes on a
 * revoke and caches for 5 minutes; re-asking every 20s spent ~15x the requests for an answer that
 * had not changed, and that is what kept tripping the ASP limiter.
 *
 * Sharing the cache also inherits its 429 handling: a rate-limited read returns the last known
 * answer rather than null, so backpressure stops masquerading as "no rows".
 */
export async function fetchMembership(
  _aspUrl: string,
  _screenToken: string,
  label: string,
  chainId?: number,
): Promise<StatusMembership | null> {
  try {
    return await aspMemberStatus(label, chainId);
  } catch {
    return null;
  }
}

/** Classify one label from its ASP membership. Fail-closed: null membership → UNKNOWN. */
export function classify(m: StatusMembership | null): NoteStatusV3 {
  if (!m) return "UNKNOWN";
  if (m.revoked) return "REVOKED";
  if (m.admitted) return "ADMITTED";
  return "PENDING";
}

export interface V3BalanceBuckets {
  privateByAsset: Record<string, bigint>;
  inReviewByAsset: Record<string, bigint>;
  flaggedByAsset: Record<string, bigint>;
  unknownByAsset: Record<string, bigint>;
  admittedRoot: string;
  revokedRoot: string;
}

function add(map: Record<string, bigint>, assetId: string, v: bigint): void {
  map[assetId] = (map[assetId] ?? 0n) + v;
}

/**
 * Membership status per LABEL, deduplicated and fetched in parallel.
 *
 * Deduplication is the load-bearing part: notes share labels — change and slice notes inherit
 * their parent's — so a wallet with eight notes may hold only two distinct labels. Asking per NOTE
 * instead of per label is what put the screening sweep over the /set/member limit, and a 429 there
 * comes back as "no rows", which renders as no In Review and no ragequit control.
 *
 * Split out of classifyNotesV3 so the same map can drive per-note UI (which notes may be
 * ragequit) without a second round of lookups.
 */
export async function statusByLabelV3(
  aspUrl: string,
  screenToken: string,
  labels: readonly string[],
  chainId?: number,
): Promise<Map<string, NoteStatusV3>> {
  const unique = Array.from(new Set(labels));
  const out = new Map<string, NoteStatusV3>();
  await Promise.all(
    unique.map(async (label) => {
      out.set(label, classify(await fetchMembership(aspUrl, screenToken, label, chainId)));
    }),
  );
  return out;
}

export async function classifyNotesV3(
  aspUrl: string,
  screenToken: string,
  notes: LabeledNote[],
  chainId?: number,
): Promise<V3BalanceBuckets> {
  const roots = await fetchComplianceRoots(aspUrl, screenToken, chainId).catch(() => ({
    admittedRoot: "0",
    revokedRoot: "0",
  }));

  const buckets: V3BalanceBuckets = {
    privateByAsset: {},
    inReviewByAsset: {},
    flaggedByAsset: {},
    unknownByAsset: {},
    admittedRoot: roots.admittedRoot,
    revokedRoot: roots.revokedRoot,
  };

  const byLabel = await statusByLabelV3(aspUrl, screenToken, notes.map((n) => n.label), chainId);

  for (const note of notes) {
    const status = byLabel.get(note.label) ?? "UNKNOWN";
    switch (status) {
      case "ADMITTED":
        add(buckets.privateByAsset, note.assetId, note.value);
        break;
      case "PENDING":
        add(buckets.inReviewByAsset, note.assetId, note.value);
        break;
      case "REVOKED":
        add(buckets.flaggedByAsset, note.assetId, note.value);
        break;
      default:
        add(buckets.unknownByAsset, note.assetId, note.value);
    }
  }
  return buckets;
}

export function isSpendableV3(status: NoteStatusV3): boolean {
  return status === "ADMITTED";
}

export function isRagequitOnlyV3(status: NoteStatusV3): boolean {
  return status === "PENDING" || status === "REVOKED";
}
