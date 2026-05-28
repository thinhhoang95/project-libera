import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import {
  readImageAnnotations,
  toStorageError,
  writeImageAnnotations,
} from "@/lib/storage";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const filePath = request.nextUrl.searchParams.get("path") ?? "";
    return NextResponse.json(await readImageAnnotations(filePath));
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      path?: string;
      annotations?: unknown;
    };

    return NextResponse.json(
      await writeImageAnnotations(body.path ?? "", body.annotations ?? []),
    );
  } catch (error) {
    return handleError(error);
  }
}
