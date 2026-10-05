/**
 * Renders a compliant receipt to a downloadable PDF in the "Terminal Ledger" (1a) design —
 * #0A0A0B card, IBM Plex Mono, gold #D6A84E accents, dotted transaction rows, a gold-tinted
 * enclave-attestation panel with a live verification QR. The design HTML is rendered to a DOM
 * node and rasterised (html2canvas) so the PDF is pixel-accurate to the Claude Design source.
 *
 * Privacy-safe: only on-chain facts in the public rows, identity printed on the owner's copy, and
 * every cryptographic value shown in FULL (word-wrapped) — nothing truncated.
 */
import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import type { Receipt } from "./receiptClient";

const CHAINS: Record<number, string> = { 8453: "Base", 42161: "Arbitrum One", 11155111: "Ethereum Sepolia", 137: "Polygon", 1: "Ethereum" };
const GOLD = "#D6A84E";
// The Siphon mark (from the app nav) — embedded so the receipt carries the brand, not just wordmark.
const LOGO_PATH = "M70.66,35.93a11.66,11.66,0,0,1,1,.83c1.84,1.89,3.69,3.78,5.5,5.7,2.24,2.35,2.14,1.66-.06,3.9-4.47,4.53-9,9-13.49,13.49-1,1-1,1.09-.16,1.95q7.47,7.5,15,15c.85.85,1,.85,1.83,0q7.5-7.47,15-15c.84-.85.83-1,0-1.84-1.58-1.61-3.2-3.2-4.8-4.8l-9.72-9.73c-1.05-1-1-1.07,0-2.14.07-.08.15-.15.23-.23L92.22,32c1.5-1.47,3-2.94,4.49-4.43.86-.87.84-.9,0-1.81-.14-.16-.3-.3-.46-.46L81.59,10.63Q76.67,5.71,71.75.8c-1.07-1.07-1.09-1.07-2.17,0L64.82,5.66,37.45,33.19q-5.19,5.22-10.38,10.43c-.88.88-.9.87-1.77,0S23.83,42,23.08,41.26c-1.46-1.5-2.95-3-4.41-4.5-1.05-1.1-1-1.11,0-2.16l.23-.23Q25.94,27.28,33,20.19c1.08-1.08,1.09-1.08,0-2.16q-4.27-4.31-8.56-8.59c-2.06-2.06-4.11-4.13-6.18-6.17-.94-.93-1-.91-1.95,0-.2.18-.39.37-.58.56q-6.52,6.53-13,13c-.46.46-.92.91-1.36,1.38-.74.81-.73.88,0,1.73.18.2.37.38.56.57l8.81,8.81c1.83,1.83,3.64,3.67,5.49,5.49.54.52.62.95,0,1.46-.33.28-.62.61-.92.91L.85,51.75a3.65,3.65,0,0,0-.76.82,1.43,1.43,0,0,0,0,1c.1.28.42.48.64.71q12,12.45,24.05,24.89c1.1,1.14,1.11,1.14,2.28,0l29.48-29.3,13.2-13.1C70,36.47,70.3,36.24,70.66,35.93Z";
const LOGO_SVG = `<svg width="30" height="25" viewBox="0 0 97.34 80" style="flex-shrink:0;display:block"><path d="${LOGO_PATH}" fill="${GOLD}"/></svg>`;

export function verificationPayload(r: Receipt, orderSignerUrl?: string) {
  return {
    v: 1, id: r.id, kind: r.kind, tx_hash: r.tx_hash, chain_id: r.chain_id, token: r.token,
    amount: r.amount, counterparty: r.counterparty, occurred_at: r.occurred_at,
    identity_hash: (r as { identity_hash?: string }).identity_hash ?? null,
    shielded_ref_hash: r.shielded_ref_hash, digest: r.digest, tee_signature: r.tee_signature,
    tee_address: r.tee_address, attestation_ref: r.attestation_ref, signer_url: orderSignerUrl ?? null,
  };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).replace(",", " ·") + " UTC" : "—";

