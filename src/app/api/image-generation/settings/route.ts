import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { readImageGenerationSettings, writeImageGenerationSettings } from "@/lib/image-generation-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await readImageGenerationSettings(), { headers: { "Cache-Control": "no-store" } });
  } catch { return jsonError("Could not load image generation settings.", 500); }
}

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError("Invalid image generation settings.", 400); }
  try { return NextResponse.json(await writeImageGenerationSettings(body)); } catch {
    return jsonError("Could not save image generation settings. Please retry.", 500);
  }
}
