import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { canSuggestShared, replyToSharedThread, SharedWriteError } from "@/lib/collab/shared-writes";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { addReviewReply } from "@/lib/storage/markdown-reviews";
import { addPdfCommentReply } from "@/lib/storage/pdf-comments";
import { localThreads, pdfThreads, sharedThreads, shortQuote, threadLocation, type CommentThread } from "./read-comments";
import { missingFileError, ok, readCurrentText, requireString, resolve, sharedDocFor, ToolError, type AgentTool, type ToolContext } from "./tools";

// ReplyToComment: a reply in an existing review thread, posted at once, so
// the agent follows up where the conversation already is instead of opening
// a second thread on the same passage. Local documents keep the reply in
// Libera's review store; shared ones send it through the collab host as the
// user's AI actor, queued when the server cannot be reached. PDFs keep the
// reply in the PDF's annotation sidecar; on a PDF the agent only replies,
// it never starts a thread.

const MAX_REPLY_CHARS = 20_000;
const STATE = "reply-to-comment";

/** Replies posted in this run, by thread, so a retried call does not post twice. */
function postedReplies(context: ToolContext) {
  let posted = context.skillState.get(STATE) as Map<string, string[]> | undefined;
  if (!posted) {
    posted = new Map();
    context.skillState.set(STATE, posted);
  }
  return posted;
}

const sameText = (left: string, right: string) => left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();

function unknownThread(path: string, threadId: string, threads: CommentThread[], text: string, pdf: boolean) {
  const open = threads.filter((thread) => !thread.resolved);
  if (!threads.length) return new ToolError(`${path} has no review comments, so there is no thread ${threadId} to reply to. ${pdf ? "You cannot start threads on a PDF; give your point in your reply to the user." : "To raise a new point, leave a comment with LeaveComment."}`);
  const listed = open.slice(0, 10).map((thread) => `- ${thread.id}: ${threadLocation(thread, text)}`);
  return new ToolError([
    `There is no thread ${threadId} on ${path}. Use a thread id exactly as ReadComments showed it.`,
    ...(listed.length ? [`Unresolved threads:`, ...listed, ...(open.length > listed.length ? [`(and ${open.length - listed.length} more; call ReadComments to see them all)`] : [])] : ["Every thread on it is resolved."]),
  ].join("\n"));
}