// Self-hosted @font-face CSS. Reused for the live document AND injected into html2canvas's clone.
// MUST be same-origin: the old Google Fonts CDN link is cross-origin, and html2canvas can't inline
// a cross-origin woff2 (CORS) — so it fell back to a proportional font and the receipt's heavy
// letter-spacing collapsed into overlapping text. Same-origin /fonts/* inlines cleanly.
const FONT_FACE_CSS = [400, 500, 600]
  .map(
    (w) => `@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:${w};` +
      `font-display:swap;src:url('/fonts/ibm-plex-mono-${w}.woff2') format('woff2');}`,
  )
  .join("");

async function ensureFont(): Promise<void> {
  if (typeof document === "undefined") return;
  if (!document.getElementById("ibm-plex-mono-font")) {
    const style = document.createElement("style");
    style.id = "ibm-plex-mono-font";
    style.textContent = FONT_FACE_CSS;
    document.head.appendChild(style);
  }
  try {
    const fonts = (document as Document & { fonts: FontFaceSet }).fonts;
    await Promise.all([
      fonts.load("400 12px 'IBM Plex Mono'"),
      fonts.load("500 12px 'IBM Plex Mono'"),
      fonts.load("600 22px 'IBM Plex Mono'"),
    ]);
    await fonts.ready;
  } catch { /* fall back to mono */ }
}

// One attestation row: muted label + full value that wraps (never truncated).
const attRow = (k: string, v: string) =>
  `<div><span style="font-size:10px;letter-spacing:1px;color:#7f7f86">${esc(k)}&nbsp;&nbsp;</span><span style="font-size:12px;color:#E7E7EA;word-break:break-all">${esc(v)}</span></div>`;

const txRow = (k: string, v: string, last = false) =>
  `<div style="display:grid;grid-template-columns:150px 1fr;padding:10px 0;${last ? "" : "border-bottom:1px dotted rgba(255,255,255,.09)"}">
     <span style="font-size:11px;letter-spacing:1px;color:#7f7f86">${esc(k)}</span>
     <span style="font-size:14px;color:#E7E7EA;word-break:break-all">${esc(v)}</span></div>`;

const idField = (k: string, v?: string) =>
  v ? `<div><div style="font-size:10px;letter-spacing:1px;color:#7f7f86">${esc(k)}</div><div style="font-size:13px;color:#E7E7EA;margin-top:3px;word-break:break-word">${esc(v)}</div></div>` : "";

