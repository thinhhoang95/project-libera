// Regressions for the 2026-11-25 file-moving review, package N1: notebooks and path-keyed stores
// (R-H2, L-H8, L-C2 notebook part, L-C4 item 1 renameNotebook, S-M3, L-M1).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assertNotebookSound, withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";
import { listReviewEntryPaths, withReviewWrite } from "../../src/lib/agent/review-store";
import { recordRootTransition } from "../../src/lib/collab/root-transitions";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { withPathLocks } from "../../src/lib/storage/fs-utils";
import { readChatState, writeChatState } from "../../src/lib/storage/document-chat";
import { deleteFile, moveFile, renameFolder, deleteFolder } from "../../src/lib/storage/files";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { addReviewThreads, findReview, loadReview } from "../../src/lib/storage/markdown-reviews";
import { createNotebook, deleteNotebook, renameNotebook } from "../../src/lib/storage/notebooks";
import { getAdminRoot, notebookPath } from "../../src/lib/storage/paths";
import { applyPendingRootTransitions } from "../../src/lib/storage/root-transitions";
import { readRecapView, recordRecapSessions } from "../../src/lib/storage/where-was-i";

const read = (relative: string) => readFile(path.join(getAdminRoot(), ...relative.split("/")), "utf8");

test("R-H2: renaming a notebook rewrites links and image addresses other notebooks hold into it", () => withTemporaryLibrary(["Old", "Other"], async () => {
  await writeLibraryFile("Old/n.md", "# Note\n");
  const upload = await writeMarkdownImageAsset("Old/n.md", new File(["photo"], "photo.png"));
  await writeLibraryFile("Old/n.md", `# Note\n\n${upload.markdown}\n`);
  await writeLibraryFile("Other/x.md", `[to it](Old/n.md)\n\n![shown](${upload.rawUrl})\n`);
  assert.match(upload.rawUrl, /document=Old%2Fn\.md/);

  const tree = await renameNotebook("Old", "New");
  assert.ok((tree as { links?: { rewritten: { path: string }[] } }).links?.rewritten.some((note) => note.path === "Other/x.md"));
  const other = await read("Other/x.md");
  assert.ok(other.includes("(New/n.md)"), other);
  assert.ok(other.includes("document=New%2Fn.md"), other);
  assert.ok(!other.includes("Old/"), other);
  await assertNotebookSound("Other");
  await assertNotebookSound("New");
}));

test("L-H8: deleting a notebook discards its pending agent reviews", () => withTemporaryLibrary(["Gone", "Stay"], async () => {
  await writeLibraryFile("Gone/n.md", "before\n");
  await writeLibraryFile("Stay/n.md", "before\n");
  await withReviewWrite("Gone/n.md", "before\n", "run-gone", async () => { await writeLibraryFile("Gone/n.md", "before\nagent\n"); });
  await withReviewWrite("Stay/n.md", "before\n", "run-stay", async () => { await writeLibraryFile("Stay/n.md", "before\nagent\n"); });
  assert.deepEqual((await listReviewEntryPaths()).paths.sort(), ["Gone/n.md", "Stay/n.md"]);
  await deleteNotebook("Gone");
  assert.deepEqual((await listReviewEntryPaths()).paths, ["Stay/n.md"]);
  await assertNotebookSound("Stay", { allow: ["pending"] , severities: ["error", "warning"] });
}));

test("L-C2: a notebook rename's review follow replaces an empty review already at the destination", () => withTemporaryLibrary(["Old"], async () => {
  await writeLibraryFile("Old/n.md", "hello world\n");
  await addReviewThreads("Old/n.md", "hello world\n", [{ range: { start: 0, end: 5 }, text: "a comment" }]);
  // A notebook of this name existed before: opening a file there left an empty review behind.
  await loadReview("New/n.md", "hello world\n");
  await renameNotebook("Old", "New");
  const review = await findReview("New/n.md");
  assert.equal(review?.threads.length, 1, "the moved review is the one found, not the empty one");
  assert.equal(review?.threads[0].messages[0].text, "a comment");
  assert.equal(await findReview("Old/n.md"), null);
}));

test("L-C4: renameNotebook waits for the locks of the notebook folder", () => withTemporaryLibrary(["Old"], async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withPathLocks([notebookPath("Old")], () => gate);
  const renaming = renameNotebook("Old", "New");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(notebookPath("Old")), "the rename has not run while the folder is locked");
  assert.ok(!existsSync(notebookPath("New")));
  release();
  await holder;
  await renaming;
  assert.ok(existsSync(notebookPath("New")));
  assert.ok(!existsSync(notebookPath("Old")));
}));

const marker = (projectId: string) => JSON.stringify({ projectId, serverUrl: "https://collab.example", accountId: "acc_1", manifestDocId: "doc_m", sharedAt: "2026-11-01T00:00:00.000Z", folderId: "fld_1" });

async function withLifecycle(notebooks: string[], run: (lifecycle: string) => Promise<void>) {
  await withTemporaryLibrary(notebooks, async () => {
    const lifecycle = path.join(getAdminRoot(), "..", `lifecycle-${Date.now()}`);
    const previous = process.env.LIBERA_COLLAB_LIFECYCLE_DIR;
    process.env.LIBERA_COLLAB_LIFECYCLE_DIR = lifecycle;
    invalidateSharedNotebookCache();
    try { await run(lifecycle); } finally {
      if (previous === undefined) delete process.env.LIBERA_COLLAB_LIFECYCLE_DIR; else process.env.LIBERA_COLLAB_LIFECYCLE_DIR = previous;
      invalidateSharedNotebookCache();
    }
  });
}

