/**
 * Withdraw coin-selection planner (PROTOCOL §6.1, PROGRAM_VERSION 5 — fractional change).
 *
 * TS port of `siphon-zk-v2/sdk/planWithdraw.js` for the browser. v4 withdraw allows the change note
 * to be any value in [0, boundaryValue], carved from the boundary note — so arbitrary amounts are a
 * SINGLE proof + SINGLE tx, no SPLIT leg.
 *
 * Pure selection: decides which notes to spend, the boundary index, and the primary/secondary
 * split. Path building + proving happen downstream (stateTreeV3, aspClient, withdrawV3).
 */

export const MAX_INPUTS = 6; // PROTOCOL §1

export interface PlannerNote {
  commitment: string;
  value: bigint;
  label: string;
  assetId: string;
  nullifier: string;
  secret: string;
}

export interface WithdrawPlan {
  selected: PlannerNote[];
  boundaryIndex: number;
  primaryValue: bigint;
  secondaryValue: bigint;
  total: bigint;
  inputCount: number;
}

interface Wrapped {
  note: PlannerNote;
  value: bigint;
}

/**
 * Plan a withdrawal of `target` of `assetId` from `notes`.
 * @throws on non-positive target, missing assetId, no matching-asset notes, insufficient funds, or
 *         a selection exceeding MAX_INPUTS.
 */
export function planWithdraw(
  notes: PlannerNote[],
  targetAmount: bigint,
  assetId: string,
): WithdrawPlan {
  const target = targetAmount;
  if (target <= 0n) throw new Error("planWithdraw: target must be positive");
  if (assetId === undefined || assetId === null || String(assetId) === "") {
    throw new Error("planWithdraw: assetId required (D1 per-asset selection)");
  }
  const asset = String(assetId);

  const pool: Wrapped[] = (notes || [])
    .filter((n) => String(n.assetId) === asset)
    .map((n) => ({ note: n, value: BigInt(n.value) }))
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

  // PROGRAM_VERSION 5 removed label uniqueness from both spend and compliance circuits.
  // Nullifiers prevent double-spends, while inherited labels deliberately allow change/slice
  // notes descended from one deposit to be combined in a later withdrawal.
  const spendable = pool;

  // Policy 1: single note (cheapest proof). Exact first, else smallest single note >= target.
  const exact = spendable.find((n) => n.value === target);
  if (exact) return build([exact], 0, target, 0n);

  const singleFits = spendable
    .filter((n) => n.value >= target)
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  if (singleFits.length > 0) {
    const boundary = singleFits[0];
    return build([boundary], 0, target, boundary.value - target);
  }

  // Policy 2: greedy descending until sum >= target; boundary = last (smallest selected).
  const desc = [...spendable].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
  const selected: Wrapped[] = [];
  let sum = 0n;
  for (const n of desc) {
    selected.push(n);
    sum += n.value;
    if (sum >= target) break;
  }
  if (sum < target) throw new Error("planWithdraw: internal — greedy did not reach target");
  if (selected.length > MAX_INPUTS) {
    throw new Error(
      `planWithdraw: target needs ${selected.length} notes but MAX_INPUTS is ${MAX_INPUTS} — merge notes first`,
    );
  }

  const boundaryIndex = selected.length - 1;
  const secondary = sum - target; // guaranteed < selected[boundaryIndex].value
  return build(selected, boundaryIndex, target, secondary);
}

/**
 * Parse the insufficient-funds throw back into minor units, or null if `message` is a different
 * error.
 *
 * The planner is pure and has no token metadata, so its message is necessarily raw: "insufficient
 * funds — have 24238, need 54239 of asset 7490717508934632905…". That is right here and unreadable
 * in a toast — it names a Poseidon asset id and two integers, from four frames down, for what is
 * simply "you asked for more than you have". The UI knows the symbol and decimals, so it does the
 * formatting; this stays next to the string it parses so the two cannot drift apart.
 */
export function parseInsufficientFunds(message: string): { have: bigint; need: bigint } | null {
  const m = /planWithdraw: insufficient funds — have (\d+), need (\d+)/.exec(message);
  return m ? { have: BigInt(m[1]), need: BigInt(m[2]) } : null;
}

/**
 * Parse the too-many-inputs throw, or null if `message` is a different error.
 *
 * The planner is pure — it cannot merge, it can only report that a merge is required. The caller
 * that CAN merge reads this to decide, rather than re-deriving the greedy selection and drifting
 * from the policy above. Same reasoning as parseInsufficientFunds, and kept beside the string it
 * parses for the same reason.
 */
export function parseTooManyNotes(message: string): { needed: number; max: number } | null {
  const m = /planWithdraw: target needs (\d+) notes but MAX_INPUTS is (\d+)/.exec(message);
  return m ? { needed: Number(m[1]), max: Number(m[2]) } : null;
}

function build(
  selectedWrapped: Wrapped[],
  boundaryIndex: number,
  primary: bigint,
  secondary: bigint,
): WithdrawPlan {
  const selected = selectedWrapped.map((w) => w.note);
  const total = selectedWrapped.reduce((acc, w) => acc + w.value, 0n);
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
