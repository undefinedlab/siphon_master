/**
 * Browser → /api/solana/admit-deposit → solasp POST /solana/admit-deposit.
 *
 * Heals ZK notes that deposited without the watcher admitting them into the association set
 * (the usual cause of `asp path: label … not member` on Devnet withdraw).
 */
import { NextRequest, NextResponse } from "next/server";
import { aspBaseUrl, aspProxyHeaders } from "@/lib/aspServerUrl";
import { gatePrivilegedProxy, requireWalletMatch } from "@/lib/privilegedProxyGate";
import { isSolanaWalletAddress } from "@/lib/apiWalletAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SOLANA_ZK_CHAIN_ID = 900002;

type Body = {
  chainId?: number;
  depositor?: string;
  commitment?: string;
  userSalt?: string;
  signature?: string;
  label?: string;
};

export async function POST(req: NextRequest) {
  const gated = await gatePrivilegedProxy(req, {
    bucket: "solana-admit-deposit",
    max: Number(process.env.SOLANA_ADMIT_RATE_MAX || "20"),
  });
  if (!gated.ok) return gated.response;

  let body: Body;
  try {
    body = JSON.parse(gated.bodyText || "{}") as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const chainId = Number(body.chainId ?? SOLANA_ZK_CHAIN_ID);
  const depositor = (body.depositor || "").trim();
  const commitment = (body.commitment || "").trim();
  const userSalt = String(body.userSalt ?? "").trim();
  const signature = (body.signature || "").trim();
  const label = (body.label || "").trim();

  if (chainId !== SOLANA_ZK_CHAIN_ID || !depositor || !commitment || !userSalt || !signature) {
    return NextResponse.json(
      { error: "invalid_request", message: "chainId 900002, depositor, commitment, userSalt, signature required" },
      { status: 400 },
    );
  }
  if (!isSolanaWalletAddress(depositor)) {
    return NextResponse.json({ error: "invalid_depositor" }, { status: 400 });
  }
  const mismatch = requireWalletMatch(gated.wallet, depositor, "depositor");
  if (mismatch) return mismatch;

  const base = aspBaseUrl(chainId);
  if (!base) {
    return NextResponse.json({ error: "asp_unconfigured" }, { status: 503 });
  }

  try {
    // Re-screen first so admit-deposit's screen_binding_failed cannot strand a fresh note.
    const screenUp = await fetch(`${base.replace(/\/+$/, "")}/screen`, {
      method: "POST",
      headers: aspProxyHeaders(base, { "Content-Type": "application/json" }, chainId),
      body: JSON.stringify({ chainId, depositor, commitment, userSalt }),
      signal: AbortSignal.timeout(60_000),
    });
    const screenBody = (await screenUp.json().catch(() => ({}))) as { decision?: string; error?: string };
    if (!screenUp.ok || screenBody.decision !== "admit") {
      return NextResponse.json(
        {
          error: "screen_required",
          message: screenBody.error || `screen decision=${screenBody.decision || screenUp.status}`,
          screen: screenBody,
        },
        { status: 403 },
      );
    }

    const upstream = await fetch(`${base.replace(/\/+$/, "")}/solana/admit-deposit`, {
      method: "POST",
      headers: aspProxyHeaders(base, { "Content-Type": "application/json" }, chainId),
      body: JSON.stringify({
        chainId,
        depositor,
        commitment,
        userSalt,
        signature,
        ...(label ? { label } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: "invalid_upstream_json", raw: text.slice(0, 200) };
    }
    // Older solasp builds lack this route — fall back to bulk admit-pending.
    if (upstream.status === 404) {
      const bulk = await fetch(`${base.replace(/\/+$/, "")}/solana/admit-pending`, {
        method: "POST",
        headers: aspProxyHeaders(base, { "Content-Type": "application/json" }, chainId),
        body: JSON.stringify({ chainId }),
        signal: AbortSignal.timeout(180_000),
      });
      const bulkText = await bulk.text();
      let bulkData: unknown = null;
      try {
        bulkData = bulkText ? JSON.parse(bulkText) : null;
      } catch {
        bulkData = { error: "invalid_upstream_json", raw: bulkText.slice(0, 200) };
      }
      return NextResponse.json(bulkData ?? {}, { status: bulk.status });
    }
    return NextResponse.json(data ?? {}, { status: upstream.status });
  } catch (e) {
    return NextResponse.json(
      { error: "asp_unreachable", message: e instanceof Error ? e.message : "fail" },
      { status: 503 },
    );
  }
}
