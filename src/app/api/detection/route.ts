import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { cancelDetectionSetup, getDetectionStatus, startDetectionSetup } from "@/lib/detection/runtime";
import { DETECTION_VARIANTS, type DetectionVariantId } from "../../../../electron/detection-preferences.cjs";

export const runtime = "nodejs";

/** Whether the runtime, the text encoder and each YOLOE-26 variant are installed, and any setup in progress. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  return NextResponse.json(getDetectionStatus());
}

/** Install what `{ variant }` still needs; the client polls GET for progress. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = (await request.json().catch(() => ({}))) as { variant?: unknown };
  const variant = DETECTION_VARIANTS.find((entry) => entry.id === body.variant)?.id as DetectionVariantId | undefined;
  if (!variant) return jsonError("Choose a model variant.", 400);
  try {
    startDetectionSetup(variant);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not start the download.", 409);
  }
  return NextResponse.json(getDetectionStatus());
}

/** Cancel a running setup. Finished downloads are kept and resume. */
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  cancelDetectionSetup();
  return NextResponse.json(getDetectionStatus());
}
