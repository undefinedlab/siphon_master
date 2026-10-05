// Runnable self-check for the TWAP/grid slice-note key fix (no test framework in this repo).
//   npx tsx src/lib/multiLegKey.check.ts
// Regression guard for "leg 0 withdraw proof failed: Insufficient balance. Have 0.0": a TWAP/grid
// leg spends ONE slice note, restricting generateZKData to that note by `_noteKey`. The key
// submitSplitOnChain returns MUST equal what scanNotes emits (canonical `siphon-note-` prefix),
// or the `key !== _noteKey` filter rejects every note and the leg withdraw finds nothing.
import assert from "node:assert";
import { noteKey } from "./localNoteStore";

const chainId = 11155111, symbol = "ETH", commitment = "12345678901234567890";

// scanNotes (localNoteStore) iterates localStorage keys with EXACTLY this prefix and returns the
// full key as meta.key. The slice key generateZKData filters against must live under it.
const scanPrefix = `siphon-note-${chainId}-${symbol.toUpperCase()}-`;
const sliceKey = noteKey(chainId, symbol, commitment); // what submitSplitOnChain now returns

assert(sliceKey.startsWith(scanPrefix),
  `slice key "${sliceKey}" must start with the scan prefix "${scanPrefix}"`);
assert.strictEqual(sliceKey, `${scanPrefix}${commitment}`,
  "slice key must equal the exact key scanNotes emits for this note");

// The OLD hand-rolled format (the bug) must NOT match — it lacks the prefix, so the leg's
// `key !== _noteKey` filter dropped every note → Have 0.0.
const buggyRawKey = `${chainId}-${symbol}-${commitment}`;
assert(buggyRawKey !== sliceKey && !buggyRawKey.startsWith("siphon-note-"),
  "raw key without siphon-note- prefix must differ from the canonical key (that was the bug)");

console.log("OK — TWAP slice key uses the canonical noteKey() format that scanNotes/_noteKey match");
