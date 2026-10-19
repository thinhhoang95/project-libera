import assert from "node:assert/strict";
import test from "node:test";
import { commentsContext, commentsContextSummary, pdfCommentChatThreads, reviewCommentThreads } from "../../src/lib/chat-comments";
import { messagesWithoutExcludedDocuments, newChatContexts, validateChatMessages, type ChatMessage } from "../../src/lib/document-chat";
import { matchingCommentTargets } from "../../src/components/libera/chat-file-composer";
import type { ReviewThread } from "../../src/lib/markdown-review";
import type { PdfCommentThread } from "../../src/lib/types";

const text = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
const start = text.indexOf("Second");
const threads: ReviewThread[] = [
  { id: "b", status: "resolved", anchor: { start, end: start + 6, quote: "Second", prefix: "", suffix: "", state: "attached" }, messages: [{ id: "m3", text: "Done.", createdAt: "2026-10-02T00:00:00Z" }] },
  { id: "a", status: "open", anchor: { start: 9, end: 14, quote: "First", prefix: "", suffix: "", state: "attached" }, messages: [
    { id: "m1", text: "Cite this?", createdAt: "2026-10-01T00:00:00Z" },
    { id: "m2", text: "Added a source.", createdAt: "2026-10-01T10:00:00Z", author: "agent" },
  ] },
];

test("review comments become one context with every reply, in document order", () => {
  const context = commentsContext("Notes/a.md", "a.md", reviewCommentThreads(threads, text))!;
  assert.equal(context.kind, "comments");
  assert.match(context.text, /^Review comments on a\.md: 1 unresolved, 1 resolved\./);
  assert.ok(context.text.indexOf("Cite this?") < context.text.indexOf("Done."));
  assert.match(context.text, /1\. open · line 3, on “First”\n {2}- the user, comment, 2026-10-01:\n {4}Cite this\?\n {2}- AI \(Agent mode, for the user\), reply/);
  assert.equal(commentsContextSummary(context), "2 threads, 1 resolved");
  assert.ok(validateChatMessages([{ id: "1", role: "user", text: "", contexts: [context] }]));
  assert.equal(commentsContext("Notes/a.md", "a.md", []), null);
});

test("PDF comments name their page", () => {
  const pdf: PdfCommentThread[] = [{ id: "p", status: "open", anchor: { quote: "A claim", segments: [{ pageNumber: 4, rects: [] }] }, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", messages: [{ id: "x", text: "Source?", createdAt: "2026-10-01T00:00:00Z" }] }];
  assert.match(commentsContext("Notes/a.pdf", "a.pdf", pdfCommentChatThreads(pdf))!.text, /1\. open · page 4, on “A claim”/);
});

test("comments are sent again only when they changed, and exclusion strips them from history", () => {
  const context = commentsContext("Notes/a.md", "a.md", reviewCommentThreads(threads, text))!;
  const sent: ChatMessage = { id: "1", role: "user", text: "Address the comments", contexts: [context] };
  assert.deepEqual(newChatContexts([], [context, { ...context }]), [context]);
  assert.deepEqual(newChatContexts([sent], [context]), []);
  const replied = commentsContext("Notes/a.md", "a.md", reviewCommentThreads([{ ...threads[1], messages: [...threads[1].messages, { id: "m4", text: "Thanks", createdAt: "2026-10-03T00:00:00Z" }] }], text))!;
  assert.deepEqual(newChatContexts([sent], [replied]), [replied]);
  assert.deepEqual(messagesWithoutExcludedDocuments([sent], [], ["Notes/a.md"])[0].contexts, []);
});

test("@Comments entries match the word, or a file name after it", () => {
  const targets = [{ path: "Notes/a.md", name: "a.md", current: true }, { path: "Notes/paper.pdf", name: "paper.pdf", current: false }];
  assert.equal(matchingCommentTargets(targets, "").length, 2);
  assert.equal(matchingCommentTargets(targets, "Com").length, 2);
  assert.deepEqual(matchingCommentTargets(targets, "comments:pap").map((target) => target.name), ["paper.pdf"]);
  assert.deepEqual(matchingCommentTargets(targets, "paper"), []);
});
