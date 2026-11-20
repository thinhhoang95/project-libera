import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openDirectory } from "../../src/lib/storage/directory-mode";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { getLinkedFolder, referenceLibraryPath } from "../../src/lib/storage/paths";
import {
  moveReferenceAttachmentsBatch,
  pendingReferenceReattach,
  reattachMissingReferenceFiles,
  readReferenceLibrary,
  resetReferenceReattachSchedule,
  updateReferenceLibrary,
  withReferenceFileLock,
} from "../../src/lib/storage/references";
import type { ReferenceAttachment } from "../../src/lib/references/types";

async function withLibrary(run: (root: string, scratch: string) => Promise<void>) {
  await pendingReferenceReattach();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-reattach-"));
  const previous = process.env.LIBERA_DATA_DIR;
  const previousMachine = process.env.LIBERA_MACHINE_ID;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  process.env.LIBERA_MACHINE_ID = "computer-a";
  const root = path.join(scratch, "data", "users", "admin");
  try {
    await mkdir(root, { recursive: true });
    await run(root, scratch);
  } finally {
    mock.restoreAll();
    await pendingReferenceReattach();
    resetReferenceReattachSchedule();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    if (previousMachine === undefined) delete process.env.LIBERA_MACHINE_ID; else process.env.LIBERA_MACHINE_ID = previousMachine;
    await rm(scratch, { recursive: true, force: true });
  }
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

/**
 * Starts a reattach pass whose commit has to wait for the library lock, runs
 * `during` (the world changing after the scan), then lets the commit go.
 */
async function reattachWhileLocked(notebook: string, during: () => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = withReferenceFileLock(referenceLibraryPath(notebook), () => gate);
  const pass = reattachMissingReferenceFiles(notebook);
  await delay(400); // The scan and hashing finish; the commit is parked on the lock.
  await during();
  release();
  await held;
  return pass;
}

test("F45: a reattachment is skipped when the original came back after the scan", async () => {
  await withLibrary(async (root) => {
    await createNotebook("A");
    await writeFile(path.join(root, "A", "paper.pdf"), "paper bytes");
    await addPdf("A", "A/paper.pdf");
    await rename(path.join(root, "A", "paper.pdf"), path.join(root, "A", "moved.pdf"));
    // A copy appears at the old place again once the scan has chosen moved.pdf.
    const result = await reattachWhileLocked("A", () => writeFile(path.join(root, "A", "paper.pdf"), "paper bytes"));
    assert.equal(result.reattached, 0);
    assert.deepEqual(await attachmentPaths("A"), ["A/paper.pdf"]);
  });
});

test("F45: a reattachment is skipped when the attachment record changed after the scan", async () => {
  await withLibrary(async (root) => {
    await createNotebook("A");
    await writeFile(path.join(root, "A", "paper.pdf"), "paper bytes");
    await addPdf("A", "A/paper.pdf");
    await rename(path.join(root, "A", "paper.pdf"), path.join(root, "A", "moved.pdf"));
    const file = referenceLibraryPath("A");
    const result = await reattachWhileLocked("A", async () => {
      // The record was replaced by a different file's hash at the same path.
      const library = JSON.parse(await readFile(file, "utf8"));
      for (const entry of Object.values(library.entries) as { attachments: { sha256: string }[] }[]) entry.attachments[0].sha256 = "0".repeat(64);
      library.revision += 1;
      await writeFile(file, JSON.stringify(library));
    });
    assert.equal(result.reattached, 0);
    assert.deepEqual(await attachmentPaths("A"), ["A/paper.pdf"]);
  });
});

test("F46: an unreadable folder keeps a lone visible match from being called unique", async () => {
  await withLibrary(async (root) => {
    await createNotebook("A");
    await mkdir(path.join(root, "A", "hidden"));
    await writeFile(path.join(root, "A", "paper.pdf"), "paper bytes");
    await addPdf("A", "A/paper.pdf");
    await rename(path.join(root, "A", "paper.pdf"), path.join(root, "A", "moved.pdf"));
    const read = fsp.readdir;
    mock.method(fsp, "readdir", (...args: Parameters<typeof fsp.readdir>) => {
      if (String(args[0]) === path.join(root, "A", "hidden")) return Promise.reject(Object.assign(new Error("provider unavailable"), { code: "EIO" }));
      return read(...args);
    });
    const result = await reattachMissingReferenceFiles("A");
    assert.equal(result.reattached, 0, "a second copy may sit in the folder that could not be read");
    assert.deepEqual(await attachmentPaths("A"), ["A/paper.pdf"]);
    mock.restoreAll();
    assert.equal((await reattachMissingReferenceFiles("A")).reattached, 1, "a complete search still re-points the one match");
  });
});

test("F95: a move reports the linked folders that are not connected, whose libraries could not be remapped", async () => {
  await withLibrary(async (_root, scratch) => {
    const original = path.join(scratch, "Project");
    await mkdir(original);
    await writeFile(path.join(original, "paper.pdf"), "paper");
    const linked = await openDirectory(original);
    await rename(original, path.join(scratch, "elsewhere"));
    await mkdir(original);
    process.env.LIBERA_MACHINE_ID = "computer-b";
    assert.equal(getLinkedFolder(linked.name)!.unresolved, true);
    const { offline } = await moveReferenceAttachmentsBatch(new Map([["A/a.pdf", "A/b.pdf"]]));
    assert.deepEqual(offline, [linked.name]);
    assert.deepEqual((await moveReferenceAttachmentsBatch(new Map())).offline, [], "nothing moved, nothing to report");
  });
});
