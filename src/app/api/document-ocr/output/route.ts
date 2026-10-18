import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { createSharedFile, SharedWriteError, writeSharedText } from "@/lib/collab/shared-writes";
import type { Provenance } from "@/lib/collab/protocol/actor";
import { toStorageError } from "@/lib/storage";
import { getFileType } from "@/lib/storage/file-types";
import { pathExists } from "@/lib/storage/fs-utils";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { getFileNode } from "@/lib/storage/tree";

export const runtime = "nodejs";

/**
 * Where "Convert PDF to Markdown" writes when the PDF is in a shared
 * notebook. The Markdown file is created through the collab host's file
 * operations, and each converted page is applied as minimal edits with AI
 * provenance, so collaborators see the pages arrive, attributed to the user's
 * AI, and nothing writes the working copy behind the host's back.
 *
 * The feature is "image-to-markdown": the conversion is the same local model
 * reading page images into Markdown as the Image to Markdown feature, and the
 * collaboration protocol's AiFeature list has no separate PDF entry.
 *
 * For PDFs anywhere else, POST answers { shared: false } and the job keeps
 * using the ordinary file routes, unchanged.
 */
const PROVENANCE: Provenance = { source: "ai", feature: "image-to-markdown" };
const MAX_CONTENT_CHARS = 20_000_000;

/** SharedWriteErrors are StorageErrors: their status and message (503 when the host is unavailable) go to the client. */
function errorResponse(error: unknown) {
  const storageError = toStorageError(error);
  return jsonError(storageError.message, storageError.status);
}

/** Body { pdfPath }: creates "<stem>.md" (or "<stem> (2).md", …) beside a shared PDF. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let body: { pdfPath?: unknown } | null;
  try { body = await request.json(); } catch { return jsonError("Invalid request.", 400); }
  const pdfPath = typeof body?.pdfPath === "string" ? body.pdfPath : "";
  if (!pdfPath || getFileType(pdfPath) !== "pdf") return jsonError("A PDF path is required.", 400);
  if (!isSharedNotebookPath(pdfPath)) return NextResponse.json({ shared: false });
  try {
    const { notebook, pathParts } = splitFilePath(pdfPath);
    const directory = pathParts.slice(0, -1);
    const stem = (pathParts.at(-1) ?? "Document").replace(/\.pdf$/i, "") || "Document";
    for (let copy = 1; copy <= 50; copy += 1) {
      const name = copy === 1 ? `${stem}.md` : `${stem} (${copy}).md`;
      const parts = [...directory, name];
      if (await pathExists(filePathFromParts(notebook, parts))) continue;
      try {
        await createSharedFile([notebook, ...parts].join("/"), "");
      } catch (error) {
        // Created by a collaborator but not on this disk yet: try the next name.
        if (error instanceof SharedWriteError && error.status === 409) continue;
        throw error;
      }
      return NextResponse.json({ shared: true, file: await getFileNode(notebook, parts) });
    }
    return jsonError(`Could not find a free name for ${stem}.md.`, 409);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Body { path, content, previous }: replaces the converted text of a shared
 * Markdown file. `previous` is what the job wrote last; if the document no
 * longer matches it (someone edited the file during the conversion), nothing
 * is applied and the job stops, keeping the pages written so far.
 */
export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let body: { path?: unknown; content?: unknown; previous?: unknown } | null;
  try { body = await request.json(); } catch { return jsonError("Invalid request.", 400); }
  const filePath = typeof body?.path === "string" ? body.path : "";
  if (!filePath || getFileType(filePath) !== "markdown") return jsonError("A Markdown path is required.", 400);
  if (typeof body?.content !== "string" || typeof body.previous !== "string" || body.content.length > MAX_CONTENT_CHARS) {
    return jsonError("The converted text is missing or too large.", 400);
  }
  if (!isSharedNotebookPath(filePath)) return jsonError(`${filePath} is not in a shared notebook.`, 400);
  try {
    const result = await writeSharedText(filePath, body.content, PROVENANCE, { expectedBefore: body.previous });
    if (result.conflict) {
      return jsonError(`${filePath} was changed by someone else during the conversion, so the conversion stopped. The pages converted before that are kept.`, 409);
    }
    return NextResponse.json({ text: result.text });
  } catch (error) {
    return errorResponse(error);
  }
}
