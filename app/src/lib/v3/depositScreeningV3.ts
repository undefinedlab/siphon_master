/**
 * Deposit screening for v3 (D1) notes.
 *
 * The v1 implementation in handler.ts is structurally unable to see v3 notes: it scans
 * localStorage for the `siphon-note-` prefix (v3 stores under `siphon-v3note-`), reads a
 * per-label DepositInfo off the legacy Entrypoint, and asks the v1 association set about it.
 * v3 has no DepositInfo and replaces label membership with the ASP bus. So on Base and Sepolia
 * the "in checking" / "flagged" rows never appeared — and neither did the ragequit controls
 * they drive, which is the only way a revoked deposit comes back.
 */
import { Contract } from "ethers";
import type { Signer } from "ethers";

import type { DepositScreening } from "../handler";
import { getTokens } from "../networks";
import { aspMemberStatus } from "./aspClientV3";
import { v3Config, v3Deployed } from "./configV3";
import { nextBusAtMs } from "./aspBusV3";
import { hashNullifier } from "./noteCryptoV3";
import { loadV3Notes, v3NoteKey } from "./noteStoreV3";
import { noteRagequitGrace } from "./ragequitGraceV3";

const KERNEL_ABI = ["function nullifiers() view returns (address)"];
const NULLIFIER_SET_ABI = ["function isUsed(uint256) view returns (bool)"];

/**
 * Which screening row, if any, a label's ASP membership warrants.
 *
 * Revocation wins over admission: a label can be both admitted (it went through the bus earlier)
 * and later revoked, and that note is flagged — treating it as admitted would hide the only
 * control that recovers it.
 *
 * null means "no row": either admitted-and-clean (privately spendable, nothing to show) or the
 * ASP was unreachable, in which case claiming a state would be worse than showing none.
 */
export function screeningPhase(
  status: { admitted: boolean; revoked: boolean } | null,
  admittedGraceActive = false,
): "checking" | "flagged" | null {
  if (!status) return null;
  if (status.revoked) return "flagged";
  return status.admitted && !admittedGraceActive ? null : "checking";
}

/** Human amount from minor units, without pulling in a formatter for two known decimals. */
export function humanAmount(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export async function listDepositScreeningV3(
  chainId: number,
  symbolRaw: string,
  signer: Signer,
  opts?: { includeChangeNotes?: boolean },
): Promise<DepositScreening[]> {
  if (!v3Deployed(chainId)) return [];
  const cfg = v3Config(chainId);
  if (!cfg?.vaultKernel) return [];

  const symbol = symbolRaw.toUpperCase();
  const decimals = getTokens(chainId)[symbol]?.decimals ?? (symbol === "ETH" ? 18 : 6);
  const includeChange = Boolean(opts?.includeChangeNotes);

  // loadV3Notes already drops locally-spent notes and notes belonging to a retired kernel
  // generation, so anything it returns is a live note for the configured deployment.
  const notes = await loadV3Notes(chainId, signer, symbol);
  if (notes.length === 0) return [];

  const me = await signer.getAddress();

  // One nullifier-set lookup path for the whole batch rather than per note.
  let nullifierSet: Contract | null = null;
  try {
    const kernel = new Contract(cfg.vaultKernel, KERNEL_ABI, signer);
    const addr: string = String(await kernel.nullifiers());
    if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
      nullifierSet = new Contract(addr, NULLIFIER_SET_ABI, signer);
    }
  } catch {
    /* fall through — the local spent flag is the fallback, same as v1 */
  }

  const out: DepositScreening[] = [];
  // One hub read per refresh, and only when something is actually waiting for the bus.
  let busAt: number | null | undefined;
  for (const note of notes) {
    // Sequential on purpose: /set/member is rate limited per client IP, and a burst of parallel
    // lookups gets 429s that would read as "unreachable" and silently empty this list.
    const status = await aspMemberStatus(note.label, chainId);

    // Unreachable ASP: say nothing rather than claim a state. Showing "in checking" here would
    // be indistinguishable from a real pending deposit, and showing nothing at least matches
    // what the user already sees.
    if (!status) continue;

    const grace = noteRagequitGrace({
      depositTimestampSeconds: note.depositTimestamp,
      createdAtMs: note.createdAt,
    });
    // No early skip past the five-minute window: the bus can take just over six minutes, and a note
    // still waiting must stay "in review" (not spendable) until it boards. Admitted notes past the
    // window get no row from screeningPhase; the ragequit button follows graceDeadlineMs instead.
    const phase = screeningPhase(status, grace.active);
    if (!phase) continue;

    // Already spent on-chain: the local flag can lag a spend made on another device.
    if (nullifierSet) {
      try {
        const nh = await hashNullifier(BigInt(note.nullifier));
        if (await nullifierSet.isUsed(nh)) continue;
      } catch {
        /* keep the row — a read failure must not hide a recoverable note */
      }
    }

    const noteKey = v3NoteKey(chainId, symbol, note.commitment);
    const isOriginal = readOrigin(noteKey) !== "change";
    if (!isOriginal && !includeChange) continue;

    const waiting = !status.admitted && !status.revoked;
    if (waiting && busAt === undefined) busAt = await nextBusAtMs(chainId);
    out.push({
      noteKey,
      token: symbol,
      amount: humanAmount(note.value, decimals),
      phase,
      // Admitted notes inside the grace window are still `checking` (so the ragequit button is
      // offered) but ARE spendable — see DepositScreening.admitted.
      admitted: status.admitted && !status.revoked,
      graceDeadlineMs: phase === "checking" ? grace.deadlineMs : undefined,
      busEtaMs: waiting ? busAt ?? undefined : undefined,
      isOriginal,
      // v3 notes are only decryptable by their owner, so a note that loaded here is this
      // wallet's. v1 had to read the depositor off-chain because it scanned shared state.
      depositor: me,
    });
  }
  return out;
}

/**
 * Provenance of a stored v3 note. Notes written before the `origin` tag existed report
 * undefined, and are treated as original deposits — matching how they were displayed before.
 */
function readOrigin(noteKey: string): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(noteKey);
    if (!raw) return undefined;
    return (JSON.parse(raw) as { origin?: string }).origin;
  } catch {
    return undefined;
  }
}
