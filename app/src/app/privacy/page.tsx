import Link from "next/link";
import Nav from "@/components/theme/Nav";
import { CONTACT_EMAIL, EFFECTIVE_DATE, ENTITY } from "@/lib/siteLegal";
import styles from "../legal.module.css";

export const metadata = {
  title: "Privacy Policy | Siphon Protocol",
  description: "Privacy policy for Siphon Protocol software and services.",
};

export default function PrivacyPage() {
  return (
    <div className={styles.legalContainer}>
      <Nav />
      <article className={styles.content}>
        <header className={styles.hero}>
          <h1 className={styles.title}>Privacy Policy</h1>
          <p className={styles.updated}>Effective {EFFECTIVE_DATE}</p>
        </header>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>1. Overview</h2>
          <p className={styles.paragraph}>
            This Privacy Policy describes how {ENTITY} (&quot;Siphon,&quot; &quot;we,&quot;
            &quot;us,&quot; or &quot;our&quot;) handles information when you use our website, dapp,
            APIs, and related software (the &quot;Services&quot;). Siphon is designed around
            self-custody and cryptographic privacy. By using the Services, you acknowledge this
            Policy.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>2. Self-custody &amp; public blockchains</h2>
          <p className={styles.paragraph}>
            Siphon does not operate a custodial wallet. When you connect a wallet, you interact
            directly with blockchain networks. Deposits, withdrawals, and fees produce on-chain
            records that are public by design and may be permanently visible, indexed, and analyzed
            by third parties. We cannot delete or modify data once published to a blockchain.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>3. What stays private by design</h2>
          <p className={styles.paragraph}>
            Siphon&apos;s architecture is built to keep sensitive strategy data off-chain and
            encrypted:
          </p>
          <ul className={styles.list}>
            <li>
              Strategy trigger prices and bounds are encrypted with FHE in your browser before
              submission
            </li>
            <li>
              Your FHE client secret key is derived locally and, in the default configuration, is
              not transmitted to our servers
            </li>
            <li>
              Vault note secrets (nullifier, preimage) are encrypted before sync to the trade
              executor
            </li>
            <li>
              Zero-knowledge withdrawals are designed to break the link between which deposit was
              spent
            </li>
          </ul>
          <p className={styles.paragraph}>
            No privacy system is perfect. Implementation bugs, user error, optional TEE paths, or
            metadata leakage may reduce privacy in practice.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>4. Information we process</h2>
          <p className={styles.paragraph}>
            We aim to minimize collection. Depending on how you use the Services, we or our
            infrastructure providers may process:
          </p>
          <ul className={styles.list}>
            <li>Wallet addresses you connect or submit in the interface</li>
            <li>On-chain transaction and interaction data (already public on-chain)</li>
            <li>
              Encrypted strategy payloads, encrypted note metadata, and execution scheduling data
              stored by the trade executor
            </li>
            <li>
              Wallet signatures used to authenticate API requests or derive encryption keys (we do not
              receive your private keys)
            </li>
            <li>
              Browser local storage for interface preferences, cached wallet state, and locally
              stored notes
            </li>
            <li>
              Technical logs such as IP address, browser type, request timestamps, and error reports
            </li>
            <li>Communications you send to us (e.g., email to {CONTACT_EMAIL})</li>
          </ul>
          <p className={styles.paragraph}>
            We do not require account registration, legal name, or government identification to use
            the core dapp.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>5. How information is used</h2>
          <p className={styles.paragraph}>We use information to:</p>
          <ul className={styles.list}>
            <li>Operate, maintain, and improve the Services</li>
            <li>Store encrypted strategies, schedule execution, and route oracle price checks</li>
            <li>Authenticate wallet-bound API requests</li>
            <li>Monitor security, abuse, and system performance</li>
            <li>Comply with applicable law and enforce our Terms</li>
            <li>Respond to inquiries you initiate</li>
          </ul>
          <p className={styles.paragraph}>
            We do not sell your personal information. We do not use the Services to offer targeted
            advertising based on cross-site profiling.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>6. Third-party providers</h2>
          <p className={styles.paragraph}>
            The Services rely on third parties such as RPC nodes, Pyth oracles, DEX protocols,
            cloud infrastructure, wallet extensions, and blockchain networks. Those parties may
            process information according to their own policies. Siphon is not responsible for
            third-party privacy practices.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>7. Cookies &amp; local storage</h2>
          <p className={styles.paragraph}>
            We use browser storage to remember interface preferences, wallet connection state, and
            locally cached cryptographic material needed for the dapp to function. You can clear site
            data through your browser settings. Disabling storage may limit functionality.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>8. Retention</h2>
          <p className={styles.paragraph}>
            We retain server-side information only as long as reasonably necessary for the purposes
            described above, unless a longer period is required by law. Encrypted strategy records
            may persist until you delete them or they expire per product rules. On-chain data cannot
            be deleted by Siphon.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>9. Security</h2>
          <p className={styles.paragraph}>
            We implement reasonable measures appropriate for a cryptographic DeFi platform, but no
            method of transmission or storage is completely secure. You use the Services at your own
            risk and are responsible for securing your wallet and device.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>10. International users</h2>
          <p className={styles.paragraph}>
            The Services may be operated from the United States. If you access the Services from
            other regions, you understand that information may be processed in jurisdictions that may
            not provide the same level of data protection as your home country.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>11. Children</h2>
          <p className={styles.paragraph}>
            The Services are not directed to individuals under 18. We do not knowingly collect
            information from children. If you believe a child has provided information to us, contact
            us and we will take reasonable steps to delete it where permitted.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>12. Changes</h2>
          <p className={styles.paragraph}>
            We may update this Policy at any time. The &quot;Effective&quot; date above will reflect
            the latest revision. Continued use after changes constitutes acceptance.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>13. Contact</h2>
          <p className={styles.paragraph}>
            Privacy questions may be directed to{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className={styles.inlineLink}>
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>

        <Link href="/" className={styles.backLink}>
          ← Back to app
        </Link>
      </article>
    </div>
  );
}
