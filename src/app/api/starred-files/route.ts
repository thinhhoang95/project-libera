import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError, updateStarredFile } from "@/lib/storage";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      path?: string;
      starred?: boolean;
    };

    return NextResponse.json(
      await updateStarredFile(body.path ?? "", Boolean(body.starred)),
    );
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
