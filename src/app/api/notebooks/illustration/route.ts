import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage/errors";
import { readNotebookCover, setNotebookIllustration } from "@/lib/storage/notebook-covers";

export const runtime = "nodejs";

function failure(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

/** A notebook's own cover. Each pick gets a new file name, so it can be cached for good. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const { image, type } = await readNotebookCover(
      request.nextUrl.searchParams.get("notebook") ?? "",
      request.nextUrl.searchParams.get("file") ?? "",
    );
    return new Response(new Uint8Array(image), {
      headers: { "Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    return failure(error);
  }
}

/** `{ notebook, illustration }`: an illustration URL from a set, or null for a random one. */
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const body = (await request.json().catch(() => null)) as { notebook?: unknown; illustration?: unknown } | null;
    const illustration = typeof body?.illustration === "string" ? body.illustration : null;
    return NextResponse.json(await setNotebookIllustration(typeof body?.notebook === "string" ? body.notebook : "", illustration));
  } catch (error) {
    return failure(error);
  }
}
