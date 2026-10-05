/**
 * Which arming path a Quick Swap takes.
 *
 * Quick Swap was the one arming entry point that never learned about v3. DetailsModal and Build
 * both branch to `buildV3Single` when the v3 strategy stack is live; SwapPanel went straight to
 * `armSameChainVaultSwap`, which proves against the v1 Entrypoint's tree AND looks for the spend
 * note in the v1 vault. A v3 depositor holds nothing there, so it scanned a 17-leaf tree for 51
 * seconds and gave up with "0 candidates" — the funds were in the v3 kernel the whole time.
 *
 * Pure and separate so the decision that was wrong is the decision under test.
 */

export type QuickSwapRoute =
  /** Arm through the enclave; it proves at fire time against the v3 kernel. */
  | "v3"
  /** Legacy atomic vault swap — valid only where v3 is not deployed. */
  | "v2-swap"
  /** Legacy same-asset re-shield — also v2-only. */
  | "v2-same-asset"
  /** Nothing sensible to do: asking to swap an asset for itself. */
  | "same-asset-unsupported";

export function quickSwapRoute(sameAsset: boolean, v3StrategiesLive: boolean): QuickSwapRoute {
  if (!sameAsset) return v3StrategiesLive ? "v3" : "v2-swap";
  // The v2 same-asset path mints a vault output note from a v1 withdraw proof. There is no v3
  // equivalent, and running the v2 one on a v3 chain reaches for notes that are not there — the
  // same failure, one branch over. Refuse it in words the user can act on instead.
  return v3StrategiesLive ? "same-asset-unsupported" : "v2-same-asset";
}
