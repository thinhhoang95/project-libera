import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { deleteTranscript, editTranscriptSegments, readTranscript, renameTranscriptSpeakers } from "@/lib/storage/transcripts";
import { getTranscriptionJobs } from "@/lib/transcription/jobs";
import type { TranscriptPayload } from "@/lib/transcription/types";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = error instanceof StorageError || (error as { code?: string })?.code ? toStorageError(error) : null;
  if (storageError) return jsonError(storageError.message, storageError.status);
  return jsonError(error instanceof Error ? error.message : "Something went wrong.", 500);
}

async function payload(path: string): Promise<TranscriptPayload> {
  const { transcript, stale, shared } = await readTranscript(path);
  return { path, transcript, stale, shared, job: getTranscriptionJobs().get(path) };
}

/** A recording's transcript, and the transcription in progress if there is one. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await payload(request.nextUrl.searchParams.get("path") ?? ""));
  } catch (error) {
    return handleError(error);
  }
}

/** Start transcribing: `{ path, engine?, speakers?, language? }`. The viewer polls GET for progress. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const body = (await request.json()) as { path?: string; engine?: unknown; speakers?: unknown; language?: unknown };
    const path = body.path ?? "";
    getTranscriptionJobs().start(path, {
      engine: body.engine === "local" || body.engine === "openrouter" ? body.engine : undefined,
      speakers: Number.isInteger(body.speakers) && (body.speakers as number) >= 0 && (body.speakers as number) <= 12 ? body.speakers as number : undefined,
      language: typeof body.language === "string" && /^[a-z]{0,3}$/.test(body.language) ? body.language : undefined,
    });
    return NextResponse.json(await payload(path));
  } catch (error) {
    return handleError(error);
  }
}

/** Rename speakers, `{ path, speakers: { "0": "Vy" } }`, or save the reader's corrections, `{ path, segments }`. */
export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const body = (await request.json()) as { path?: string; speakers?: Record<string, unknown>; segments?: unknown };
    if (body.segments !== undefined) await editTranscriptSegments(body.path ?? "", body.segments);
    const names = Object.fromEntries(Object.entries(body.speakers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (Object.keys(names).length || body.segments === undefined) await renameTranscriptSpeakers(body.path ?? "", names);
    return NextResponse.json(await payload(body.path ?? ""));
  } catch (error) {
    return handleError(error);
  }
}

/** `?path=…` cancels a running transcription; `&transcript=1` deletes the transcript. */
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const path = request.nextUrl.searchParams.get("path") ?? "";
    getTranscriptionJobs().cancel(path);
    if (request.nextUrl.searchParams.get("transcript") === "1") await deleteTranscript(path);
    return NextResponse.json(await payload(path));
  } catch (error) {
    return handleError(error);
  }
}
