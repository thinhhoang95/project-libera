import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { cachedPdfIdentity } from "../../src/lib/storage/pdf-identity";
import { mayBeBack, ORPHAN_GRACE_MS, ORPHAN_RETENTION_MS, reconcilePdfSidecars, setAsideBaseName } from "../../src/lib/storage/pdf-sidecars";
import { filePathFromParts, orphanedSidecarsDirectoryPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { whenNotebookIdle, withNotebookOperation } from "../../src/lib/storage/migration-fence";
import { fileExistence } from "../../src/lib/storage/library-links";
import { assertNotebookSound, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Review of 2026-11-25, package U2 (E-H1 PDF part, E-H4, E-H8): a case-only
// external rename keeps a PDF's side-cars, set-aside names fit the file-name
// limit, one failure does not stop the pass, and upkeep, Try to fix and
// Acknowledge never overlap on a notebook.

const BYTES = "%PDF-1.4 u2 bytes";
const LATER = () => Date.now() + 120_000;
const sizeOf = (bytes: string) => Buffer.byteLength(bytes);
const identityOf = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return cachedPdfIdentity(filePathFromParts(notebook, parts)); };
const listing = async (directory: string) => readdir(directory).catch(() => [] as string[]);
const annotationsDirectory = (notebook: string) => path.dirname(pdfAnnotationsPath(notebook, ["x.pdf"]));

test("E-H1: a case-only rename of a PDF moves its side-car to the new spelling at once, hashed or legacy", () => withTemporaryLibrary(["U2a"], async () => {
  const old = filePathFromParts("U2a", ["Paper.pdf"]);
  await writeLibraryFile("U2a/Paper.pdf", BYTES);
  await writeLibraryFile("U2a/Legacy.pdf", BYTES + "!");
  const identity = await identityOf("U2a/Paper.pdf");
  await writeAt(pdfAnnotationsPath("U2a", ["Paper.pdf"]), JSON.stringify({ source: identity, note: "hashed" }));
  await writeAt(pdfAnnotationsPath("U2a", ["Legacy.pdf"]), JSON.stringify({ note: "legacy" }));
  await rename(old, filePathFromParts("U2a", ["paper.pdf"]));
  await rename(filePathFromParts("U2a", ["Legacy.pdf"]), filePathFromParts("U2a", ["legacy.pdf"]));

  const result = await reconcilePdfSidecars("U2a", [{ path: "U2a/paper.pdf", size: sizeOf(BYTES) }, { path: "U2a/legacy.pdf", size: sizeOf(BYTES + "!") }]);
  assert.equal(result.setAside, 0);
  assert.equal(result.reattached, 2);
  assert.deepEqual((await listing(annotationsDirectory("U2a"))).sort(), ["legacy.pdf.json", "paper.pdf.json"], "the side-cars carry the new spelling");
  assert.match(await readFile(pdfAnnotationsPath("U2a", ["paper.pdf"]), "utf8"), /hashed/);
  // A later pass finds nothing missing.
  const again = await reconcilePdfSidecars("U2a", [{ path: "U2a/paper.pdf", size: sizeOf(BYTES) }, { path: "U2a/legacy.pdf", size: sizeOf(BYTES + "!") }], { now: LATER() });
  assert.deepEqual(again, { reattached: 0, setAside: 0 });
  assert.deepEqual(await listing(orphanedSidecarsDirectoryPath("U2a", "annotations")), []);
  await assertNotebookSound("U2a");
}));

test("E-H1: a case-only rename of a folder moves the side-cars under it", () => withTemporaryLibrary(["U2b"], async () => {
  await writeLibraryFile("U2b/Docs/a.pdf", BYTES);
  await writeAt(pdfAnnotationsPath("U2b", ["Docs", "a.pdf"]), JSON.stringify({ note: "in folder" }));
  await rename(filePathFromParts("U2b", ["Docs"]), filePathFromParts("U2b", ["Docs-tmp"]));
  await rename(filePathFromParts("U2b", ["Docs-tmp"]), filePathFromParts("U2b", ["docs"]));

  const result = await reconcilePdfSidecars("U2b", [{ path: "U2b/docs/a.pdf", size: sizeOf(BYTES) }]);
  assert.equal(result.setAside, 0);
  assert.equal(result.reattached, 1);
  assert.deepEqual(await listing(annotationsDirectory("U2b")), ["docs"], "the folder of side-cars carries the new spelling");
  assert.match(await readFile(pdfAnnotationsPath("U2b", ["docs", "a.pdf"]), "utf8"), /in folder/);
  await assertNotebookSound("U2b");
}));

test("E-H1: an unhashed set-aside record whose PDF came back in another case is kept past expiry and comes back", () => withTemporaryLibrary(["U2c"], async () => {
  await writeLibraryFile("U2c/paper.pdf", BYTES);
  const record = path.join(orphanedSidecarsDirectoryPath("U2c", "annotations"), "1-aaaa-Paper.pdf.json");
  const old = new Date(Date.now() - ORPHAN_RETENTION_MS - 86_400_000).toISOString();
  await writeAt(record, JSON.stringify({ kind: "annotations", originalPath: "U2c/Paper.pdf", orphanedAt: old, source: null, sidecar: { note: "legacy set aside" } }));
  const files = [{ path: "U2c/paper.pdf", size: sizeOf(BYTES) }];
  assert.equal(await mayBeBack({ originalPath: "U2c/Paper.pdf", source: null }, files, new Map(), (libraryPath) => fileExistence().isFile(libraryPath)), true);
  const result = await reconcilePdfSidecars("U2c", files, { now: LATER() });
  assert.equal(result.reattached, 1);
  assert.match(await readFile(pdfAnnotationsPath("U2c", ["paper.pdf"]), "utf8"), /legacy set aside/);
  await assertNotebookSound("U2c");
}));

test("E-H1: a new PDF set does not wait out the set-aside scan interval", () => withTemporaryLibrary(["U2d"], async () => {
  const none = await reconcilePdfSidecars("U2d", []);
  assert.deepEqual(none, { reattached: 0, setAside: 0 });
  await writeLibraryFile("U2d/back.pdf", BYTES);
  const identity = await identityOf("U2d/back.pdf");
  const record = path.join(orphanedSidecarsDirectoryPath("U2d", "annotations"), "1-aaaa-old.pdf.json");
  await writeAt(record, JSON.stringify({ kind: "annotations", originalPath: "U2d/old.pdf", orphanedAt: new Date().toISOString(), source: identity, sidecar: { source: identity, note: "set aside" } }));
  // Within the minute, but the notebook's PDFs changed.
  const result = await reconcilePdfSidecars("U2d", [{ path: "U2d/back.pdf", size: sizeOf(BYTES) }]);
  assert.equal(result.reattached, 1);
}));

test("E-H8: a set-aside name stays within 255 bytes for a long PDF name, and one failure does not stop the pass", () => withTemporaryLibrary(["U2e"], async () => {
  const long = `${"é".repeat(88)}.pdf`; // 176 bytes + ".pdf"
  assert.ok(Buffer.byteLength(`${long}.json`) > 179);
  assert.ok(Buffer.byteLength(`${long}.json`) <= 255);
  await writeAt(pdfAnnotationsPath("U2e", [long]), JSON.stringify({ note: "long one" }));
  await writeAt(pdfAnnotationsPath("U2e", ["gone.pdf"]), JSON.stringify({ note: "plain" }));
  const files: Array<{ path: string; size: number }> = [];
  await reconcilePdfSidecars("U2e", files, { now: 1_000 });
  const result = await reconcilePdfSidecars("U2e", files, { now: 1_000 + ORPHAN_GRACE_MS + 1 });
  assert.equal(result.setAside, 2);
  const names = await listing(orphanedSidecarsDirectoryPath("U2e", "annotations"));
  assert.equal(names.length, 2);
  for (const name of names) assert.ok(Buffer.byteLength(name) + 52 <= 255, `${name} leaves room for the write's temporary name`);
  const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(orphanedSidecarsDirectoryPath("U2e", "annotations"), name), "utf8"))));
  assert.ok(records.some((record) => record.originalPath === `U2e/${long}`), "the original path stays in the record");
  assert.ok(Buffer.byteLength(setAsideBaseName(`${long}.json`)) <= 170);
  assert.notEqual(setAsideBaseName(`${"a".repeat(300)}1.pdf.json`), setAsideBaseName(`${"a".repeat(300)}2.pdf.json`));
  assert.match(setAsideBaseName(`${"a".repeat(300)}.pdf.json`), /\.pdf\.json$/);
}));

