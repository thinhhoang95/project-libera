import { NextRequest, NextResponse } from "next/server";
import { jsonError, renewArchiveAccess, requireAuth } from "@/lib/api";
import {
  ARCHIVE_COOKIE_NAME,
  archiveUnlockRetryAfterMs,
  getExpiredCookieOptions,
  recordArchiveUnlockAttempt,
  verifyPassword,
} from "@/lib/auth";

export const runtime = "nodejs";

/** Unlock the Protected Archive with the Libera password, entered again. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const retryAfterMs = archiveUnlockRetryAfterMs();
  if (retryAfterMs > 0) {
    const seconds = Math.ceil(retryAfterMs / 1000);
    return NextResponse.json(
      { error: `Too many wrong passwords. Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.` },
      { status: 429, headers: { "Retry-After": String(seconds) } },
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  if (typeof body?.password !== "string" || !body.password) return jsonError("Password is required.", 400);

  const verification = verifyPassword(body.password);
  if (!verification.ok) {
    if (verification.reason === "missing-config") return jsonError("Password authentication is not configured.", 500);
    recordArchiveUnlockAttempt(false);
    return jsonError("Wrong password.", 401);
  }

  recordArchiveUnlockAttempt(true);
  return renewArchiveAccess(NextResponse.json({ unlocked: true }));
}

/** Lock the archive again. */
export function DELETE() {
  const response = NextResponse.json({ unlocked: false });
  response.cookies.set(ARCHIVE_COOKIE_NAME, "", getExpiredCookieOptions());
  return response;
}
