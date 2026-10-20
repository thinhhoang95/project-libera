import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_SKILLS } from "../../src/lib/agent/skills";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import { activeTools, ALL_TOOLS, type AgentTool, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent } from "../../src/lib/agent/types";
import { normalizePdfCommentAnchor, normalizePdfCommentThreads, pdfCommentPages, sortPdfCommentThreads } from "../../src/lib/pdf-comments";
import { readPdfAnnotations, writePdfAnnotations } from "../../src/lib/storage/annotations";
import { archiveFile, copyFileToDirectory, deleteFile, deleteFolder, moveFile, moveFileToDirectory, renameFolder } from "../../src/lib/storage/files";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { addPdfCommentReply, changePdfComments, readPdfComments } from "../../src/lib/storage/pdf-comments";
import type { PdfCommentAnchor, PdfCommentThread } from "../../src/lib/types";

// Review comments on PDFs: kept in the PDF's annotation sidecar beside its
// markup, carried by every file operation, and readable (and answerable, never
// started) by the agent.

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-pdf-comments-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try { await createNotebook("Notes"); await run(); }
  finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function pdf(relative: string) {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "%PDF-1.4\n%%EOF\n");
}

const anchor = (pageNumber: number, y: number, quote: string): PdfCommentAnchor => ({ segments: [{ pageNumber, rects: [{ x: 0.1, y, width: 0.5, height: 0.02 }] }], quote });
const highlight = [{ id: "h1", type: "highlight", pageNumber: 1, color: "#fde047", rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.02 }], quote: "marked" }];

async function comment(relative: string, text: string, at = anchor(1, 0.2, "The method converges.")) {
  const { threads } = await changePdfComments(relative, { action: "comment", anchor: at, text });
  return threads.at(-1)!;
}
const texts = async (relative: string) => (await readPdfComments(relative)).threads.map((thread) => thread.messages.map((message) => message.text));

test("anchors and threads from disk are validated, ordered by page and position, and labelled by page", () => {
  assert.equal(normalizePdfCommentAnchor({ segments: [], quote: "x" }), null);
  assert.equal(normalizePdfCommentAnchor({ segments: [{ pageNumber: 2, rects: ["nope"] }] }), null);
  const spread = normalizePdfCommentAnchor({ quote: "  a\n b ", segments: [{ pageNumber: 4, rects: [{ x: 0, y: 0.9, width: 2, height: 0.05 }] }, { pageNumber: 3, rects: [{ x: 0.2, y: 0.95, width: 0.1, height: 0.01 }] }] })!;
  assert.deepEqual(spread.segments.map((segment) => segment.pageNumber), [3, 4], "segments are in page order");
  assert.equal(spread.segments[1].rects[0].width, 1, "boxes stay on the page");
  assert.equal(pdfCommentPages(spread), "pages 3-4");
  assert.equal(pdfCommentPages(anchor(7, 0.1, "")), "page 7");

  let ids = 0;
  const threads = normalizePdfCommentThreads([
    { id: "late", anchor: anchor(2, 0.1, "b"), status: "open", messages: [{ id: "m", text: "second page" }] },
    { id: "early", anchor: anchor(1, 0.5, "a"), status: "resolved", messages: [{ text: "lower on page one", author: "agent" }, { text: "" }] },
    { id: "top", anchor: anchor(1, 0.1, "c"), status: "bogus", messages: [{ text: "top of page one", author: "someone" }] },
    { id: "empty", anchor: anchor(1, 0.1, "c"), messages: [] },
    { id: "unanchored", messages: [{ text: "where?" }] },
    "garbage",
  ], () => `id-${++ids}`, "2026-10-19T00:00:00.000Z");
  assert.deepEqual(threads.map((thread) => thread.id), ["late", "early", "top"]);
  assert.deepEqual(sortPdfCommentThreads(threads).map((thread) => thread.id), ["top", "early", "late"]);
  assert.equal(threads[2].status, "open", "unknown statuses are open");
  assert.equal(threads[1].messages.length, 1, "empty messages are dropped");
  assert.equal(threads[1].messages[0].author, "agent");
  assert.equal(threads[2].messages[0].author, undefined, "only the agent is marked");
});

