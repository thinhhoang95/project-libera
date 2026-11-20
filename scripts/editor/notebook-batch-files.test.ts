import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as batchRoute } from "../../src/app/api/files/batch/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import type { ReviewDocument } from "../../src/lib/markdown-review";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { BatchRefusedError, deleteFiles, moveFilesToDirectory, type BatchItem } from "../../src/lib/storage/batch-files";
import { localFileIdentity } from "../../src/lib/storage/file-identity";
import { createFolder, moveFileToDirectory } from "../../src/lib/storage/files";
import { addReviewThreads } from "../../src/lib/storage/markdown-reviews";
import { filePathFromParts, getAdminRoot, getStateRoot, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { inspectReviewDocuments } from "../../src/lib/storage/review-files";
import { getFileNode, getTree } from "../../src/lib/storage/tree";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, seedNotebook, splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// A batch is the single operations repeated, so it must leave the notebook as
// the single operations do: sound according to Check Notebook (the oracle).

const sound = (notebook: string) => assertNotebookSound(notebook, { severities: ["error", "warning", "info"], allow: ["info indexes: "] });
const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };
const exists = (target: string) => stat(target).then(() => true, () => false);
const pythonCode = (note: string) => path.join(getAdminRoot(), ...pythonSidecarPath(note).split("/"));

/** What the tree gives the rail for a file: the path and the identity the app sends back. */
async function item(relative: string): Promise<BatchItem> {
  const { notebook, parts } = splitLibraryPath(relative);
  return { path: relative, fileId: localFileIdentity(await getFileNode(notebook, parts)) };
}

/** A note with a star, tags, Python code and a review, beside the seeded project. */
async function recordedNote(relative: string) {
  const text = "hello world\n";
  await writeLibraryFile(relative, text);
  await setStarredFilePath(relative, true);
  await setFileTagsForPath(relative, ["batch"]);
  await writeAt(pythonCode(relative), "print('mine')\n");
  await addReviewThreads(relative, text, [{ range: { start: 0, end: 5 }, text: "a comment" }]);
}

const unchanged = async (relatives: string[]) => {
  for (const relative of relatives) assert.equal(await exists(disk(relative)), true, `${relative} is still where it was`);
};

test("a batch move of files with side files, a star, tags, Python code and a review ends sound", () => withTemporaryLibrary(["Nb"], async () => {
  await seedNotebook("Nb");
  await recordedNote("Nb/notes/b.md");
  await createFolder("Nb", "dest");
  await sound("Nb");

  const sources = ["Nb/papers/a.pdf", "Nb/audio/memo.m4a", "Nb/notes/n.md", "Nb/notes/b.md"];
  const items = await Promise.all(sources.map(item));
  const result = await moveFilesToDirectory(items, "Nb/dest");

  assert.deepEqual(result.moved.map((entry) => entry.to), ["Nb/dest/a.pdf", "Nb/dest/memo.m4a", "Nb/dest/n.md", "Nb/dest/b.md"]);
  assert.equal(result.failed, null);
  assert.ok(result.moved.every((entry) => entry.payload?.file.path === entry.to), "each move returns what the single move does");
  for (const source of sources) assert.equal(await exists(disk(source)), false);

  // Every record went with its file.
  await readFile(pdfAnnotationsPath("Nb", ["dest", "a.pdf"]), "utf8");
  // The move re-writes the figure-sources footer; the user's code is what it was.
  assert.ok((await readFile(pythonCode("Nb/dest/b.md"), "utf8")).startsWith("print('mine')\n"));
  assert.equal(await exists(pythonCode("Nb/notes/b.md")), false);
  const metadata = await readWorkspaceMetadata();
  assert.ok(metadata.starredFilePaths.includes("Nb/dest/b.md"));
  assert.ok(!metadata.starredFilePaths.includes("Nb/notes/b.md"));
  assert.deepEqual(metadata.fileTags["Nb/dest/b.md"], ["batch"]);
  const reviews = await inspectReviewDocuments<ReviewDocument>(getStateRoot(), "Nb/dest/b.md");
  assert.equal(reviews?.[0].threads.length, 1);
  await sound("Nb");
}));

