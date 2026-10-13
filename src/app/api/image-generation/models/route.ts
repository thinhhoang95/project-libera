import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { defaultImageModel, getImageGenerationModels } from "@/lib/image-generation-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json({ models: await getImageGenerationModels(request.signal), defaultModel: defaultImageModel() });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load image models.", 502);
  }
}
