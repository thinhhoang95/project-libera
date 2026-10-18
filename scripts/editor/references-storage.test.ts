import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDirectory } from "../../src/lib/storage/directory-mode";
import {
  archiveFile,
  archiveFolder,
  copyFileToDirectory,
  deleteFile,
  deleteFolder,
  moveFile,
  moveFileToDirectory,
  renameFolder,
} from "../../src/lib/storage/files";
import { createNotebook, deleteNotebook, renameNotebook } from "../../src/lib/storage/notebooks";
import { getLinkedFolder, referenceLibraryPath } from "../../src/lib/storage/paths";
import {
  LibraryOpError,
  pendingReferenceReattach,
  reattachMissingReferenceFiles,
  readReferenceLibrary,
  ReferenceRevisionConflict,
  remapReferenceAttachments,
  resetReferenceReattachSchedule,
  updateReferenceLibrary,
} from "../../src/lib/storage/references";
import { StorageError } from "../../src/lib/storage/errors";
import { getTree } from "../../src/lib/storage/tree";
import type { ReferenceAttachment, ReferenceLibrary } from "../../src/lib/references/types";

async function withLibrary(run: (root: string, scratch: string) => Promise<void>) {
  await pendingReferenceReattach();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-references-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  const root = path.join(scratch, "data", "users", "admin");
  try {
    await mkdir(root, { recursive: true });
    await run(root, scratch);
  } finally {
    await pendingReferenceReattach();
    resetReferenceReattachSchedule();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

const book = (title: string) => ({ type: "book" as const, title });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function filePaths(library: ReferenceLibrary) {
  return Object.values(library.entries).flatMap((entry) => entry.attachments.map((attachment) =>
    attachment.kind === "url" ? attachment.url : attachment.path)).sort();
}

async function addWithFiles(notebook: string, title: string, paths: string[]) {
  const library = await readReferenceLibrary(notebook);
  return updateReferenceLibrary(notebook, library.revision, [{
    op: "add",
    entry: { csl: book(title), attachments: paths.map((file): ReferenceAttachment => ({ kind: file.endsWith(".pdf") ? "pdf" : "markdown", path: file })) },
  }]);
}

test("reads a missing library as empty without writing, and rejects unknown notebooks", async () => {
  await withLibrary(async (root) => {
    await createNotebook("Notes");
    const library = await readReferenceLibrary("Notes");
    assert.deepEqual(library, { version: 1, revision: 0, style: "apa", entries: {} });
    assert.deepEqual(await readdir(path.join(root, "Notes")), [".libera-notebook.json"], "nothing was written");
    await assert.rejects(readReferenceLibrary("Missing"), (error: unknown) => error instanceof StorageError && error.status === 404);
    await assert.rejects(updateReferenceLibrary("Missing", 0, []), (error: unknown) => error instanceof StorageError && error.status === 404);
    await assert.rejects(readReferenceLibrary("../x"), (error: unknown) => error instanceof StorageError && error.status === 400);
    assert.equal(referenceLibraryPath("Notes"), path.join(root, "Notes", ".libera", "references", "library.json"));
  });
});

test("writes revisions, skips no-op writes, reports conflicts with the current library, and rejects invalid ops atomically", async () => {
  await withLibrary(async () => {
    await createNotebook("Notes");
    const first = await updateReferenceLibrary("Notes", 0, [{ op: "add", entry: { csl: book("One") } }]);
    assert.equal(first.revision, 1);
    const stored = JSON.parse(await readFile(referenceLibraryPath("Notes"), "utf8"));
    assert.deepEqual(stored, first);
    assert.deepEqual(await readReferenceLibrary("Notes"), first);

    const unchanged = await updateReferenceLibrary("Notes", 1, [{ op: "set-style", style: "apa" }]);
    assert.equal(unchanged.revision, 1, "a change that changes nothing keeps the revision");

    await assert.rejects(updateReferenceLibrary("Notes", 0, [{ op: "set-style", style: "ieee" }]), (error: unknown) => {
      assert.ok(error instanceof ReferenceRevisionConflict);
      assert.equal(error.status, 409);
      assert.deepEqual(error.library, first);
      return true;
    });

    const before = await readFile(referenceLibraryPath("Notes"), "utf8");
    await assert.rejects(updateReferenceLibrary("Notes", 1, [
      { op: "set-style", style: "ieee" },
      { op: "delete", id: "ref_unknown" },
    ]), LibraryOpError);
    assert.equal(await readFile(referenceLibraryPath("Notes"), "utf8"), before, "nothing was written");

    const latest = await updateReferenceLibrary("Notes", null, [{ op: "set-style", style: "ieee" }]);
    assert.equal(latest.revision, 2);
    assert.equal(latest.style, "ieee");
  });
});

test("a corrupt library is moved aside, never overwritten; a newer version is left alone", async () => {
  await withLibrary(async () => {
    await createNotebook("Notes");
    const target = referenceLibraryPath("Notes");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{ not json");
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      assert.deepEqual((await readReferenceLibrary("Notes")).entries, {});
    } finally { console.warn = warn; }
    assert.equal(warnings.length, 1);
    const files = await readdir(path.dirname(target));
    const aside = files.find((name) => name.startsWith("library.json.corrupt-"));
    assert.ok(aside, "the damaged file is kept");
    assert.equal(await readFile(path.join(path.dirname(target), aside), "utf8"), "{ not json");
    assert.ok(!files.includes("library.json"), "reading did not write a new library");

    await writeFile(target, JSON.stringify({ version: 1, revision: 3, style: "apa", entries: { a: { id: "b" } } }));
    console.warn = () => undefined;
    try {
      const library = await updateReferenceLibrary("Notes", 0, [{ op: "add", entry: { csl: book("Fresh") } }]);
      assert.equal(library.revision, 1);
    } finally { console.warn = warn; }
    assert.equal((await readdir(path.dirname(target))).filter((name) => name.includes(".corrupt-")).length, 2);

    await writeFile(target, JSON.stringify({ version: 2, revision: 1, style: "apa", entries: {} }));
    await assert.rejects(readReferenceLibrary("Notes"), (error: unknown) => error instanceof StorageError && error.status === 409 && /newer version/.test(error.message));
    await assert.rejects(updateReferenceLibrary("Notes", null, []), /newer version/);
    assert.equal(JSON.parse(await readFile(target, "utf8")).version, 2);
  });
});

test("parallel updates serialize without lost updates", async () => {
  await withLibrary(async () => {
    await createNotebook("Notes");
    const results = await Promise.all(Array.from({ length: 25 }, (_, index) =>
      updateReferenceLibrary("Notes", null, [{ op: "add", entry: { csl: book(`Title ${index}`) } }])));
    assert.deepEqual(results.map((library) => library.revision).sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index + 1));
    const library = await readReferenceLibrary("Notes");
    assert.equal(library.revision, 25);
    assert.equal(Object.keys(library.entries).length, 25);

    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
      updateReferenceLibrary("Notes", 25, [{ op: "add", entry: { csl: book(`Race ${index}`) } }])));
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1, "one writer wins a revision");
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled" || outcome.reason instanceof ReferenceRevisionConflict));
    assert.deepEqual(await readdir(path.dirname(referenceLibraryPath("Notes"))), ["library.json"], "no lock or temporary files are left");
  });
});

