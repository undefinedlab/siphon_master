"use client";

import { useState } from "react";
import { showAppToast } from "@/lib/appToast";
import { getTradeExecutorBaseUrl } from "@/lib/tradeExecutorClient";
import { createReceipt, type NewReceiptInput, type ReceiptIdentity } from "@/lib/receiptClient";
import { downloadReceiptPdf } from "@/lib/receiptPdf";
import "../Predictions/PrivateReceipts.css";

export interface ReceiptPrefill {
  kind: "deposit" | "withdraw";
  amount?: string;
  token?: string;
  chain_id?: number;
  tx_hash?: string;
  counterparty?: string;
  occurred_at?: string;
}

const CHAINS: [number, string][] = [[8453, "Base"], [42161, "Arbitrum One"], [11155111, "Sepolia"], [137, "Polygon"]];

/** Generate a compliant receipt for a specific deposit/withdrawal. The transaction facts are
 *  pre-filled from the activity row (editable); the user adds the merchant/payee identity, which
 *  is encrypted at rest and printed only on their copy. Mints + downloads the signed PDF. */
export default function ReceiptModal({
  prefill,
  onClose,
}: {
  prefill: ReceiptPrefill;
  onClose: () => void;
}) {
  const [form, setForm] = useState<NewReceiptInput>({
    kind: prefill.kind,
    amount: prefill.amount ?? "",
    token: prefill.token ?? "USDC",
    chain_id: prefill.chain_id ?? 8453,
    tx_hash: prefill.tx_hash ?? "",
    counterparty: prefill.counterparty ?? "",
    occurred_at: prefill.occurred_at ?? new Date().toISOString(),
    identity: {},
  });
  const [saving, setSaving] = useState(false);

  const setId = (k: keyof ReceiptIdentity, v: string) =>
    setForm((f) => ({ ...f, identity: { ...f.identity, [k]: v } }));

  const submit = async () => {
    if (!form.amount) { showAppToast("Enter an amount.", "error"); return; }
    setSaving(true);
    try {
      const r = await createReceipt(form);
      showAppToast("Receipt minted and enclave-signed.", "success", 5000);
      await downloadReceiptPdf(r, { includeIdentity: true, orderSignerUrl: getTradeExecutorBaseUrl() });
      onClose();
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : "Failed to create receipt.", "error", 7000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rc-modal-bg" onClick={() => !saving && onClose()}>
      <div className="rc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rc-modal-head">
          <span>Compliant Receipt · {prefill.kind === "deposit" ? "Deposit" : "Withdrawal"}</span>
          <button className="rc-x" onClick={onClose}>×</button>
        </div>
        <div className="rc-modal-body">
          <div className="rc-sec">Transaction</div>
          <div className="rc-grid">
            <label>Amount<input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="21" /></label>
            <label>Token<input value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} /></label>
            <label>Network
              <select value={form.chain_id} onChange={(e) => setForm({ ...form, chain_id: Number(e.target.value) })}>
                {CHAINS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label>Date<input value={form.occurred_at?.slice(0, 16)} onChange={(e) => setForm({ ...form, occurred_at: new Date(e.target.value).toISOString() })} type="datetime-local" /></label>
            <label className="rc-wide">Transaction hash<input value={form.tx_hash} onChange={(e) => setForm({ ...form, tx_hash: e.target.value })} placeholder="0x…" /></label>
            <label className="rc-wide">{prefill.kind === "deposit" ? "From address" : "To / recipient address"}<input value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} placeholder="0x… (optional)" /></label>
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
            <button className="rc-cancel" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="rc-save" onClick={() => void submit()} disabled={saving}>{saving ? "Signing…" : "Mint & Download"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
