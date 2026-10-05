/**
 * Server proxy: browser → /api/asp-screen → siphon-asp POST /screen.
 * Keeps ASP_SCREEN_TOKEN off the client.
 *
 * Auth: wallet signature required; depositor must match authenticated wallet.
 */
import { NextRequest, NextResponse } from "next/server";
import { aspBaseUrl, aspProxyHeaders, aspScreenUpstreamUrl } from "@/lib/aspServerUrl";
import { gatePrivilegedProxy, requireWalletMatch } from "@/lib/privilegedProxyGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ScreenBody = {
  chainId?: number;
  depositor?: string;
  txHash?: string;
  commitment?: string;
  userSalt?: string;
  /** @deprecated never forward — privacy: soft screen is depositor-only */
  precommitment?: string;
  /** @deprecated never forward — Hard ASP admit is postman+on-chain only */
  label?: string;
  asset?: string;
};

export async function POST(req: NextRequest) {
  const gated = await gatePrivilegedProxy(req, {
    bucket: "asp-screen",
    max: Number(process.env.ASP_SCREEN_RATE_MAX || "30"),
  });
  if (!gated.ok) return gated.response;

  if (!aspBaseUrl()) {
    return NextResponse.json(
      { error: "asp_unconfigured", message: "ASP_URL is not set on the app server" },
      { status: 503 },
    );
  }

  let body: ScreenBody;
  try {
    body = JSON.parse(gated.bodyText || "{}") as ScreenBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const chainId = Number(body.chainId);
  const depositor = (body.depositor || "").trim();
  if (!Number.isFinite(chainId) || !depositor) {
    return NextResponse.json(
      { error: "invalid_request", message: "chainId and depositor required" },
      { status: 400 },
    );
  }

  const mismatch = requireWalletMatch(gated.wallet, depositor, "depositor");
  if (mismatch) return mismatch;

  const aspUrl = aspBaseUrl(chainId);
  const upstreamUrl = aspScreenUpstreamUrl(aspUrl);
  const headers = aspProxyHeaders(aspUrl, { "Content-Type": "application/json" }, chainId);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      // Privacy: never forward precommitment/label — soft screen is depositor KYT only;
      // Hard ASP membership is postman + LabelMinted, not client-supplied secrets.
      body: JSON.stringify({
        chainId,
        depositor,
        txHash: body.txHash || undefined,
        commitment: body.commitment || undefined,
        // Required alongside commitment for the ASP to create the PENDING record the deposit
        // watcher matches on (aspv2 app.py: `decision == admit and user_salt and commitment`).
        // Without it every deposit is scanned and then skipped, so the note never leaves In Review.
        // This is not a new disclosure: userSalt is already a public `deposit()` calldata argument.
        userSalt: body.userSalt || undefined,
        asset: body.asset || undefined,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const text = await upstream.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: "invalid_upstream_json", raw: text.slice(0, 200) };
    }

    // Privacy: strip hop-graph / checked addresses from browser-facing responses.
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      delete obj.checked;
      delete obj.addresses_checked;
    }

    return NextResponse.json(data ?? {}, { status: upstream.status });
  } catch (e) {
    console.warn("[asp-screen] upstream failed:", e);
    return NextResponse.json(
      {
        error: "asp_unreachable",
        message: e instanceof Error ? e.message : "ASP unreachable",
      },
      { status: 503 },
    );
  }
}