test("attachments without a hash get sha256 and size from the file", async () => {
  await withLibrary(async (root) => {
    await createNotebook("Notes");
    await createNotebook("Papers");
    await writeFile(path.join(root, "Papers", "a.pdf"), "%PDF-1.4 a");
    await writeFile(path.join(root, "Notes", "n.md"), "# Note");
    let library = await updateReferenceLibrary("Notes", 0, [{ op: "add", entry: { csl: book("A"), attachments: [{ kind: "pdf", path: "Papers/a.pdf" }, { kind: "url", url: "https://a.org" }] } }]);
    const entry = Object.values(library.entries)[0];
    assert.deepEqual(entry.attachments[0], { kind: "pdf", path: "Papers/a.pdf", sha256: sha("%PDF-1.4 a"), size: 10 });
    library = await updateReferenceLibrary("Notes", library.revision, [{ op: "attach", id: entry.id, attachment: { kind: "markdown", path: "Notes/n.md" } }]);
    assert.deepEqual(library.entries[entry.id].attachments[2], { kind: "markdown", path: "Notes/n.md", sha256: sha("# Note"), size: 6 });
    const given = { kind: "pdf" as const, path: "Papers/given.pdf", sha256: "b".repeat(64), size: 1 };
    library = await updateReferenceLibrary("Notes", library.revision, [{ op: "attach", id: entry.id, attachment: given }]);
    assert.deepEqual(library.entries[entry.id].attachments[3], given, "a hash that is given is kept, and the file is not read");

    for (const attachment of [{ kind: "pdf", path: "Papers/missing.pdf" }, { kind: "pdf", path: "Papers/../../escape.pdf" }, { kind: "pdf", path: "Papers/.libera/x.pdf" }] as ReferenceAttachment[]) {
      await assert.rejects(updateReferenceLibrary("Notes", library.revision, [{ op: "attach", id: entry.id, attachment }]),
        (error: unknown) => (error instanceof StorageError || error instanceof LibraryOpError) && error.status === 400, JSON.stringify(attachment));
    }
    assert.equal((await readReferenceLibrary("Notes")).revision, library.revision);
  });
});

