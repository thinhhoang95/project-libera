import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fsp from "node:fs/promises";
import { mkdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { readTetherTarget, resetBibTethers, settleBibTether, tetherBibFile } from "../../src/lib/references/bib-tether";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { subscribeReferenceEvents, type ReferenceServerEvent } from "../../src/lib/references/library-events";
import type { ReferenceAttachment } from "../../src/lib/references/types";
import { migrationJournalDirectory, migrationJournalsChanged } from "../../src/lib/storage/migration-fence";
import { notebookPath, referenceLibraryPath } from "../../src/lib/storage/paths";
import {
  moveReferenceAttachments,
  pendingReferenceReattach,
  reattachMissingReferenceFiles,
  readReferenceLibrary,
  resetReferenceReattachSchedule,
  updateReferenceLibrary,
  withReferenceFileLock,
} from "../../src/lib/storage/references";
import { assertNotebookSound, withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";

// 2026-11-25 file-moving review, package R1: the .bib tether follows a local
// move even when bib-tether.ts's event listener is not there (L-H2), and the
// background re-attach respects shared notebooks, the migration fence and the
// bytes it chose, and reports its change like any other (E-H9).

const DOE_BIB = "@book{doe2019,\n  author = {Doe, John},\n  title = {A book},\n  year = {2019},\n  publisher = {Press}\n}\n";

async function withLibrary(run: () => Promise<void>) {
  await withTemporaryLibrary(["A", "B"], async () => {
    mock.restoreAll();
    try { await run(); }
    finally {
      await pendingReferenceReattach();
      resetReferenceReattachSchedule();
      await settleBibTether("A").catch(() => undefined);
      resetBibTethers();
      resetBibMirrorScheduler();
      mock.restoreAll();
    }
  });
}

/** A process that never loaded the tether: nobody listens to reference events. */
function coldStart() {
  const listeners = (globalThis as Record<symbol, Set<unknown> | undefined>)[Symbol.for("libera.referenceServerEvents")];
  listeners?.clear();
}

async function addPdf(notebook: string, file: string) {
  const library = await readReferenceLibrary(notebook);
  await updateReferenceLibrary(notebook, library.revision, [{
    op: "add",
    entry: { csl: { type: "book", title: "Paper" }, attachments: [{ kind: "pdf", path: file } as ReferenceAttachment] },
  }]);
}

const attachmentPaths = async (notebook: string) => Object.values((await readReferenceLibrary(notebook)).entries)
  .flatMap((entry) => entry.attachments.map((attachment) => attachment.kind === "url" ? attachment.url : attachment.path));

test("L-H2: a moved .bib is followed by its tether without the tether module's listener, before the move returns", () => withLibrary(async () => {
  const file = await writeLibraryFile("A/old.bib", DOE_BIB);
  await tetherBibFile("A", file, { prefer: "file" });
  await settleBibTether("A");
  resetBibTethers();
  coldStart();
  await rename(file, path.join(notebookPath("A"), "new.bib"));
  await moveReferenceAttachments("A/old.bib", "A/new.bib");
  // No settling, no waiting: the tether's record already names the new file.
  assert.deepEqual(await readTetherTarget("A"), { libraryPath: "A/new.bib" });
  await settleBibTether("A");
  await assertNotebookSound("A", { allow: ["tetherFileMissing"], severities: ["error", "warning"] });
}));

test("L-H2: a failing attachment remap is thrown, after the tether has followed", () => withLibrary(async () => {
  const file = await writeLibraryFile("A/old.bib", DOE_BIB);
  await tetherBibFile("A", file, { prefer: "file" });
  await settleBibTether("A");
  resetBibTethers();
  coldStart();
  // A notebook whose library cannot be read (a folder where the file should be).
  await mkdir(referenceLibraryPath("B"), { recursive: true });
  await rename(file, path.join(notebookPath("A"), "new.bib"));
  await assert.rejects(moveReferenceAttachments("A/old.bib", "A/new.bib"));
  assert.deepEqual(await readTetherTarget("A"), { libraryPath: "A/new.bib" });
}));

test("E-H9: an attachment of a shared notebook whose file has not arrived is not repointed to a same-bytes copy", () => withLibrary(async () => {
  await writeLibraryFile("Sh/paper.pdf", "paper bytes");
  await writeFile(path.join(notebookPath("Sh"), ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  await addPdf("A", "Sh/paper.pdf");
  await fsp.rm(path.join(notebookPath("Sh"), "paper.pdf"));
  await writeLibraryFile("B/copy.pdf", "paper bytes");
  const result = await reattachMissingReferenceFiles("A");
  assert.equal(result.reattached, 0, "the shared file may only be on its way");
  assert.deepEqual(await attachmentPaths("A"), ["Sh/paper.pdf"]);
  invalidateSharedNotebookCache();
}));

test("E-H9: nothing is repointed while a migration involves the attachment's notebook", () => withLibrary(async () => {
  await writeLibraryFile("A/paper.pdf", "paper bytes");
  await addPdf("A", "A/paper.pdf");
  await rename(path.join(notebookPath("A"), "paper.pdf"), path.join(notebookPath("A"), "moved.pdf"));
  const journals = migrationJournalDirectory();
  await mkdir(journals, { recursive: true });
  await writeFile(path.join(journals, "m1.json"), JSON.stringify({ state: "moving", source: "A", destination: { notebook: "B" }, items: [{ from: "A/paper.pdf", to: "B/paper.pdf" }] }));
  migrationJournalsChanged();
  assert.equal((await reattachMissingReferenceFiles("A")).reattached, 0);
  assert.deepEqual(await attachmentPaths("A"), ["A/paper.pdf"]);
  await fsp.rm(path.join(journals, "m1.json"));
  migrationJournalsChanged();
  assert.equal((await reattachMissingReferenceFiles("A")).reattached, 1);
  assert.deepEqual(await attachmentPaths("A"), ["A/moved.pdf"]);
}));

test("E-H9: a target whose bytes changed (same size) after the scan is not committed", () => withLibrary(async () => {
  await writeLibraryFile("A/paper.pdf", "paper bytes");
  await addPdf("A", "A/paper.pdf");
  const moved = path.join(notebookPath("A"), "moved.pdf");
  await rename(path.join(notebookPath("A"), "paper.pdf"), moved);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = withReferenceFileLock(referenceLibraryPath("A"), () => gate);
  const pass = reattachMissingReferenceFiles("A");
  await delay(400);
  await writeFile(moved, "other bytes!"); // the same length, other content
  await utimes(moved, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  release();
  await held;
  assert.equal((await pass).reattached, 0);
  assert.deepEqual(await attachmentPaths("A"), ["A/paper.pdf"]);
}));

test("E-H9: a re-attachment is announced like any library change", () => withLibrary(async () => {
  await writeLibraryFile("A/paper.pdf", "paper bytes");
  await addPdf("A", "A/paper.pdf");
  await rename(path.join(notebookPath("A"), "paper.pdf"), path.join(notebookPath("A"), "moved.pdf"));
  const events: ReferenceServerEvent[] = [];
  const stop = subscribeReferenceEvents((event) => events.push(event));
  try {
    assert.equal((await reattachMissingReferenceFiles("A")).reattached, 1);
  } finally { stop(); }
  const revision = (await readReferenceLibrary("A")).revision;
  assert.deepEqual(events.filter((event) => event.type === "library"), [{ type: "library", notebook: "A", revision }]);
  await stat(referenceLibraryPath("A"));
}));
