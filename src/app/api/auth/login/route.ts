import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, getSessionCookieOptions, SESSION_COOKIE_NAME, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { password?: string } | null;

  if (!body?.password) {
    return NextResponse.json({ error: "Password is required." }, { status: 400 });
  }

  const verification = verifyPassword(body.password);

  if (!verification.ok) {
    const message =
      verification.reason === "missing-config"
        ? "Password authentication is not configured."
        : "Invalid password.";

    return NextResponse.json({ error: message }, { status: 401 });
  }

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(), getSessionCookieOptions());

  return response;
}
