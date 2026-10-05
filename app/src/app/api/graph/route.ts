import { NextRequest, NextResponse } from "next/server";
import {
  assertBrowserSameOrigin,
  walletAuthResponse,
} from "@/lib/apiWalletAuth";
import {
  assessStrategyArming,
  getAnonymitySet,
  getRecentVaultSwaps,
  getUniswapPoolDepth,
  MAX_SWAP_QUERY_LIMIT,
} from "@siphon/sdk-ts/graph";
import {
  authorizeGraphHttp,
  clientKeyFromRequest,
  graphHttpAuthResponse,
  isRateLimited,
} from "@/lib/graphHttpGuard";

export const runtime = "nodejs";

function parseChainId(raw: string | null): number | null {
  const n = Number(raw || "8453");
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Agent / Builder vault-index data plane (Ponder REST via trade-executor).
 * GET ?action=anonymity-set|pool-depth|swaps|assess
 * pool-depth is a deprecated stub (no The Graph).
 */
export async function GET(req: NextRequest) {
  const originDeny = assertBrowserSameOrigin(req);
  if (originDeny) return walletAuthResponse(originDeny)!;

  const denied = graphHttpAuthResponse(authorizeGraphHttp(req));
  if (denied) return denied;

  const ip = clientKeyFromRequest(req);
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const action = (req.nextUrl.searchParams.get("action") || "").trim();
  const chainId = parseChainId(req.nextUrl.searchParams.get("chainId"));
  if (chainId == null) {
    return NextResponse.json({ error: "invalid_chainId" }, { status: 400 });
  }

  try {
    if (action === "anonymity-set") {
      const asset = (req.nextUrl.searchParams.get("asset") || "ETH").toUpperCase();
      if (!["ETH", "USDC"].includes(asset)) {
        return NextResponse.json({ error: "unsupported_asset" }, { status: 400 });
      }
      const data = await getAnonymitySet(chainId, asset);
      return NextResponse.json(data);
    }
    if (action === "pool-depth") {
      const tokenIn = (req.nextUrl.searchParams.get("tokenIn") || "USDC").toUpperCase();
      const tokenOut = (req.nextUrl.searchParams.get("tokenOut") || "ETH").toUpperCase();
      const data = await getUniswapPoolDepth(chainId, tokenIn, tokenOut);
      return NextResponse.json(data);
    }
    if (action === "swaps") {
      const limit = Math.min(
        Number(req.nextUrl.searchParams.get("limit") || "10"),
        MAX_SWAP_QUERY_LIMIT,
      );
      const data = await getRecentVaultSwaps(chainId, limit);
      return NextResponse.json(data);
    }
    if (action === "assess") {
      const fromAsset = (req.nextUrl.searchParams.get("fromAsset") || "USDC").toUpperCase();
      const toAsset = req.nextUrl.searchParams.get("toAsset");
      const includeSwap = req.nextUrl.searchParams.get("includeSwap") !== "false";
      const data = await assessStrategyArming({
        chainId,
        fromAsset,
        toAsset: toAsset ? toAsset.toUpperCase() : null,
        includeSwap,
      });
      return NextResponse.json(data);
    }
    return NextResponse.json(
      {
        error: "unknown_action",
        actions: ["anonymity-set", "pool-depth", "swaps", "assess"],
      },
      { status: 400 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "graph_error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const originDeny = assertBrowserSameOrigin(req);
  if (originDeny) return walletAuthResponse(originDeny)!;

  const denied = graphHttpAuthResponse(authorizeGraphHttp(req));
  if (denied) return denied;

  let body: {
    action?: string;
    chainId?: number;
    asset?: string;
    fromAsset?: string;
    toAsset?: string;
    tokenIn?: string;
    tokenOut?: string;
    includeSwap?: boolean;
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const action = body.action || "assess";
  const chainId = body.chainId ?? 8453;
  const url = req.nextUrl.clone();
  url.searchParams.set("action", action);
  url.searchParams.set("chainId", String(chainId));
  if (body.asset) url.searchParams.set("asset", body.asset);
  if (body.fromAsset) url.searchParams.set("fromAsset", body.fromAsset);
  if (body.toAsset) url.searchParams.set("toAsset", body.toAsset);
  if (body.tokenIn) url.searchParams.set("tokenIn", body.tokenIn);
  if (body.tokenOut) url.searchParams.set("tokenOut", body.tokenOut);
  if (body.includeSwap != null) url.searchParams.set("includeSwap", String(body.includeSwap));
  if (body.limit != null) url.searchParams.set("limit", String(body.limit));

  return GET(
    new NextRequest(url, {
      headers: req.headers,
    }),
  );
}
