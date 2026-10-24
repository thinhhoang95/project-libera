import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getAccountUsage } from "@/lib/openrouter-pricing";

export const runtime = "nodejs";

/** GET /api/usage/account → the OpenRouter key's own counters and credit limit, or `{ account: null }` without a key. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json({ account: await getAccountUsage() });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not reach OpenRouter.", 502);
  }
}
