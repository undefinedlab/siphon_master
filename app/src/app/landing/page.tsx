"use client";

import Link from "next/link";
import Nav from "@/components/theme/Nav";
import ThreeEffect from "@/components/theme/ThreeEffect";
import EcosystemOrbits from "@/components/theme/EcosystemOrbits";
import {
  MockApiSdk,
  MockBuilderCanvas,
  MockEncryptedVault,
  MockStrategyRun,
  MockWidgetSpace,
} from "@/components/theme/LandingMocks";
import { CONTACT_EMAIL, ENTITY } from "@/lib/siteLegal";
import { PartnerLogo } from "@/components/theme/PartnerLogo";
import styles from "../hero.module.css";
import landingStyles from "../landing.module.css";

const HACKATHON_WINS = [
  {
    partner: "protocollabs",
    event: "PL Genesis · Protocol Labs",
    detail: "Best Next Gen AI App · Lit Protocol",
  },
  {
    partner: "ethglobal",
    event: "HackMoney 2026 · ETH Global",
    detail: "Stablecoin Payment Systems · Circle",
  },
  {
    partner: "solana",
    event: "Solana Privacy Hackathon",
    detail: "Honorable Mention · QuickNode",
  },
  {
    partner: "zama",
    event: "Zama Builders Program",
    detail: "Pre-Mainnet Cohort · FHE Privacy",
  },
  {
    partner: "ethglobal",
    event: "ETH Global Buenos Aires",
    detail: "AI Decentralized Application · 0G",
  },
  {
    partner: "polkadot",
    event: "Polkadot Sub0 2025",
    detail: "Crosschain Intents · Hyperbridge",
  },
  {
    partner: "ethglobal",
    event: "ETH Online 2025",
    detail: "Overall Finalist · 700 teams",
  },
  {
    partner: "1inch",
    event: "Unite DeFi · ETH Global",
    detail: "Best DeFi Consumer App · 1inch",
  },
  {
    partner: "ethereum",
    event: "ETH Cannes 2025",
    detail: "ZK Privacy · Ethereum Foundation",
  },
  {
    partner: "layerzero",
    event: "ETH Prague 2025",
    detail: "Crosschain Communication · LayerZero",
  },
  {
    partner: "ethglobal",
    event: "ETH Global Bangkok",
    detail: "Blockchain Tools · Blockscout",
  },
] as const;

