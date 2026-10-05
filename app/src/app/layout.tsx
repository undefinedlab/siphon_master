import type { Metadata } from "next";
import { Source_Code_Pro } from "next/font/google";
import { ROBOTS_DIRECTIVES } from "@/lib/botProtection";
import { AppProviders } from "./providers";
import "./globals.css";

// Avoid SSG worker hangs on Railway (external font/RPC during "Generating static pages").
export const dynamic = "force-dynamic";

const sourceCode = Source_Code_Pro({
  variable: "--font-source-code",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Siphon Protocol - Fully Encrypted DeFi Execution Layer",
  description: "Execute DeFi strategies on-demand in a fully encrypted manner. Run arbitrage, yield farming, liquidity mining, and grid trading privately. Your trades remain invisible to MEV bots and front-runners.",
  keywords: ["DeFi", "encrypted execution", "privacy", "strategy execution", "MEV protection", "blockchain", "cryptocurrency"],
  authors: [{ name: "Siphon Protocol" }],
  robots: {
    index: false,
    follow: false,
    nocache: true,
    noarchive: true,
    nosnippet: true,
    noimageindex: true,
    notranslate: true,
    googleBot: {
      index: false,
      follow: false,
      noarchive: true,
      nosnippet: true,
      noimageindex: true,
      notranslate: true,
      "max-video-preview": -1,
      "max-image-preview": "none",
      "max-snippet": -1,
    },
  },
  other: {
    robots: ROBOTS_DIRECTIVES,
  },
  openGraph: {
    title: "Siphon Protocol - Fully Encrypted DeFi Execution Layer",
    description: "Execute DeFi strategies on-demand in a fully encrypted manner. Your trades remain invisible to MEV bots and front-runners.",
    type: "website",
    siteName: "Siphon Protocol",
  },
  twitter: {
    card: "summary_large_image",
    title: "Siphon Protocol - Fully Encrypted DeFi Execution Layer",
    description: "Execute DeFi strategies on-demand in a fully encrypted manner. Your trades remain invisible to MEV bots and front-runners.",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${sourceCode.variable} antialiased`}>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
