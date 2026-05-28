import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { createNotebook, deleteNotebook, renameNotebook, toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as { name?: string };
    return NextResponse.json(await createNotebook(body.name ?? ""));
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
    const body = (await request.json()) as { path?: string; name?: string };
    return NextResponse.json(await renameNotebook(body.path ?? "", body.name ?? ""));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const notebook = request.nextUrl.searchParams.get("path") ?? "";
    return NextResponse.json(await deleteNotebook(notebook));
  } catch (error) {
    return handleError(error);
  }
}
