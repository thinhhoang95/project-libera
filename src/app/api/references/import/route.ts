import { readFile, stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import {
  isReferenceImportPath,
  parseReferenceImport,
  planReferenceImport,
  referenceImportFormatForPath,
  referenceImportOutcome,
  ReferenceImportError,
  type ReferenceImportFormat,
} from "@/lib/references/import";
import { LibraryOpError } from "@/lib/references/library-ops";
import { MAX_TEXT_FILE_BYTES } from "@/lib/storage/constants";
import { StorageError, toStorageError } from "@/lib/storage/errors";
import { assertSafeSegment, filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { readReferenceLibrary, ReferenceRevisionConflict, updateReferenceLibrary } from "@/lib/storage/references";

export const runtime = "nodejs";

// POST { notebook, format, text } or { notebook, path } → { library, added,
// errors, duplicates, renamedKeys } (the "Import and export" contract in
// docs/references/lanes.md). Text, and files read by path, are limited to
// the size the editor opens as text.

const FORMATS: readonly ReferenceImportFormat[] = ["auto", "bibtex", "ris", "csl-json"];
/** JSON escaping can double the text; the text itself is checked separately. */
const MAX_BODY_BYTES = MAX_TEXT_FILE_BYTES * 2 + 4096;
/** The plan is made against the library it is applied to; retry when another writer gets there first. */
const MAX_ATTEMPTS = 5;
const TOO_LARGE = `References to import are limited to ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB.`;

function handleError(error: unknown) {
  if (error instanceof ReferenceImportError) return jsonError(error.message, error.status);
  if (error instanceof ReferenceRevisionConflict) return jsonError("The reference library is busy. Try again.", 409);
  if (error instanceof LibraryOpError) return jsonError(error.message, 400);
  if (error instanceof StorageError) return jsonError(error.message, error.status);
  const storageError = toStorageError(error);
  if (storageError.status === 500) console.error("[references] Could not import references.", error);
  return jsonError(storageError.status === 500 ? "Could not import the references." : storageError.message, storageError.status);
}

/** A reference file in the library, through the same checks as every file route. Hidden and reserved folders are refused. */
async function readLibraryReferenceFile(relativePath: string) {
  const { notebook, pathParts } = splitFilePath(relativePath);
  if (notebook.startsWith(".")) throw new StorageError("Path segment is reserved.");
  if (!isReferenceImportPath(relativePath)) throw new ReferenceImportError("Only .bib, .ris, .json and .nbib files can be imported into References.");
  const absolutePath = filePathFromParts(notebook, pathParts);
  let size: number;
  try {
    const stats = await stat(absolutePath);
    if (!stats.isFile()) throw new StorageError(`“${relativePath}” is not a file.`, 400);
    size = stats.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StorageError("File was not found.", 404);
    throw error;
  }
  if (size > MAX_TEXT_FILE_BYTES) throw new ReferenceImportError(TOO_LARGE, 413);
  const text = await readFile(absolutePath, "utf8");
  if (text.includes("\u0000")) throw new ReferenceImportError(`“${pathParts.at(-1)}” is not a text file.`, 415);
  return text;
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonError(TOO_LARGE, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return jsonError("The request is not valid JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("The request is invalid.");
    const { notebook, format, text, path } = body as { notebook?: unknown; format?: unknown; text?: unknown; path?: unknown };
    if (typeof notebook !== "string") return jsonError("Notebook name is required.");
    const safeNotebook = assertSafeSegment(notebook, "Notebook name");

    let parsed;
    if (typeof path === "string") {
      const source = await readLibraryReferenceFile(path);
      parsed = parseReferenceImport(source, referenceImportFormatForPath(path, source));
    } else if (typeof text === "string") {
      if (text.length > MAX_TEXT_FILE_BYTES) return jsonError(TOO_LARGE, 413);
      const chosen = format ?? "auto";
      if (typeof chosen !== "string" || !FORMATS.includes(chosen as ReferenceImportFormat)) {
        return jsonError("Import format must be auto, bibtex, ris or csl-json.");
      }
      parsed = parseReferenceImport(text, chosen as ReferenceImportFormat);
    } else {
      return jsonError("Send the references as text, or the path of a reference file.");
    }

    for (let attempt = 1; ; attempt++) {
      const before = await readReferenceLibrary(safeNotebook);
      const plan = planReferenceImport(before, parsed);
      if (!plan.ops.length) return NextResponse.json(referenceImportOutcome(before, before, plan, parsed.errors));
      try {
        const after = await updateReferenceLibrary(safeNotebook, before.revision, plan.ops);
        return NextResponse.json(referenceImportOutcome(before, after, plan, parsed.errors));
      } catch (error) {
        if (!(error instanceof ReferenceRevisionConflict) || attempt >= MAX_ATTEMPTS) throw error;
      }
    }
  } catch (error) {
    return handleError(error);
  }
}
