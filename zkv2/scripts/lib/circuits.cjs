/** @typedef {{ key: string, main: string, verifier: string, nPublic: number }} CircuitSpec */

/** Poseidon Merkle / SMT depth — must match on-chain trees + PROTOCOL. */
const TREE_DEPTH = 32;

/** Hermez phase-1 ptau (powersOfTau28_hez_final_20). */
const PTAU_FILE = "powersOfTau28_hez_final_20.ptau";

/** PROTOCOL.md §4 — fixed 25-limb public encoding for all spend actions. */
const PUBLIC_WIDTH = 25;

/** @type {CircuitSpec[]} */
const WITHDRAW = [1, 2, 3, 4, 5, 6].map((n) => ({
  key: `withdraw${n}`,
  main: `withdraw${n}`,
  verifier: `SpendWithdrawVerifier${n}`,
  nPublic: PUBLIC_WIDTH,
}));

/** @type {CircuitSpec[]} */
const MERGE = [2, 3, 4, 5, 6].map((n) => ({
  key: `merge${n}`,
  main: `merge${n}`,
  verifier: `SpendMergeVerifier${n}`,
  nPublic: PUBLIC_WIDTH,
}));

/** @type {CircuitSpec[]} */
const CIRCUITS = [
  ...WITHDRAW,
  ...MERGE,
  { key: "swap", main: "swap", verifier: "SpendSwapVerifier", nPublic: PUBLIC_WIDTH },
  { key: "split", main: "split", verifier: "SpendSplitVerifier", nPublic: PUBLIC_WIDTH },
  { key: "ragequit", main: "ragequit", verifier: "SpendRagequitVerifier", nPublic: PUBLIC_WIDTH },
];

const BY_KEY = Object.fromEntries(CIRCUITS.map((c) => [c.key, c]));

/**
 * Pick withdraw/merge circuit key from PROTOCOL inputCount.
 * Only returns keys present in BY_KEY (no path segments / traversal).
 */
function circuitKeyForAction(action, inputCount) {
  const a = Number(action);
  if (!Number.isInteger(a) || a < 0 || a > 4) {
    throw new Error(`unknown action ${action}`);
  }
  let key;
  if (a === 2) key = "swap";
  else if (a === 3) key = "split";
  else if (a === 4) key = "ragequit";
  else {
    const n = inputCount;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 6) {
      throw new Error(`invalid inputCount ${inputCount}`);
    }
    if (a === 0) key = `withdraw${n}`;
    else if (a === 1) {
      if (n < 2) throw new Error(`merge requires inputCount >= 2, got ${n}`);
      key = `merge${n}`;
    }
  }
  if (!BY_KEY[key]) {
    throw new Error(`unknown circuit key ${key}`);
  }
  return key;
}

module.exports = {
  TREE_DEPTH,
  PTAU_FILE,
  PUBLIC_WIDTH,
  CIRCUITS,
  BY_KEY,
  circuitKeyForAction,
};
