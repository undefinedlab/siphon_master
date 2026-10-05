"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SIPHON_LOGO_PATH } from "@/components/theme/GlitchLogo";
import { EFFECTIVE_DATE, ENTITY } from "@/lib/siteLegal";
import styles from "./onboarding.module.css";

const OVERLAY_FADE_MS = 600;
const SCREEN_FADE_MS = 380;
const SWIPE_THRESHOLD_PX = 52;
const NUDGE_MS = 700;

const WHAT_POINTS = [
  "Your balances and trades stay out of public view. Watchers can’t follow your hand.",
  "Swap, set price rules, or run automated plans from one private balance.",
  "You keep control of your funds: withdraw or move them whenever you choose.",
] as const;

const NOT_POINTS = [
  "Not a mixer or tumbler — it isn’t built to scrub dirty funds into “clean” coins.",
  "Not a tool for crime, sanctions evasion, or hiding illegal activity.",
  "Not a bank, custodian, or exchange that holds your money for you.",
] as const;

const HOW_STEPS = [
  {
    title: "Deposit",
    body: "Send crypto in. Once deposited, your funds become private — balances and moves stay out of public view.",
  },
  {
    title: "Build a strategy",
    body: "From a single swap to multi-step plans of any complexity — on the board, or by describing what you want.",
  },
  {
    title: "Check results",
    body: "Let it run, then withdraw or move funds when you’re ready. You’re in control the whole time.",
  },
] as const;

type OnboardingPage = 0 | 1 | 2 | 3 | 4;
const LAST_PAGE: OnboardingPage = 4;

interface WelcomeOnboardingProps {
  onComplete: () => void;
}

