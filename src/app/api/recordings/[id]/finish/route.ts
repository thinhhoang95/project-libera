import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { finishRecording } from "@/lib/recording/sessions";
import { getTree } from "@/lib/storage";
import { toStorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Save the recording, its transcript and its recap into the notebook. */
export async function POST(request: NextRequest, context: Context) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { id } = await context.params;
    const finished = await finishRecording(id);
    return NextResponse.json({ ...finished, tree: await getTree() });
  } catch (error) {
    // Encoder and speech-model failures say what went wrong; storage errors keep their status.
    const storageError = toStorageError(error);
    const message = storageError.status === 500 && error instanceof Error ? error.message : storageError.message;
    return NextResponse.json({ error: message }, { status: storageError.status });
  }
}
