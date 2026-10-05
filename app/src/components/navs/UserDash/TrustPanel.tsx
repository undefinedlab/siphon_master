"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  clearTosAcceptance,
  readTosAcceptance,
  saveTosAcceptance,
  TOS_ACCEPTANCE_VERSION,
  TRUST_TOS_EVENT,
  type TosAcceptanceRecord,
} from "@/lib/tosAcceptance";
import {
  clearKytStatus,
  isKytPassed,
  readKytStatus,
  saveKytStatus,
  type KytStatusRecord,
} from "@/lib/kytStatus";
import { isLevel1TrustComplete } from "@/lib/trustLevel1";
import { trustEnforcementEnabled } from "@/lib/trustBypass";
import {
  isLevel2TrustComplete,
  readLevel2Status,
  verifyLevel2Trust,
  type Level2StatusRecord,
} from "@/lib/trustLevel2";
import { isZkKycEnabled } from "@/lib/zkmeConfig";
import { launchZkKyc } from "@/lib/zkmeWidget";
import {
  AspUnavailableError,
  aspFailClosed,
  aspScreenEnabled,
  formatAspDenyMessage,
  isSanctioned,
  KytFeeRequiredError,
  OracleUnavailableError,
  screenWithAsp,
} from "@/lib/sanctionsScreen";
import { getSelectedChainId } from "@/lib/networks";
import { showAppToast } from "@/lib/appToast";
import {
  checkKycFeePaid,
  checkKytFeePaid,
  ensureKycFeePaid,
  fetchComplianceFeeStatus,
  formatFeeExpiry,
  payComplianceFee,
  PRODUCT_KYC,
  PRODUCT_KYT,
} from "@/lib/complianceFee";
import "./TrustPanel.css";

type Props = {
  wallet: string | null | undefined;
};

type TrustMode = "personal" | "business" | "agent";
type LevelId = "l1" | "l2_kyc" | "l2_kyb" | "l2_kya";

const TRUST_MODE_KEY = "siphon-trust-mode";

const MARQUEE_SEGMENTS = [
  "Level 1 Trust required",
  "Accept Terms of Use",
  "Clear wallet KYT",
  "Deposits locked",
];

const ZK_KYC_POINTS = [
  "Proofs generated on your device — raw ID data never leaves the phone",
  "Partner AML screening bundled in zkKYC — sanctions / PEP without a separate step",
  "No PII stored by Siphon — we only receive a yes/no eligibility signal",
  "Reusable credential — verify once with zk.me, reuse without re-uploading",
] as const;

const ZK_KYB_POINTS = [
  "Entity proofs stay encrypted on your side — formation docs never sit on Siphon",
  "Partner AML bundled in zkKYB — business sanctions without a separate step",
  "Zero-knowledge KYB — prove legal standing without ownership charts",
  "Reusable zk.me credential — verify the business once, reuse across integrations",
] as const;

const ZK_KYA_POINTS = [
  "Agent identity attestation — prove this wallet is an authorized agent, not a random bot",
  "Human-principal binding — zk.me links the agent to a verified operator without exposing PII",
  "No agent dossier stored by Siphon — we only receive a pass/fail eligibility signal",
  "Reusable credential — verify once, reuse for x402 / AP2 and other agent integrations",
] as const;

function readStoredMode(): TrustMode {
  if (typeof window === "undefined") return "personal";
  try {
    const v = localStorage.getItem(TRUST_MODE_KEY);
    if (v === "business") return "business";
    if (v === "agent") return "agent";
    return "personal";
  } catch {
    return "personal";
  }
}

/**
 * UserDash Trust tab —
 * L1: TOS + KYT (required to deposit — all profiles)
 * L2 Personal: zkKYC · Business: zkKYB · Agent: zkKYA (all coming soon)
 * Deposit-time ASP admission still runs its own AML screen in the background.
 */
