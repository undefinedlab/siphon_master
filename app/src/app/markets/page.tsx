"use client";

import Nav from "@/components/theme/Nav";
import PrivateMarkets from "@/components/navs/Predictions/PrivateMarkets";
import { useIsAdmin } from "@/lib/adminWallet";

export default function MarketsPage() {
  const isAdmin = useIsAdmin();
  return (
    <div className="markets-page" style={{ minHeight: "100vh", background: "#000" }}>
      {/* Nav is position:fixed globally — render it, then offset content below it. */}
      <Nav />
      {/* Clear the fixed nav (top:15px + ~2em padding + logo height). */}
      <div style={{ width: "100%", paddingTop: "5.5rem" }}>
        {isAdmin ? (
          <PrivateMarkets />
        ) : (
          <div style={{ textAlign: "center", color: "#888", padding: "6rem 1.5rem" }}>
            <h1 style={{ color: "#fff", fontSize: "2rem", marginBottom: "0.75rem" }}>
              Private Markets
            </h1>
            <p style={{ fontSize: "1.1rem" }}>Coming soon.</p>
          </div>
        )}
      </div>
    </div>
  );
}
