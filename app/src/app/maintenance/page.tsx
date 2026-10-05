export const metadata = { title: "Siphon — Under Maintenance" };

export default function Maintenance() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", letterSpacing: "0.05em" }}>
        UNDER MAINTENANCE
      </h1>
      <p style={{ opacity: 0.7, maxWidth: "36rem" }}>
        We&apos;re upgrading our infrastructure for faster confidential
        transactions. Deposits, withdrawals, and trading are temporarily
        disabled. Your funds are safe and untouched on-chain.
      </p>
      <p style={{ opacity: 0.5, fontSize: "0.85rem" }}>
        Back shortly — check back soon.
      </p>
    </main>
  );
}
