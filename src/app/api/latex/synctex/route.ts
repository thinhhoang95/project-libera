import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { synctexForward, synctexInverse } from "@/lib/latex/synctex";
import { toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.rootPath !== "string" || typeof body.buildId !== "string") return jsonError("Compile the document first.", 400);

  try {
    if (body.direction === "forward") {
      if (typeof body.path !== "string" || !finite(body.line)) return jsonError("Invalid source position.", 400);
      const locations = await synctexForward(body.rootPath, body.buildId, body.path, body.line, finite(body.column) ? body.column : 0);
      return NextResponse.json({ locations });
    }
    if (body.direction === "inverse") {
      if (!finite(body.page) || !finite(body.x) || !finite(body.y)) return jsonError("Invalid PDF position.", 400);
      return NextResponse.json({ location: await synctexInverse(body.rootPath, body.buildId, body.page, body.x, body.y) });
    }
    return jsonError("Unknown SyncTeX direction.", 400);
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}
