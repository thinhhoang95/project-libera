import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { readInk, writeInk } from "@/lib/storage/ink";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

/** `?path=` a file, and optionally `chunks=page-0001,page-0002` (else every chunk with ink). */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const filePath = request.nextUrl.searchParams.get("path") ?? "";
    const chunks = request.nextUrl.searchParams.get("chunks");
    return NextResponse.json(await readInk(filePath, chunks ? chunks.split(",").filter(Boolean).slice(0, 500) : undefined));
  } catch (error) {
    return handleError(error);
  }
}

/**
 * `{ path, chunk, frame, ops: { add, erase, unerase }, rendering? }`: changes to
 * this computer's ink; `rendering` is a Markdown ink block's SVG source.
 */
export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      path?: string;
      chunk?: string;
      frame?: unknown;
      ops?: unknown;
      rendering?: string;
    };

    return NextResponse.json(await writeInk(body.path ?? "", body.chunk ?? "", body.ops, body.frame, { rendering: body.rendering }));
  } catch (error) {
    return handleError(error);
  }
}
