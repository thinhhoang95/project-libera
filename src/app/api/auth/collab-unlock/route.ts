// Re-enter the master password so the collab host can read the sign-in shared
// by the person's other computers (electron/collab/control/shared-sign-in.ts).
// Needed when Libera opened on a still-valid session cookie: then no password
// was typed this launch and the host cannot decrypt the shared file.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { verifyPassword } from "@/lib/auth";
import { CollabHostError, unlockCollabHostAndWait } from "@/lib/collab/host-client";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  if (typeof body?.password !== "string" || !body.password) {
    return NextResponse.json({ error: "Password is required." }, { status: 400 });
  }
  if (!verifyPassword(body.password).ok) {
    return NextResponse.json({ error: "That is not your Libera master password." }, { status: 403 });
  }

  try {
    await unlockCollabHostAndWait(body.password);
  } catch (error) {
    if (error instanceof CollabHostError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return NextResponse.json({ ok: true });
}
