import Link from "next/link";
import Nav from "@/components/theme/Nav";
import { CONTACT_EMAIL, EFFECTIVE_DATE, ENTITY } from "@/lib/siteLegal";
import styles from "../legal.module.css";

export const metadata = {
  title: "Terms of Use | Siphon Protocol",
  description: "Terms of use for Siphon Protocol software and services.",
};

export default function TermsPage() {
  return (
    <div className={styles.legalContainer}>
      <Nav />
      <article className={styles.content}>
        <header className={styles.hero}>
          <h1 className={styles.title}>Terms of Use</h1>
          <p className={styles.updated}>Effective {EFFECTIVE_DATE}</p>
        </header>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>1. Agreement &amp; binding effect</h2>
          <p className={styles.paragraph}>
            These Terms of Use (&quot;Terms&quot;) are a legally binding agreement between you
            (&quot;you,&quot; &quot;User&quot;) and {ENTITY} (&quot;Siphon,&quot; &quot;Company,&quot;
            &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) governing access to and use of the
            Siphon Protocol website, dapp, smart contracts, APIs, documentation, open-source
            components, and related software (collectively, the &quot;Services&quot;). By accessing,
            connecting a wallet to, or otherwise using the Services, you acknowledge that you have
            read, understood, and agree to be bound by these Terms and our Privacy Policy. If you do
            not agree, you must not access or use the Services.
          </p>
          <p className={styles.paragraph}>
            If you use the Services on behalf of an entity, you represent that you have authority to
            bind that entity, and &quot;you&quot; includes that entity.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>2. Nature of the Services</h2>
          <p className={styles.paragraph}>
            Siphon provides non-custodial software for private DeFi execution, including encrypted
            vault deposits, visual strategy composition, homomorphically encrypted trigger evaluation,
            and zero-knowledge withdrawals. The Services are software tools only. Siphon does not
            hold, control, or have access to your private keys, seed phrases, or on-chain assets.
            We are not a broker, dealer, exchange, custodian, money transmitter, investment adviser,
            fiduciary, trustee, or agent for you. No agency, partnership, joint venture, or
            employment relationship is created between you and Siphon by your use of the Services.
          </p>
          <p className={styles.paragraph}>
            The Services may include beta, early-access, or experimental features. Functionality,
            supported chains, tokens, fees, and availability may change, degrade, or be discontinued
            at any time without notice. We make no commitment to maintain, support, or continue any
            feature, integration, or network.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>3. No professional advice; no reliance</h2>
          <p className={styles.paragraph}>
            Nothing in the Services — including UI copy, documentation, examples, AI-generated
            content, community materials, or communications from us — constitutes financial,
            investment, trading, legal, tax, accounting, or other professional advice. You must not
            rely on the Services for any decision to buy, sell, hold, or transfer digital assets.
            You are solely responsible for your own due diligence and for obtaining independent
            professional advice.
          </p>
          <p className={styles.paragraph}>
            You acknowledge that you are not entering into these Terms in reliance upon any promise,
            representation, or warranty not expressly set forth herein.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>4. Assumption of risk &amp; release</h2>
          <p className={styles.paragraph}>
            YOU EXPRESSLY ACKNOWLEDGE AND AGREE THAT YOUR USE OF THE SERVICES AND ANY ON-CHAIN OR
            OFF-CHAIN ACTIVITY INITIATED THROUGH THEM IS AT YOUR SOLE RISK. Blockchain,
            cryptocurrency, smart contract, FHE, ZK, oracle, and privacy technologies involve
            substantial and inherent risks, including but not limited to:
          </p>
          <ul className={styles.list}>
            <li>Total or partial loss of digital assets</li>
            <li>Smart contract bugs, exploits, hacks, and irreversible transactions</li>
            <li>Network congestion, forks, outages, reorgs, and validator failures</li>
            <li>Regulatory actions, sanctions, enforcement, and loss of access</li>
            <li>User error, lost keys, phishing, malware, and wallet compromise</li>
            <li>Third-party protocol, bridge, oracle, DEX, RPC, or liquidity failures</li>
            <li>Encryption, proving, TEE, or runtime errors affecting execution or privacy</li>
            <li>Front-running, MEV, slippage, and adverse market movements</li>
            <li>Tax, reporting, and compliance obligations in your jurisdiction</li>
          </ul>
          <p className={styles.paragraph}>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, YOU VOLUNTARILY ASSUME ALL SUCH RISKS AND
            RELEASE, WAIVE, AND DISCHARGE SIPHON AND ITS AFFILIATES, OFFICERS, DIRECTORS,
            EMPLOYEES, CONTRACTORS, AGENTS, AND LICENSORS FROM ANY AND ALL CLAIMS, DEMANDS,
            DAMAGES, LOSSES, LIABILITIES, AND CAUSES OF ACTION (INCLUDING NEGLIGENCE) ARISING OUT OF
            OR RELATED TO THE SERVICES, YOUR USE OF THEM, OR ANY DIGITAL ASSET TRANSACTION.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>5. No privacy or security guarantees</h2>
          <p className={styles.paragraph}>
            While the Services are designed to enhance privacy, no system guarantees complete
            anonymity, confidentiality, or unlinkability. Implementation defects, user misconfiguration,
            metadata leakage, chain analysis, optional TEE paths, or third-party behavior may reduce
            privacy in practice. Siphon makes no warranty that your activity will remain private,
            untraceable, or free from surveillance.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>6. Fees &amp; taxes</h2>
          <p className={styles.paragraph}>
            Certain features require on-chain execution or monitoring fees, payable as displayed in
            the interface. All fees are non-refundable once submitted on-chain. You are solely
            responsible for network gas, third-party charges, and all tax obligations arising from
            your use of the Services.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>7. Prohibited conduct</h2>
          <p className={styles.paragraph}>You agree not to:</p>
          <ul className={styles.list}>
            <li>Use the Services in violation of any applicable law, regulation, or sanctions program</li>
            <li>Use the Services for money laundering, terrorist financing, fraud, or illicit activity</li>
            <li>Attempt to exploit, attack, reverse engineer, or interfere with the Services</li>
            <li>Circumvent access controls, rate limits, or security measures</li>
            <li>Submit malicious code, false data, or content that infringes third-party rights</li>
            <li>Use the Services if you are a prohibited or sanctioned person or entity</li>
          </ul>
          <p className={styles.paragraph}>
            We may investigate violations and cooperate with law enforcement. We may block wallet
            addresses, restrict access, or terminate use at our sole discretion, with or without
            notice.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>8. Intellectual property</h2>
          <p className={styles.paragraph}>
            The Services, including all software, branding, documentation, and content (excluding
            open-source components under their own licenses), are owned by Siphon or its licensors
            and protected by intellectual property laws. No rights are granted except the limited,
            revocable, non-exclusive, non-transferable right to use the Services in accordance with
            these Terms. You may not copy, modify, distribute, sell, or create derivative works
            from the Services except as permitted by applicable open-source licenses.
          </p>
          <p className={styles.paragraph}>
            If you provide feedback or suggestions, you grant Siphon a perpetual, irrevocable,
            worldwide, royalty-free license to use them without obligation to you.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>9. Third-party services</h2>
          <p className={styles.paragraph}>
            The Services integrate with or link to third-party wallets, RPC providers, blockchains,
            DEXs, oracles, cloud infrastructure, and data sources. Siphon does not control and
            expressly disclaims all responsibility for third-party services, their availability,
            security, or terms. Your use of third-party services is at your sole risk.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>10. Disclaimer of warranties</h2>
          <p className={`${styles.paragraph} ${styles.caps}`}>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICES ARE PROVIDED ON AN
            &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; BASIS WITHOUT WARRANTIES OF ANY KIND,
            WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING WITHOUT LIMITATION ANY
            IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE,
            NON-INFRINGEMENT, ACCURACY, AVAILABILITY, SECURITY, QUIET ENJOYMENT, OR THAT THE
            SERVICES WILL MEET YOUR REQUIREMENTS OR PRODUCE ANY PARTICULAR RESULT. WE DO NOT
            WARRANT THAT THE SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF
            HARMFUL COMPONENTS, OR THAT DEFECTS WILL BE CORRECTED.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>11. Limitation of liability</h2>
          <p className={`${styles.paragraph} ${styles.caps}`}>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL SIPHON OR ITS
            AFFILIATES, OFFICERS, DIRECTORS, EMPLOYEES, CONTRACTORS, AGENTS, OR LICENSORS BE
            LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE
            DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL, REPUTATION, OR DIGITAL
            ASSETS, ARISING OUT OF OR RELATED TO THE SERVICES OR THESE TERMS, WHETHER BASED IN
            CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR ANY OTHER THEORY, EVEN IF
            WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. SOME JURISDICTIONS DO NOT
            ALLOW CERTAIN LIMITATIONS; IN SUCH CASES, OUR LIABILITY IS LIMITED TO THE MAXIMUM
            EXTENT PERMITTED BY LAW.
          </p>
          <p className={`${styles.paragraph} ${styles.caps}`}>
            OUR AGGREGATE LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THE SERVICES OR
            THESE TERMS SHALL NOT EXCEED THE GREATER OF (A) ONE HUNDRED U.S. DOLLARS (US$100) OR
            (B) THE TOTAL FEES YOU PAID DIRECTLY TO SIPHON FOR THE SERVICES IN THE TWELVE (12)
            MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>12. Indemnification</h2>
          <p className={styles.paragraph}>
            You agree to defend, indemnify, and hold harmless Siphon and its affiliates, officers,
            directors, employees, contractors, agents, and licensors from and against any and all
            third-party claims, demands, actions, damages, losses, liabilities, costs, and expenses
            (including reasonable attorneys&apos; fees and court costs) arising out of or related to:
            (a) your use of the Services; (b) your digital asset transactions; (c) your violation of
            these Terms; (d) your violation of applicable law or third-party rights; or (e) any
            content or data you submit. Siphon may assume exclusive defense and control of any
            matter subject to indemnification at your expense, and you agree to cooperate.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>13. Eligibility &amp; compliance</h2>
          <p className={styles.paragraph}>
            You represent and warrant that you are at least 18 years old, have legal capacity to
            enter into these Terms, and are not located in, ordinarily resident in, or a citizen
            of any jurisdiction where use of the Services is prohibited. You will comply with all
            applicable laws, including export control and sanctions laws. You are solely responsible
            for determining whether your use of the Services is lawful in your jurisdiction.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>14. Dispute resolution; arbitration; class waiver</h2>
          <p className={styles.paragraph}>
            Any dispute, claim, or controversy arising out of or relating to these Terms or the
            Services (&quot;Dispute&quot;) shall be resolved by binding arbitration administered by
            the American Arbitration Association (&quot;AAA&quot;) under its Commercial Arbitration
            Rules, except that either party may seek injunctive relief in court for intellectual
            property or unauthorized access. The arbitration shall take place in Wilmington,
            Delaware, USA, in English, before a single arbitrator. Judgment on the award may be
            entered in any court of competent jurisdiction.
          </p>
          <p className={`${styles.paragraph} ${styles.caps}`}>
            YOU AND SIPHON AGREE THAT EACH MAY BRING CLAIMS AGAINST THE OTHER ONLY IN YOUR OR ITS
            INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS,
            COLLECTIVE, CONSOLIDATED, OR REPRESENTATIVE PROCEEDING. THE ARBITRATOR MAY NOT
            CONSOLIDATE PROCEEDINGS OR PRESIDE OVER ANY FORM OF CLASS OR REPRESENTATIVE ACTION.
          </p>
          <p className={styles.paragraph}>
            You waive any right to a jury trial for Disputes covered by this section to the maximum
            extent permitted by law.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>15. Governing law</h2>
          <p className={styles.paragraph}>
            These Terms are governed by the laws of the State of Delaware, United States, without
            regard to conflict-of-law principles, except that the Federal Arbitration Act governs
            Section 14. For matters not subject to arbitration, you consent to the exclusive
            jurisdiction of the state and federal courts located in Delaware.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>16. Changes, suspension &amp; termination</h2>
          <p className={styles.paragraph}>
            We may modify, suspend, or discontinue the Services or these Terms at any time. Material
            changes may be posted on the website; continued use after the effective date constitutes
            acceptance. We may terminate or restrict your access at any time, for any reason or no
            reason, with or without notice. Upon termination, Sections intended to survive will
            survive, including disclaimers, limitations of liability, indemnification, dispute
            resolution, and governing law.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>17. Force majeure</h2>
          <p className={styles.paragraph}>
            Siphon shall not be liable for any failure or delay resulting from events beyond our
            reasonable control, including acts of God, war, terrorism, labor disputes, internet or
            utility failures, blockchain network failures, regulatory actions, or third-party service
            outages.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>18. Assignment; severability; waiver; entire agreement</h2>
          <p className={styles.paragraph}>
            You may not assign these Terms without our prior written consent. We may assign these
            Terms freely. If any provision is held invalid or unenforceable, the remaining provisions
            remain in effect. Our failure to enforce any provision is not a waiver. These Terms,
            together with the Privacy Policy, constitute the entire agreement between you and Siphon
            regarding the Services and supersede all prior agreements and understandings.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>19. Contact</h2>
          <p className={styles.paragraph}>
            Questions regarding these Terms may be directed to{" "}
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
