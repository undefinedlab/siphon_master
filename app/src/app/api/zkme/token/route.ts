/**
 * Server proxy: mint short-lived zkMe widget access tokens.
 * Keeps ZKME_API_KEY off the client.
 *
 * POST /api/zkme/token  { "lv": "zkKYC" }
 */
import { NextRequest, NextResponse } from "next/server";
import { gatePrivilegedProxy } from "@/lib/privilegedProxyGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_URL = "https://nest-api.zk.me/api/token/get";

function zkMeCredentials(): { appId: string; apiKey: string } | null {
  const appId = (process.env.ZKME_MCH_NO || process.env.ZKME_APP_ID || "").trim();
  const apiKey = (process.env.ZKME_API_KEY || "").trim();
  if (!appId || !apiKey) return null;
  return { appId, apiKey };
}

/** zkMe docs: 1 = zkKYC, 2 = MeID */
function lvToCode(lv: string | undefined): number {
  const normalized = (lv || "zkKYC").trim().toLowerCase();
  if (normalized === "meid") return 2;
  return 1;
}

/** 0 = email/social (zkKYC), 1 = wallet address (MeID only). */
function apiModePermission(lv: string | undefined): number {
  const normalized = (lv || "zkKYC").trim().toLowerCase();
  if (normalized === "meid") {
    const raw = (process.env.ZKME_WIDGET_LOGIN_MODE || "wallet").trim().toLowerCase();
    return raw === "email" ? 0 : 1;
  }
  return 0;
}

export async function POST(req: NextRequest) {
  const gated = await gatePrivilegedProxy(req, {
    bucket: "zkme-token",
    max: Number(process.env.ZKME_TOKEN_RATE_MAX || "20"),
  });
  if (!gated.ok) return gated.response;

  const creds = zkMeCredentials();
  if (!creds) {
    return NextResponse.json({ error: "zkme_unconfigured" }, { status: 503 });
  }

  let body: { lv?: string } = {};
  try {
    body = JSON.parse(gated.bodyText || "{}") as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: creds.apiKey,
        appId: creds.appId,
        apiModePermission: apiModePermission(body.lv),
        lv: lvToCode(body.lv),
      }),
      cache: "no-store",
    });
    const data = (await resp.json()) as {
      code?: number;
      data?: { accessToken?: string };
      msg?: string;
    };
    const token = data.data?.accessToken;
    if (!resp.ok || !token) {
      return NextResponse.json(
        { error: "zkme_token_failed", message: data.msg ?? `HTTP ${resp.status}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ accessToken: token });
  } catch (err) {
    return NextResponse.json(
      { error: "zkme_unreachable", message: String(err) },
      { status: 503 },
    );
  }
}
