/**
 * Human decimal amounts that are safe to hand to ethers' parseUnits, and honest to display.
 *
 * Two failure modes this exists to kill, both seen in the wild on a real balance of 8.1e-7 ETH:
 *
 * 1. JS stringifies numbers below 1e-6 in EXPONENTIAL notation — String(8.1e-7) is "8.1e-7" —
 *    and parseUnits rejects that with `invalid FixedNumber string value`. The withdraw panel hit
 *    this and failed the transaction outright.
 * 2. parseUnits ALSO throws when the fraction carries more digits than the token has decimals.
 *    0.00000081 is 8 places; USDC has 6. So even after fixing the notation, the same value would
 *    still throw on a USDC withdrawal.
 *
 * Excess precision is TRUNCATED, never rounded. These strings feed balance and allowance
 * comparisons, where rounding up invents funds the user does not have — which is the same class
 * of bug as the display that rounded 0.00000081 up to 0.000001 and invited a withdrawal of more
 * than the balance.
 */

/**
 * Expand exponential notation to plain decimal by moving the point textually.
 *
 * Deliberately does no float arithmetic: shifting digits in a string is exact, whereas anything
 * routed back through a Number reintroduces the representation error this is here to avoid.
 */
function expandExponential(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return "0";
  const [, sign, intPart, fracPart = "", expStr] = m;
  const digits = intPart + fracPart;
  const point = intPart.length + Number(expStr);

  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + out;
}

/**
 * Fixed-notation rendering of a JS number — never exponential, and never inventing digits.
 *
 * String(n) gives the SHORTEST round-tripping decimal, which is the value the user means:
 * String(0.064025) is "0.064025". Going through toFixed(20) instead yields
 * "0.06402499999999999600" — and truncating that to 6 places produced 0.064024, quietly losing a
 * digit of a real balance. The self-check pins that case.
 */
function plainString(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = String(n);
  return /e/i.test(s) ? expandExponential(s) : s;
}

/**
 * Normalise a human amount to a plain decimal string with at most `decimals` fraction digits.
 * Safe to pass straight to parseUnits. Returns "0" for anything unparseable.
 */
export function toAmountString(value: number | string, decimals: number): string {
  const dp = Math.max(0, Math.min(Math.floor(decimals) || 0, 30));

  let s = typeof value === "number" ? plainString(value) : String(value ?? "").trim();
  if (!s) return "0";

  // A string can arrive in exponential form too (it came from a number somewhere upstream).
  if (/e/i.test(s)) {
    s = expandExponential(s);
  }
  if (!/^-?\d*(\.\d*)?$/.test(s)) return "0";

  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);

  const [wholeRaw = "0", fracRaw = ""] = s.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  // Slice, not round: this must never report more than the user actually holds.
  const frac = fracRaw.slice(0, dp).replace(/0+$/, "");

  const body = frac ? `${whole}.${frac}` : whole;
  return neg && body !== "0" ? `-${body}` : body;
}

/**
 * Display form of a balance. Truncates like toAmountString, but says "<0.000001" instead of "0"
 * for a non-zero balance too small to show — so dust never reads as either zero or as more than
 * it is.
 */
export function displayAmount(value: number | string, dp = 6): string {
  const s = toAmountString(value, dp);
  const n = typeof value === "number" ? value : Number(value);
  if (s === "0" && Number.isFinite(n) && n > 0) {
    return `<${(10 ** -dp).toFixed(dp)}`;
  }
  return s;
}
