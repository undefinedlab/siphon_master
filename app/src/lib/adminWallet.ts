import { useEffect, useState } from "react";
import { resolveWalletAddress } from "@/lib/walletAddress";
import { isAdminWallet } from "@/lib/adminWalletCore";

export { isAdminWallet } from "@/lib/adminWalletCore";

/** Reactive: true only while the connected wallet is on the admin allowlist. */
export function useIsAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    const check = () => setAdmin(isAdminWallet(resolveWalletAddress()));
    check();
    window.addEventListener("walletConnected", check);
    window.addEventListener("walletDisconnected", check);
    return () => {
      window.removeEventListener("walletConnected", check);
      window.removeEventListener("walletDisconnected", check);
    };
  }, []);
  return admin;
}