function receiptHtml(r: Receipt, qr: string, includeIdentity: boolean): string {
  const idHex = r.id.replace(/-/g, "").slice(0, 8).toUpperCase();
  const id = includeIdentity ? (r.identity || {}) : {};
  const network = r.chain_id ? (CHAINS[r.chain_id] || `Chain ${r.chain_id}`) : "—";
  const kindLabel = r.kind === "deposit" ? "Deposit" : "Withdrawal";
  const heroComment = r.kind === "deposit" ? "// deposit into shielded vault" : "// withdrawal from shielded vault";

  const parties = includeIdentity && Object.keys(id).length
    ? `<div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid rgba(255,255,255,.07)">
         <div style="padding:26px 40px;border-right:1px solid rgba(255,255,255,.07)">
           <div style="font-size:11px;letter-spacing:3px;color:${GOLD};margin-bottom:16px">MERCHANT / PAYER</div>
           <div style="display:flex;flex-direction:column;gap:12px">
             ${idField("NAME", id.merchant_name)}${idField("EMAIL", id.merchant_email)}${idField("ADDRESS", id.merchant_address)}${idField("TAX ID", id.tax_id)}
           </div>
         </div>
         <div style="padding:26px 40px">
           <div style="font-size:11px;letter-spacing:3px;color:${GOLD};margin-bottom:16px">PAYEE / RECIPIENT</div>
           <div style="display:flex;flex-direction:column;gap:12px">
             ${idField("NAME", id.payee_name)}${idField("EMAIL", id.payee_email)}${idField("ADDRESS", id.payee_address)}${idField("MEMO", id.memo)}
           </div>
         </div>
       </div>`
    : "";

  const att = [
    r.tee_address && attRow("SIGNER", r.tee_address),
    r.digest && attRow("DIGEST", r.digest),
    r.tee_signature && attRow("SIGNATURE", r.tee_signature),
    (r as { identity_hash?: string }).identity_hash && attRow("IDENTITY", (r as { identity_hash?: string }).identity_hash!),
    r.shielded_ref_hash && attRow("SHIELDED-REF", r.shielded_ref_hash),
    r.attestation_ref && attRow("ATTESTATION", r.attestation_ref),
  ].filter(Boolean).join("");

  return `
  <div style="width:780px;background:#0A0A0B;border:1px solid rgba(255,255,255,.09);border-radius:14px;overflow:hidden;font-family:'IBM Plex Mono',ui-monospace,monospace;color:#E7E7EA">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:36px 40px 28px">
      <div style="display:flex;align-items:center;gap:14px">
        ${LOGO_SVG}
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="font-size:22px;font-weight:600;letter-spacing:5px;color:#fff">SIPHON</div>
          <div style="font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:${GOLD}">Compliant Receipt</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:10px">
        <div style="font-size:13px;letter-spacing:1px;color:${GOLD}">#${idHex}</div>
        <div style="display:flex;align-items:center;gap:7px;font-size:11px;letter-spacing:2px;color:#E7E7EA;border:1px solid ${GOLD};padding:4px 10px;border-radius:6px">
          <span style="width:6px;height:6px;border-radius:50%;background:${GOLD}"></span>SIGNED
        </div>
      </div>
    </div>
    <div style="padding:8px 40px 30px;border-top:1px solid rgba(255,255,255,.07)">
      <div style="display:flex;align-items:baseline;gap:12px;margin-top:22px">
        <span style="font-size:62px;font-weight:600;letter-spacing:0;color:#fff;line-height:1">${esc(r.amount ?? "—")}</span>
        <span style="font-size:24px;color:#9a9aa0">${esc(r.token ?? "")}</span>
      </div>
      <div style="font-size:13px;color:#7f7f86;margin-top:12px">${heroComment}</div>
    </div>
    <div style="padding:26px 40px;border-top:1px solid rgba(255,255,255,.07)">
      <div style="font-size:11px;letter-spacing:3px;color:${GOLD};margin-bottom:16px">TRANSACTION</div>
      <div style="display:flex;flex-direction:column">
        ${txRow("TYPE", kindLabel)}
        ${txRow("AMOUNT", `${r.amount ?? "—"} ${r.token ?? ""}`.trim())}
        ${txRow("NETWORK", network)}
        ${txRow("DATE", fmtDate(r.occurred_at))}
        ${r.counterparty ? txRow(r.kind === "deposit" ? "FROM" : "TO", r.counterparty) : ""}
        ${txRow("TX HASH", r.tx_hash || "—", true)}
      </div>
    </div>
    ${parties}
    <div style="padding:28px 40px;border-top:1px solid rgba(255,255,255,.07);background:rgba(214,168,78,.06)">
      <div style="display:flex;gap:28px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;letter-spacing:3px;color:${GOLD};margin-bottom:12px">ENCLAVE ATTESTATION</div>
          <div style="font-size:12.5px;line-height:1.7;color:#a9a9af;max-width:420px">Signed inside Siphon's attested TEE. Scan to verify — recompute the digest, recover the signer, and confirm it is the report_data-bound enclave. No party sees the shielded position.</div>
          <div style="margin-top:18px;display:flex;flex-direction:column;gap:8px">${att}</div>
        </div>
        <div style="flex-shrink:0;padding:8px;background:#E9E2CF;border-radius:8px"><img src="${qr}" alt="verification QR" style="display:block;width:128px;height:128px"></div>
      </div>
    </div>
    <div style="padding:18px 40px;border-top:1px solid rgba(255,255,255,.07);font-size:10.5px;line-height:1.7;color:#66666c">This receipt certifies a completed on-chain settlement. Counterparties and positions beyond those listed are never revealed. siphon.money/verify · ${idHex}</div>
  </div>`;
}

