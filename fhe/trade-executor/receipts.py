"""Compliant receipts API — mint, list, share, verify.

Design: 'compliant by disclosure'. A receipt is a user-held, cryptographically-notarised record
of a shielded deposit/withdrawal. The PUBLIC layer reveals only what's already on-chain; the
IDENTITY layer (merchant/payee) is encrypted and returned only to the authenticated owner; the
ATTESTATION layer (enclave signature over the digest) lets anyone verify authenticity without
trusting Siphon. Nothing here goes on-chain, and the shielded note is stored as a hash only — so
a withdrawal receipt can never be relinked to its funding deposit through this table.
"""
from __future__ import annotations  # executor runs Python 3.9 — defer `X | None` annotations

import hashlib
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify

from database import db, Receipt
from wallet_auth import verify_wallet_sig, verify_wallet_write
import receipt_signer

receipts_bp = Blueprint("receipts", __name__)

_VALID_KINDS = {"deposit", "withdraw"}
# Identity sub-fields we accept from the generate-receipt form (mirrors the DashX modal).
_IDENTITY_FIELDS = (
    "merchant_name", "merchant_email", "merchant_address", "tax_id",
    "payee_name", "payee_email", "payee_address", "memo",
)


def _clean_identity(raw: dict | None) -> dict:
    """Keep only known identity fields, trimmed. Empty values dropped so the digest is stable."""
    raw = raw or {}
    out = {}
    for k in _IDENTITY_FIELDS:
        v = raw.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = v.strip()
    return out


def _parse_ts(v) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        return None


@receipts_bp.post("/receipt")
# Minting a receipt is a MUTATING route, so it must sit on the write lane like every other one
# (app.py uses @verify_wallet_write throughout). It was on the read verifier, which reads
# X-Signature / X-Timestamp — but the client sends the write headers X-Write-Signature /
# X-Write-Nonce, so the read check found nothing and every mint failed with
# "Invalid or missing wallet signature". GET /receipts below is a genuine read and stays as-is.
@verify_wallet_write
def create_receipt(wallet=None):
    """Mint a receipt for a settled transaction. Wallet-sig gated: the recovered wallet is the
    owner (body user_id is ignored). Computes the canonical digest, has the enclave sign it, and
    stores the encrypted identity layer. Returns the owner view (identity included)."""
    data = request.json or {}
    kind = str(data.get("kind", "")).lower()
    if kind not in _VALID_KINDS:
        return jsonify({"error": f"kind must be one of {sorted(_VALID_KINDS)}"}), 400

    identity = _clean_identity(data.get("identity"))
    public = {
        "kind": kind,
        "tx_hash": data.get("tx_hash"),
        "chain_id": data.get("chain_id"),
        "token": data.get("token"),
        "amount": (str(data["amount"]) if data.get("amount") is not None else None),
        "counterparty": data.get("counterparty"),
        # Normalise to an ISO string for a stable digest.
        "occurred_at": (_parse_ts(data.get("occurred_at")).isoformat() if _parse_ts(data.get("occurred_at")) else None),
    }

    # Shielded reference is stored as a hash only — never the note secret / linkage.
    shielded_ref = data.get("shielded_ref")
    shielded_ref_hash = (
        "0x" + hashlib.sha256(str(shielded_ref).encode()).hexdigest() if shielded_ref else None
    )

    id_hash = receipt_signer.identity_hash(identity)
    digest = receipt_signer.canonical_digest(public, identity, shielded_ref_hash)
    try:
        sig = receipt_signer.sign_receipt(digest)
    except Exception as e:
        return jsonify({"error": f"receipt signing failed: {e}"}), 502

    r = Receipt(
        user_id=wallet,
        kind=kind,
        tx_hash=public["tx_hash"],
        chain_id=public["chain_id"],
        token=public["token"],
        amount=public["amount"],
        counterparty=public["counterparty"],
        occurred_at=_parse_ts(public["occurred_at"]),
        identity=(__import__("json").dumps(identity) if identity else None),
        identity_hash=id_hash,
        shielded_ref_hash=shielded_ref_hash,
        strategy_id=data.get("strategy_id"),
        digest=digest,
        tee_signature=sig["signature"],
        tee_address=sig["address"],
        attestation_ref=sig["attestation_ref"],
        status="SIGNED",
    )
    db.session.add(r)
    db.session.commit()
    return jsonify({"receipt": r.to_dict(include_identity=True)}), 201


