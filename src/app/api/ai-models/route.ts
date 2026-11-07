import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getAiModelChoices } from "@/lib/ai-preferences";

export const runtime = "nodejs";

/** The Model Pool and each editor action's default, for the model picker in the editors' context menus. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  return NextResponse.json(getAiModelChoices());
}