/** Intro: welcome → what it is → what it is not → how to use → early alpha + terms. */
export default function WelcomeOnboarding({ onComplete }: WelcomeOnboardingProps) {
  const [visible, setVisible] = useState(false);
  const [overlayExiting, setOverlayExiting] = useState(false);
  const [page, setPage] = useState<OnboardingPage>(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [tosOpen, setTosOpen] = useState(false);
  const [nudgeAccept, setNudgeAccept] = useState(false);
  const finishedRef = useRef(false);
  const pageRef = useRef<OnboardingPage>(0);
  const acceptedRef = useRef(false);
  const tosOpenRef = useRef(false);
  const transitioningRef = useRef(false);
  const touchStartYRef = useRef(0);
  const overlayRef = useRef<HTMLDivElement>(null);
  const nudgeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    acceptedRef.current = accepted;
  }, [accepted]);

  useEffect(() => {
    tosOpenRef.current = tosOpen;
  }, [tosOpen]);

  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  useEffect(() => {
    return () => {
      if (nudgeTimerRef.current != null) window.clearTimeout(nudgeTimerRef.current);
    };
  }, []);

  const flashAcceptNudge = useCallback(() => {
    setNudgeAccept(true);
    if (nudgeTimerRef.current != null) window.clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = window.setTimeout(() => setNudgeAccept(false), NUDGE_MS);
  }, []);

  const goToPage = useCallback((next: OnboardingPage) => {
    if (transitioningRef.current || pageRef.current === next) return;
    transitioningRef.current = true;
    setPageVisible(false);
    window.setTimeout(() => {
      setPage(next);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setPageVisible(true);
          transitioningRef.current = false;
        });
      });
    }, SCREEN_FADE_MS);
  }, []);

  const finish = useCallback(() => {
    if (finishedRef.current || transitioningRef.current) return;
    if (!acceptedRef.current) {
      flashAcceptNudge();
      return;
    }
    finishedRef.current = true;
    setOverlayExiting(true);
    window.setTimeout(onComplete, OVERLAY_FADE_MS);
  }, [flashAcceptNudge, onComplete]);

  const advance = useCallback(() => {
    if (finishedRef.current || transitioningRef.current || tosOpenRef.current) return;
    if (pageRef.current < LAST_PAGE) goToPage((pageRef.current + 1) as OnboardingPage);
    else finish();
  }, [finish, goToPage]);

  const retreat = useCallback(() => {
    if (finishedRef.current || transitioningRef.current || tosOpenRef.current) return;
    if (pageRef.current > 0) goToPage((pageRef.current - 1) as OnboardingPage);
  }, [goToPage]);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (tosOpenRef.current) return;
      e.preventDefault();
      if (e.deltaY > 20) advance();
      else if (e.deltaY < -20) retreat();
    };

    const onTouchStart = (e: TouchEvent) => {
      touchStartYRef.current = e.touches[0]?.clientY ?? 0;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (tosOpenRef.current) return;
      const endY = e.changedTouches[0]?.clientY ?? touchStartYRef.current;
      const deltaY = touchStartYRef.current - endY;
      if (deltaY > SWIPE_THRESHOLD_PX) advance();
      else if (deltaY < -SWIPE_THRESHOLD_PX) retreat();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [advance, retreat]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tosOpenRef.current) {
        if (e.key === "Escape") {
          e.preventDefault();
          setTosOpen(false);
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        advance();
      } else if (e.key === " " && pageRef.current === LAST_PAGE) {
        return;
      } else if (e.key === " ") {
        e.preventDefault();
        advance();
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "Backspace") {
        e.preventDefault();
        retreat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, retreat]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const canEnter = page < LAST_PAGE || accepted;
  const onLastPage = page === LAST_PAGE;

  return (
    <div
      ref={overlayRef}
      className={`${styles.overlay} ${overlayExiting ? styles.overlayExiting : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Siphon"
    >
      <div className={styles.contentWrap}>
        <div
          className={`${styles.screen} ${visible && pageVisible ? styles.screenVisible : ""}`}
          key={page}
        >
          <div className={styles.hero}>
            <svg className={styles.heroLogo} viewBox="0 0 97.34 80" aria-hidden>
              <path d={SIPHON_LOGO_PATH} fill="currentColor" />
            </svg>
            <p className={styles.timeLine}>it&apos;s time.</p>
          </div>

          {page === 0 ? (
            <div className={styles.explain}>
              <h2 className={styles.explainTitle}>Welcome to Siphon</h2>
              <p className={styles.explainLead}>
                Please read this one-time onboarding guide carefully. It explains what Siphon is,
                what it is not, how to use it, and the risks of early alpha software.
              </p>
            </div>
          ) : page === 1 ? (
            <div className={styles.explain}>
              <h2 className={styles.explainTitle}>What Siphon is</h2>
              <p className={styles.explainLead}>
                Siphon is a protocol for using crypto privately, so your activity and alpha aren&apos;t an open
                book on the blockchain.
              </p>
              <ul className={styles.pointList} aria-label="What Siphon permits">
                {WHAT_POINTS.map((point) => (
                  <li key={point} className={styles.pointItem}>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          ) : page === 2 ? (
            <div className={styles.explain}>
              <h2 className={styles.explainTitle}>What Siphon is not</h2>
              <p className={styles.explainLead}>
                Not a shield for breaking the law or washing funds.
              </p>
              <ul className={styles.pointList} aria-label="What Siphon is not">
                {NOT_POINTS.map((point) => (
                  <li key={point} className={styles.pointItem}>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          ) : page === 3 ? (
            <div className={styles.explain}>
              <h2 className={styles.explainTitle}>How to use it</h2>
              <p className={styles.explainLead}>
                Three steps. That&apos;s the whole loop.
              </p>
              <ol className={styles.howList} aria-label="How to use Siphon">
                {HOW_STEPS.map((step, i) => (
                  <li key={step.title} className={styles.howItem}>
                    <span className={styles.howIndex}>{i + 1}</span>
                    <div className={styles.howCopy}>
                      <span className={styles.howTitle}>{step.title}</span>
                      <span className={styles.howBody}>{step.body}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className={styles.explain}>
              <h2 className={styles.explainTitle}>Siphon is in early alpha</h2>
              <p className={styles.explainLead}>
                Software can fail. Bugs, downtime, and loss of funds are possible. You use Siphon
                entirely at your own risk.
              </p>
              <label
                className={`${styles.disclaimer} ${nudgeAccept ? styles.disclaimerNudge : ""}`}
              >
                <input
                  type="checkbox"
                  className={styles.disclaimerInput}
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span className={styles.disclaimerTick} aria-hidden>
                  {accepted ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </span>
                <span className={styles.disclaimerText}>
                  I accept that I use Siphon at my own risk and agree to the{" "}
                  <button
                    type="button"
                    className={styles.disclaimerLink}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setTosOpen(true);
                    }}
                  >
                    Terms of Use
                  </button>
                </span>
              </label>
              {nudgeAccept && !accepted ? (
                <p className={styles.disclaimerHint} role="status">
                  Accept the disclaimer to continue
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.pageDots} aria-hidden>
          <span className={`${styles.pageDot} ${page === 0 ? styles.pageDotActive : ""}`} />
          <span className={`${styles.pageDot} ${page === 1 ? styles.pageDotActive : ""}`} />
          <span className={`${styles.pageDot} ${page === 2 ? styles.pageDotActive : ""}`} />
          <span className={`${styles.pageDot} ${page === 3 ? styles.pageDotActive : ""}`} />
          <span className={`${styles.pageDot} ${page === 4 ? styles.pageDotActive : ""}`} />
        </div>
        <button
          type="button"
          className={`${styles.scrollTip} ${!canEnter ? styles.scrollTipDisabled : ""}`}
          onClick={advance}
          aria-disabled={!canEnter}
        >
          <span className={styles.scrollHintDesktop}>
            {!onLastPage ? "scroll" : accepted ? "scroll to enter" : "accept to enter"}
          </span>
          <span className={styles.scrollHintMobile}>
            {!onLastPage ? "swipe" : accepted ? "swipe to enter" : "accept to enter"}
          </span>
          <svg
            className={styles.scrollChevron}
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <path d="M12 5v14M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </footer>

      {tosOpen ? (
        <div
          className={styles.tosBackdrop}
          role="presentation"
          onClick={() => setTosOpen(false)}
        >
          <div
            className={styles.tosModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-tos-title"
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <header className={styles.tosHeader}>
              <h2 id="onboarding-tos-title" className={styles.tosTitle}>
                Terms &amp; disclaimer
              </h2>
              <button
                type="button"
                className={styles.tosClose}
                onClick={() => setTosOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <div className={styles.tosBody}>
              <p className={styles.tosMeta}>
                {ENTITY} · Effective {EFFECTIVE_DATE}
              </p>
              <p>
                <strong>Siphon is early open alpha.</strong> The protocol, interfaces, circuits,
                infrastructure, and related software are unfinished and experimental. Bugs —
                including critical ones — downtime, failed proofs, wrong execution, privacy
                failures, and <strong>total or partial loss of funds</strong> can and may occur.
                Features may break, change, or disappear without notice.
              </p>
              <p>
                <strong>Everything you do is at your sole risk.</strong> You alone decide to
                deposit, trade, automate, withdraw, or interact in any way. You alone are
                responsible for your keys, wallets, devices, network choices, compliance, taxes,
                and outcomes. No one else is responsible for your decisions or losses.
              </p>
              <p>
                The Services are provided <strong>as is</strong> and <strong>as available</strong>,
                with <strong>no warranties of any kind</strong> — express, implied, or statutory —
                including merchantability, fitness for a purpose, title, non-infringement,
                security, privacy, accuracy, availability, or that defects will be corrected.
              </p>
              <p>
                To the maximum extent permitted by law, {ENTITY}, its affiliates, shareholders,
                officers, directors, employees, contractors, agents, licensors, contributors, and
                anyone else involved in building, operating, or promoting Siphon{" "}
                <strong>
                  have no duty, responsibility, or liability to you
                </strong>{" "}
                for any claim, demand, loss, cost, or damage of any kind — including loss of
                digital assets — arising from the Services, your use of them, our acts or
                omissions, mistakes, bugs, negligence, or failure to warn. You{" "}
                <strong>release and forever waive</strong> all such claims against those parties.
              </p>
              <p>
                Even if Siphon or anyone listed above makes a mistake, acts negligently, or the
                software fails badly, you agree you <strong>cannot and will not hold them
                responsible</strong> for resulting harm or fund loss, except where a mandatory law
                that cannot be waived says otherwise. Where liability cannot be fully excluded, it
                is limited to the maximum extent that law allows.
              </p>
              <p>
                Nothing here is financial, legal, investment, or tax advice. If you do not accept
                these terms, do not use Siphon.
              </p>
              <p>
                By ticking the box you confirm you have read this disclaimer, understand that use
                is entirely at your own risk, release {ENTITY} and related parties as stated above,
                and agree to the full{" "}
                <a href="/terms" target="_blank" rel="noopener noreferrer" className={styles.tosFullLink}>
                  Terms of Use
                </a>
                .
              </p>
            </div>
            <footer className={styles.tosFooter}>
              <button
                type="button"
                className={styles.tosAcceptBtn}
                onClick={() => {
                  setAccepted(true);
                  setTosOpen(false);
                }}
              >
                I understand — accept at my own risk
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