export default function Home() {
  return (
    <div className={landingStyles.landingPage}>
      <Nav />
      {/* Hero section with ThreeEffect */}
      <div className={landingStyles.heroSection}>
        <div className={`${styles.heroContainer} ${styles.landingHero}`}>
          <h1 className={styles.heroTagline}>
           The fully encrypted execution layer for on-chain finance
          </h1>
          <p className={styles.heroSubtitle}>
            Private vaults, strategies builder, and sealed execution.
          </p>
        </div>
        <ThreeEffect />
      </div>

      <div className={landingStyles.awardsBand} aria-label="Hackathon wins">
        <p className={landingStyles.awardsLabel}>Recognized at</p>
        <div className={landingStyles.marquee}>
          <div className={landingStyles.marqueeTrack}>
            {[0, 1].map((copy) => (
              <div className={landingStyles.marqueeGroup} key={copy} aria-hidden={copy === 1}>
                {HACKATHON_WINS.map((win) => (
                  <div className={landingStyles.marqueeItem} key={`${copy}-${win.event}`}>
                    <PartnerLogo
                      partner={win.partner}
                      className={landingStyles.marqueeLogo}
                    />
                    <div className={landingStyles.marqueeText}>
                      <span className={landingStyles.marqueeEvent}>{win.event}</span>
                      <span className={landingStyles.marqueeDetail}>{win.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {/* Scrollable Content Sections */}
      <div className={landingStyles.contentSections}>
        <section className={`${landingStyles.contentSection} ${landingStyles.problemSection}`}>
          <h2 className={landingStyles.problemTitle}>
            On-chain finance is public by default —
            and that costs you.
          </h2>
          <p className={landingStyles.problemLead}>
            Intent, size, and strategy logic sit in the open for front-runners,
            MEV bots, and anyone watching the chain. Siphon closes that gap.
          </p>
        </section>

        <section className={landingStyles.contentSection}>
          <div className={landingStyles.sectionRow}>
            <div className={landingStyles.sectionCopy}>
              <p className={landingStyles.sectionMiniTitle}>Sealed execution</p>
              <h2 className={landingStyles.sectionTitle}>On-Demand Strategy</h2>
              <p className={landingStyles.sectionDescription}>
                Arm limits, stops, TWAP, and DCA loops in one place. Strategies
                stay encrypted until they fire — then execute without broadcasting
                your edge to the mempool.
              </p>
              <ul className={landingStyles.sectionPoints}>
                <li>Connect, fund the vault, and run — no long setup</li>
                <li>Live status for Armed, Pending, and Executed runs</li>
                <li>Trigger bounds stay sealed with FHE until you authorize</li>
              </ul>
            </div>
            <div className={landingStyles.sectionVisual}>
              <MockStrategyRun />
            </div>
          </div>
        </section>

        <section className={landingStyles.contentSection}>
          <div className={`${landingStyles.sectionRow} ${landingStyles.sectionRowReverse}`}>
            <div className={landingStyles.sectionCopy}>
              <p className={landingStyles.sectionMiniTitle}>AI + visual builder</p>
              <h2 className={landingStyles.sectionTitle}>Build and Deploy</h2>
              <p className={landingStyles.sectionDescription}>
                Compose flows on a visual canvas — Deposit, Schedule, Swap,
                Withdraw — or describe the strategy to the AI Builder and get a
                graph you can smoke-test, then pay and run.
              </p>
              <ul className={landingStyles.sectionPoints}>
                <li>Natural-language AI that maps prompts to valid blocks</li>
                <li>Chain swaps, loops, and schedules into sealed workflows</li>
                <li>Keep strategies private or share what you choose</li>
              </ul>
            </div>
            <div className={landingStyles.sectionVisual}>
              <MockBuilderCanvas />
            </div>
          </div>
        </section>

        <section className={landingStyles.contentSection}>
          <div className={landingStyles.sectionRow}>
            <div className={landingStyles.sectionCopy}>
              <p className={landingStyles.sectionMiniTitle}>Your workspace</p>
              <h2 className={landingStyles.sectionTitle}>Make it yours</h2>
              <p className={landingStyles.sectionDescription}>
                Your dashboard is a workspace, not a fixed screen. Arrange widget
                tiles for vault balance, live strategies, markets, and tools —
                then customize the layout until it matches how you trade.
              </p>
              <ul className={landingStyles.sectionPoints}>
                <li>Drag-ready widget grid with glass panels from the dapp</li>
                <li>Add market intel, runs, swaps, and more from the library</li>
                <li>AI assistant sits beside your space for quick strategy drafts</li>
              </ul>
            </div>
            <div className={landingStyles.sectionVisual}>
              <MockWidgetSpace />
            </div>
          </div>
        </section>

        <section className={landingStyles.contentSection}>
          <div className={`${landingStyles.sectionRow} ${landingStyles.sectionRowReverse}`}>
            <div className={landingStyles.sectionCopy}>
              <p className={landingStyles.sectionMiniTitle}>Privacy stack</p>
              <h2 className={landingStyles.sectionTitle}>Fully Encrypted</h2>
              <p className={landingStyles.sectionDescription}>
                Deposit into a privacy vault backed by ZK commitments. Strategy
                parameters never leave your browser in plaintext. Withdraw and
                spend with proofs — not public ledger trails.
              </p>
              <ul className={landingStyles.sectionPoints}>
                <li>Private balance only you can spend</li>
                <li>FHE-encrypted trigger comparison against live oracles</li>
                <li>ZK withdraws that break the link between deposit and exit</li>
              </ul>
            </div>
            <div className={landingStyles.sectionVisual}>
              <MockEncryptedVault />
            </div>
          </div>
        </section>

        <section className={landingStyles.contentSection}>
          <div className={landingStyles.sectionRow}>
            <div className={landingStyles.sectionCopy}>
              <p className={landingStyles.sectionMiniTitle}>Developer access</p>
              <h2 className={landingStyles.sectionTitle}>API &amp; SDK</h2>
              <p className={landingStyles.sectionDescription}>
                Programmatic access to Siphon — private notes, deposits,
                withdrawals, and sealed strategies from your own code,
                authenticated with a prepaid API key.
              </p>
              <ul className={landingStyles.sectionPoints}>
                <li>TypeScript SDK with notes, strategies, and fees</li>
                <li>MCP tools for agents over the same /v1 surface</li>
                <li>Prepaid sk_ keys — coming soon to the dashboard</li>
              </ul>
            </div>
            <div className={landingStyles.sectionVisual}>
              <MockApiSdk />
            </div>
          </div>
        </section>
        
        <section className={landingStyles.contentSection}>
          <div className={`${landingStyles.sectionContent} ${landingStyles.alignCenter}`}>
            <EcosystemOrbits 
              chains={['Solana', 'Ethereum', 'Base', 'Bitcoin', 'Polygon', 'Arbitrum']}
              protocols={['Jupiter', 'Uniswap', 'Raydium', 'Orca', '1inch', 'Curve']}
            />
            <h2 className={landingStyles.ecosystemTitle}>An ecosystem of chains and protocols</h2>
          </div>
        </section>
      </div>

      <div className={landingStyles.siteFooter} role="contentinfo" aria-label="Site footer">
        <div className={landingStyles.siteFooterInner}>
          <div className={landingStyles.footerTop}>
            <div className={landingStyles.footerBrand}>
              <div className={landingStyles.footerBrandMark}>
                <svg width="22" height="18" viewBox="0 0 97.34 80" aria-hidden="true">
                  <path
                    d="M70.66,35.93a11.66,11.66,0,0,1,1,.83c1.84,1.89,3.69,3.78,5.5,5.7,2.24,2.35,2.14,1.66-.06,3.9-4.47,4.53-9,9-13.49,13.49-1,1-1,1.09-.16,1.95q7.47,7.5,15,15c.85.85,1,.85,1.83,0q7.5-7.47,15-15c.84-.85.83-1,0-1.84-1.58-1.61-3.2-3.2-4.8-4.8l-9.72-9.73c-1.05-1-1-1.07,0-2.14.07-.08.15-.15.23-.23L92.22,32c1.5-1.47,3-2.94,4.49-4.43.86-.87.84-.9,0-1.81-.14-.16-.3-.3-.46-.46L81.59,10.63Q76.67,5.71,71.75.8c-1.07-1.07-1.09-1.07-2.17,0L64.82,5.66,37.45,33.19q-5.19,5.22-10.38,10.43c-.88.88-.9.87-1.77,0S23.83,42,23.08,41.26c-1.46-1.5-2.95-3-4.41-4.5-1.05-1.1-1-1.11,0-2.16l.23-.23Q25.94,27.28,33,20.19c1.08-1.08,1.09-1.08,0-2.16q-4.27-4.31-8.56-8.59c-2.06-2.06-4.11-4.13-6.18-6.17-.94-.93-1-.91-1.95,0-.2.18-.39.37-.58.56q-6.52,6.53-13,13c-.46.46-.92.91-1.36,1.38-.74.81-.73.88,0,1.73.18.2.37.38.56.57l8.81,8.81c1.83,1.83,3.64,3.67,5.49,5.49.54.52.62.95,0,1.46-.33.28-.62.61-.92.91L.85,51.75a3.65,3.65,0,0,0-.76.82,1.43,1.43,0,0,0,0,1c.1.28.42.48.64.71q12,12.45,24.05,24.89c1.1,1.14,1.11,1.14,2.28,0l29.48-29.3,13.2-13.1C70,36.47,70.3,36.24,70.66,35.93Z"
                    fill="currentColor"
                  />
                </svg>
                <span>Siphon Protocol</span>
              </div>
              <p className={landingStyles.footerTagline}>
                Fully encrypted on-chain execution.
              </p>
             
            </div>

            <div className={landingStyles.footerCol}>
              <p className={landingStyles.footerColTitle}>Product</p>
              <div className={landingStyles.footerNav}>
                <Link href="/">Dapp</Link>
                <a href="https://docs.siphon.money" target="_blank" rel="noopener noreferrer">
                  Docs
                </a>
              </div>
            </div>

            <div className={landingStyles.footerCol}>
              <p className={landingStyles.footerColTitle}>Legal</p>
              <div className={landingStyles.footerNav}>
                <Link href="/terms">Terms</Link>
                <Link href="/privacy">Privacy</Link>
              </div>
            </div>

            <div className={landingStyles.footerCol}>
              <p className={landingStyles.footerColTitle}>Contact</p>
              <div className={landingStyles.footerNav}>
                <a href={`mailto:${CONTACT_EMAIL}`}>Email</a>
                <a
                  href="https://t.me/SiphonSupportBot"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Support
                </a>
                <a
                  href="https://twitter.com/SiphonMoney"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Twitter
                </a>
              </div>
            </div>
          </div>

          <div className={landingStyles.footerBottom}>
            <p className={landingStyles.footerCopyright}>
              © {new Date().getFullYear()} {ENTITY} All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
