import { NextRequest, NextResponse } from "next/server";
import { jsonError, renewArchiveAccess, requireArchiveAccess, requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";

const MAX_IDS = 10_000;

export const text = (value: unknown) => (typeof value === "string" ? value : "");

export const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= 100).slice(0, MAX_IDS) : [];

/**
 * Authenticate, parse the JSON body, run a gallery change and report storage errors.
 * `archive` routes also need the Protected Archive unlocked, and keep it unlocked.
 */
export async function galleryRoute(request: NextRequest, run: (body: Record<string, unknown>) => Promise<unknown>, { archive = false } = {}) {
  const authError = archive ? requireArchiveAccess(request) : requireAuth(request);
  if (authError) return authError;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return jsonError("Invalid request.", 400); }
  try {
    const response = NextResponse.json(await run(body ?? {}));
    return archive ? renewArchiveAccess(response) : response;
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
