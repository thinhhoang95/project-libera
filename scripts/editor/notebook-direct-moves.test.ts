import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { StorageError } from "../../src/lib/storage/errors";
import { createFolder, moveFile, moveFileToDirectory, renameFolder } from "../../src/lib/storage/files";
import { definitionsPath, filePathFromParts, getAdminRoot, itemPath } from "../../src/lib/storage/paths";
import { moveFolderSidecars } from "../../src/lib/storage/sidecars";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Direct moves and renames made in the app (the tab strip's Move menu, drag
// and drop, rename): all or nothing, never over the records of another file,
// never deleting a record by changing the file type, case-only renames on a
// case-insensitive disk, and a notice for links that open another file.

const exists = (target: string) => stat(target).then(() => true, () => false);
const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };
const definitionsOf = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return definitionsPath(notebook, parts); };
const pythonCode = (note: string) => path.join(getAdminRoot(), ...pythonSidecarPath(note).split("/"));
const rejects409 = (error: unknown) => error instanceof StorageError && error.status === 409;

test("a direct move that cannot take the definitions along leaves the note and its records where they were", () => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "sub");
  await writeLibraryFile("Nb/a.md", "# A\n");
  await writeAt(definitionsOf("Nb/a.md"), "{}");
  // A regular file where the destination's definitions folder would be.
  await writeAt(path.dirname(definitionsOf("Nb/sub/a.md")), "in the way");

  await assert.rejects(() => moveFileToDirectory("Nb/a.md", "Nb/sub"), rejects409);
  assert.equal(await exists(disk("Nb/a.md")), true);
  assert.equal(await exists(disk("Nb/sub/a.md")), false);
  assert.equal(await exists(definitionsOf("Nb/a.md")), true);

}));

test("a sidecar that fails to move after the note moved puts the note back", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => withTemporaryLibrary(["Nb"], async () => {
  await createFolder("Nb", "sub");
  await writeLibraryFile("Nb/a.md", "# A\n");
  await writeAt(definitionsOf("Nb/a.md"), "{}");
  // A folder the checks can't tell is unusable: it exists but can't be written to.
  const blocked = path.dirname(definitionsOf("Nb/sub/a.md"));
  await mkdir(blocked, { recursive: true });
  await chmod(blocked, 0o555);
  try {
    await assert.rejects(() => moveFileToDirectory("Nb/a.md", "Nb/sub"));
    assert.equal(await exists(disk("Nb/a.md")), true);
    assert.equal(await exists(disk("Nb/sub/a.md")), false);
    assert.equal(await exists(definitionsOf("Nb/a.md")), true);
    assert.equal(await readFile(disk("Nb/a.md"), "utf8"), "# A\n");
  } finally {
    await chmod(blocked, 0o755);
  }
}));

test("renaming a folder onto a name that still has the records of an earlier file is refused, and nothing is deleted", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Nb/old/inside.md", "# Inside\n");
  await writeAt(definitionsOf("Nb/old/inside.md"), "{\"mine\":true}");
  // The records of a file that was in `gone` before it was deleted outside the app.
  await writeAt(definitionsOf("Nb/gone/unrelated.md"), "{\"theirs\":true}");

  await assert.rejects(() => renameFolder("Nb/old", "gone"), rejects409);
  assert.equal(await exists(itemPath("Nb", ["old"])), true);
  assert.equal(await exists(itemPath("Nb", ["gone"])), false);
  assert.equal(await readFile(definitionsOf("Nb/gone/unrelated.md"), "utf8"), "{\"theirs\":true}");
  assert.equal(await readFile(definitionsOf("Nb/old/inside.md"), "utf8"), "{\"mine\":true}");

  // A star or tags kept under the destination name count too.
  await writeLibraryFile("Nb/old2/x.md", "# X\n");
  await setStarredFilePath("Nb/vacant/lost.md", true);
  await assert.rejects(() => renameFolder("Nb/old2", "vacant"), rejects409);
  assert.equal(await exists(itemPath("Nb", ["old2"])), true);
  await setFileTagsForPath("Nb/tagged/lost.md", ["t"]);
  await assert.rejects(() => renameFolder("Nb/old2", "tagged"), rejects409);

  // The wholesale move itself will not delete what is at the destination.
  await assert.rejects(() => moveFolderSidecars("Nb", ["old"], "Nb", ["gone"]), rejects409);
  assert.equal(await readFile(definitionsOf("Nb/gone/unrelated.md"), "utf8"), "{\"theirs\":true}");
  assert.equal(await exists(definitionsOf("Nb/old/inside.md")), true);
}));

