import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getReferenceResolveSettings } from "@/lib/references/resolve/settings";

export const runtime = "nodejs";

// GET → { lookupOnline, useAi, webSearch, autoCreateForPdfs }: the
// Preferences → AI → References defaults, for the panel's toggles (the Add
// box's web search, the fact-check popover, "Follow Preferences"). The
// contact email and the model stay on the server.

type ReferencePreferenceDefaults = {
  lookupOnline: boolean;
  useAi: boolean;
  webSearch: boolean;
  autoCreateForPdfs: boolean;
};

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const settings = getReferenceResolveSettings();
  const body: ReferencePreferenceDefaults = {
    lookupOnline: settings.lookupOnline,
    useAi: settings.useAi,
    webSearch: settings.webSearchDefault,
    autoCreateForPdfs: settings.autoCreateForPdfs,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
