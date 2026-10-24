import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getModelInfo } from "@/lib/openrouter-pricing";
import type { UsageReport } from "@/lib/spending";
import { readUsageBuckets } from "@/lib/storage/usage-ledger";

export const runtime = "nodejs";

/** The Spending page's data: GET /api/usage → every recorded OpenRouter request, hourly per model, with model prices. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { buckets, since } = await readUsageBuckets();
    const models = await getModelInfo(new Set(buckets.map((bucket) => bucket.model)));
    return NextResponse.json({ buckets, models, since } satisfies UsageReport);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not read spending history.", 500);
  }
}
