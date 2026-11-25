import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { inkFileName } from "../../src/lib/ink/authors";
import { emptyInkAuthorFile } from "../../src/lib/ink/codec";
import { inkFolderPath, reconcileInkFolders, resetInkStorageForTests } from "../../src/lib/storage/ink";
import { verifyNotebook } from "../../src/lib/storage/integrity";
import { cachedPdfIdentity } from "../../src/lib/storage/pdf-identity";
import { ORPHAN_GRACE_MS, ORPHAN_RETENTION_MS } from "../../src/lib/storage/pdf-sidecars";
import { filePathFromParts, orphanedSidecarsDirectoryPath } from "../../src/lib/storage/paths";
import { assertNotebookSound, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Review of 2026-11-25, package U1 (ink upkeep): E-C3 (a set-aside across
// volumes), E-H1 (a file renamed in case or normalization only keeps its ink),
// E-H6 (a returned file clears its missing timer) and E-M1 (the check reads a
// multi-version ink folder as the upkeep does).

const BYTES = "%PDF-1.4 u1 bytes";
const FRAME = { unit: "pt" as const, width: 100, height: 100 };
const AUTHOR = "aaaaaaaaaa";

const sourceOf = async (relative: string) => {
  const [notebook, ...parts] = relative.split("/");
  const found = await cachedPdfIdentity(filePathFromParts(notebook, parts));
  return { size: found.size, sha256: found.contentHash };
};

async function seedInk(notebook: string, parts: string[], pages: Array<{ chunk: string; source?: { size: number; sha256: string } }> = [{ chunk: "page-0001" }]) {
  const folder = inkFolderPath(notebook, parts);
  for (const page of pages) await writeAt(path.join(folder, inkFileName(page.chunk, AUTHOR)), JSON.stringify(emptyInkAuthorFile({ key: AUTHOR }, FRAME, page.source)));
  return folder;
}

const exists = async (target: string) => { try { await fs.access(target); return true; } catch { return false; } };
const listing = (directory: string) => readdir(directory).catch(() => [] as string[]);
const filesOf = (notebook: string, ...relative: string[]) => relative.map((entry) => ({ path: `${notebook}/${entry}`, size: Buffer.byteLength(BYTES) }));

test("E-H1: a Markdown note renamed only in case keeps its ink under the new spelling", () => withTemporaryLibrary(["U1a"], async () => {
  resetInkStorageForTests();
  const note = await writeLibraryFile("U1a/Old.md", "# note\n");
  await seedInk("U1a", ["Old.md"]);
  await rename(note, path.join(path.dirname(note), "old.md"));
  const result = await reconcileInkFolders("U1a", [], { now: Date.now() + 120_000 });
  assert.deepEqual(result, { reattached: 1, setAside: 0 });
  assert.deepEqual(await listing(path.dirname(inkFolderPath("U1a", ["old.md"]))), ["old.md"], "the ink folder is spelled as the file now");
  assert.deepEqual(await listing(orphanedSidecarsDirectoryPath("U1a", "ink")), [], "nothing was set aside");
  await assertNotebookSound("U1a");
}));

test("E-H1: a PDF with recorded bytes renamed only in case keeps its ink, and so does its renamed folder", () => withTemporaryLibrary(["U1b"], async () => {
  resetInkStorageForTests();
  const pdf = await writeLibraryFile("U1b/Docs/Paper.pdf", BYTES);
  await seedInk("U1b", ["Docs", "Paper.pdf"], [{ chunk: "page-0001", source: await sourceOf("U1b/Docs/Paper.pdf") }]);
  // The file, then its folder, renamed outside Libera.
  await rename(pdf, path.join(path.dirname(pdf), "paper.pdf"));
  await rename(path.dirname(pdf), path.join(path.dirname(path.dirname(pdf)), "docs"));
  const result = await reconcileInkFolders("U1b", filesOf("U1b", "docs/paper.pdf"), { now: Date.now() + 120_000 });
  assert.deepEqual(result, { reattached: 1, setAside: 0 });
  const inkRoot = path.dirname(path.dirname(inkFolderPath("U1b", ["docs", "paper.pdf"])));
  assert.deepEqual(await listing(inkRoot), ["docs"]);
  assert.deepEqual(await listing(path.join(inkRoot, "docs")), ["paper.pdf"]);
  assert.deepEqual(await listing(orphanedSidecarsDirectoryPath("U1b", "ink")), []);
  await assertNotebookSound("U1b");
}));

test("E-H1: a note renamed only in Unicode normalization keeps its ink", () => withTemporaryLibrary(["U1c"], async () => {
  resetInkStorageForTests();
  const composed = "café.md";
  const decomposed = "café.md";
  const note = await writeLibraryFile(`U1c/${composed}`, "# note\n");
  await seedInk("U1c", [composed]);
  await rename(note, path.join(path.dirname(note), decomposed));
  const result = await reconcileInkFolders("U1c", [], { now: Date.now() + 120_000 });
  assert.equal(result.reattached, 1);
  assert.equal(result.setAside, 0);
  const names = await listing(path.dirname(inkFolderPath("U1c", [composed])));
  assert.deepEqual(names, [decomposed], "the ink folder is spelled as the file now");
  await assertNotebookSound("U1c");
}));

test("E-H1: set-aside Markdown ink whose file is back under another spelling is not expired", () => withTemporaryLibrary(["U1d"], async () => {
  resetInkStorageForTests();
  await writeLibraryFile("U1d/old.md", "# note\n");
  // The slot of the file is taken by ink saved since, so nothing is reattached; only the expiry decides.
  await seedInk("U1d", ["old.md"]);
  const orphans = orphanedSidecarsDirectoryPath("U1d", "ink");
  const kept = path.join(orphans, "1-aaaaaaaa");
  const now = Date.now();
  await writeAt(path.join(kept, "record.json"), JSON.stringify({ originalPath: "U1d/Old.md", orphanedAt: new Date(now - ORPHAN_RETENTION_MS - 86_400_000).toISOString(), source: null }));
  await writeAt(path.join(kept, "ink", inkFileName("page-0001", AUTHOR)), JSON.stringify(emptyInkAuthorFile({ key: AUTHOR }, FRAME)));
  await reconcileInkFolders("U1d", [], { now });
  assert.ok(await exists(path.join(kept, "ink")), "the ink stays for its file");
}));

test("E-H6: a file that came back gets the full grace again the next time it goes", () => withTemporaryLibrary(["U1e"], async () => {
  resetInkStorageForTests();
  const pdf = await writeLibraryFile("U1e/a.pdf", BYTES);
  const folder = await seedInk("U1e", ["a.pdf"], [{ chunk: "page-0001", source: { size: 5, sha256: "ab".repeat(32) } }]);
  const start = Date.now() + 120_000;
  await rm(pdf);
  await reconcileInkFolders("U1e", [], { now: start });
  await writeFile(pdf, BYTES);
  await reconcileInkFolders("U1e", filesOf("U1e", "a.pdf"), { now: start + 10_000 });
  await rm(pdf);
  // Past the first blip's grace, but well within the second's.
  const result = await reconcileInkFolders("U1e", [], { now: start + ORPHAN_GRACE_MS + 20_000 });
  assert.equal(result.setAside, 0, "the new blip is within its own grace");
  assert.ok(await exists(folder));
  assert.equal((await reconcileInkFolders("U1e", [], { now: start + ORPHAN_GRACE_MS + 20_000 + ORPHAN_GRACE_MS })).setAside, 1);
}));

/** Makes a rename of `folder` into the set-aside directory fail as it does between volumes. */
function crossVolume(folder: string, orphans: string) {
  const real = fs.rename;
  mock.method(fs, "rename", async (from: string, to: string) => {
    if (path.resolve(from) === path.resolve(folder) && path.resolve(to).startsWith(path.resolve(orphans))) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    return real(from, to);
  });
}

test("E-C3: ink set aside across volumes is copied and published, with no record left without its ink", () => withTemporaryLibrary(["U1f"], async () => {
  resetInkStorageForTests();
  const orphans = orphanedSidecarsDirectoryPath("U1f", "ink");
  const folder = await seedInk("U1f", ["gone.pdf"], [{ chunk: "page-0001", source: { size: 5, sha256: "ab".repeat(32) } }]);
  const other = await seedInk("U1f", ["other.pdf"], [{ chunk: "page-0001", source: { size: 6, sha256: "cd".repeat(32) } }]);
  const now = Date.now();
  await reconcileInkFolders("U1f", [], { now });
  try {
    crossVolume(folder, orphans);
    const result = await reconcileInkFolders("U1f", [], { now: now + ORPHAN_GRACE_MS });
    assert.equal(result.setAside, 2, "the other folder is reconciled too");
  } finally { mock.restoreAll(); }
  assert.ok(!(await exists(folder)) && !(await exists(other)));
  const directories = await listing(orphans);
  assert.equal(directories.length, 2);
  for (const name of directories) {
    assert.ok(await exists(path.join(orphans, name, "ink", inkFileName("page-0001", AUTHOR))), "every record has its ink");
    assert.deepEqual((await listing(path.join(orphans, name))).sort(), ["ink", "record.json"], "no staging left behind");
  }
  // A further refresh adds nothing.
  await reconcileInkFolders("U1f", [], { now: now + 2 * ORPHAN_GRACE_MS });
  assert.equal((await listing(orphans)).length, 2);
  await assertNotebookSound("U1f");
}));

test("E-C3: ink edited just before a cross-volume copy is copied as it is, with nothing lost", () => withTemporaryLibrary(["U1g"], async () => {
  resetInkStorageForTests();
  const orphans = orphanedSidecarsDirectoryPath("U1g", "ink");
  const folder = await seedInk("U1g", ["gone.pdf"], [{ chunk: "page-0001", source: { size: 5, sha256: "ab".repeat(32) } }]);
  const now = Date.now();
  await reconcileInkFolders("U1g", [], { now });
  try {
    const real = fs.rename;
    mock.method(fs, "rename", async (from: string, to: string) => {
      if (path.resolve(from) === path.resolve(folder) && path.resolve(to).startsWith(path.resolve(orphans))) {
        // A save lands after the move was tried and before the copy is checked.
        const file = path.join(folder, inkFileName("page-0001", AUTHOR));
        await writeFile(file, `${await readFile(file, "utf8")} `);
        await utimes(file, new Date(), new Date(Date.now() + 5_000));
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      }
      return real(from, to);
    });
    assert.equal((await reconcileInkFolders("U1g", [], { now: now + ORPHAN_GRACE_MS })).setAside, 1, "the copy is taken of what is there");
  } finally { mock.restoreAll(); }
  // The edit happened before the snapshot, so the copy is consistent and the move completes; nothing is lost either way.
  const [name] = await listing(orphans);
  assert.ok(await exists(path.join(orphans, name, "ink", inkFileName("page-0001", AUTHOR))));
}));

test("E-C3: one folder that fails does not stop the rest, and the failure is still reported", () => withTemporaryLibrary(["U1h"], async () => {
  resetInkStorageForTests();
  const orphans = orphanedSidecarsDirectoryPath("U1h", "ink");
  const bad = await seedInk("U1h", ["a-bad.pdf"], [{ chunk: "page-0001", source: { size: 5, sha256: "ab".repeat(32) } }]);
  const good = await seedInk("U1h", ["b-good.pdf"], [{ chunk: "page-0001", source: { size: 6, sha256: "cd".repeat(32) } }]);
  const now = Date.now();
  await reconcileInkFolders("U1h", [], { now });
  try {
    const real = fs.rename;
    mock.method(fs, "rename", async (from: string, to: string) => {
      if (path.resolve(from) === path.resolve(bad)) throw Object.assign(new Error("disk trouble"), { code: "EIO" });
      return real(from, to);
    });
    await assert.rejects(reconcileInkFolders("U1h", [], { now: now + ORPHAN_GRACE_MS }), /disk trouble/);
  } finally { mock.restoreAll(); }
  assert.ok(await exists(bad), "the failed folder stays where it was");
  assert.ok(!(await exists(good)), "the other was set aside");
  assert.ok((await listing(orphans)).length >= 1);
}));

test("E-M1: the check reads every source of a multi-version ink folder, as the upkeep does", () => withTemporaryLibrary(["U1i"], async () => {
  resetInkStorageForTests();
  await writeLibraryFile("U1i/first.pdf", BYTES);
  await writeLibraryFile("U1i/second.pdf", "%PDF-1.4 a different one!");
  await seedInk("U1i", ["gone.pdf"], [
    { chunk: "page-0001", source: await sourceOf("U1i/first.pdf") },
    { chunk: "page-0002", source: await sourceOf("U1i/second.pdf") },
  ]);
  const report = await verifyNotebook("U1i");
  const about = report.findings.filter((finding) => finding.path === "U1i/gone.pdf");
  assert.ok(about.length > 0, "the folder is reported");
  assert.ok(!about.some((finding) => /belong to/.test(finding.message)), "no one file is promised it");
  assert.ok(about.every((finding) => !finding.clear), "and it is not offered for removal");
  // The upkeep agrees: it moves and sets aside nothing.
  const result = await reconcileInkFolders("U1i", filesOf("U1i", "first.pdf"), { now: Date.now() + 5 * ORPHAN_GRACE_MS });
  assert.deepEqual(result, { reattached: 0, setAside: 0 });
}));