test("file operations move and detach attachments in every library, across notebooks", async () => {
  await withLibrary(async (root) => {
    await createNotebook("A");
    await createNotebook("B");
    await mkdir(path.join(root, "B", "papers", "deep"), { recursive: true });
    await mkdir(path.join(root, "B", "drop"), { recursive: true });
    for (const file of ["B/one.pdf", "B/two.pdf", "B/papers/three.pdf", "B/papers/deep/four.pdf", "B/note.md", "B/five.pdf", "A/six.pdf", "B/seven.pdf"]) {
      await writeFile(path.join(root, file), file);
    }
    await addWithFiles("A", "Cross", ["B/one.pdf", "B/two.pdf", "B/papers/three.pdf", "B/papers/deep/four.pdf", "B/note.md"]);
    await addWithFiles("B", "Local", ["B/papers/three.pdf", "B/five.pdf", "A/six.pdf", "B/seven.pdf"]);
    // A damaged library elsewhere never fails a file operation.
    await createNotebook("C");
    await mkdir(path.dirname(referenceLibraryPath("C")), { recursive: true });
    await writeFile(referenceLibraryPath("C"), "corrupt");

    await moveFile("B/one.pdf", "B", "uno.pdf");
    await moveFile("B/two.pdf", "A", "two.pdf");
    await moveFileToDirectory("B/note.md", "B/drop");
    await renameFolder("B/papers", "articles");
    assert.deepEqual(filePaths(await readReferenceLibrary("A")), ["A/two.pdf", "B/articles/deep/four.pdf", "B/articles/three.pdf", "B/drop/note.md", "B/uno.pdf"]);
    assert.deepEqual(filePaths(await readReferenceLibrary("B")), ["A/six.pdf", "B/articles/three.pdf", "B/five.pdf", "B/seven.pdf"]);

    await archiveFile("B/five.pdf");
    await archiveFolder("B/articles");
    assert.deepEqual(filePaths(await readReferenceLibrary("B")), ["A/six.pdf", "B/_archive/articles/three.pdf", "B/_archive/five.pdf", "B/seven.pdf"]);
    assert.deepEqual(filePaths(await readReferenceLibrary("A")).filter((file) => file.includes("_archive")), ["B/_archive/articles/deep/four.pdf", "B/_archive/articles/three.pdf"]);

    const copied = await copyFileToDirectory("B/seven.pdf", "A");
    assert.equal(copied.file.path, "A/seven copy.pdf");
    assert.ok(!filePaths(await readReferenceLibrary("B")).includes("A/seven copy.pdf"), "a copy is not attached");

    const beforeDelete = (await readReferenceLibrary("A")).revision;
    await deleteFile("B/uno.pdf");
    await deleteFolder("B/_archive/articles");
    const afterDelete = await readReferenceLibrary("A");
    assert.deepEqual(filePaths(afterDelete), ["A/two.pdf", "B/drop/note.md"]);
    assert.equal(Object.keys(afterDelete.entries).length, 1, "the entry stays when its files are gone");
    assert.equal(afterDelete.revision, beforeDelete + 2, "each changed transaction bumps the revision once");
    assert.equal(await readFile(referenceLibraryPath("C"), "utf8"), "corrupt", "the damaged library was not touched");
  });
});