test("E-H8: one side-car that cannot be set aside does not abort the rest of the pass", () => withTemporaryLibrary(["U2f"], async () => {
  await writeAt(pdfAnnotationsPath("U2f", ["a.pdf"]), JSON.stringify({ note: "a" }));
  await writeAt(pdfAnnotationsPath("U2f", ["b.pdf"]), JSON.stringify({ note: "b" }));
  await reconcilePdfSidecars("U2f", [], { now: 1_000 });
  const real = fs.rename;
  let failed = false;
  mock.method(fs, "rename", async (from: string, to: string) => {
    if (!failed && String(to).includes(`${path.sep}orphaned-sidecars${path.sep}`)) { failed = true; throw Object.assign(new Error("name too long"), { code: "ENAMETOOLONG" }); }
    return real(from, to);
  });
  try {
    const result = await reconcilePdfSidecars("U2f", [], { now: 1_000 + ORPHAN_GRACE_MS + 1 });
    assert.equal(result.setAside, 1, "the other side-car was still set aside");
  } finally { mock.restoreAll(); }
}));

test("E-H8: the record written for a side-car that changed meanwhile is removed", () => withTemporaryLibrary(["U2g"], async () => {
  const sidecar = pdfAnnotationsPath("U2g", ["gone.pdf"]);
  await writeAt(sidecar, JSON.stringify({ note: "before" }));
  await reconcilePdfSidecars("U2g", [], { now: 1_000 });
  const real = fs.rename;
  mock.method(fs, "rename", async (from: string, to: string) => {
    const result = await real(from, to);
    if (String(to).includes(`${path.sep}orphaned-sidecars${path.sep}`)) await writeFile(sidecar, JSON.stringify({ note: "saved meanwhile" }));
    return result;
  });
  try { await reconcilePdfSidecars("U2g", [], { now: 1_000 + ORPHAN_GRACE_MS + 1 }); } finally { mock.restoreAll(); }
  assert.match(await readFile(sidecar, "utf8"), /saved meanwhile/, "the newer bytes stay");
  assert.deepEqual(await listing(orphanedSidecarsDirectoryPath("U2g", "annotations")), [], "no stale copy is left to come back later");
}));

