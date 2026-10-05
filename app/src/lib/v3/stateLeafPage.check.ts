import assert from "node:assert";
import { normalizeStateLeafPage } from "./stateLeavesClient";

const shuffled = normalizeStateLeafPage(
  [
    { leafIndex: 2, commitment: "30" },
    { leafIndex: 0, commitment: "10" },
    { leafIndex: 1, commitment: "20" },
  ],
  0,
);
assert.ok("leaves" in shuffled);
assert.deepStrictEqual(shuffled.leaves, [10n, 20n, 30n]);

const next = normalizeStateLeafPage(
  [
    { leafIndex: 4, commitment: "50" },
    { leafIndex: 3, commitment: "40" },
  ],
  3,
);
assert.ok("leaves" in next);
assert.deepStrictEqual(next.leaves, [40n, 50n]);

const gap = normalizeStateLeafPage(
  [
    { leafIndex: 0, commitment: "10" },
    { leafIndex: 2, commitment: "30" },
  ],
  0,
);
assert.ok("error" in gap);
assert.match(gap.error, /expected 1, got 2/);

console.log("stateLeafPage.check: OK — indexed rows sort by leafIndex and gaps fail closed");
