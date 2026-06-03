import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import {
  createNotebookGroup,
  deleteNotebookGroup,
  toStorageError,
  updateNotebookGroup,
} from "@/lib/storage";

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
    const body = (await request.json()) as {
      description?: string;
      notebookNames?: string[];
      title?: string;
    };

    return NextResponse.json(await createNotebookGroup(body));
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
      description?: string;
      id?: string;
      notebookNames?: string[];
      title?: string;
    };

    return NextResponse.json(await updateNotebookGroup(body.id ?? "", body));
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
    const id = request.nextUrl.searchParams.get("id") ?? "";
    return NextResponse.json(await deleteNotebookGroup(id));
  } catch (error) {
    return handleError(error);
  }
}
