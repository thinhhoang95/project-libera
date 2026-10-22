import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { PythonRunError, runPythonSidecar } from "@/lib/python/execute";
import { PYTHON_CELL_ID, pythonSidecarPath } from "@/lib/python/sidecar";
import { toStorageError } from "@/lib/storage/errors";
import { assertMarkdownFileName } from "@/lib/storage/file-types";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { migratePythonSidecar } from "@/lib/storage/markdown-assets";

export const runtime = "nodejs";

/** Resolve Code links, including sidecars saved using the original layout. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const document = request.nextUrl.searchParams.get("document") ?? "";
  try {
    assertMarkdownFileName(splitFilePath(document).name);
    await migratePythonSidecar(document);
    const sidecar = splitFilePath(pythonSidecarPath(document));
    await readFile(filePathFromParts(sidecar.notebook, sidecar.pathParts), "utf8");
    return NextResponse.json({ path: pythonSidecarPath(document) });
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}

/**
 * Re-run a note's Python from the Visual editor: `{ document, cell? }` runs
 * the saved sidecar up to `cell` (every cell without one) and saves the
 * figures. The note is not changed here: the editor points its images at the
 * new figures, so the change is part of its draft and its undo.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { document?: unknown; cell?: unknown };
  const document = typeof body.document === "string" ? body.document : "";
  const cell = typeof body.cell === "string" && body.cell ? body.cell : undefined;
  if (cell !== undefined && !PYTHON_CELL_ID.test(cell)) return jsonError("The cell id is invalid.", 400);

  let source: string;
  try {
    assertMarkdownFileName(splitFilePath(document).name);
    await migratePythonSidecar(document);
    const sidecar = splitFilePath(pythonSidecarPath(document));
    source = await readFile(filePathFromParts(sidecar.notebook, sidecar.pathParts), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return jsonError(`This note has no Python file (${pythonSidecarPath(document).split("/").pop()}).`, 404);
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }

  try {
    const result = await runPythonSidecar({ documentPath: document, source, cell, signal: request.signal });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PythonRunError) return jsonError(error.message, 422);
    return jsonError(error instanceof Error ? error.message : "Running Python failed.", 500);
  }
}
