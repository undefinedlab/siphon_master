/**
 * Hard ASP child admit is postman/admin only — never forward from the browser.
 * Client-supplied parent edges were a critical ASP membership forge + privacy leak.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      error: "forbidden",
      message:
        "Child label admit is postman-only (on-chain ChangeLabeled). Browser /set/child is disabled.",
    },
    { status: 403 },
  );
}