test("notebook rename remaps pointers into it; notebook delete detaches them and removes its own library", async () => {
  await withLibrary(async (root) => {
    await createNotebook("A");
    await createNotebook("B");
    await writeFile(path.join(root, "B", "b.pdf"), "b");
    await writeFile(path.join(root, "A", "a.pdf"), "a");
    await writeFile(path.join(root, "BB.pdf"), "not in a notebook");
    await addWithFiles("A", "Points to B", ["B/b.pdf", "A/a.pdf"]);
    await addWithFiles("B", "Own", ["B/b.pdf", "A/a.pdf"]);

    await renameNotebook("B", "Bee");
    assert.deepEqual(filePaths(await readReferenceLibrary("A")), ["A/a.pdf", "Bee/b.pdf"]);
    assert.deepEqual(filePaths(await readReferenceLibrary("Bee")), ["A/a.pdf", "Bee/b.pdf"], "the library moved with the folder");

    await renameNotebook("A", "Alpha");
    assert.deepEqual(filePaths(await readReferenceLibrary("Bee")), ["Alpha/a.pdf", "Bee/b.pdf"]);

    await deleteNotebook("Bee");
    assert.deepEqual(filePaths(await readReferenceLibrary("Alpha")), ["Alpha/a.pdf"]);
    assert.equal(Object.keys((await readReferenceLibrary("Alpha")).entries).length, 1);
  });
});

test("attachments into a linked folder follow moves; its library lives in the data directory", async () => {
  await withLibrary(async (root, scratch) => {
    const project = path.join(scratch, "Project");
    await mkdir(path.join(project, "pdfs"), { recursive: true });
    await writeFile(path.join(project, "paper.pdf"), "paper");
    const { name } = await openDirectory(project);
    await createNotebook("Notes");
    await addWithFiles("Notes", "Linked", [`${name}/paper.pdf`]);
    await addWithFiles(name, "Inside", [`${name}/paper.pdf`]);
    const folder = getLinkedFolder(name)!;
    assert.ok(referenceLibraryPath(name).startsWith(folder.stateRoot), "a linked folder's library is kept in the data directory");

    await moveFileToDirectory(`${name}/paper.pdf`, `${name}/pdfs`);
    assert.deepEqual(filePaths(await readReferenceLibrary("Notes")), [`${name}/pdfs/paper.pdf`]);
    assert.deepEqual(filePaths(await readReferenceLibrary(name)), [`${name}/pdfs/paper.pdf`]);

    await renameNotebook(name, "Renamed");
    assert.deepEqual(filePaths(await readReferenceLibrary("Notes")), ["Renamed/pdfs/paper.pdf"]);
    assert.deepEqual(filePaths(await readReferenceLibrary("Renamed")), ["Renamed/pdfs/paper.pdf"]);
    assert.ok(root);
  });
});

