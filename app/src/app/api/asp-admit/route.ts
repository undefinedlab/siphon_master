/**
 * Server proxy: after a mined deposit, postman admits the LabelMinted leaf into the ASP set
 * and publishes the root on-chain. Browser never holds ASP_POSTMAN_TOKEN.
 *
 * Auth: request-bound wallet signature (Siphon auth v1:req); depositor must match signed wallet.
 * Rate-limited per IP. Soft-fails upstream — deposit UX already treats admit as best-effort.
 */
import { NextRequest, NextResponse } from "next/server";
import { aspBaseUrl, aspPostmanProxyHeaders, aspPostmanToken, aspPostmanUpstreamUrl } from "@/lib/aspServerUrl";
import {
  assertBrowserSameOrigin,
  privilegedWalletAuthMaxAgeSec,
  verifyPrivilegedWalletAuthHeaders,
  walletAuthResponse,
} from "@/lib/apiWalletAuth";
import {
  clientKeyFromRequest,
  isRateLimited,
} from "@/lib/graphHttpGuard";
import { assertAdmitDepositReceipt, assertV3ExitTicketReceipt, commitAdmitTxHash } from "@/lib/aspAdmitReceipt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADMIT_RATE_MAX = Number(process.env.ASP_ADMIT_RATE_MAX || "20");

type AdmitBody = {
  chainId?: number;
  label?: string;
  txHash?: string;
  vault?: string;
  asset?: string;
  /** Must equal authenticated wallet (depositing EOA). */
  depositor?: string;
  /** v3/v5 deposits: the kernel emits Deposited(commitment, nonce), not LabelMinted. With these the
   *  receipt is checked like an exit ticket and the ASP derives the label from userSalt itself. */
  commitment?: string;
  userSalt?: string;
};

function isHexAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

function isTxHash(v: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(v);
}

export async function POST(req: NextRequest) {
  const originDeny = assertBrowserSameOrigin(req);
  if (originDeny) {
    return NextResponse.json(originDeny.body, { status: originDeny.status });
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const auth = verifyPrivilegedWalletAuthHeaders(
    req,
    bodyText,
    process.env,
    Math.floor(Date.now() / 1000),
    { maxAgeSec: privilegedWalletAuthMaxAgeSec() },
  );
  const denied = walletAuthResponse(auth);
  if (denied) return denied;
  const wallet = auth.ok ? auth.wallet : "";

  const ip = clientKeyFromRequest(req);
  if (isRateLimited(`asp-admit:${ip}`, ADMIT_RATE_MAX)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (wallet && wallet !== "optional" && isRateLimited(`asp-admit:w:${wallet}`, ADMIT_RATE_MAX)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  if (!aspBaseUrl()) {
    return NextResponse.json({ error: "asp_unconfigured" }, { status: 503 });
  }

  let body: AdmitBody;
  try {
    body = JSON.parse(bodyText) as AdmitBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const chainId = Number(body.chainId);
  const label = (body.label || "").trim();
  const txHash = (body.txHash || "").trim();
  const vault = (body.vault || body.asset || "").trim();
  const depositor = (body.depositor || "").trim().toLowerCase();

  if (!Number.isFinite(chainId) || !label || !txHash || !vault) {
    return NextResponse.json(
      { error: "invalid_request", message: "chainId, label, txHash, and vault required" },
      { status: 400 },
    );
  }
  if (!isTxHash(txHash)) {
    return NextResponse.json(
      { error: "invalid_request", message: "txHash must be 0x-prefixed 32-byte hex" },
      { status: 400 },
    );
  }
  if (!depositor || !isHexAddress(depositor)) {
    return NextResponse.json(
      { error: "invalid_request", message: "depositor (0x address) required" },
      { status: 400 },
    );
  }
  if (wallet !== "optional" && depositor !== wallet) {
    return NextResponse.json(
      { error: "depositor_mismatch", message: "depositor must match authenticated wallet" },
      { status: 403 },
    );
  }

  // Resolved per chain: a chain with its own ASP (ASP_URL_<id>) also has its own postman token.
  const aspUrl = aspBaseUrl(chainId);
  if (!aspPostmanToken(chainId)) {
    return NextResponse.json({ error: "asp_postman_unconfigured" }, { status: 503 });
  }

  const commitment = (body.commitment || "").trim();
  const userSalt = String(body.userSalt ?? "").trim();
  const v3 = Boolean(commitment && userSalt);
  // v5 never emits LabelMinted, so the legacy check 400'd label_not_minted on every v3 deposit —
  // and the ASP's /set/admit requires userSalt anyway. That dead path is the one that re-keys
  // admission when another deposit took the predicted nonce (the watcher cannot match it then).
  const receiptCheck = v3
    ? await assertV3ExitTicketReceipt({ chainId, txHash, depositor, vault, commitment, userSalt })
    : await assertAdmitDepositReceipt({ chainId, txHash, depositor, vault, label });
  if (!receiptCheck.ok) {
    return NextResponse.json(receiptCheck.body, { status: receiptCheck.status });
  }

  const upstreamUrl = aspPostmanUpstreamUrl(aspUrl, "admit");
  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: aspPostmanProxyHeaders(undefined, chainId),
      body: JSON.stringify({ chainId, label, txHash, vault, depositor, ...(v3 ? { commitment, userSalt } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: "invalid_upstream_json", raw: text.slice(0, 200) };
    }
    // Burn the txHash only once postman has actually taken the admit (OMEGA-07 replay guard).
    // Anything else — the ASP confirmation race, a timeout, a 5xx — must stay retryable, or the
    // deposit is stranded out of the association set for the full 24h TTL and can never be spent.
    if (upstream.ok) commitAdmitTxHash(txHash);
    return NextResponse.json(data ?? {}, { status: upstream.status });
  } catch (e) {
    console.warn("[asp-admit] upstream failed:", e);
    return NextResponse.json(
      { error: "asp_unreachable", message: e instanceof Error ? e.message : "ASP unreachable" },
      { status: 503 },
    );
  }
}
