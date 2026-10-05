"use client";

import { useCallback, useEffect, useState } from "react";
import { showAppToast } from "@/lib/appToast";
import { getSigner } from "@/lib/nexus";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import {
  listReceipts,
  createReceipt,
  type Receipt,
  type NewReceiptInput,
  type ReceiptIdentity,
} from "@/lib/receiptClient";
import { downloadReceiptPdf } from "@/lib/receiptPdf";
import { verifyReceipt, type VerifyReport } from "@/lib/receiptVerifier";
import "./PrivateReceipts.css";

const CHAINS: Record<number, string> = { 8453: "Base", 42161: "Arbitrum One", 11155111: "Sepolia", 137: "Polygon" };
const short = (h?: string | null) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : "—");

const EMPTY: NewReceiptInput = {
  kind: "withdraw", token: "USDC", chain_id: 8453, amount: "",
  tx_hash: "", counterparty: "", occurred_at: "",
  identity: {},
};

/**
 * "My Receipts" — mint, download, and verify compliant receipts for shielded deposits/withdrawals.
 * The public layer is safe to share; the identity layer prints only on the owner's copy; every
 * receipt is enclave-signed and independently verifiable (receiptVerifier).
 */
export default function PrivateReceipts() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewReceiptInput>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setReceipts(await listReceipts()); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = getSigner();
      const addr = s ? await s.getAddress().catch(() => null) : null;
      if (cancelled || !addr) return;
      setWallet(addr);
      void load();
    })();
    return () => { cancelled = true; };
  }, [load]);

  const setId = (k: keyof ReceiptIdentity, v: string) =>
    setForm((f) => ({ ...f, identity: { ...f.identity, [k]: v } }));

  const submit = async () => {
    if (!form.amount) { showAppToast("Enter an amount.", "error"); return; }
    setSaving(true);
    try {
      const r = await createReceipt({ ...form, occurred_at: form.occurred_at || new Date().toISOString() });
      showAppToast("Receipt minted and enclave-signed.", "success", 5000);
      setReceipts((prev) => [r, ...prev]);
      setOpen(false);
      setForm(EMPTY);
      await downloadReceiptPdf(r, { includeIdentity: true, orderSignerUrl: getTradeExecutorBaseUrl() });
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : "Failed to create receipt.", "error", 7000);
    } finally {
      setSaving(false);
    }
  };

  const verify = async (r: Receipt) => {
    setVerifying(r.id);
    try {
      const rep: VerifyReport = await verifyReceipt(r, getTradeExecutorBaseUrl());
      if (rep.valid) showAppToast(`Verified ✓ — signed by the attested enclave (${short(rep.recoveredSigner)}).`, "success", 6000);
      else showAppToast(rep.reason || "Verification failed.", "error", 7000);
    } finally {
      setVerifying(null);
    }
  };

  if (!wallet) return null;

  return (
    <div className="rc-wrap">
      <div className="rc-head">
        <span className="rc-title">My Receipts</span>
        <div className="rc-head-actions">
          <button className="rc-refresh" onClick={() => void load()} disabled={loading}>{loading ? "…" : "↻"}</button>
          <button className="rc-new" onClick={() => setOpen(true)}>+ Generate Receipt</button>
        </div>
      </div>

      {receipts.length === 0 && !loading && (
        <div className="rc-empty">No receipts yet. Generate a compliant receipt for a deposit or withdrawal — private by default, verifiable on demand.</div>
      )}

      <div className="rc-list">
        {receipts.map((r) => (
          <div key={r.id} className="rc-row">
            <div className="rc-row-main">
              <span className="rc-amt">{r.amount} {r.token}</span>
              <span className={`rc-kind rc-kind--${r.kind}`}>{r.kind}</span>
              {r.attestation_ref && r.attestation_ref !== "dev" && <span className="rc-stamp" title="Enclave-attested">◆ attested</span>}
            </div>
            <div className="rc-row-sub">
              <span>{r.chain_id ? (CHAINS[r.chain_id] || `chain ${r.chain_id}`) : "—"}</span>
              <span>#{r.id.slice(0, 8)}</span>
              {r.occurred_at && <span>{new Date(r.occurred_at).toLocaleDateString()}</span>}
              <span title={r.digest || ""}>digest {short(r.digest)}</span>
            </div>
            <div className="rc-row-actions">
              <button onClick={() => downloadReceiptPdf(r, { includeIdentity: true, orderSignerUrl: getTradeExecutorBaseUrl() })}>Download PDF</button>
              <button onClick={() => void verify(r)} disabled={verifying === r.id}>{verifying === r.id ? "Verifying…" : "Verify"}</button>
            </div>
          </div>
        ))}
      </div>

      {open && (
        <div className="rc-modal-bg" onClick={() => !saving && setOpen(false)}>
          <div className="rc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rc-modal-head">
              <span>Generate Compliant Receipt</span>
              <button className="rc-x" onClick={() => setOpen(false)}>×</button>
            </div>
            <div className="rc-modal-body">
              <div className="rc-sec">Transaction</div>
              <div className="rc-grid">
                <label>Type
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "deposit" | "withdraw" })}>
                    <option value="withdraw">Withdrawal</option>
                    <option value="deposit">Deposit</option>
                  </select>
                </label>
                <label>Amount<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="140.22" /></label>
                <label>Token<input value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="USDC" /></label>
                <label>Network
                  <select value={form.chain_id} onChange={(e) => setForm({ ...form, chain_id: Number(e.target.value) })}>
                    <option value={8453}>Base</option>
                    <option value={42161}>Arbitrum One</option>
                    <option value={11155111}>Sepolia</option>
                    <option value={137}>Polygon</option>
                  </select>
                </label>
                <label className="rc-wide">Transaction hash<input value={form.tx_hash} onChange={(e) => setForm({ ...form, tx_hash: e.target.value })} placeholder="0x…" /></label>
                <label className="rc-wide">{form.kind === "deposit" ? "From address" : "To / recipient address"}<input value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} placeholder="0x…" /></label>
              </div>

              <div className="rc-sec">Merchant / Payer</div>
              <div className="rc-grid">
                <label>Name<input value={form.identity?.merchant_name || ""} onChange={(e) => setId("merchant_name", e.target.value)} /></label>
                <label>Email<input value={form.identity?.merchant_email || ""} onChange={(e) => setId("merchant_email", e.target.value)} /></label>
                <label className="rc-wide">Address<input value={form.identity?.merchant_address || ""} onChange={(e) => setId("merchant_address", e.target.value)} /></label>
                <label className="rc-wide">Tax ID / PAN / VAT / GSTIN<input value={form.identity?.tax_id || ""} onChange={(e) => setId("tax_id", e.target.value)} placeholder="Optional" /></label>
              </div>

              <div className="rc-sec">Payee / Recipient</div>
              <div className="rc-grid">
                <label>Name<input value={form.identity?.payee_name || ""} onChange={(e) => setId("payee_name", e.target.value)} placeholder="Optional" /></label>
                <label>Email<input value={form.identity?.payee_email || ""} onChange={(e) => setId("payee_email", e.target.value)} placeholder="Optional" /></label>
                <label className="rc-wide">Memo<input value={form.identity?.memo || ""} onChange={(e) => setId("memo", e.target.value)} placeholder="Optional note" /></label>
              </div>
            </div>
            <div className="rc-modal-foot">
              <span className="rc-note">Identity is encrypted at rest and printed only on your copy.</span>
              <div>
                <button className="rc-cancel" onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
                <button className="rc-save" onClick={() => void submit()} disabled={saving}>{saving ? "Signing…" : "Mint & Download"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