/** Render the 1a receipt design to a downloadable, card-sized PDF. */
export async function downloadReceiptPdf(
  r: Receipt,
  opts: { includeIdentity?: boolean; orderSignerUrl?: string; verifyBaseUrl?: string } = {},
): Promise<void> {
  await ensureFont();
  // The QR encodes a short VERIFY URL (not the full payload) so it stays low-density and scannable
  // at print size — the page it opens fetches the receipt and runs the check.
  // Prefer the branded app origin (siphon.money) — a Next rewrite proxies /verify/* to the
  // executor, so the QR shows the branded domain rather than the raw …sslip.io host.
  const appOrigin = typeof window !== "undefined" ? window.location.origin : "https://siphon.money";
  const base = (opts.verifyBaseUrl || appOrigin).replace(/\/+$/, "");
  const verifyUrl = `${base}/verify/receipt/${r.id}`;
  const qr = await QRCode.toDataURL(verifyUrl, {
    margin: 0, width: 320, errorCorrectionLevel: "M", color: { dark: "#0A0A0B", light: "#E9E2CF" },
  }).catch(() => "");

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;background:#0A0A0B;padding:0";
  host.innerHTML = receiptHtml(r, qr, opts.includeIdentity ?? false);
  document.body.appendChild(host);
  const card = host.firstElementChild as HTMLElement;

  try {
    // html2canvas-pro: maintained fork that fixes stock html2canvas 1.4.1's text bugs — dropped
    // word-spacing in wrapped paragraphs and mis-rendered (negative) letter-spacing that jammed
    // the receipt text together. API-compatible.
    const { default: html2canvas } = await import("html2canvas-pro");
    const canvas = await html2canvas(card, {
      scale: 2,
      backgroundColor: "#0A0A0B",
      useCORS: true,
      logging: false,
      // html2canvas rasterises into a cloned iframe document — inject the @font-face there too so
      // the mono font is present in the clone, not just the live page.
      //
      // ...and then WAIT for it, which is the whole point. html2canvas-pro awaits
      // `documentClone.fonts.ready` BEFORE it calls onclone (html2canvas-pro.esm.js ~7847), so the
      // face injected here has never been waited on. The clone then rasterises in the
      // `ui-monospace` fallback while the glyph positions were measured against IBM Plex Mono.
      // Both are monospace, so the output still LOOKS right — it just has the wrong advances, and
      // the text jams into itself ("0.03USDC", "depositintoshieldedvault").
      //
      // onclone's own promise IS awaited (same file, next line), so awaiting here is the fix.
      onclone: async (clonedDoc: Document) => {
        const s = clonedDoc.createElement("style");
        s.textContent = FONT_FACE_CSS;
        clonedDoc.head.appendChild(s);
        const f = (clonedDoc as Document & { fonts?: FontFaceSet }).fonts;
        if (!f) return;
        try {
          // Same weights as ensureFont(). A woff2 face is size-independent, so the px in the
          // descriptor only has to parse — the weight is what selects the right file.
          await Promise.all([400, 500, 600].map((w) => f.load(`${w} 12px 'IBM Plex Mono'`)));
          await f.ready;
        } catch {
          /* fall back to mono — a jammed receipt beats no receipt */
        }
      },
    });
    const wPx = card.offsetWidth, hPx = card.offsetHeight;
    const doc = new jsPDF({ unit: "px", format: [wPx, hPx], orientation: hPx >= wPx ? "portrait" : "landscape" });
    doc.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, wPx, hPx);
    doc.save(`siphon-receipt-${r.id.replace(/-/g, "").slice(0, 8).toLowerCase()}.pdf`);
  } finally {
    document.body.removeChild(host);
  }
}
