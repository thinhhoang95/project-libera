import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { isIllustrationImageId, isIllustrationSetId } from "../../../../../../electron/notebook-illustrations.cjs";
import { illustrationFilePath } from "../../../../../../electron/notebook-illustration-store.cjs";
import { getAdminRoot } from "@/lib/storage/paths";

export const runtime = "nodejs";

type Context = { params: Promise<{ setId: string; imageId: string }> };

/** An illustration from one of the user's sets. A new crop gets a new id, so it can be cached for good. */
export async function GET(request: NextRequest, context: Context) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const { setId, imageId } = await context.params;
  if (!isIllustrationSetId(setId) || !isIllustrationImageId(imageId)) return jsonError("Illustration not found.", 404);
  try {
    const image = await readFile(illustrationFilePath(getAdminRoot(), setId, imageId));
    return new Response(new Uint8Array(image), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    return jsonError("Illustration not found.", (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500);
  }
}
