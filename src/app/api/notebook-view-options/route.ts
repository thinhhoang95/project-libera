import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError, updateNotebookViewOptions } from "@/lib/storage";
import type { LiberaNotebookViewOptions } from "@/lib/types";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as Partial<LiberaNotebookViewOptions>;
    return NextResponse.json(await updateNotebookViewOptions(body));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
