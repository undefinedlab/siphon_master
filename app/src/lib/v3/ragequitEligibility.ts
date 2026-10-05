/**
 * Can this note ragequit? — PROTOCOL.md §5.2.1, decided before we spend 30s in the prover.
 *
 * Ragequit is the ATTRIBUTED exit, and the circuit admits exactly one of two branches:
 *   revoked (1): the label is IN the revoked SMT — the live path, after a KYT fail or an ops exit.
 *   pending (0): SMT non-inclusion AND admittedRoot == EMPTY_ASP_ROOT — bootstrap only, and
 *                unsatisfiable in production, where the ASP is non-empty after its first bus.
 *
 * So a clean, not-yet-admitted note CANNOT exit early. §5.2.1 lists that state as "Forbidden —
 * wait for admit publish". Without this check the user waits out a full proof and gets an opaque
 * `Assert Failed` from snarkjs; the constraint is knowable up front, so say it up front.
 */

/** The revoked SMT reports a non-membership slot as leaf "0"; anything else is a real leaf. */
export function isRevokedByLeaf(revokedSmtLeaf: string): boolean {
  return String(revokedSmtLeaf ?? "0") !== "0";
}

/** Null when the ragequit can proceed; otherwise the message to show the user. */
export function ragequitBlockedReason(branch: 0 | 1, revokedSmtLeaf: string): string | null {
  // Branch 0 carries its own admittedRoot == EMPTY_ASP_ROOT constraint, which only a bootstrap
  // deployment can satisfy. Nothing to pre-check here that the circuit does not check better.
  if (branch !== 1) return null;
  if (isRevokedByLeaf(revokedSmtLeaf)) return null;
  return "This deposit has not been flagged, so it cannot be recovered early — it becomes spendable once the ASP admits it (usually a few minutes).";
}
