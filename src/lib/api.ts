import { NextRequest, NextResponse } from "next/server";
import { SESSION_EXPIRED_HEADER } from "@/lib/auth-session";
import {
  ARCHIVE_COOKIE_NAME,
  createArchiveToken,
  getArchiveCookieOptions,
  SESSION_COOKIE_NAME,
  verifyArchiveToken,
  verifySessionToken,
} from "@/lib/auth";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function requireAuth(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!verifySessionToken(token)) {
    const response = jsonError("Authentication required.", 401);
    response.headers.set(SESSION_EXPIRED_HEADER, "1");
    return response;
  }

  return null;
}

/** Signed in, and the password was entered again to open the Protected Archive. */
export function requireArchiveAccess(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  if (!verifyArchiveToken(request.cookies.get(ARCHIVE_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "The Protected Archive is locked.", locked: true }, { status: 403 });
  }

  return null;
}

/** Keeps the archive open while it is in use; it relocks after a quiet spell. */
export function renewArchiveAccess(response: NextResponse) {
  response.cookies.set(ARCHIVE_COOKIE_NAME, createArchiveToken(), getArchiveCookieOptions());
  return response;
}
