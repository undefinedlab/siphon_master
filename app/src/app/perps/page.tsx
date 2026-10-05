"use client";

import Nav from "@/components/theme/Nav";
import PrivatePerps from "@/components/navs/Perps/PrivatePerps";

export default function PerpsPage() {
  return (
    <div className="perps-page" style={{ minHeight: "100vh", background: "#000" }}>
      <Nav />
      <div style={{ width: "100%", paddingTop: "5.5rem" }}>
        <PrivatePerps />
      </div>
    </div>
  );
}