test("comments are kept in the PDF's sidecar beside its markup, and neither writer drops the other", () => withLibrary(async () => {
  await pdf("Notes/paper.pdf");
  await writePdfAnnotations("Notes/paper.pdf", highlight);
  const thread = await comment("Notes/paper.pdf", "Is this proven?");
  assert.equal(thread.status, "open");
  assert.equal(thread.anchor.quote, "The method converges.");

  // The viewer saves whole markup lists without knowing about comments.
  await writePdfAnnotations("Notes/paper.pdf", [...highlight, { ...highlight[0], id: "h2" }]);
  assert.deepEqual(await texts("Notes/paper.pdf"), [["Is this proven?"]]);
  await changePdfComments("Notes/paper.pdf", { action: "reply", threadId: thread.id, text: "See lemma 2." });
  assert.deepEqual((await readPdfAnnotations("Notes/paper.pdf")).annotations.map((annotation) => annotation.id), ["h1", "h2"]);

  const sidecar = JSON.parse(await readFile(pdfAnnotationsPath("Notes", ["paper.pdf"]), "utf8"));
  assert.equal(sidecar.annotations.length, 2);
  assert.equal(sidecar.comments.length, 1);

  // Saves racing each other: every reply and the markup survive.
  await Promise.all([
    writePdfAnnotations("Notes/paper.pdf", highlight),
    addPdfCommentReply("Notes/paper.pdf", thread.id, "Agent reply.", "agent"),
    changePdfComments("Notes/paper.pdf", { action: "reply", threadId: thread.id, text: "Third." }),
    writePdfAnnotations("Notes/paper.pdf", highlight),
  ]);
  const [stored] = (await readPdfComments("Notes/paper.pdf")).threads;
  assert.deepEqual(stored.messages.map((message) => message.text).sort(), ["Agent reply.", "Is this proven?", "See lemma 2.", "Third."]);
  assert.equal(stored.messages.find((message) => message.text === "Agent reply.")?.author, "agent");
  assert.deepEqual((await readPdfAnnotations("Notes/paper.pdf")).annotations.map((annotation) => annotation.id), ["h1"]);
}));