test("E-H4: two upkeep passes on a notebook never run at once, and Try to fix and Acknowledge queue behind them", () => withTemporaryLibrary(["U2h"], async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = whenNotebookIdle("U2h", async () => { order.push("upkeep 1 start"); await gate; order.push("upkeep 1 end"); });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await whenNotebookIdle("U2h", async () => { order.push("upkeep 2"); });
  assert.equal(second, false, "a second upkeep pass is skipped, not run beside the first");
  const repair = withNotebookOperation("U2h", async () => { order.push("repair start"); await Promise.resolve(); order.push("repair end"); });
  const cleanup = withNotebookOperation("U2h", async () => { order.push("cleanup"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["upkeep 1 start"], "nothing overlaps the running upkeep");
  release();
  assert.equal(await first, true);
  await Promise.all([repair, cleanup]);
  assert.deepEqual(order, ["upkeep 1 start", "upkeep 1 end", "repair start", "repair end", "cleanup"]);
  // Free again, and another notebook was never held.
  assert.equal(await whenNotebookIdle("U2h", async () => undefined), true);
}));

test("E-H4: an operation that starts another on the same notebook is not deadlocked, and a failure releases the turn", () => withTemporaryLibrary(["U2i"], async () => {
  const seen: string[] = [];
  await withNotebookOperation("U2i", async () => { await withNotebookOperation("U2i", async () => { seen.push("inner"); }); });
  assert.deepEqual(seen, ["inner"]);
  await assert.rejects(withNotebookOperation("U2i", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await whenNotebookIdle("U2i", async () => undefined), true);
}));
