"use strict";

/**
 * Withdraw coin-selection planner (PROTOCOL §6.1, PROGRAM_VERSION 4 — fractional change).
 *
 * v4 withdraw allows the change note to be ANY value in [0, boundaryValue] — carved from the
 * boundary note, all other selected inputs fully consumed (circuit enforces
 * `secondaryValue <= inValue[boundaryIndex]` via LessEqThan(128)). That makes arbitrary-amount
 * withdrawals a SINGLE proof + SINGLE tx — no SPLIT leg, no two-tx saga.
 *
 * This module is pure selection: it decides WHICH notes to spend, the boundary index, and the
 * primary/secondary split. It does NOT build Merkle/ASP/SMT paths (see aspClient +
 * state-leaf reconstruction) and does NOT prove (see proveSpend). Output feeds those layers.
 *
 * Selection policy:
 *   1. Prefer a single note (N=1) — cheapest proof (withdraw1). Exact single note first, else the
 *      smallest single note >= target (fractional change carved from it).
 *   2. Else greedy: sort candidates descending, take from the top until sum >= target. The last
 *      note added is the boundary; because it is what tipped the sum over target, the change
 *      (sum - target) is always < that note's value, so `change <= boundaryValue` holds by
 *      construction. Safety is still the circuit constraint — this is only the honest path.
 *
 * Per-asset (D1): all selection is scoped to a single assetId. A caller withdrawing token A never
 * selects token-B notes.
 */

const MAX_INPUTS = 6; // PROTOCOL §1

/**
 * @typedef {Object} PlannerNote
 * @property {string} commitment
 * @property {bigint|string|number} value
 * @property {string} label
 * @property {string} assetId
 * @property {string} nullifier
 * @property {string} secret
 */

/**
 * @typedef {Object} WithdrawPlan
 * @property {PlannerNote[]} selected     notes to spend, in the order the witness expects
 * @property {number} boundaryIndex       index into `selected` of the change-hosting note
 * @property {bigint} primaryValue        amount withdrawn to the payee
 * @property {bigint} secondaryValue      change note value (0 == no change)
 * @property {bigint} total               sum of selected note values
 * @property {number} inputCount          selected.length (1..6)
 */

function toBig(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("planWithdraw: unsafe number value; pass bigint/string");
    return BigInt(v);
  }
  if (typeof v === "string") return BigInt(v);
  throw new Error("planWithdraw: value must be bigint|string|number");
}

/**
 * Plan a withdrawal of `target` of `assetId` from `notes`.
 *
 * @param {PlannerNote[]} notes  candidate spendable notes (any assets; filtered here)
 * @param {bigint|string|number} targetAmount  amount to withdraw (minor units)
 * @param {string} assetId  asset to withdraw (uint160(token) as decimal string)
 * @returns {WithdrawPlan}
 * @throws if target is non-positive, no matching-asset notes, or funds insufficient / can't fit
 *         within MAX_INPUTS.
 */
function planWithdraw(notes, targetAmount, assetId) {
  const target = toBig(targetAmount);
  if (target <= 0n) throw new Error("planWithdraw: target must be positive");
  if (assetId === undefined || assetId === null || String(assetId) === "") {
    throw new Error("planWithdraw: assetId required (D1 per-asset selection)");
  }
  const asset = String(assetId);

  // D1: scope to a single asset. Normalize values to bigint once.
  const pool = (notes || [])
    .filter((n) => String(n.assetId) === asset)
    .map((n) => ({ note: n, value: toBig(n.value) }))
    .filter((n) => n.value > 0n);

  if (pool.length === 0) {
    throw new Error(`planWithdraw: no spendable notes for asset ${asset}`);
  }

  const totalAvailable = pool.reduce((acc, n) => acc + n.value, 0n);
  if (totalAvailable < target) {
    throw new Error(
      `planWithdraw: insufficient funds — have ${totalAvailable}, need ${target} of asset ${asset}`,
    );
  }

  // --- Policy 1: single note (N=1), cheapest proof. ---
  // Exact single note first (zero change), else smallest single note >= target (fractional change).
  const exact = pool.find((n) => n.value === target);
  if (exact) {
    return build([exact], 0, target, 0n);
  }
  const singleFits = pool
    .filter((n) => n.value >= target)
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  if (singleFits.length > 0) {
    const boundary = singleFits[0]; // smallest single note >= target
    return build([boundary], 0, target, boundary.value - target);
  }

  // --- Policy 2: greedy descending until sum >= target. ---
  // Boundary = last note added (smallest selected). change = sum - target < boundary.value.
  const desc = [...pool].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
  const selected = [];
  let sum = 0n;
  for (const n of desc) {
    selected.push(n);
    sum += n.value;
    if (sum >= target) break;
  }
  if (sum < target) {
    // Unreachable given totalAvailable >= target, but fail closed.
    throw new Error("planWithdraw: internal — greedy did not reach target");
  }
  if (selected.length > MAX_INPUTS) {
    throw new Error(
      `planWithdraw: target needs ${selected.length} notes but MAX_INPUTS is ${MAX_INPUTS} — ` +
        `merge notes first`,
    );
  }

  const boundaryIndex = selected.length - 1; // last added == smallest selected
  const secondary = sum - target; // guaranteed < selected[boundaryIndex].value
  return build(selected, boundaryIndex, target, secondary);
}

function build(selectedWrapped, boundaryIndex, primary, secondary) {
  const selected = selectedWrapped.map((w) => w.note);
  const total = selectedWrapped.reduce((acc, w) => acc + w.value, 0n);
  // Invariant guards (defensive — the circuit re-checks all of these).
  const boundaryValue = selectedWrapped[boundaryIndex].value;
  if (secondary < 0n) throw new Error("planWithdraw: negative change");
  if (secondary > boundaryValue) {
    throw new Error("planWithdraw: change exceeds boundary value (would fail §6.1 v4)");
  }
  if (primary + secondary !== total) {
    throw new Error("planWithdraw: primary + secondary != sum (conservation)");
  }
  if (primary <= 0n) throw new Error("planWithdraw: primary must be positive");
  return {
    selected,
    boundaryIndex,
    primaryValue: primary,
    secondaryValue: secondary,
    total,
    inputCount: selected.length,
  };
}

module.exports = { planWithdraw, MAX_INPUTS };
