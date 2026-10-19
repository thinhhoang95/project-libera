import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { requireSharedDoc } from "@/lib/collab/shared-writes";
import { localThreads, pdfThreads, sharedThreads, threadLocation, type CommentThread } from "@/lib/agent/read-comments";
import { resolveLibraryPath, statLibraryPath } from "@/lib/agent/library";
import { commentsContext, type ChatCommentThread } from "@/lib/chat-comments";
import { getFileType } from "@/lib/storage/file-types";
import { toStorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

// A file's review comments as chat context, for an @Comments mention of a file
// other than the one in view (the panel reads that one's live comments). `text`
// is the editor's draft of an open Markdown or LaTeX file, which local anchors
// are mapped onto; without it the saved file is read.
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let body: { path?: unknown; text?: unknown } | null;
  try { body = await request.json(); } catch { return jsonError("Invalid comments request.", 400); }
  if (typeof body?.path !== "string" || !body.path || (body.text !== undefined && typeof body.text !== "string")) return jsonError("Invalid comments request.", 400);
  try {
    const resolved = await resolveLibraryPath(body.path);
    const fileType = getFileType(resolved.path);
    if (fileType !== "markdown" && fileType !== "latex" && fileType !== "pdf") return jsonError("Only Markdown, LaTeX and PDF files have review comments.", 400);
    const name = resolved.pathParts.at(-1) ?? resolved.path;
    let text = "";
    let threads: CommentThread[];
    if (fileType === "pdf") {
      const found = await pdfThreads(resolved.path);
      if (!found) return jsonError(`${name} was not found.`, 404);
      threads = found;
    } else if (isSharedNotebookPath(resolved.path)) {
      ({ text, threads } = await sharedThreads(resolved.path, await requireSharedDoc(resolved.path)));
    } else {
      if (typeof body.text === "string") text = body.text;
      else {
        if (!(await statLibraryPath(resolved))?.isFile()) return jsonError(`${name} was not found.`, 404);
        text = await readFile(resolved.absolutePath, "utf8");
      }
      threads = await localThreads(resolved.path, text);
    }
    const ordered = [...threads].sort((left, right) => (left.range?.start ?? Infinity) - (right.range?.start ?? Infinity));
    const chatThreads: ChatCommentThread[] = ordered.map((thread) => ({ status: thread.status, where: threadLocation(thread, text), messages: thread.messages }));
    return NextResponse.json({ context: commentsContext(resolved.path, name, chatThreads) });
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}