export const replyToCommentTool: AgentTool = {
  name: "ReplyToComment",
  kind: "comment",
  description: `Replies in an existing review comment thread on a Markdown, LaTeX or PDF file, the way a person answers in the Comments panel.

Usage:
- Call ReadComments first; thread_id is a thread's id exactly as ReadComments shows it.
- text is the reply itself, in Markdown: no ":::comment" block, no quoting of the thread.
- Prefer a reply over a new LeaveComment comment whenever your point is about something an existing thread already raises, or answers it. Leave a new comment only for a different point.
- The reply is posted at once; it cannot be changed or removed afterwards, so write it in one go. One reply per thread unless the user asks for more.
- Resolved threads cannot be replied to.
- On a PDF you can only reply: threads there are started by the user, and LeaveComment does not work on PDFs.
- In shared notebooks collaborators see the reply as AI acting for the user.`,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Library path of the Markdown, LaTeX or PDF file." },
      thread_id: { type: "string", description: "The thread's id, as ReadComments showed it." },
      text: { type: "string", description: "The reply, in Markdown." },
    },
    required: ["file_path", "thread_id", "text"],
    additionalProperties: false,
  },
  describe: (args) => `Replying to a comment on ${String(args.file_path ?? "a file")}`,
  async run(args, context) {
    const resolved = await resolve(context, requireString(args, "file_path"));
    const threadId = requireString(args, "thread_id").trim();
    const text = requireString(args, "text").trim();
    const fileType = getFileType(resolved.path);
    if (fileType !== "markdown" && fileType !== "latex" && fileType !== "pdf") throw new ToolError(`${resolved.path} is not a Markdown, LaTeX or PDF file; only .md, .tex and .pdf files have review comments.`);
    const pdf = fileType === "pdf";
    if (text.length > MAX_REPLY_CHARS) throw new ToolError(`The reply is too long (${text.length.toLocaleString("en")} characters). Keep replies under ${MAX_REPLY_CHARS.toLocaleString("en")} characters.`);
    if (/^[ \t]*:::[ \t]*(comment\b.*)?$/im.test(text)) throw new ToolError(`Write only the reply's text in text, without ":::comment" or ":::" lines. Nothing was posted.`);

    // PDF comments are kept beside the PDF in every notebook, shared or not.
    const shared = !pdf && isSharedNotebookPath(resolved.path) ? await sharedDocFor(context, resolved) : null;
    if (shared && !canSuggestShared(shared)) {
      throw new ToolError(shared.revoked || shared.role !== "viewer"
        ? `${resolved.path} is read-only: access to its shared notebook was revoked. Give your answer in your reply to the user instead.`
        : `Your role in this shared notebook (${shared.role}) cannot comment on ${resolved.path}. Give your answer in your reply to the user instead.`);
    }
    let documentText: string;
    let threads: CommentThread[];
    if (pdf) {
      const found = await pdfThreads(resolved.path);
      if (!found) return missingFileError(context, resolved);
      documentText = "";
      threads = found;
    } else if (shared) ({ text: documentText, threads } = await sharedThreads(resolved.path, shared));
    else {
      const current = await readCurrentText(context, resolved);
      if (!current) return missingFileError(context, resolved);
      documentText = current.content;
      threads = await localThreads(resolved.path, documentText);
    }

    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw unknownThread(resolved.path, threadId, threads, documentText, pdf);
    if (thread.resolved) throw new ToolError(`Thread ${threadId} on ${resolved.path} is resolved, so it takes no more replies. Leave it alone unless the problem is back; then ${pdf ? "tell the user in your reply" : "leave a new comment with LeaveComment, or tell the user in your reply"}. Nothing was posted.`);
    const posted = postedReplies(context);
    const earlier = posted.get(`${resolved.path}\n${threadId}`) ?? [];
    const last = thread.messages.filter((message) => !message.deleted).at(-1);
    if (earlier.some((reply) => sameText(reply, text)) || (last && sameText(last.text, text))) {
      throw new ToolError(`Thread ${threadId} already ends with this reply. Nothing was posted again.`);
    }

    let queued = false;
    if (shared) {
      try {
        const result = await replyToSharedThread(resolved.path, {
          threadId, body: text, doc: shared,
          ai: { feature: "review-comments", ...(context.model ? { model: context.model } : {}), runId: context.snapshots.runId },
        });
        queued = result.queued;
      } catch (error) {
        if (error instanceof SharedWriteError) {
          throw new ToolError(error.status === 404
            ? `Thread ${threadId} is no longer on ${resolved.path} (it may have just been deleted). Nothing was posted. Call ReadComments to see the current threads.`
            : `${error.message} Nothing was posted.`);
        }
        throw error;
      }
    } else {
      try {
        if (pdf) await addPdfCommentReply(resolved.path, threadId, text, "agent");
        else await addReviewReply(resolved.path, threadId, text, "agent");
      }
      catch (error) {
        if (error instanceof StorageError) {
          throw new ToolError(error.status === 404
            ? `Thread ${threadId} was removed from ${resolved.path} just now. Nothing was posted. Call ReadComments to see the current threads.`
            : `Could not save the reply: ${error.message} Nothing was posted.`);
        }
        throw error;
      }
    }
    posted.set(`${resolved.path}\n${threadId}`, [...earlier, text]);
    context.emit({ type: "comments_added", path: resolved.path, count: 1 });

    const opener = thread.messages.find((message) => !message.deleted);
    const about = opener ? ` (${opener.who}: ${shortQuote(opener.text, 80)})` : "";
    const where = threadLocation(thread, documentText);
    return ok(
      queued
        ? `Your reply in thread ${threadId} on ${resolved.path}${about}, at ${where}, is queued: the collaboration server cannot be reached now, so it is sent when it can. Do not post it again.`
        : `Replied in thread ${threadId} on ${resolved.path}${about}, at ${where}. It is in the Comments panel now.`,
      queued ? "Reply queued" : "Replied",
      text,
    );
  },
};
