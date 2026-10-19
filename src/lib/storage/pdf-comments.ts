import { randomUUID } from "node:crypto";
import { MAX_PDF_COMMENT_CHARS, normalizePdfCommentAnchor } from "@/lib/pdf-comments";
import { StorageError } from "@/lib/storage/errors";
import { readPdfCommentThreads, updatePdfCommentThreads } from "@/lib/storage/annotations";
import type { PdfCommentMessage, PdfCommentThread, PdfCommentsPayload } from "@/lib/types";

// Review comments on PDFs. Threads are kept in the PDF's annotation sidecar
// (`.libera/annotations/pdf/by-path/<path>.json`, key `comments`), so renames,
// moves, copies, archiving and deletion of the PDF or its folders carry them
// exactly as they carry its highlights. Each operation changes one thread
// under the sidecar's lock, so the viewer saving markup and the agent
// replying never overwrite each other.

export { readPdfCommentThreads as readPdfComments };

export type PdfCommentAction =
  | { action: "comment"; anchor: unknown; text: unknown }
  | { action: "reply"; threadId: unknown; text: unknown }
  | { action: "edit"; threadId: unknown; messageId: unknown; text: unknown }
  | { action: "resolve"; threadId: unknown; resolved: unknown }
  | { action: "delete"; threadId: unknown }
  | { action: "delete-message"; threadId: unknown; messageId: unknown };

function commentText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new StorageError("Enter a comment.");
  if (text.length > MAX_PDF_COMMENT_CHARS) throw new StorageError(`Comments are limited to ${MAX_PDF_COMMENT_CHARS.toLocaleString("en")} characters.`);
  return text;
}

function findThread(threads: PdfCommentThread[], threadId: unknown) {
  const thread = typeof threadId === "string" ? threads.find((candidate) => candidate.id === threadId) : undefined;
  if (!thread) throw new StorageError("Comment thread was not found.", 404);
  return thread;
}

function touched(thread: PdfCommentThread, now: string, patch: Partial<PdfCommentThread>): PdfCommentThread {
  return { ...thread, ...patch, updatedAt: now };
}

/** Applies one Comments-panel action to a PDF's threads and returns them all. */
export async function changePdfComments(relativePath: string, input: PdfCommentAction): Promise<PdfCommentsPayload> {
  const now = new Date().toISOString();
  const { payload } = await updatePdfCommentThreads(relativePath, (threads) => {
    switch (input.action) {
      case "comment": {
        const anchor = normalizePdfCommentAnchor(input.anchor);
        if (!anchor) throw new StorageError("Select text on a page to comment on.");
        const thread: PdfCommentThread = { id: randomUUID(), anchor, status: "open", messages: [{ id: randomUUID(), text: commentText(input.text), createdAt: now }], createdAt: now, updatedAt: now };
        return { threads: [...threads, thread], result: thread.id };
      }
      case "reply": {
        const thread = findThread(threads, input.threadId);
        const message: PdfCommentMessage = { id: randomUUID(), text: commentText(input.text), createdAt: now };
        return { threads: threads.map((t) => t === thread ? touched(t, now, { messages: [...t.messages, message] }) : t), result: thread.id };
      }
      case "edit": {
        const thread = findThread(threads, input.threadId);
        const target = thread.messages.find((message) => message.id === input.messageId);
        if (!target) throw new StorageError("Comment was not found.", 404);
        if (target.author === "agent") throw new StorageError("The agent's replies cannot be edited.");
        const text = commentText(input.text);
        return { threads: threads.map((t) => t === thread ? touched(t, now, { messages: t.messages.map((m) => m === target ? { ...m, text, editedAt: now } : m) }) : t), result: thread.id };
      }
      case "resolve": {
        const thread = findThread(threads, input.threadId);
        return { threads: threads.map((t) => t === thread ? touched(t, now, { status: input.resolved === true ? "resolved" : "open" }) : t), result: thread.id };
      }
      case "delete": {
        const thread = findThread(threads, input.threadId);
        return { threads: threads.filter((t) => t !== thread), result: thread.id };
      }
      case "delete-message": {
        const thread = findThread(threads, input.threadId);
        const index = thread.messages.findIndex((message) => message.id === input.messageId);
        if (index < 0) throw new StorageError("Comment was not found.", 404);
        // The opening comment carries the thread; deleting it deletes the thread.
        if (index === 0) return { threads: threads.filter((t) => t !== thread), result: thread.id };
        return { threads: threads.map((t) => t === thread ? touched(t, now, { messages: t.messages.filter((_, i) => i !== index) }) : t), result: thread.id };
      }
      default:
        throw new StorageError("Unknown comment action.");
    }
  });
  return payload;
}

/** The agent's reply in a thread (ReplyToComment). StorageError 404 when the thread is gone. */
export async function addPdfCommentReply(relativePath: string, threadId: string, text: string, author?: "agent") {
  const now = new Date().toISOString();
  const { result } = await updatePdfCommentThreads(relativePath, (threads) => {
    const thread = findThread(threads, threadId);
    const message: PdfCommentMessage = { id: randomUUID(), text: commentText(text), createdAt: now, ...(author ? { author } : {}) };
    return { threads: threads.map((t) => t === thread ? touched(t, now, { messages: [...t.messages, message] }) : t), result: message };
  });
  return result;
}
