import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { copyReferenceEntries } from "@/lib/references/copy-entries";
import { isValidCitationKey } from "@/lib/references/keys";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";

export const runtime = "nodejs";

// POST /api/references/copy with { from, to, keys } (notebook names and
// citation keys or aliases in `from`) → { keys: { key: destinationKey },
// copied, reused, missing, destinationRevision }. Copies the entries behind
// the keys into `to`'s library the way copy-on-move does
// (src/lib/references/copy-entries.ts), reusing the same work when `to`
// already has it.

const MAX_KEYS = 200;

function handleError(error: unknown) {
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error("[references] Could not copy references.", error);
  return jsonError(storageError.status === 500 ? "Could not copy the references." : storageError.message, storageError.status);
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    let body: unknown;
    try { body = await request.json(); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { from, to, keys } = body as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string") return jsonError("from and to must be notebook names.");
    const source = assertSafeSegment(from, "Notebook name");
    const destination = assertSafeSegment(to, "Notebook name");
    if (!Array.isArray(keys) || !keys.length) return jsonError("keys must list at least one citation key.");
    if (keys.length > MAX_KEYS) return jsonError(`Copy at most ${MAX_KEYS} references at once.`);
    if (!keys.every((key): key is string => typeof key === "string" && isValidCitationKey(key))) return jsonError("keys must be citation keys.");
    return NextResponse.json(await copyReferenceEntries(source, destination, keys), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
