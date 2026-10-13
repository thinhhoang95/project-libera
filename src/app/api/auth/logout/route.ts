import { NextResponse } from "next/server";
import { ARCHIVE_COOKIE_NAME, getExpiredCookieOptions, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE_NAME, "", getExpiredCookieOptions());
  // Signing out also locks the Protected Archive.
  response.cookies.set(ARCHIVE_COOKIE_NAME, "", getExpiredCookieOptions());

  return response;
}