test("the Comments panel's actions edit, resolve and delete threads, and refuse what they cannot do", () => withLibrary(async () => {
  await pdf("Notes/paper.pdf");
  const first = await comment("Notes/paper.pdf", "First");
  const second = await comment("Notes/paper.pdf", "Second", anchor(2, 0.3, "Elsewhere."));
  await changePdfComments("Notes/paper.pdf", { action: "edit", threadId: first.id, messageId: first.messages[0].id, text: "First, edited" });
  await changePdfComments("Notes/paper.pdf", { action: "resolve", threadId: second.id, resolved: true });
  let { threads } = await readPdfComments("Notes/paper.pdf");
  assert.equal(threads[0].messages[0].text, "First, edited");
  assert.ok(threads[0].messages[0].editedAt);
  assert.equal(threads[1].status, "resolved");
  await changePdfComments("Notes/paper.pdf", { action: "resolve", threadId: second.id, resolved: false });
  await changePdfComments("Notes/paper.pdf", { action: "delete", threadId: first.id });
  ({ threads } = await readPdfComments("Notes/paper.pdf"));
  assert.deepEqual(threads.map((thread: PdfCommentThread) => [thread.id, thread.status]), [[second.id, "open"]]);

  const reply = await addPdfCommentReply("Notes/paper.pdf", second.id, "From the agent.", "agent");
  await assert.rejects(changePdfComments("Notes/paper.pdf", { action: "edit", threadId: second.id, messageId: reply.id, text: "Rewritten" }), /agent's replies cannot be edited/);
  await assert.rejects(changePdfComments("Notes/paper.pdf", { action: "comment", anchor: { segments: [], quote: "x" }, text: "Nowhere" }), /Select text on a page/);
  await assert.rejects(changePdfComments("Notes/paper.pdf", { action: "comment", anchor: anchor(1, 0.1, "x"), text: "   " }), /Enter a comment/);
  await assert.rejects(changePdfComments("Notes/paper.pdf", { action: "reply", threadId: "missing", text: "Hello" }), (error: { status?: number }) => error.status === 404);
  await assert.rejects(addPdfCommentReply("Notes/paper.pdf", first.id, "Too late"), (error: { status?: number }) => error.status === 404);
  await assert.rejects(readPdfComments("Notes/missing.pdf"), (error: { code?: string }) => error.code === "ENOENT");
}));

test("comments follow PDFs and folders through renames, moves, copies, archive and deletion", () => withLibrary(async () => {
  await pdf("Notes/old/paper.pdf");
  await comment("Notes/old/paper.pdf", "keep");
  await moveFile("Notes/old/paper.pdf", "Notes", "renamed.pdf");
  await renameFolder("Notes/old", "new");
  assert.deepEqual(await texts("Notes/new/renamed.pdf"), [["keep"]]);

  await copyFileToDirectory("Notes/new/renamed.pdf", "Notes", "copy.pdf");
  await createNotebook("Other");
  await moveFileToDirectory("Notes/new/renamed.pdf", "Other", "moved.pdf");
  assert.deepEqual(await texts("Notes/copy.pdf"), [["keep"]]);
  assert.deepEqual(await texts("Other/moved.pdf"), [["keep"]]);

  // A copy's threads are its own.
  const [copied] = (await readPdfComments("Notes/copy.pdf")).threads;
  await changePdfComments("Notes/copy.pdf", { action: "reply", threadId: copied.id, text: "only on the copy" });
  assert.deepEqual(await texts("Other/moved.pdf"), [["keep"]]);

  // A new PDF at an old path starts without the old comments.
  await deleteFile("Notes/copy.pdf");
  await pdf("Notes/copy.pdf");
  assert.deepEqual(await texts("Notes/copy.pdf"), []);

  const archived = await archiveFile("Other/moved.pdf");
  assert.deepEqual(await texts(archived.file.path), [["keep"]]);

  await pdf("Notes/doomed/paper.pdf");
  await comment("Notes/doomed/paper.pdf", "gone");
  await deleteFolder("Notes/doomed");
  await pdf("Notes/doomed/paper.pdf");
  assert.deepEqual(await texts("Notes/doomed/paper.pdf"), []);
}));

// ---- The agent ---------------------------------------------------------------

function makeContext() {
  const events: AgentEvent[] = [];
  const context: ToolContext = {
    permission: "read-only", skills: AGENT_SKILLS, loadedSkills: new Set(), skillState: new Map(),
    notebook: "Notes", notebooks: ["Notes"], openFiles: new Set(), drafts: new Map(), fileState: new Map(),
    tasks: [], snapshots: new RunSnapshots(`run-${randomUUID()}`), changed: new Map(), maxResultChars: 40_000,
    signal: new AbortController().signal, emit: (event) => events.push(event),
  };
  return { context, events };
}

async function call(context: ToolContext, name: string, args: Record<string, unknown>) {
  const tool = activeTools(ALL_TOOLS, context).find((candidate: AgentTool) => candidate.name === name);
  assert.ok(tool, `${name} is offered`);
  try { return await tool.run(args, context); }
  catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true, result: "" }; }
}

