/**
 * Admin-wallet UI gate — NOT an authorization control.
 *
 * NEXT_PUBLIC_ADMIN_WALLETS is compiled into the client bundle by design so the
 * network toggle can hide admin-only chains. Treat the list as public:
 * - Never use isAdminWallet() as the sole gate for privileged server actions.
 * - On-chain roles / ASP postman / executor flags must enforce real auth.
 * - Disclosure is acceptable for UX; phishing risk is acknowledged.
 */
const ADMIN_WALLETS = new Set(
  (process.env.NEXT_PUBLIC_ADMIN_WALLETS ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean),
);

/** True if address appears in the public admin allowlist (UI-only). */
export function isAdminWallet(address: string | null | undefined): boolean {
  return !!address && ADMIN_WALLETS.has(address.toLowerCase());
}

/** Count of configured admin addresses (does not leak the list). */
export function adminWalletAllowlistSize(): number {
  return ADMIN_WALLETS.size;
}
