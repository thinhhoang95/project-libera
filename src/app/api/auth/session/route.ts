import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, getSessionExpiresAt } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const expiresAt = getSessionExpiresAt(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  return NextResponse.json({
    authenticated: expiresAt !== null,
    expiresAt,
  }, { headers: { "Cache-Control": "no-store" } });
}