test("renaming a folder onto a vacant name with nothing left behind still moves its records", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/old/inside.md", "# Inside\n");
  await writeAt(definitionsOf("Nb/old/inside.md"), "{}");
  await mkdir(path.dirname(definitionsOf("Nb/fresh/none.md")), { recursive: true });
  await renameFolder("Nb/old", "fresh");
  assert.equal(await exists(definitionsOf("Nb/fresh/inside.md")), true);
  assert.equal(await exists(definitionsOf("Nb/old/inside.md")), false);
}));

test("renaming to another file type refuses to delete records, and proceeds when nothing would be lost", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/note.md", "# Note\n");
  await writeAt(pythonCode("Nb/note.md"), "print('hi')\n");

  await assert.rejects(() => moveFile("Nb/note.md", "Nb", "note.pdf"), (error) => rejects409(error) && /Python code/.test((error as Error).message));
  assert.equal(await exists(disk("Nb/note.md")), true);
  assert.equal(await exists(disk("Nb/note.pdf")), false);
  assert.equal(await exists(pythonCode("Nb/note.md")), true);

  await assert.rejects(() => moveFileToDirectory("Nb/note.md", "Nb", "note.pdf"), rejects409);
  assert.equal(await exists(pythonCode("Nb/note.md")), true);

  // No records: the rename may go ahead (the bytes are not converted).
  await writeLibraryFile("Nb/plain.md", "# Plain\n");
  await moveFile("Nb/plain.md", "Nb", "plain.txt");
  assert.equal(await exists(disk("Nb/plain.txt")), true);
}));

test("a case-only rename of a file or folder is a rename, with its records following", async (context) => {
  await withTemporaryLibrary(["Nb"], async () => {
    await writeLibraryFile("Nb/Case.md", "# Case\n");
    if (!(await exists(disk("Nb/case.md")))) { context.skip("the disk is case-sensitive"); return; }
    await writeAt(definitionsOf("Nb/Case.md"), "{}");
    await setStarredFilePath("Nb/Case.md", true);
    await setFileTagsForPath("Nb/Case.md", ["t"]);

    await moveFile("Nb/Case.md", "Nb", "case.md");
    assert.ok((await readdir(itemPath("Nb", []))).includes("case.md"));
    assert.ok(!(await readdir(itemPath("Nb", []))).includes("Case.md"));
    assert.equal(await readFile(disk("Nb/case.md"), "utf8"), "# Case\n");
    assert.ok((await readdir(path.dirname(definitionsOf("Nb/case.md")))).includes("case.md.json"));
    assert.equal(await readFile(definitionsOf("Nb/case.md"), "utf8"), "{}");
    const metadata = await readWorkspaceMetadata();
    assert.deepEqual(metadata.starredFilePaths, ["Nb/case.md"]);
    assert.deepEqual(Object.keys(metadata.fileTags), ["Nb/case.md"]);

    // The same through the Move menu's entry point.
    await moveFileToDirectory("Nb/case.md", "Nb", "CASE.md");
    assert.ok((await readdir(itemPath("Nb", []))).includes("CASE.md"));
    assert.deepEqual((await readWorkspaceMetadata()).starredFilePaths, ["Nb/CASE.md"]);

    await writeLibraryFile("Nb/Folder/in.md", "# In\n");
    await writeAt(definitionsOf("Nb/Folder/in.md"), "{}");
    await renameFolder("Nb/Folder", "folder");
    assert.ok((await readdir(itemPath("Nb", []))).includes("folder"));
    assert.ok(!(await readdir(itemPath("Nb", []))).includes("Folder"));
    assert.equal(await readFile(definitionsOf("Nb/folder/in.md"), "utf8"), "{}");
  });
});

test("a move rewrites a moved note's relative links to keep opening the same files (docs/features/move-link-refactor.md)", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/index.md", "[Chapter](chapter.md) and [Gone](only-here.md) and [Same](same.md)\n");
  await writeLibraryFile("Nb/chapter.md", "# Outer chapter\n");
  await writeLibraryFile("Nb/only-here.md", "# Only here\n");
  await writeLibraryFile("Nb/same.md", "# Same\n");
  await writeLibraryFile("Nb/sub/chapter.md", "# Inner chapter\n");
  await writeLibraryFile("Nb/sub/same.md", "# Same\n");

  const moved = await moveFileToDirectory("Nb/index.md", "Nb/sub");
  // Same-named files beside the new place are not picked up: each link keeps its file.
  assert.equal(moved.content, "[Chapter](../chapter.md) and [Gone](../only-here.md) and [Same](../same.md)\n");
  assert.deepEqual(moved.links?.rewritten.map((note) => note.path), ["Nb/sub/index.md"]);

  // A move that changes nothing about its links rewrites nothing.
  await writeLibraryFile("Nb/plain.md", "[Chapter](chapter.md)\n");
  const renamed = await moveFile("Nb/plain.md", "Nb", "renamed.md");
  assert.equal(renamed.links, undefined);
}));
