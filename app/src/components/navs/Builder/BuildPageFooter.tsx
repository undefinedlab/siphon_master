"use client";

import Link from "next/link";

const INTERNAL_LINKS = [
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
] as const;

const DOCS_URL = "https://docs.siphon.money";
const SUPPORT_URL = "https://t.me/SiphonSupportBot";

export default function BuildPageFooter() {
  return (
    <footer className="build-page-footer" aria-label="Site links">
      <nav className="build-page-footer-nav">
        {INTERNAL_LINKS.map((link) => (
          <Link key={link.label} href={link.href} className="build-page-footer-link">
            {link.label}
          </Link>
        ))}
        <a
          href={DOCS_URL}
          className="build-page-footer-link"
          target="_blank"
          rel="noopener noreferrer"
        >
          Docs
        </a>
        <a
          href={SUPPORT_URL}
          className="build-page-footer-link"
          target="_blank"
          rel="noopener noreferrer"
        >
          Support
        </a>
      </nav>
    </footer>
  );
}
