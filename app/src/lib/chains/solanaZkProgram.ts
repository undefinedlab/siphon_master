/**
 * The deployed siphon-vault-zk program (Solana Devnet). Shared by the browser client
 * (solanaVaultZk.ts) and server checks (aspRootFreshness.ts) so neither drifts.
 *
 * `NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID` still overrides it; the default exists so siphon.money/solana
 * works on the main Amplify build without new public env vars, and so an unset variable lands on the
 * ZK vault rather than the retired scaffold-verify program.
 */
/** Live Solana Devnet ZK vault (BktHH… — own deployer + JitoSOL allowlist; replaces 9W7Xn…). */
export const SOLANA_DEVNET_ZK_PROGRAM_ID = "BktHHQ8KJpfnwLNMEqnh9uANEyuFa1qYtbhzHwCKMEDe";

export function solanaZkProgramId(): string {
  return (process.env.NEXT_PUBLIC_SIPHON_SOLANA_PROGRAM_ID || "").trim() || SOLANA_DEVNET_ZK_PROGRAM_ID;
}