test("the agent reads a PDF's comments with their pages and passages, and replies without starting threads", () => withLibrary(async () => {
  await pdf("Notes/paper.pdf");
  const lower = await comment("Notes/paper.pdf", "Which dataset is this?", anchor(2, 0.6, "We evaluate on the held-out split."));
  const upper = await comment("Notes/paper.pdf", "Typo in the title?", anchor(1, 0.05, "A Stuy of Convergence"));
  const done = await comment("Notes/paper.pdf", "Fixed already.", anchor(3, 0.1, "Appendix"));
  await changePdfComments("Notes/paper.pdf", { action: "reply", threadId: lower.id, text: "I think it is CIFAR." });
  await changePdfComments("Notes/paper.pdf", { action: "resolve", threadId: done.id, resolved: true });

  const { context, events } = makeContext();
  const read = await call(context, "ReadComments", { file_path: "Notes/paper.pdf" });
  assert.ok(!read.isError, read.text);
  assert.match(read.text, /^Review comments on Notes\/paper\.pdf: 2 open threads, 1 resolved thread \(resolved ones not shown/);
  assert.match(read.text, /Read the pages they are on[^\n]*reply in a thread with ReplyToComment, but not leave new comments/);
  // Reading order: page 1 before page 2.
  assert.ok(read.text.indexOf(`Thread ${upper.id} · open · page 1, on “A Stuy of Convergence”`) >= 0, read.text);
  assert.ok(read.text.indexOf(upper.id) < read.text.indexOf(lower.id));
  assert.match(read.text, new RegExp(`Thread ${lower.id} · open · page 2, on “We evaluate on the held-out split\\.”\\n  - the user, comment, \\d{4}-\\d{2}-\\d{2}:\\n    Which dataset is this\\?\\n  - the user, reply, \\d{4}-\\d{2}-\\d{2}:\\n    I think it is CIFAR\\.`));
  assert.ok(!read.text.includes(done.id));
  assert.match((await call(context, "ReadComments", { file_path: "Notes/paper.pdf", status: "all" })).text, new RegExp(`Thread ${done.id} · resolved · page 3`));

  // Replies come with the leave-review-comments skill.
  await call(context, "Skill", { name: "leave-review-comments" });
  const reply = await call(context, "ReplyToComment", { file_path: "Notes/paper.pdf", thread_id: lower.id, text: "Table 2 says it is CIFAR-10." });
  assert.ok(!reply.isError, reply.text);
  assert.match(reply.text, new RegExp(`^Replied in thread ${lower.id} on Notes/paper\\.pdf \\(the user: “Which dataset is this\\?”\\), at page 2, on “We evaluate`));
  const stored = (await readPdfComments("Notes/paper.pdf")).threads.find((thread) => thread.id === lower.id)!;
  assert.deepEqual(stored.messages.at(-1), { ...stored.messages.at(-1)!, text: "Table 2 says it is CIFAR-10.", author: "agent" });
  assert.deepEqual(events.filter((event) => event.type === "comments_added"), [{ type: "comments_added", path: "Notes/paper.pdf", count: 1 }]);
  assert.match((await call(context, "ReadComments", { file_path: "Notes/paper.pdf" })).text, /- AI \(Agent mode, for the user\), reply, [\d-]+:\n    Table 2 says it is CIFAR-10\./);

  assert.match((await call(context, "ReplyToComment", { file_path: "Notes/paper.pdf", thread_id: lower.id, text: "Table 2 says it is CIFAR-10." })).text, /already ends with this reply/);
  assert.match((await call(context, "ReplyToComment", { file_path: "Notes/paper.pdf", thread_id: done.id, text: "Agreed." })).text, /is resolved[^\n]*tell the user in your reply\. Nothing was posted\./);
  assert.match((await call(context, "ReplyToComment", { file_path: "Notes/paper.pdf", thread_id: "nope", text: "Hi" })).text, new RegExp(`There is no thread nope on Notes/paper\\.pdf[\\s\\S]*- ${upper.id}: page 1, on “A Stuy of Convergence”`));
  const leave = await call(context, "LeaveComment", { file_path: "Notes/paper.pdf", old_string: "x", new_string: "x\n\n:::comment\nNew point\n:::" });
  assert.ok(leave.isError);
  assert.match(leave.text, /You cannot leave new comments on a PDF \(Notes\/paper\.pdf\)\. You can reply in the threads already on it with ReplyToComment/);
  assert.equal((await readPdfComments("Notes/paper.pdf")).threads.length, 3, "the agent started no thread");

  await pdf("Notes/blank.pdf");
  assert.match((await call(context, "ReadComments", { file_path: "Notes/blank.pdf" })).text, /^Notes\/blank\.pdf has no unresolved review comments\.$/);
  assert.match((await call(context, "ReplyToComment", { file_path: "Notes/blank.pdf", thread_id: "x", text: "Hi" })).text, /has no review comments[^\n]*You cannot start threads on a PDF/);
  assert.match((await call(context, "ReadComments", { file_path: "Notes/absent.pdf" })).text, /^No file at Notes\/absent\.pdf\./);
}));