test("a batch with a name collision or a leftover record at a destination is refused and changes nothing", () => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "dest");
  await writeLibraryFile("Nb/one/a.md", "# one\n");
  await writeLibraryFile("Nb/two/a.md", "# two\n");
  await writeLibraryFile("Nb/two/b.md", "# b\n");
  const both = await Promise.all(["Nb/one/a.md", "Nb/two/a.md"].map(item));
  await assert.rejects(moveFilesToDirectory(both, "Nb/dest"), (error: unknown) => error instanceof BatchRefusedError && error.problems.length === 1 && /both be named a\.md/.test(error.problems[0].message));
  await unchanged(["Nb/one/a.md", "Nb/two/a.md"]);
  assert.equal(await exists(disk("Nb/dest/a.md")), false);

  // A file already at one destination name.
  await writeLibraryFile("Nb/dest/b.md", "# taken\n");
  const clash = await Promise.all(["Nb/one/a.md", "Nb/two/b.md"].map(item));
  await assert.rejects(moveFilesToDirectory(clash, "Nb/dest"), (error: unknown) => error instanceof BatchRefusedError && error.problems[0].path === "Nb/two/b.md");
  await unchanged(["Nb/one/a.md", "Nb/two/b.md"]);
  assert.equal(await exists(disk("Nb/dest/a.md")), false, "the file before the problem did not move either");

  // The star of a file deleted outside the app is still at a destination name.
  await rm(disk("Nb/dest/b.md"));
  await setStarredFilePath("Nb/dest/b.md", true);
  await assert.rejects(moveFilesToDirectory(clash, "Nb/dest"), (error: unknown) => error instanceof BatchRefusedError && /star of a file that was there before/.test(error.problems[0].message));
  await unchanged(["Nb/one/a.md", "Nb/two/b.md"]);
  assert.equal(await exists(disk("Nb/dest/a.md")), false);
  assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/dest/b.md"]);
}));

test("a failure midway reports what moved and what did not, and the notebook stays sound", () => withTemporaryLibrary(["Nb"], async () => {
  await seedNotebook("Nb");
  await recordedNote("Nb/notes/b.md");
  await createFolder("Nb", "dest");
  const sources = ["Nb/papers/a.pdf", "Nb/notes/b.md", "Nb/audio/memo.m4a"];
  const items = await Promise.all(sources.map(item));

  // Something else takes the second name after the whole batch was checked.
  const result = await moveFilesToDirectory(items, "Nb/dest", {
    move: async (entry, directory) => {
      if (entry.path === "Nb/notes/b.md") await writeLibraryFile("Nb/dest/b.md", "someone else's file\n");
      return moveFileToDirectory(entry.path, directory, undefined, { expectedFileId: entry.fileId });
    },
  });

  assert.deepEqual(result.moved.map((entry) => entry.from), ["Nb/papers/a.pdf"]);
  assert.equal(result.failed?.path, "Nb/notes/b.md");
  assert.match(result.failed?.error ?? "", /already exists/);
  assert.deepEqual(result.notMoved, ["Nb/audio/memo.m4a"]);
  await unchanged(["Nb/notes/b.md", "Nb/audio/memo.m4a", "Nb/dest/a.pdf"]);
  assert.equal(await readFile(disk("Nb/dest/b.md"), "utf8"), "someone else's file\n");
  assert.ok((await readWorkspaceMetadata()).starredFilePaths.includes("Nb/notes/b.md"), "the unmoved file keeps its star");
  await sound("Nb");
}));

test("a source that was replaced since it was selected refuses the batch, and a delete skips it", () => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "dest");
  await writeLibraryFile("Nb/a.md", "# a\n");
  await writeLibraryFile("Nb/b.md", "# b\n");
  await writeLibraryFile("Nb/c.md", "# c\n");
  const items = await Promise.all(["Nb/a.md", "Nb/b.md", "Nb/c.md"].map(item));
  // b.md is another file by now.
  await rm(disk("Nb/b.md"));
  await writeLibraryFile("Nb/b.md", "# a different, longer file\n");

  await assert.rejects(moveFilesToDirectory(items, "Nb/dest"), (error: unknown) => error instanceof BatchRefusedError && error.problems.length === 1 && error.problems[0].path === "Nb/b.md");
  await unchanged(["Nb/a.md", "Nb/b.md", "Nb/c.md"]);
  assert.equal(await exists(disk("Nb/dest/a.md")), false);

  const deleted = await deleteFiles(items);
  assert.deepEqual(deleted.deleted, ["Nb/a.md", "Nb/c.md"]);
  assert.deepEqual(deleted.failed.map((entry) => entry.path), ["Nb/b.md"]);
  assert.equal(await readFile(disk("Nb/b.md"), "utf8"), "# a different, longer file\n");
}));

