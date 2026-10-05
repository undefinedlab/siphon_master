import styles from "./landing-mocks.module.css";

export function MockStrategyRun() {
  return (
    <div className={styles.frame} aria-hidden="true">
      <div className={styles.frameChrome}>
        <div>
          <span className={styles.frameTitle}>Runs</span>
          <span className={styles.frameChromeMuted}> · Live strategies</span>
        </div>
        <span className={styles.frameChromeMuted}>Activity</span>
      </div>
      <div className={styles.runCard}>
        <div className={styles.runCardTop}>
          <span className={styles.runTitle}>0.5 ETH → USDC</span>
          <span className={`${styles.badge} ${styles.badgeArmed}`}>Armed</span>
        </div>
        <div className={styles.runMeta}>
          <span>twap</span>
          <span>Base</span>
        </div>
      </div>
      <div className={`${styles.runCard} ${styles.runCardDim}`}>
        <div className={styles.runCardTop}>
          <span className={styles.runTitle}>1.2 ETH → USDC</span>
          <span className={`${styles.badge} ${styles.badgePending}`}>Pending</span>
        </div>
        <div className={styles.runMeta}>
          <span>limit order</span>
          <span>Base</span>
        </div>
      </div>
      <div className={`${styles.runCard} ${styles.runCardDim}`}>
        <div className={styles.runCardTop}>
          <span className={styles.runTitle}>0.25 ETH → USDC</span>
          <span className={`${styles.badge} ${styles.badgeExecuted}`}>Executed</span>
        </div>
        <div className={styles.runMeta}>
          <span>dca</span>
          <span>Base</span>
        </div>
      </div>
      <p className={styles.runFoot}>3 live</p>
    </div>
  );
}

export function MockBuilderCanvas() {
  return (
    <div className={`${styles.frame} ${styles.frameCanvas}`} aria-hidden="true">
      <div className={styles.canvasGrid} />
      <div className={styles.nodeStack}>
        <div className={styles.node}>
          <div className={styles.nodeTitle}>Deposit</div>
          <div className={styles.nodeRow}>
            <span className={styles.chip}>0.5</span>
            <span className={styles.chip}>ETH</span>
          </div>
        </div>
        <div className={`${styles.node} ${styles.nodeControl}`}>
          <div className={styles.nodeTitle}>Schedule</div>
          <div className={styles.nodeRow}>
            <span className={styles.chip}>Every</span>
            <span className={styles.chip}>1 day</span>
          </div>
        </div>
        <div className={`${styles.node} ${styles.nodeStrategy}`}>
          <div className={styles.nodeTitle}>Limit Order</div>
          <div className={styles.nodeRow}>
            <span className={styles.chip}>ETH → USDC</span>
          </div>
        </div>
        <div className={styles.node}>
          <div className={styles.nodeTitle}>Withdraw</div>
          <div className={styles.nodeRow}>
            <span className={styles.chip}>Your wallet</span>
          </div>
        </div>
      </div>
      <div className={styles.aiStrip}>
        <p className={styles.aiLabel}>Builder</p>
        <p className={styles.aiBubble}>
          Limit sell 0.5 ETH for USDC, then withdraw to wallet.
        </p>
        <div className={styles.aiComposer}>
          Ask a question or describe your strategy…
        </div>
      </div>
    </div>
  );
}

export function MockWidgetSpace() {
  return (
    <div className={styles.frame} aria-hidden="true">
      <div className={styles.frameChrome}>
        <span>Dashboard</span>
        <span className={styles.customizePill}>Customize dashboard</span>
      </div>
      <div className={styles.widgetGrid}>
        <div className={styles.widget}>
          <p className={styles.widgetEyebrow}>Fear &amp; Greed</p>
          <div className={styles.gaugeRow}>
            <div className={styles.gaugeArc} />
            <p className={styles.widgetValue}>62</p>
          </div>
          <p className={styles.widgetSub}>Greed</p>
        </div>
        <div className={`${styles.widget} ${styles.widgetActive}`}>
          <p className={styles.widgetEyebrow}>Runs</p>
          <p className={styles.widgetValue}>3 live</p>
          <p className={styles.widgetSub}>0.5 ETH → USDC · Armed</p>
        </div>
        <div className={styles.widget}>
          <p className={styles.widgetEyebrow}>Market cap</p>
          <p className={styles.widgetValueSm}>$2.41T</p>
          <p className={styles.widgetSub}>+1.8% 24h</p>
        </div>
        <div className={styles.widget}>
          <p className={styles.widgetEyebrow}>24h volume</p>
          <p className={styles.widgetValueSm}>$84.2B</p>
          <p className={styles.widgetSub}>Crypto total</p>
        </div>
      </div>
    </div>
  );
}

export function MockEncryptedVault() {
  return (
    <div className={styles.frame} aria-hidden="true">
      <div className={styles.vaultCard}>
        <div className={styles.vaultHead}>
          <span className={styles.vaultTitle}>Private Balance</span>
          <span className={styles.networkChip}>Base</span>
        </div>
        <p className={styles.vaultAmount}>
          2.48 <span>ETH</span>
        </p>
        <div className={styles.vaultSecondary}>
          <span>In Review</span>
          <span>0.12 ETH</span>
        </div>
        <p className={styles.vaultNote}>Your private vault balance on Base</p>
      </div>
      <div className={styles.depositCard}>
        <div className={styles.vaultActions}>
          <span className={styles.vaultTabActive}>Deposit</span>
          <span className={styles.vaultTab}>Withdraw</span>
        </div>
        <div className={styles.depositField}>
          <span className={styles.depositPlaceholder}>Amount</span>
          <span className={styles.depositMax}>Max</span>
          <span className={styles.depositToken}>ETH</span>
        </div>
        <div className={styles.depositConfirm}>Confirm</div>
      </div>
    </div>
  );
}

export function MockApiSdk() {
  return (
    <div className={styles.frame} aria-hidden="true">
      <div className={styles.frameChrome}>
        <span className={styles.frameTitle}>SIPHON API</span>
        <span className={styles.comingSoon}>Coming soon</span>
      </div>
      <div className={styles.apiCard}>
        <p className={styles.apiCardTitle}>Prepaid API credit</p>
        <p className={styles.apiCardCopy}>
          Buy credit with USDC, get an <code>sk_…</code> key for the TypeScript
          SDK and MCP tools.
        </p>
        <div className={styles.apiKeyRow}>
          <span className={styles.apiKeyMask}>sk_live · · · · 8f2a</span>
          <span className={styles.apiKeyMeta}>Active</span>
        </div>
        <div className={styles.apiMethods}>
          <span>notes</span>
          <span>deposits</span>
          <span>withdrawals</span>
          <span>strategies</span>
        </div>
        <div className={styles.apiCta}>Pay 25 USDC &amp; generate key</div>
      </div>
    </div>
  );
}
