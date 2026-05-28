import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return NextResponse.json({
    authenticated: verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value),
  });
}