@receipts_bp.get("/receipts")
@verify_wallet_sig
def list_receipts(wallet=None):
    """List the authenticated owner's receipts (owner view, identity included)."""
    rows = (
        Receipt.query.filter_by(user_id=wallet)
        .order_by(Receipt.created_at.desc())
        .limit(500)
        .all()
    )
    return jsonify({"receipts": [r.to_dict(include_identity=True) for r in rows]})


@receipts_bp.get("/receipt/<receipt_id>")
def get_receipt_public(receipt_id):
    """Public view of a receipt (no identity) — safe to share via a link. The attestation layer is
    included so the recipient can verify authenticity."""
    r = Receipt.query.get(receipt_id)
    if not r:
        return jsonify({"error": "not found"}), 404
    return jsonify({"receipt": r.to_dict(include_identity=False)})


_VERIFY_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify · Siphon Receipt</title>
<style>
  :root{--gold:#D6A84E}
  *{box-sizing:border-box} body{margin:0;background:#0A0A0B;color:#E7E7EA;
    font-family:'IBM Plex Mono',ui-monospace,monospace;-webkit-font-smoothing:antialiased;
    display:flex;justify-content:center;padding:24px}
  .card{width:100%;max-width:520px;border:1px solid rgba(255,255,255,.09);border-radius:14px;overflow:hidden}
  .hd{padding:26px 26px 20px}
  .brand{font-size:16px;font-weight:600;letter-spacing:4px;color:#fff}
  .sub{font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:var(--gold);margin-top:6px}
  .verdict{display:flex;align-items:center;gap:12px;padding:22px 26px;border-top:1px solid rgba(255,255,255,.07)}
  .dot{width:12px;height:12px;border-radius:50%}
  .ok{background:#5FB07A;box-shadow:0 0 14px #5FB07A} .bad{background:#C96A62;box-shadow:0 0 14px #C96A62} .wait{background:#7f7f86}
  .vtext{font-size:15px;font-weight:600}
  .rows{padding:8px 26px 22px} .row{display:grid;grid-template-columns:120px 1fr;padding:9px 0;
    border-bottom:1px dotted rgba(255,255,255,.09);font-size:12.5px}
  .k{color:#7f7f86;letter-spacing:1px} .v{color:#E7E7EA;word-break:break-all}
  .chk{color:#5FB07A} .x{color:#C96A62} .note{padding:16px 26px;font-size:11px;color:#66666c;line-height:1.7;
    border-top:1px solid rgba(255,255,255,.07)}
</style></head><body>
<div class="card">
  <div class="hd"><div class="brand">SIPHON</div><div class="sub">Receipt Verification</div></div>
  <div class="verdict"><span id="dot" class="dot wait"></span><span id="verdict" class="vtext">Verifying…</span></div>
  <div class="rows" id="rows"></div>
  <div class="note">Recomputes the canonical digest and recovers the signer from the enclave signature. For full trust, confirm the signer is the report_data-bound order-signer enclave via its attestation.</div>
</div>
<script>
const ID=%RECEIPT_ID%;
const el=id=>document.getElementById(id);
const row=(k,v,cls)=>`<div class="row"><span class="k">${k}</span><span class="v ${cls||''}">${v}</span></div>`;
(async()=>{
  try{
    const rc=await fetch('/receipt/'+ID).then(r=>r.json());
    if(!rc.receipt){throw new Error('Receipt not found');}
    const r=rc.receipt;
    const vr=await fetch('/receipt/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(r)}).then(x=>x.json());
    const ok=vr.valid;
    el('dot').className='dot '+(ok?'ok':'bad');
    el('verdict').textContent=ok?'Authentic · signature valid':'Verification failed';
    const enclave=r.attestation_ref&&r.attestation_ref!=='dev';
    el('rows').innerHTML=[
      row('AMOUNT', (r.amount||'—')+' '+(r.token||'')),
      row('TYPE', r.kind),
      row('DIGEST', vr.digest_matches?'matches ✓':'MISMATCH ✕', vr.digest_matches?'chk':'x'),
      row('SIGNATURE', vr.signature_valid?'valid ✓':'INVALID ✕', vr.signature_valid?'chk':'x'),
      row('SIGNER', vr.recovered_signer||'—'),
      row('ATTESTED', enclave?'enclave ✓':'dev key (pre-CVM)', enclave?'chk':''),
      row('RECEIPT', '#'+ID.replace(/-/g,'').slice(0,8).toUpperCase()),
    ].join('');
  }catch(e){
    el('dot').className='dot bad'; el('verdict').textContent='Could not verify';
    el('rows').innerHTML=row('ERROR', e.message||'unknown', 'x');
  }
})();
</script></body></html>"""


@receipts_bp.get("/verify/receipt/<receipt_id>")
def verify_receipt_page(receipt_id):
    """Human-facing verification page (the receipt QR points here). Fetches the public receipt,
    recomputes the digest + recovers the signer, and shows a pass/fail verdict — scannable from any
    phone since it renders in the browser at the executor's public origin."""
    import json as _json
    safe_id = _json.dumps(str(receipt_id))  # inject as a JS string literal, escaped
    html = _VERIFY_PAGE.replace("%RECEIPT_ID%", safe_id)
    return html, 200, {"Content-Type": "text/html; charset=utf-8"}


@receipts_bp.post("/receipt/verify")
def verify_receipt():
    """Trustless-style verification helper: recompute the digest from the presented fields and
    recover the signer from the signature. A verifier can run this (or the client-side verifier)
    to confirm the receipt is authentic and unaltered. Full trust also checks the attestation
    quote binds `signer` to the genuine order-signer enclave (done client-side / L1+)."""
    data = request.json or {}
    public = {k: data.get(k) for k in ("kind", "tx_hash", "chain_id", "token", "amount", "counterparty", "occurred_at")}
    shielded_ref_hash = data.get("shielded_ref_hash")
    claimed_digest = data.get("digest")
    signature = data.get("tee_signature")
    claimed_signer = (data.get("tee_address") or "").lower()

    # Use the receipt's identity_hash commitment (public view carries no raw identity); only
    # recompute it if the discloser chose to include the full identity block.
    id_hash = data.get("identity_hash") or receipt_signer.identity_hash(data.get("identity"))
    recomputed = receipt_signer.digest_from_idhash(public, id_hash, shielded_ref_hash)
    digest_ok = (recomputed == claimed_digest) if claimed_digest else True

    signer = None
    sig_ok = False
    if signature and recomputed:
        try:
            from eth_account import Account
            from eth_account.messages import encode_defunct

            signer = Account.recover_message(encode_defunct(hexstr=recomputed), signature=signature).lower()
            sig_ok = (signer == claimed_signer) if claimed_signer else True
        except Exception:
            sig_ok = False

    return jsonify({
        "valid": bool(digest_ok and sig_ok and signer),
        "digest_matches": digest_ok,
        "signature_valid": sig_ok,
        "recovered_signer": signer,
        "recomputed_digest": recomputed,
        "attestation_ref": data.get("attestation_ref"),
        "note": "For full trust, also verify the attestation quote binds the signer to the genuine order-signer enclave.",
    })
