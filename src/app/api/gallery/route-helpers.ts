import { NextRequest, NextResponse } from "next/server";
import { jsonError, renewArchiveAccess, requireArchiveAccess, requireAuth } from "@/lib/api";
import type { GalleryContents } from "@/lib/image-generation";
import { toStorageError } from "@/lib/storage";
import { withSharing } from "@/lib/storage/gallery-sharing";

const MAX_IDS = 10_000;

export const text = (value: unknown) => (typeof value === "string" ? value : "");

export const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= 100).slice(0, MAX_IDS) : [];

function isContents(value: unknown): value is GalleryContents {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as GalleryContents).albums) && Array.isArray((value as GalleryContents).photos);
}

/** Adds shared-album details to gallery contents in a route's answer (the answer itself, or its `gallery`). */
export async function shared<T>(result: T): Promise<T> {
  if (isContents(result)) return await withSharing(result) as T;
  if (result && typeof result === "object" && isContents((result as { gallery?: unknown }).gallery)) {
    return { ...result, gallery: await withSharing((result as unknown as { gallery: GalleryContents }).gallery) };
  }
  return result;
}

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
    const response = NextResponse.json(await shared(await run(body ?? {})));
    return archive ? renewArchiveAccess(response) : response;
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