test("a batch delete takes the files and their records, and ends sound", () => withTemporaryLibrary(["Nb"], async () => {
  await seedNotebook("Nb");
  await recordedNote("Nb/notes/b.md");
  const sources = ["Nb/papers/a.pdf", "Nb/notes/b.md", "Nb/audio/memo.m4a"];
  const result = await deleteFiles(await Promise.all(sources.map(item)));

  assert.deepEqual(result.deleted, sources);
  assert.deepEqual(result.failed, []);
  for (const source of sources) assert.equal(await exists(disk(source)), false);
  assert.equal(await exists(pythonCode("Nb/notes/b.md")), false);
  const metadata = await readWorkspaceMetadata();
  assert.deepEqual(metadata.starredFilePaths, []);
  assert.equal(metadata.fileTags["Nb/notes/b.md"], undefined);
  await sound("Nb");
}));

test("the batch route moves and deletes, refuses with the problems, and the tree carries the identity of local files", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await createFolder("Nb", "dest");
  await writeLibraryFile("Nb/a.md", "# a\n");
  await writeLibraryFile("Nb/b.md", "# b\n");
  await writeLibraryFile("Nb/dest/b.md", "# taken\n");
  const tree = await getTree();
  const node = tree.notebooks.find((notebook) => notebook.name === "Nb")?.children.find((child) => child.kind === "file" && child.name === "a.md");
  assert.ok(node && node.kind === "file");
  assert.equal(node.fileId, localFileIdentity(node));

  const headers = { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`, "content-type": "application/json" };
  const post = (body: object) => batchRoute(new NextRequest("http://localhost/api/files/batch", { method: "POST", headers, body: JSON.stringify(body) }));
  const items = [{ path: "Nb/a.md", fileId: node.fileId }, { path: "Nb/b.md" }];

  const refused = await post({ action: "move", items, destinationDirectory: "Nb/dest" });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { problems: { path: string }[] }).problems[0].path, "Nb/b.md");
  await unchanged(["Nb/a.md", "Nb/b.md"]);
  // Another notebook is the migration's, not this route's.
  assert.equal((await post({ action: "move", items, destinationDirectory: "Other" })).status, 409);

  const moved = await post({ action: "move", items: [items[0]], destinationDirectory: "Nb/dest" });
  assert.equal(moved.status, 200);
  assert.deepEqual(((await moved.json()) as { moved: { to: string }[] }).moved.map((entry) => entry.to), ["Nb/dest/a.md"]);

  const removed = await post({ action: "delete", items: [{ path: "Nb/b.md" }, { path: "Nb/dest/a.md", fileId: "local:wrong:1" }] });
  const body = (await removed.json()) as { deleted: string[]; failed: { path: string }[] };
  assert.deepEqual(body.deleted, ["Nb/b.md"]);
  assert.deepEqual(body.failed.map((entry) => entry.path), ["Nb/dest/a.md"]);
  await sound("Nb");
}));

test("files of a batch that link to each other all move, their links follow, and the notebook stays sound", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/drafts/a.md", "# A\n\nSee [b](b.md).\n");
  await writeLibraryFile("Nb/drafts/b.md", "# B\n\nSee [a](a.md).\n");
  await createFolder("Nb", "notes");
  // The identities the rail had when the files were selected: moving a.md rewrites b.md's link to it before b.md moves.
  const items = [await item("Nb/drafts/a.md"), await item("Nb/drafts/b.md")];
  const result = await moveFilesToDirectory(items, "Nb/notes");
  assert.equal(result.failed, null, "the second file is not refused for the batch's own rewrite of it");
  assert.deepEqual(result.moved.map((entry) => entry.to), ["Nb/notes/a.md", "Nb/notes/b.md"]);
  assert.equal(await readFile(disk("Nb/notes/a.md"), "utf8"), "# A\n\nSee [b](b.md).\n");
  assert.equal(await readFile(disk("Nb/notes/b.md"), "utf8"), "# B\n\nSee [a](a.md).\n");
  await sound("Nb");
}));

test("a note that stays and links to files of a batch is rewritten once, and the batch reports it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/drafts/a.md", "# A\n");
  await writeLibraryFile("Nb/drafts/b.md", "# B\n\nSee [a](a.md).\n");
  await writeLibraryFile("Nb/index.md", "[a](drafts/a.md) and [b](drafts/b.md)\n");
  await createFolder("Nb", "notes");
  const result = await moveFilesToDirectory([await item("Nb/drafts/a.md"), await item("Nb/drafts/b.md")], "Nb/notes");
  assert.equal(result.failed, null);
  assert.equal(await readFile(disk("Nb/index.md"), "utf8"), "[a](notes/a.md) and [b](notes/b.md)\n");
  assert.deepEqual(result.links?.rewritten.map((note) => note.path).sort(), ["Nb/index.md"], "b.md's link to a.md kept its form, so only the staying note was rewritten");
  await sound("Nb");
}));
