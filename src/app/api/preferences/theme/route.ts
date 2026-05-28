import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { isThemePreference } from "@/lib/theme";
import { writeConfiguredThemePreference } from "@/lib/theme-config";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  const body = (await request.json().catch(() => null)) as { theme?: unknown } | null;
  const theme = body?.theme;

  if (!isThemePreference(theme)) {
    return jsonError("Theme must be light or dark.", 400);
  }

  try {
    return NextResponse.json({
      theme: await writeConfiguredThemePreference(theme),
    });
  } catch (error) {
    return jsonError(
      `Unable to save theme: ${error instanceof Error ? error.message : "Unknown error."}`,
      500,
    );
  }
}
