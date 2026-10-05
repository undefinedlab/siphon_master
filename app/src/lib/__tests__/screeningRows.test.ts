// @ts-expect-error Bun's test module is provided by the test runtime, not the Next.js app types.
import { describe, expect, test } from "bun:test";
import { toScreeningRows } from "../v3/screeningStore";
import type { NoteStatusV3 } from "../v3/noteStatusV3";

/**
 * These rows decide which deposits the dashboard offers a ragequit for. Both directions are
 * harmful: show an admitted note and we offer a privacy-destroying exit it does not need; hide a
 * pending one and a user waiting on the admit bus has no way out at all.
 *
 * UNKNOWN is the case that caused the reported bug. It means the ASP could not be reached — a 429,
 * usually — and treating it as a verdict is exactly how backpressure turned into "nothing pending".
 */

const USDC = "111";
const WETH = "222";
const symbolByAssetId = new Map([
  [USDC, { symbol: "USDC", decimals: 6 }],
  [WETH, { symbol: "ETH", decimals: 18 }],
]);

const note = (
  commitment: string,
  label: string,
  value: bigint,
  assetId = USDC,
  depositTimestamp?: number,
  // Real deposits carry one; change notes never do. Defaulted so existing cases keep testing
  // the deposit path they were written for.
  depositTxHash: string | undefined = "0xdep",
) => ({ commitment, label, value, assetId, depositTimestamp, depositTxHash });

function rows(
  notes: ReturnType<typeof note>[],
  statuses: Record<string, NoteStatusV3>,
  nowMs?: number,
) {
  return toScreeningRows({
    chainId: 8453,
    notes,
    byLabel: new Map(Object.entries(statuses)) as Map<string, NoteStatusV3>,
    symbolByAssetId,
    depositor: "0xdead",
    nowMs,
  });
}

describe("toScreeningRows", () => {
  test("a PENDING note becomes an in-review row", () => {
    const out = rows([note("c1", "L1", 500_000n)], { L1: "PENDING" });
    expect(out.length).toBe(1);
    expect(out[0].phase).toBe("checking");
    expect(out[0].amount).toBe("0.5");
    expect(out[0].token).toBe("USDC");
  });

  test("a REVOKED note becomes a flagged row", () => {
    const out = rows([note("c1", "L1", 2_000_000n)], { L1: "REVOKED" });
    expect(out[0].phase).toBe("flagged");
    expect(out[0].amount).toBe("2");
  });

  test("an ADMITTED note produces NO row — it is spendable, not recoverable", () => {
    expect(rows([note("c1", "L1", 1_000_000n)], { L1: "ADMITTED" })).toEqual([]);
  });

  test("an off-chain ADMITTED note remains ragequittable for five minutes", () => {
    const depositedAt = 1_000;
    const out = rows(
      [note("c1", "L1", 1_000_000n, USDC, depositedAt)],
      { L1: "ADMITTED" },
      (depositedAt + 299) * 1_000,
    );
    expect(out).toHaveLength(1);
    expect(out[0].phase).toBe("checking");
  });

  test("an off-chain ADMITTED note leaves the ragequit list after five minutes", () => {
    const depositedAt = 1_000;
    expect(
      rows(
        [note("c1", "L1", 1_000_000n, USDC, depositedAt)],
        { L1: "ADMITTED" },
        (depositedAt + 301) * 1_000,
      ),
    ).toEqual([]);
  });

  test("UNKNOWN produces no row — an unreachable ASP is not a verdict", () => {
    // The reported bug in miniature: never claim a state we could not read.
    expect(rows([note("c1", "L1", 1_000_000n)], { L1: "UNKNOWN" })).toEqual([]);
  });

  test("a label missing from the map is treated as UNKNOWN, not as pending", () => {
    expect(rows([note("c1", "L1", 1_000_000n)], {})).toEqual([]);
  });

  test("notes sharing a label all resolve from that one lookup", () => {
    // Change and slice notes inherit their parent's label; deduping by label is what keeps the
    // request count under the /set/member cap.
    const out = rows(
      [note("c1", "L1", 1_000_000n), note("c2", "L1", 500_000n)],
      { L1: "PENDING" },
    );
    expect(out.length).toBe(2);
    expect(out.map((r) => r.amount).sort()).toEqual(["0.5", "1"]);
  });

  test("mixed statuses select only the recoverable ones", () => {
    const out = rows(
      [
        note("c1", "L1", 1_000_000n),
        note("c2", "L2", 2_000_000n),
        note("c3", "L3", 3_000_000n),
        note("c4", "L4", 4_000_000n),
      ],
      { L1: "ADMITTED", L2: "PENDING", L3: "REVOKED", L4: "UNKNOWN" },
    );
    expect(out.map((r) => r.amount)).toEqual(["2", "3"]);
    expect(out.map((r) => r.phase)).toEqual(["checking", "flagged"]);
  });

  test("an asset we do not display is skipped rather than mislabelled", () => {
    expect(rows([note("c1", "L1", 1n, "999")], { L1: "PENDING" })).toEqual([]);
  });

  test("decimals come from the asset, so an 18-decimal note is not read as 6", () => {
    const out = rows([note("c1", "L1", 10_000_000_000_000_000n, WETH)], { L1: "PENDING" });
    expect(out[0].token).toBe("ETH");
    expect(out[0].amount).toBe("0.01");
  });

  test("the noteKey is the canonical v3 key, so ragequit can find the note", () => {
    const out = rows([note("abc", "L1", 1_000_000n)], { L1: "PENDING" });
    expect(out[0].noteKey).toBe("siphon-v3note-8453-USDC-abc");
  });

  test("no notes means no rows", () => {
    expect(rows([], { L1: "PENDING" })).toEqual([]);
  });

  /**
   * The reported bug: 1 USDC showed under both "private balance" and "exit window open", and the
   * exit window survived every reload. syncV3FromServer re-materialised each server-side note with
   * `createdAt: Date.now()`, so a re-synced old deposit looked like it had just landed. These two
   * pin the states that re-sync can produce.
   */
  test("an ADMITTED note deposited long ago shows no exit window", () => {
    const depositedAt = 1_000;
    const out = rows(
      [note("c1", "L1", 1_000_000n, USDC, depositedAt)],
      { L1: "ADMITTED" },
      (depositedAt + 301) * 1_000,
    );
    expect(out).toEqual([]);
  });

  test("a CHANGE note gets no exit window — it has no Deposited event to ticket", () => {
    // The reported case: 0.00003191 ETH left over from a strategy fill sat under "exit window
    // open" for ever. A swap's change note has no depositTxHash, so the exit ticket route would
    // reject it; offering the button guarantees a failed click.
    const changeNote = note("c1", "L1", 1_000_000n, USDC, undefined, undefined);
    expect(rows([changeNote], { L1: "ADMITTED" })).toEqual([]);
  });

  test("a REVOKED change note KEEPS its exit — revoked needs no ticket", () => {
    // ensureRagequitExitTicket short-circuits on an already-revoked label, so this one really can
    // exit. Hiding it would strand a flagged note with no way out.
    const changeNote = note("c1", "L1", 1_000_000n, USDC, undefined, undefined);
    expect(rows([changeNote], { L1: "REVOKED" })[0].phase).toBe("flagged");
  });

  test("an ADMITTED note with no known deposit time shows no exit window", () => {
    // A re-synced note whose deposit time the server never had. Unknown must read as closed:
    // inventing a fresh window re-opens a public exit for a note that long since lost one.
    expect(rows([note("c1", "L1", 1_000_000n, USDC, undefined)], { L1: "ADMITTED" })).toEqual([]);
  });
});
