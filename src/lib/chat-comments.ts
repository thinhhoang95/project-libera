import type { ChatContext } from "./document-chat";
import type { ReviewThread } from "./markdown-review";
import type { PdfCommentThread } from "./types";
import { isSharedMessage, isSharedThread } from "./collab/review-store/types";
import { pdfCommentPages, sortPdfCommentThreads } from "./pdf-comments";

// Review comments as chat context: the threads on a document and every reply,
// flattened to text the model reads as reference material. The chat panel
// builds them from the Comments panel's live state for the document in view;
// /api/document-chat/comments builds them for other files.

export type ChatCommentThread = {
  status: string;
  /** Where the thread is: "line 12, on “…”", "page 3, on “…”". */
  where: string;
  messages: { who: string; date: string; text: string; edited?: boolean; deleted?: boolean }[];
};

const MAX_COMMENTS_CHARS = 200_000;

export function shortCommentQuote(text: string, limit = 120) {
  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat}”`;
}

function lineOf(text: string, offset: number) {
  let line = 1;
  for (let index = text.indexOf("\n"); index >= 0 && index < offset; index = text.indexOf("\n", index + 1)) line++;
  return line;
}

/** Markdown and LaTeX threads (local or shared), in document order; `text` is what their anchors refer to. */
export function reviewCommentThreads(threads: ReviewThread[], text: string): ChatCommentThread[] {
  return [...threads]
    .filter((thread) => thread.messages.some((message) => !isSharedMessage(message) || !message.shared.deleted))
    .sort((left, right) => (left.anchor.state === "orphaned" ? Infinity : left.anchor.start) - (right.anchor.state === "orphaned" ? Infinity : right.anchor.start))
    .map((thread) => {
      const detached = thread.anchor.state === "orphaned" || (isSharedThread(thread) && thread.shared.detached);
      const first = lineOf(text, thread.anchor.start), last = lineOf(text, Math.max(thread.anchor.start, thread.anchor.end - 1));
      return {
        status: detached ? "detached" : thread.status,
        where: detached ? `passage no longer in the document (it was on ${shortCommentQuote(thread.anchor.quote)})`
          : `${first === last ? `line ${first}` : `lines ${first}-${last}`}, on ${shortCommentQuote(text.slice(thread.anchor.start, thread.anchor.end) || thread.anchor.quote)}`,
        messages: thread.messages.map((message) => isSharedMessage(message)
          ? { who: `${message.shared.actor?.kind === "ai" ? "AI for " : ""}${message.shared.author.displayName}${message.shared.mine ? " (the user)" : ""}`, date: message.createdAt.slice(0, 10), text: message.text, edited: !!message.shared.editedAt, deleted: message.shared.deleted }
          : { who: message.author === "agent" ? "AI (Agent mode, for the user)" : "the user", date: message.createdAt.slice(0, 10), text: message.text }),
      };
    });
}

/** A PDF's threads, in reading order. */
export function pdfCommentChatThreads(threads: PdfCommentThread[]): ChatCommentThread[] {
  return sortPdfCommentThreads(threads).map((thread) => ({
    status: thread.status,
    where: `${pdfCommentPages(thread.anchor)}${thread.anchor.quote ? `, on ${shortCommentQuote(thread.anchor.quote)}` : ""}`,
    messages: thread.messages.map((message) => ({ who: message.author === "agent" ? "AI (Agent mode, for the user)" : "the user", date: message.createdAt.slice(0, 10), text: message.text, edited: !!message.editedAt })),
  }));
}

export function formatChatComments(name: string, threads: ChatCommentThread[]) {
  const resolved = threads.filter((thread) => thread.status === "resolved").length;
  const header = `Review comments on ${name}: ${threads.length - resolved} unresolved, ${resolved} resolved.`;
  const blocks = threads.map((thread, index) => {
    const visible = thread.messages.filter((message) => !message.deleted);
    const lines = visible.map((message) => {
      const label = message === thread.messages[0] ? "comment" : "reply";
      return `  - ${message.who}, ${label}, ${message.date}${message.edited ? " (edited)" : ""}:\n    ${message.text.trim().replace(/\n/g, "\n    ")}`;
    });
    if (thread.messages[0]?.deleted) lines.unshift("  - (The opening comment was deleted.)");
    return `${index + 1}. ${thread.status} · ${thread.where}\n${lines.join("\n")}`;
  });
  let text = header;
  for (const [index, block] of blocks.entries()) {
    if (text.length + block.length + 2 > MAX_COMMENTS_CHARS) { text += `\n\n[${blocks.length - index} more threads not shown; the size limit was reached.]`; break; }
    text += `\n\n${block}`;
  }
  return text;
}

/** The comments context for a document, or null when it has no comments. */
export function commentsContext(path: string, name: string, threads: ChatCommentThread[]): ChatContext | null {
  return threads.length ? { kind: "comments", path, name, text: formatChatComments(name, threads) } : null;
}

/** The thread count of a comments context, for a compact badge. */
export function commentsContextCount(context: ChatContext) {
  const match = context.text.match(/: (\d+) unresolved, (\d+) resolved\./);
  return match ? String(Number(match[1]) + Number(match[2])) : undefined;
}

/** "3 threads" for a comments context, read back from its header. */
export function commentsContextSummary(context: ChatContext) {
  const match = context.text.match(/: (\d+) unresolved, (\d+) resolved\./);
  if (!match) return "comments";
  const total = Number(match[1]) + Number(match[2]);
  return `${total} thread${total === 1 ? "" : "s"}${Number(match[2]) ? `, ${match[2]} resolved` : ""}`;
}
