import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import {
  cancelLocalModelDownload,
  getLocalModelStatus,
  isLocalModelId,
  startLocalModelDownload,
  type LocalModelId,
} from "@/lib/models/local-models";

export const runtime = "nodejs";

type Context = { params: Promise<{ model: string }> };

async function modelId(request: NextRequest, context: Context): Promise<LocalModelId | NextResponse> {
  const authError = requireAuth(request);
  if (authError) return authError;
  const { model } = await context.params;
  return isLocalModelId(model) ? model : jsonError("Unknown model.", 404);
}

/** Whether a local model is installed, or how far its download has come. */
export async function GET(request: NextRequest, context: Context) {
  const id = await modelId(request, context);
  if (id instanceof NextResponse) return id;
  return NextResponse.json(await getLocalModelStatus(id));
}

/** Start downloading the model; the client polls GET for progress. */
export async function POST(request: NextRequest, context: Context) {
  const id = await modelId(request, context);
  if (id instanceof NextResponse) return id;
  try {
    startLocalModelDownload(id);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not start the download.", 409);
  }
  return NextResponse.json(await getLocalModelStatus(id));
}

/** Cancel a running download. The files so far are kept so it can resume. */
export async function DELETE(request: NextRequest, context: Context) {
  const id = await modelId(request, context);
  if (id instanceof NextResponse) return id;
  cancelLocalModelDownload(id);
  return NextResponse.json(await getLocalModelStatus(id));
}