export default function TrustPanel({ wallet }: Props) {
  const [mode, setMode] = useState<TrustMode>("personal");
  const [tosRecord, setTosRecord] = useState<TosAcceptanceRecord | null>(null);
  const [kytRecord, setKytRecord] = useState<KytStatusRecord | null>(null);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreePrivacy, setAgreePrivacy] = useState(false);
  const [kytBusy, setKytBusy] = useState(false);
  const [feePaid, setFeePaid] = useState<boolean | null>(null); // KYT entitlement
  const [feeExpiresAt, setFeeExpiresAt] = useState<string | null>(null);
  const [kycFeePaid, setKycFeePaid] = useState<boolean | null>(null);
  const [kycFeeExpiresAt, setKycFeeExpiresAt] = useState<string | null>(null);
  const [l2Busy, setL2Busy] = useState(false);
  const [l2Record, setL2Record] = useState<Level2StatusRecord | null>(null);
  const zkKycLive = isZkKycEnabled();

  useEffect(() => {
    setMode(readStoredMode());
  }, []);

  const setTrustMode = (next: TrustMode) => {
    setMode(next);
    try {
      localStorage.setItem(TRUST_MODE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const refresh = useCallback(() => {
    if (!wallet) {
      setTosRecord(null);
      setKytRecord(null);
      return;
    }
    const tos = readTosAcceptance(wallet);
    const kyt = readKytStatus(wallet);
    // Level 1 is atomic — drop orphaned TOS from older builds. Not on Devnet, where Level 1 is
    // Terms only: KYT there runs on every deposit through the Solana ASP, not in this panel.
    if (tos && !isKytPassed(wallet) && trustEnforcementEnabled()) {
      clearTosAcceptance(wallet);
      setTosRecord(null);
    } else {
      setTosRecord(tos);
    }
    setKytRecord(kyt);
    if (zkKycLive) {
      setL2Record(readLevel2Status(wallet, "zkkyc"));
      void verifyLevel2Trust(wallet, "zkkyc")
        .then((ok) => {
          if (ok) setL2Record(readLevel2Status(wallet, "zkkyc"));
          else setL2Record(null);
        })
        .catch(() => setL2Record(null));
    } else {
      setL2Record(null);
    }
  }, [wallet, zkKycLive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!wallet) {
      setFeePaid(null);
      setFeeExpiresAt(null);
      setKycFeePaid(null);
      setKycFeeExpiresAt(null);
      return;
    }
    void fetchComplianceFeeStatus(wallet, PRODUCT_KYT).then((status) => {
      if (!status) return;
      setFeePaid(Boolean(status.paid ?? status.active));
      setFeeExpiresAt(status.expiresAt ?? null);
    });
    void fetchComplianceFeeStatus(wallet, PRODUCT_KYC).then((status) => {
      if (!status) return;
      setKycFeePaid(Boolean(status.paid ?? status.active));
      setKycFeeExpiresAt(status.expiresAt ?? null);
    });
  }, [wallet, kytRecord, l2Record]);

  const tosOk = Boolean(tosRecord);
  const kytOk = isKytPassed(wallet);
  const kytDenied = kytRecord?.decision === "deny";
  /** Devnet / SKIP_TRUST: Level 1 is Terms only (no EVM fee wallet); deposits stay unlocked. */
  const devnetTrustPreview = !trustEnforcementEnabled();
  const l1Ok = devnetTrustPreview ? tosOk : tosOk && kytOk;
  const l2Ok = zkKycLive ? isLevel2TrustComplete(wallet, "zkkyc") : false;

  const runKytScreen = async (targetWallet: string): Promise<KytStatusRecord | null> => {
    const chainId = getSelectedChainId();
    let decision: KytStatusRecord["decision"] = "clear";
    let reasons: string[] = [];
    let source: KytStatusRecord["source"] = "oracle";

    if (aspScreenEnabled()) {
      try {
        const result = await screenWithAsp({ chainId, depositor: targetWallet });
        if (result.decision === "deny") {
          decision = "deny";
          reasons = result.reasons;
          source = "asp";
        } else if (result.decision === "pending") {
          if (result.reasons.includes("kyt_fee_required")) {
            showAppToast(
              "Compliance fee required — complete the payment step above, then try again.",
              "info",
            );
          } else {
            showAppToast(
              `KYT pending${result.reasons.length ? ` (${result.reasons.join(", ")})` : ""}. Try again shortly.`,
              "info",
            );
          }
          return null;
        } else {
          decision = "admit";
          reasons = result.reasons;
          source = "asp";
        }
      } catch (e) {
        if (e instanceof KytFeeRequiredError) {
          showAppToast(e.message, "info");
          return null;
        }
        if (e instanceof AspUnavailableError) {
          if (aspFailClosed()) {
            showAppToast("KYT screening unavailable — try again when ASP is back.", "error");
            return null;
          }
        } else {
          throw e;
        }
      }
    }

    if (decision !== "deny") {
      try {
        const sanctioned = await isSanctioned(targetWallet, chainId);
        if (sanctioned) {
          decision = "deny";
          reasons = ["oracle_sanctioned"];
          source = source === "asp" ? "both" : "oracle";
        } else if (source === "asp") {
          source = "both";
        } else {
          decision = "clear";
          source = "oracle";
        }
      } catch (e) {
        if (e instanceof OracleUnavailableError) {
          if (decision === "admit") {
            showAppToast("ASP clear — oracle unreachable, result cached from ASP only.", "info");
          } else {
            showAppToast(e.message, "error");
            return null;
          }
        } else {
          throw e;
        }
      }
    }

    return saveKytStatus({
      wallet: targetWallet,
      chainId,
      checkedAt: new Date().toISOString(),
      decision,
      reasons,
      source,
    });
  };

  const onCompleteLevel1 = async () => {
    if (!wallet) {
      showAppToast("Connect a wallet first", "error");
      return;
    }
    if (!agreeTerms || !agreePrivacy) {
      showAppToast("Confirm both Terms of Use and Privacy Policy", "error");
      return;
    }
    if (devnetTrustPreview) {
      // The fee is an EVM transfer and KYT needs an EVM signer; a Devnet (Phantom) wallet has
      // neither. Each Devnet deposit is still screened by the Solana ASP before admission.
      setTosRecord(saveTosAcceptance(wallet));
      showAppToast("Level 1 complete — Terms accepted. Devnet deposits are screened by the ASP.", "success");
      return;
    }
    setKytBusy(true);
    try {
      // Check / collect the one-time $0.50 compliance fee before running KYT.
      const alreadyPaid = feePaid ?? (await checkKytFeePaid(wallet));
      if (!alreadyPaid) {
        const paid = await payComplianceFee(wallet, PRODUCT_KYT);
        if (!paid) return;
        setFeePaid(true);
        const status = await fetchComplianceFeeStatus(wallet, PRODUCT_KYT);
        setFeeExpiresAt(status?.expiresAt ?? null);
      } else {
        setFeePaid(true);
      }

      const kytResult = await runKytScreen(wallet);
      if (!kytResult) return;

      setKytRecord(kytResult);
      if (kytResult.decision === "deny") {
        clearTosAcceptance(wallet);
        setTosRecord(null);
        showAppToast(formatAspDenyMessage(kytResult.reasons.length ? kytResult.reasons : ["policy"]), "error");
        return;
      }

      const tos = saveTosAcceptance(wallet);
      setTosRecord(tos);
      showAppToast("Level 1 complete — deposits unlocked", "success");
    } catch (e) {
      clearTosAcceptance(wallet);
      setTosRecord(null);
      const message = e instanceof Error ? e.message : "Level 1 check failed";
      showAppToast(message, "error");
    } finally {
      setKytBusy(false);
    }
  };

  const onRecheckLevel1 = async () => {
    if (!wallet) return;
    setKytBusy(true);
    try {
      const kytResult = await runKytScreen(wallet);
      if (!kytResult) return;

      setKytRecord(kytResult);
      if (kytResult.decision === "deny") {
        clearTosAcceptance(wallet);
        clearKytStatus(wallet);
        setTosRecord(null);
        setAgreeTerms(false);
        setAgreePrivacy(false);
        showAppToast(formatAspDenyMessage(kytResult.reasons.length ? kytResult.reasons : ["policy"]), "error");
        return;
      }

      showAppToast("Level 1 re-verified", "success");
    } catch (e) {
      const message = e instanceof Error ? e.message : "KYT check failed";
      showAppToast(message, "error");
    } finally {
      setKytBusy(false);
    }
  };

  const onStartZkKyc = async () => {
    if (!wallet) {
      showAppToast("Connect a wallet first", "error");
      return;
    }
    if (!l1Ok) {
      showAppToast("Complete Level 1 Trust before starting zkKYC", "info");
      return;
    }
    setL2Busy(true);
    try {
      const entitled = kycFeePaid ?? (await checkKycFeePaid(wallet));
      if (!entitled) {
        const paid = await ensureKycFeePaid(wallet);
        if (!paid) return;
        setKycFeePaid(true);
        const status = await fetchComplianceFeeStatus(wallet, PRODUCT_KYC);
        setKycFeeExpiresAt(status?.expiresAt ?? null);
      }

      const chainId = getSelectedChainId();
      await launchZkKyc({
        wallet,
        chainId,
        onFinished: (results) => {
          if (results.isGrant && results.status === "matching") {
            setL2Record(readLevel2Status(wallet, "zkkyc"));
            showAppToast("Level 2 zkKYC complete — higher limits unlocked", "success");
          } else {
            showAppToast("zkKYC not granted — try again or contact support", "error");
          }
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not open zkKYC";
      showAppToast(message, "error");
    } finally {
      setL2Busy(false);
    }
  };

  const onRevokeLevel1 = () => {
    if (!wallet) return;
    clearTosAcceptance(wallet);
    clearKytStatus(wallet);
    setTosRecord(null);
    setKytRecord(null);
    setAgreeTerms(false);
    setAgreePrivacy(false);
    showAppToast("Level 1 cleared — deposits locked until you re-complete TOS + KYT", "info");
  };

  const modeToggle = (
    <div className="trust-mode-toggle" role="group" aria-label="Trust profile">
      <button
        type="button"
        className={`userdash-network-btn${mode === "personal" ? " active" : ""}`}
        onClick={() => setTrustMode("personal")}
      >
        Personal
      </button>
      <button
        type="button"
        className={`userdash-network-btn${mode === "business" ? " active" : ""}`}
        onClick={() => setTrustMode("business")}
      >
        Business
      </button>
      <button
        type="button"
        className={`userdash-network-btn${mode === "agent" ? " active" : ""}`}
        onClick={() => setTrustMode("agent")}
      >
        Agent
      </button>
    </div>
  );

  if (!wallet) {
    return (
      <div className="trust-panel">
        {modeToggle}
        <div className="userdash-notes-card userdash-api-page">
          <div className="userdash-balance-header">
            <h2 className="userdash-balance-title">Trust</h2>
          </div>
          <p className="userdash-notes-description">
            Connect a wallet to complete Level 1 (TOS + KYT) and unlock deposits.
          </p>
        </div>
      </div>
    );
  }

  type LevelCard = {
    id: LevelId;
    lvl: string;
    title: string;
    blurb: string;
    ok: boolean;
    statusLabel: string;
    statusReady: boolean;
    disabledSoon?: boolean;
  };

  const l1Blurb =
    mode === "agent"
      ? "Accept Terms and clear wallet KYT for this agent wallet. Required to deposit. Each deposit still re-screens via ASP admission."
      : mode === "business"
        ? "Accept Terms and clear wallet KYT for the entity wallet. Required to deposit. Each deposit still re-screens via ASP admission."
        : "Accept Terms and clear wallet KYT (on-chain transaction risk). Required to deposit. Each deposit still re-screens via ASP admission.";

  const l1Card: LevelCard = {
    id: "l1",
    lvl: "01",
    title: "TOS + KYT",
    blurb: devnetTrustPreview
      ? "Accept Terms and Privacy. On Devnet there is no fee, and KYT runs on every deposit through the Solana ASP."
      : l1Blurb,
    ok: l1Ok,
    statusLabel: l1Ok
        ? "Passed"
        : kytBusy
          ? "Checking…"
          : kytDenied
            ? "Denied"
            : "Required",
    statusReady: l1Ok,
  };

  const l2Personal: LevelCard = {
    id: "l2_kyc",
    lvl: "02",
    title: "ZK KYC",
    blurb: zkKycLive && !devnetTrustPreview
      ? "zkKYC — identity + partner AML. Separate $0.50/year KYC fee (not included in Level 1 KYT)."
      : "zkKYC — identity + partner AML in one credential. Coming soon.",
    ok: devnetTrustPreview ? false : l2Ok,
    statusLabel: devnetTrustPreview || !zkKycLive
      ? "Coming soon"
      : l2Ok
          ? "Verified"
          : l2Busy
            ? "Opening…"
            : l1Ok
              ? "Available"
              : "Requires L1",
    statusReady: devnetTrustPreview ? false : l2Ok,
    disabledSoon: devnetTrustPreview || !zkKycLive,
  };

  const l2Business: LevelCard = {
    id: "l2_kyb",
    lvl: "02",
    title: "ZK KYB",
    blurb: "zkKYB — business identity + partner AML in one credential. Coming soon.",
    ok: false,
    statusLabel: "Coming soon",
    statusReady: false,
    disabledSoon: true,
  };

  const l2Agent: LevelCard = {
    id: "l2_kya",
    lvl: "02",
    title: "ZK KYA",
    blurb: "zkKYA — agent identity + human-principal binding. Coming soon.",
    ok: false,
    statusLabel: "Coming soon",
    statusReady: false,
    disabledSoon: true,
  };

  const levels =
    mode === "business" ? [l1Card, l2Business] : mode === "agent" ? [l1Card, l2Agent] : [l1Card, l2Personal];

  const renderL1Body = () => {
    return l1Ok ? (
      <>
        <p className="userdash-notes-description">
          Terms accepted{" "}
          {tosRecord?.acceptedAt ? new Date(tosRecord.acceptedAt).toLocaleString() : ""} · KYT cleared{" "}
          {kytRecord?.checkedAt ? new Date(kytRecord.checkedAt).toLocaleString() : ""}
        </p>
        <p className="userdash-notes-description">
          <Link href="/terms" target="_blank" rel="noopener noreferrer" className="trust-link">
            Terms
          </Link>
          {" · "}
          <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="trust-link">
            Privacy
          </Link>
          {" · "}v{TOS_ACCEPTANCE_VERSION}
          {devnetTrustPreview ? " · KYT on each deposit" : ` · ${kytRecord?.source ?? "—"} · chain ${kytRecord?.chainId ?? "—"}`}
        </p>
        <div className="userdash-notes-actions">
          {!devnetTrustPreview && (
          <button
            type="button"
            className="userdash-notes-button userdash-notes-button--secondary"
            onClick={() => void onRecheckLevel1()}
            disabled={kytBusy}
          >
            {kytBusy ? "Re-checking…" : "Re-check"}
          </button>
          )}
          <button
            type="button"
            className="userdash-notes-button userdash-notes-button--secondary"
            onClick={onRevokeLevel1}
            disabled={kytBusy}
          >
            Revoke Level 1
          </button>
        </div>
      </>
    ) : (
      <>
        <label className="trust-check-row">
          <input
            type="checkbox"
            checked={agreeTerms}
            onChange={(e) => setAgreeTerms(e.target.checked)}
            disabled={kytBusy}
          />
          <span>
            I agree to the{" "}
            <Link href="/terms" target="_blank" rel="noopener noreferrer" className="trust-link">
              Terms of Use
            </Link>
            .
          </span>
        </label>
        <label className="trust-check-row">
          <input
            type="checkbox"
            checked={agreePrivacy}
            onChange={(e) => setAgreePrivacy(e.target.checked)}
            disabled={kytBusy}
          />
          <span>
            I agree to the{" "}
            <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="trust-link">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        {kytDenied && (
          <p className="trust-hint userdash-notes-description">
            KYT denied
            {kytRecord?.reasons?.length ? `: ${kytRecord.reasons.slice(0, 3).join(", ")}` : ""}.
          </p>
        )}
        {feePaid !== true && !devnetTrustPreview && (
          <p className="trust-fee-note">$0.50 deposit for zkKYT required.</p>
        )}
        <div className="userdash-notes-actions">
          <button
            type="button"
            className="userdash-notes-button userdash-notes-button--primary"
            onClick={() => void onCompleteLevel1()}
            disabled={kytBusy || !agreeTerms || !agreePrivacy}
          >
            {devnetTrustPreview
              ? "Accept Terms"
              : kytBusy ? "Running TOS + KYT…" : kytDenied ? "Retry Level 1" : "Accept Terms & run KYT"}
          </button>
        </div>
      </>
    );
  };

  const renderDisabledZkCard = (points: readonly string[], cta: string) => {
    return (
    <>
      <ul className="trust-points">
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <div className="userdash-notes-actions">
        <button type="button" className="userdash-notes-button userdash-notes-button--secondary" disabled>
          {cta}
        </button>
      </div>
    </>
    );
  };

  const renderL2KycBody = () => {
    return l2Ok ? (
      <>
        <p className="userdash-notes-description">
          zkKYC verified{" "}
          {l2Record?.verifiedAt ? new Date(l2Record.verifiedAt).toLocaleString() : ""}
          {l2Record?.programNo ? ` · program ${l2Record.programNo}` : ""}
          {kycFeeExpiresAt ? ` · KYC fee until ${formatFeeExpiry(kycFeeExpiresAt)}` : ""}
        </p>
        <ul className="trust-points">
          {ZK_KYC_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <div className="userdash-notes-actions">
          <button
            type="button"
            className="userdash-notes-button userdash-notes-button--secondary"
            onClick={() => void onStartZkKyc()}
            disabled={l2Busy || !l1Ok}
          >
            {l2Busy ? "Opening zkKYC…" : "Re-verify zkKYC"}
          </button>
        </div>
      </>
    ) : (
      <>
        <ul className="trust-points">
          {ZK_KYC_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        {!l1Ok && (
          <p className="trust-hint userdash-notes-description">Complete Level 1 before starting zkKYC.</p>
        )}
        {l1Ok && kycFeePaid !== true && (
          <p className="trust-fee-note">$0.50 deposit for zkKYC required.</p>
        )}
        <div className="userdash-notes-actions">
          <button
            type="button"
            className="userdash-notes-button userdash-notes-button--primary"
            onClick={() => void onStartZkKyc()}
            disabled={l2Busy || !l1Ok || !zkKycLive}
          >
            {l2Busy ? "Opening zkKYC…" : "Start zkKYC"}
          </button>
        </div>
      </>
    );
  };

  return (
    <div className="trust-panel">
      {modeToggle}

      {devnetTrustPreview ? (
        <div className="trust-devnet-banner userdash-notes-card" role="status">
          <p className="userdash-notes-description">
            <strong>Solana Devnet.</strong> Level 1 here is accepting the Terms; every deposit is still
            screened by the ASP. Level 2 (zkKYC / KYB / KYA) is coming soon.
          </p>
        </div>
      ) : null}

      <div className="trust-grid">
        {levels.map((level) => (
          <div
            key={`${mode}-${level.id}`}
            className={`userdash-notes-card trust-card${level.disabledSoon ? " trust-card--soon" : ""}${
              level.ok ? " trust-card--ok" : ""
            }`}
          >
            <div className="trust-card-top">
              <div className="trust-card-eyebrow">
                <span className="trust-card-lvl">Level {level.lvl}</span>
                <span
                  className={`userdash-fhe-status${
                    level.statusReady
                      ? " userdash-fhe-status--ready"
                      : " userdash-fhe-status--generating"
                  }`}
                >
                  {level.statusLabel}
                </span>
              </div>
              <h2 className="userdash-balance-title">{level.title}</h2>
              <p className="userdash-notes-description">{level.blurb}</p>
            </div>

            <div className="trust-card-body">
              {level.id === "l1" && renderL1Body()}
              {level.id === "l2_kyc" &&
                (zkKycLive && !devnetTrustPreview
                  ? renderL2KycBody()
                  : renderDisabledZkCard(ZK_KYC_POINTS, "ZK KYC — coming soon"))}
              {level.id === "l2_kyb" && renderDisabledZkCard(ZK_KYB_POINTS, "ZK KYB — coming soon")}
              {level.id === "l2_kya" && renderDisabledZkCard(ZK_KYA_POINTS, "ZK KYA — coming soon")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Scrolling marquee when Overview still needs Level 1 (TOS + KYT). */
export function TrustNudge({
  wallet,
  onOpenTrust,
}: {
  wallet: string | null | undefined;
  onOpenTrust: () => void;
}) {
  const [needs, setNeeds] = useState(false);

  useEffect(() => {
    if (!wallet || !trustEnforcementEnabled()) {
      setNeeds(false);
      return;
    }
    const sync = () => setNeeds(!isLevel1TrustComplete(wallet));
    sync();
    window.addEventListener(TRUST_TOS_EVENT, sync);
    return () => window.removeEventListener(TRUST_TOS_EVENT, sync);
  }, [wallet]);

  if (!wallet || !needs) return null;

  const track = [...MARQUEE_SEGMENTS, ...MARQUEE_SEGMENTS];

  return (
    <div className="trust-marquee" role="status" aria-live="polite">
      <div className="trust-marquee-rail">
        <div className="trust-marquee-viewport">
          <div className="trust-marquee-track">
            {track.map((text, i) => (
              <span key={`${text}-${i}`} className="trust-marquee-item">
                <span className="trust-marquee-dot" aria-hidden />
                {text}
              </span>
            ))}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="userdash-notes-button userdash-notes-button--primary trust-marquee-cta"
        onClick={onOpenTrust}
      >
        Open Trust
      </button>
    </div>
  );
}