test("remapReferenceAttachments writes only libraries that change", async () => {
  await withLibrary(async (root) => {
    await createNotebook("A");
    await createNotebook("B");
    await writeFile(path.join(root, "A", "a.pdf"), "a");
    await addWithFiles("A", "A", ["A/a.pdf"]);
    await addWithFiles("B", "B", ["A/a.pdf"]);
    await updateReferenceLibrary("B", null, [{ op: "add", entry: { csl: book("No files") } }]);
    assert.deepEqual(await remapReferenceAttachments((file) => file), []);
    assert.deepEqual(await remapReferenceAttachments((file) => file === "A/a.pdf" ? "A/z.pdf" : file), ["A", "B"]);
    assert.equal((await readReferenceLibrary("A")).revision, 2);
  });
});

test("re-attaches moved files by hash: one match re-points, several matches do not, nothing missing walks nothing", async () => {
  await withLibrary(async (root) => {
    await createNotebook("A");
    await createNotebook("B");
    await mkdir(path.join(root, "B", "elsewhere"), { recursive: true });
    await writeFile(path.join(root, "A", "unique.pdf"), "unique bytes");
    await writeFile(path.join(root, "A", "twin.pdf"), "twin bytes");
    await writeFile(path.join(root, "A", "same-size.pdf"), "other bytes!");
    await addWithFiles("A", "Unique", ["A/unique.pdf"]);
    await addWithFiles("A", "Twin", ["A/twin.pdf"]);

    assert.deepEqual(await reattachMissingReferenceFiles(), { missing: 0, walked: false, reattached: 0 });

    // Moved outside Libera: the pointers break.
    await rename(path.join(root, "A", "unique.pdf"), path.join(root, "B", "elsewhere", "moved.pdf"));
    await rename(path.join(root, "A", "twin.pdf"), path.join(root, "B", "twin-1.pdf"));
    await writeFile(path.join(root, "B", "elsewhere", "twin-2.pdf"), "twin bytes");
    await writeFile(path.join(root, "B", "elsewhere", "decoy.md"), "unique bytes");
    const revision = (await readReferenceLibrary("A")).revision;

    assert.deepEqual(await reattachMissingReferenceFiles("A"), { missing: 2, walked: true, reattached: 1 });
    const library = await readReferenceLibrary("A");
    assert.deepEqual(filePaths(library), ["A/twin.pdf", "B/elsewhere/moved.pdf"], "the ambiguous twin is left alone");
    assert.equal(library.revision, revision + 1);
    assert.deepEqual(await reattachMissingReferenceFiles("A"), { missing: 1, walked: true, reattached: 0 });
  });
});

test("getTree starts re-attaching in the background without waiting for it", async () => {
  await withLibrary(async (root) => {
    await createNotebook("A");
    await writeFile(path.join(root, "A", "paper.pdf"), "paper bytes");
    await addWithFiles("A", "Paper", ["A/paper.pdf"]);
    await mkdir(path.join(root, "A", "moved"));
    await rename(path.join(root, "A", "paper.pdf"), path.join(root, "A", "moved", "paper.pdf"));
    resetReferenceReattachSchedule();

    const tree = await getTree();
    assert.ok(tree.notebooks.some((notebook) => notebook.name === "A"));
    const pending = pendingReferenceReattach();
    assert.ok(pending, "a run started");
    assert.deepEqual(filePaths(await readReferenceLibrary("A")), ["A/paper.pdf"], "the tree did not wait for it");
    assert.deepEqual(await pending, { missing: 1, walked: true, reattached: 1 });
    assert.deepEqual(filePaths(await readReferenceLibrary("A")), ["A/moved/paper.pdf"]);

    await getTree();
    assert.equal(pendingReferenceReattach(), null, "at most once every 30 seconds");
  });
});
