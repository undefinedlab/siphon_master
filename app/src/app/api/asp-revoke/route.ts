/**
 * Browser-authenticated v3 pre-admit exit ticket.
 *
 * The browser may ask to make one of ITS real deposits ragequit-eligible, but it never receives
 * ASP_POSTMAN_TOKEN. We verify the request-bound wallet signature and the exact on-chain deposit,
 * then forward the evidence to ASP `/set/revoke`, which derives the label again from userSalt.
 */
import { NextRequest, NextResponse } from "next/server";

import { assertV3ExitTicketReceipt } from "@/lib/aspAdmitReceipt";
import { aspBaseUrl, aspPostmanProxyHeaders, aspPostmanToken, aspPostmanUpstreamUrl } from "@/lib/aspServerUrl";
import { gatePrivilegedProxy, requireWalletMatch } from "@/lib/privilegedProxyGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExitTicketBody = {
  chainId?: number;
  label?: string;
  commitment?: string;
  txHash?: string;
  userSalt?: string;
  vault?: string;
  depositor?: string;
};

function decimalField(value: string, { nonZero = false }: { nonZero?: boolean } = {}): boolean {
  try {
    const parsed = BigInt(value);
    return parsed >= (nonZero ? 1n : 0n);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const gated = await gatePrivilegedProxy(req, {
    bucket: "asp-revoke",
    max: Number(process.env.ASP_REVOKE_RATE_MAX || "8"),
  });
  if (!gated.ok) return gated.response;

  if (!aspBaseUrl()) return NextResponse.json({ error: "asp_unconfigured" }, { status: 503 });

  let body: ExitTicketBody;
  try {
    body = JSON.parse(gated.bodyText || "{}") as ExitTicketBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const chainId = Number(body.chainId);
  const label = String(body.label || "").trim();
  const commitment = String(body.commitment || "").trim();
  const txHash = String(body.txHash || "").trim();
  const userSalt = String(body.userSalt || "").trim();
  const vault = String(body.vault || "").trim();
  const depositor = String(body.depositor || "").trim().toLowerCase();

  if (
    !Number.isSafeInteger(chainId) ||
    !decimalField(label, { nonZero: true }) ||
    !decimalField(commitment, { nonZero: true }) ||
    !decimalField(userSalt, { nonZero: true }) ||
    !/^0x[0-9a-fA-F]{64}$/.test(txHash) ||
    !/^0x[0-9a-fA-F]{40}$/.test(vault)
  ) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: "valid chainId, label, commitment, txHash, userSalt, and vault required",
      },
      { status: 400 },
    );
  }
  const mismatch = requireWalletMatch(gated.wallet, depositor, "depositor");
  if (mismatch) return mismatch;

  const aspUrl = aspBaseUrl(chainId);
  if (!aspPostmanToken(chainId)) {
    return NextResponse.json({ error: "asp_postman_unconfigured" }, { status: 503 });
  }

  const receipt = await assertV3ExitTicketReceipt({
    chainId,
    txHash,
    depositor,
    vault,
    commitment,
    userSalt,
  });
  if (!receipt.ok) return NextResponse.json(receipt.body, { status: receipt.status });

  try {
    const upstream = await fetch(aspPostmanUpstreamUrl(aspUrl, "revoke"), {
      method: "POST",
      headers: aspPostmanProxyHeaders(undefined, chainId),
      body: JSON.stringify({
        chainId,
        label,
        commitment,
        txHash,
        userSalt,
        vault,
        depositor,
        reason: "user_pre_admit_exit",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = { error: "invalid_upstream_json" };
    }
    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    return NextResponse.json(
      {
        error: "asp_unreachable",
        message: error instanceof Error ? error.message : "ASP unreachable",
      },
      { status: 503 },
    );
  }
}