test("S-M3: a root transition keeps the pending agent review of the renamed folder", () => withLifecycle(["Old"], async (lifecycle) => {
  await writeLibraryFile("Old/n.md", "before\n");
  await withReviewWrite("Old/n.md", "before\n", "run-root", async () => { await writeLibraryFile("Old/n.md", "before\nagent\n"); });
  await rename(notebookPath("Old"), notebookPath("New"));
  await writeFile(path.join(notebookPath("New"), ".libera-shared.json"), marker("prj_1"));
  invalidateSharedNotebookCache();
  recordRootTransition(lifecycle, { projectId: "prj_1", from: "Old", to: "New" });
  await applyPendingRootTransitions();
  assert.deepEqual((await listReviewEntryPaths()).paths, ["New/n.md"]);
}));

test("S-M3: two folders that swapped names are not merged", () => withLifecycle(["A", "B"], async (lifecycle) => {
  await writeLibraryFile("A/n.md", "alpha text\n");
  await writeLibraryFile("B/n.md", "bravo text\n");
  await addReviewThreads("A/n.md", "alpha text\n", [{ range: { start: 0, end: 5 }, text: "alpha comment" }]);
  await addReviewThreads("B/n.md", "bravo text\n", [{ range: { start: 0, end: 5 }, text: "bravo comment" }]);
  // Project 1 was A and is now B; project 2 was B and is now A.
  await writeFile(path.join(notebookPath("B"), ".libera-shared.json"), marker("prj_1"));
  await writeFile(path.join(notebookPath("A"), ".libera-shared.json"), marker("prj_2"));
  invalidateSharedNotebookCache();
  recordRootTransition(lifecycle, { projectId: "prj_1", from: "A", to: "B" });
  recordRootTransition(lifecycle, { projectId: "prj_2", from: "B", to: "A" });
  await applyPendingRootTransitions();
  const a = await findReview("A/n.md");
  const b = await findReview("B/n.md");
  assert.equal(a?.threads.length, 1, "A keeps one review");
  assert.equal(b?.threads.length, 1, "B keeps one review");
  assert.equal(a?.threads[0].messages[0].text, "alpha comment");
  assert.equal(b?.threads[0].messages[0].text, "bravo comment");
}));

const chatWith = (path: string) => ({
  activeId: "c1",
  chats: [{
    id: "c1", title: "Chat", prompt: "",
    selections: [{ kind: "selection" as const, path, name: "n.md", text: "quoted" }],
    messages: [{ id: "m1", role: "user" as const, text: "hi", contexts: [{ kind: "document" as const, path, name: "n.md", text: "body" }] }],
    excludedDocumentPaths: [path],
    documentPages: { [path]: 2 },
  }],
});

test("L-M1: a moved file keeps its chat, a deleted one leaves no live chat state", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/n.md", "text\n");
  await writeLibraryFile("Nb/sub/m.md", "more\n");
  await writeChatState("history", chatWith("Nb/n.md"));
  await moveFile("Nb/n.md", "Nb", "renamed.md");
  let chat = ((await readChatState("history")) as ReturnType<typeof chatWith>).chats[0];
  assert.equal(chat.selections[0].path, "Nb/renamed.md");
  assert.equal(chat.messages[0].contexts[0].path, "Nb/renamed.md");
  assert.deepEqual(chat.excludedDocumentPaths, ["Nb/renamed.md"]);
  assert.deepEqual(chat.documentPages, { "Nb/renamed.md": 2 });

  // A folder rename moves what is under it.
  await writeChatState("history", chatWith("Nb/sub/m.md"));
  await renameFolder("Nb/sub", "deeper");
  chat = ((await readChatState("history")) as ReturnType<typeof chatWith>).chats[0];
  assert.equal(chat.selections[0].path, "Nb/deeper/m.md");

  await deleteFile("Nb/deeper/m.md");
  chat = ((await readChatState("history")) as ReturnType<typeof chatWith>).chats[0];
  assert.equal(chat.selections.length, 0);
  assert.deepEqual(chat.excludedDocumentPaths, []);
  assert.deepEqual(chat.documentPages, {});
  assert.equal(chat.messages.length, 1, "what was sent stays");
  await assertNotebookSound("Nb");
}));

test("L-M1: a moved file keeps its place in the where-was-i recap; a deleted one leaves it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/n.md", "text\n");
  await writeLibraryFile("Nb/k.md", "text\n");
  const entry = (file: string) => ({ path: file, name: file, fileType: "markdown", lastAt: new Date().toISOString(), edited: true });
  await recordRecapSessions({ sessionId: "session-aaaa", startedAt: new Date(Date.now() - 60_000).toISOString(), notebooks: { Nb: [entry("n.md"), entry("k.md")] } });
  await moveFile("Nb/n.md", "Nb", "renamed.md");
  let view = await readRecapView("Nb", "session-other", false);
  assert.deepEqual(view.session?.files.map((file) => file.path).sort(), ["k.md", "renamed.md"]);
  assert.equal(view.session?.files.find((file) => file.path === "renamed.md")?.name, "renamed.md");
  await deleteFile("Nb/k.md");
  view = await readRecapView("Nb", "session-other", false);
  assert.deepEqual(view.session?.files.map((file) => file.path), ["renamed.md"]);
}));

test("L-M1: deleting a folder drops what a chat holds about the files under it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/sub/m.md", "more\n");
  await writeChatState("history", chatWith("Nb/sub/m.md"));
  await deleteFolder("Nb/sub");
  const chat = ((await readChatState("history")) as ReturnType<typeof chatWith>).chats[0];
  assert.equal(chat.selections.length, 0);
  await mkdir(notebookPath("Nb"), { recursive: true });
}));
