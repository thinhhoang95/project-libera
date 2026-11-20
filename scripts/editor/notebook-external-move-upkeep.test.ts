import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { inkFileName } from "../../src/lib/ink/authors";
import { emptyInkAuthorFile } from "../../src/lib/ink/codec";
import { inkFolderPath, reconcileInkFolders } from "../../src/lib/storage/ink";
import { cachedPdfIdentity } from "../../src/lib/storage/pdf-identity";
import { matchByIdentity, ORPHAN_GRACE_MS, ORPHAN_RETENTION_MS, reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { filePathFromParts, orphanedSidecarsDirectoryPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// Upkeep of side files after a file was moved outside the app (review of
// 2026-11-20, findings 34, 35, 36, 37 and 39): reattachment never replaces
// work saved meanwhile, a folder of ink from two versions is not moved whole,
// an interrupted set-aside stays discoverable, expiry keeps work whose file
// may be back, and slot occupancy follows the file system's case rules.

const BYTES = "%PDF-1.4 upkeep bytes";
const OTHER_BYTES = "%PDF-1.4 other bytes!";
const FRAME = { unit: "pt" as const, width: 100, height: 100 };
const AUTHOR = "aaaaaaaaaa";

/** Past the minute the upkeep waits between scans of set-aside records, which the notebook's own creation may have just started. */
const LATER = () => Date.now() + 120_000;

const identityOf =async (relative: string) => {
  const [notebook, ...parts] = relative.split("/");
  return cachedPdfIdentity(filePathFromParts(notebook, parts));
};
const sizeOf = (bytes: string) => Buffer.byteLength(bytes);
const annotations = (notebook: string, relative: string) => pdfAnnotationsPath(notebook, relative.split("/").slice(1));

/** An annotations side file as the app saves it, recording the PDF it was made for. */
const annotationJson = (identity: { size: number; contentHash: string }, note: string) => JSON.stringify({ source: identity, note });

async function seedInk(relative: string, pages: Array<{ chunk: string; source?: { size: number; sha256: string } }>) {
  const [notebook, ...parts] = relative.split("/");
  const folder = inkFolderPath(notebook, parts);
  for (const page of pages) await writeAt(path.join(folder, inkFileName(page.chunk, AUTHOR)), JSON.stringify(emptyInkAuthorFile({ key: AUTHOR }, FRAME, page.source)));
  return folder;
}

const inkSourceOf = async (relative: string) => { const found = await identityOf(relative); return { size: found.size, sha256: found.contentHash }; };

/** Runs `plant` the first time the file system is asked to publish at `destination`, as a save that lands after the upkeep's checks would. */
function plantBeforePublishing(destination: string, plant: () => Promise<void>) {
  const real = { link: fs.link, mkdir: fs.mkdir, rename: fs.rename };
  let planted = false;
  const hit = async (value: unknown) => {
    if (planted || typeof value !== "string" || path.resolve(value) !== path.resolve(destination)) return;
    planted = true;
    await plant();
  };
  mock.method(fs, "link", async (from: string, to: string) => { await hit(to); return real.link(from, to); });
  mock.method(fs, "rename", async (from: string, to: string) => { await hit(to); return real.rename(from, to); });
  mock.method(fs, "mkdir", async (directory: string, options?: object) => { await hit(directory); return real.mkdir(directory, options as never); });
  return real;
}

async function exists(target: string) {
  try { await fs.access(target); return true; } catch { return false; }
}

test("finding 34: a live annotations file is not moved over one saved at the destination meanwhile", () => withTemporaryLibrary(["Up34"], async () => {
  await writeLibraryFile("Up34/moved.pdf", BYTES);
  const identity = await identityOf("Up34/moved.pdf");
  await writeAt(annotations("Up34", "Up34/old.pdf"), annotationJson(identity, "before"));
  const destination = annotations("Up34", "Up34/moved.pdf");
  try {
    plantBeforePublishing(destination, () => writeFile(destination, annotationJson(identity, "saved meanwhile")));
    const result = await reconcilePdfSidecars("Up34", [{ path: "Up34/moved.pdf", size: sizeOf(BYTES) }], { now: LATER() });
    assert.equal(result.reattached, 0);
  } finally { mock.restoreAll(); }
  assert.match(await readFile(destination, "utf8"), /saved meanwhile/, "the new annotation stays");
  assert.match(await readFile(annotations("Up34", "Up34/old.pdf"), "utf8"), /before/, "the source stays until it was published");
}));

test("finding 34: a set-aside annotations record is not published over a file saved meanwhile", () => withTemporaryLibrary(["Up34b"], async () => {
  await writeLibraryFile("Up34b/back.pdf", BYTES);
  const identity = await identityOf("Up34b/back.pdf");
  const record = path.join(orphanedSidecarsDirectoryPath("Up34b", "annotations"), "1-aaaa-old.pdf.json");
  await writeAt(record, JSON.stringify({ kind: "annotations", originalPath: "Up34b/old.pdf", orphanedAt: new Date().toISOString(), source: identity, sidecar: { source: identity, note: "set aside" } }));
  const destination = annotations("Up34b", "Up34b/back.pdf");
  try {
    plantBeforePublishing(destination, () => writeFile(destination, annotationJson(identity, "saved meanwhile")));
    const result = await reconcilePdfSidecars("Up34b", [{ path: "Up34b/back.pdf", size: sizeOf(BYTES) }], { now: LATER() });
    assert.equal(result.reattached, 0);
  } finally { mock.restoreAll(); }
  assert.match(await readFile(destination, "utf8"), /saved meanwhile/);
  assert.ok(await exists(record), "the set-aside record is kept");
}));

test("finding 34: ink moved to a file is not moved over ink saved there meanwhile", () => withTemporaryLibrary(["Up34c"], async () => {
  await writeLibraryFile("Up34c/moved.pdf", BYTES);
  const source = await inkSourceOf("Up34c/moved.pdf");
  const folder = await seedInk("Up34c/old.pdf", [{ chunk: "page-0001", source }]);
  const destination = inkFolderPath("Up34c", ["moved.pdf"]);
  let real!: { mkdir: typeof fs.mkdir };
  try {
    real = plantBeforePublishing(destination, async () => {
      await real.mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, inkFileName("page-0002", AUTHOR)), JSON.stringify(emptyInkAuthorFile({ key: AUTHOR }, FRAME, source)));
    });
    const result = await reconcileInkFolders("Up34c", [{ path: "Up34c/moved.pdf", size: sizeOf(BYTES) }], { now: LATER() });
    assert.equal(result.reattached, 0);
  } finally { mock.restoreAll(); }
  assert.deepEqual(await readdir(destination), [inkFileName("page-0002", AUTHOR)], "the new ink stays");
  assert.deepEqual(await readdir(folder), [inkFileName("page-0001", AUTHOR)], "the old folder stays until it was published");
}));

test("finding 35: an ink folder whose pages name different versions is not reattached whole", () => withTemporaryLibrary(["Up35"], async () => {
  await writeLibraryFile("Up35/first.pdf", BYTES);
  await writeLibraryFile("Up35/second.pdf", OTHER_BYTES);
  const folder = await seedInk("Up35/old.pdf", [
    { chunk: "page-0001", source: await inkSourceOf("Up35/first.pdf") },
    { chunk: "page-0002", source: await inkSourceOf("Up35/second.pdf") },
  ]);
  const files = [{ path: "Up35/first.pdf", size: sizeOf(BYTES) }, { path: "Up35/second.pdf", size: sizeOf(OTHER_BYTES) }];
  const now = Date.now();
  for (const at of [now, now + ORPHAN_GRACE_MS + 1]) {
    const result = await reconcileInkFolders("Up35", files, { now: at });
    assert.deepEqual(result, { reattached: 0, setAside: 0 });
  }
  assert.equal((await readdir(folder)).length, 2, "left where it is");
  assert.ok(!(await exists(inkFolderPath("Up35", ["first.pdf"]))) && !(await exists(inkFolderPath("Up35", ["second.pdf"]))));
}));

test("finding 36: an interrupted ink set-aside leaves a record naming the folder, and finishes next time", () => withTemporaryLibrary(["Up36"], async () => {
  const folder = await seedInk("Up36/gone.pdf", [{ chunk: "page-0001", source: { size: 5, sha256: "ab".repeat(32) } }]);
  const orphans = orphanedSidecarsDirectoryPath("Up36", "ink");
  const now = Date.now();
  await reconcileInkFolders("Up36", [], { now });
  try {
    const real = { rename: fs.rename, mkdir: fs.mkdir };
    const fail = (value: unknown) => { if (typeof value === "string" && value.startsWith(orphans) && value.endsWith(`${path.sep}ink`)) throw Object.assign(new Error("interrupted"), { code: "EIO" }); };
    mock.method(fs, "rename", async (from: string, to: string) => { fail(to); return real.rename(from, to); });
    mock.method(fs, "mkdir", async (directory: string, options?: object) => { fail(directory); return real.mkdir(directory, options as never); });
    await assert.rejects(reconcileInkFolders("Up36", [], { now: now + ORPHAN_GRACE_MS }), /interrupted/);
  } finally { mock.restoreAll(); }
  const [name] = await readdir(orphans);
  const record = JSON.parse(await readFile(path.join(orphans, name, "record.json"), "utf8")) as { originalPath: string };
  assert.equal(record.originalPath, "Up36/gone.pdf", "the origin was written before the move");
  assert.ok(await exists(folder), "the ink is still where it was");

  assert.equal((await reconcileInkFolders("Up36", [], { now: now + ORPHAN_GRACE_MS + 1 })).setAside, 1);
  assert.ok(!(await exists(folder)));
  const moved = (await readdir(orphans)).filter((entry) => entry !== name);
  assert.equal(moved.length, 1);
  assert.ok(await exists(path.join(orphans, moved[0], "ink")));
  // The record of the interrupted attempt held no ink: it goes once it is clearly stale.
  await reconcileInkFolders("Up36", [], { now: now + 10 * ORPHAN_GRACE_MS });
  assert.ok(!(await exists(path.join(orphans, name))));
  assert.ok(await exists(path.join(orphans, moved[0], "ink")));
}));

test("finding 37: expiry keeps set-aside annotations whose file is back but whose slot is taken", () => withTemporaryLibrary(["Up37"], async () => {
  await writeLibraryFile("Up37/back.pdf", BYTES);
  await writeLibraryFile("Up37/lost.pdf", OTHER_BYTES);
  const identity = await identityOf("Up37/back.pdf");
  await writeAt(annotations("Up37", "Up37/back.pdf"), annotationJson(identity, "work of its own"));
  const directory = orphanedSidecarsDirectoryPath("Up37", "annotations");
  const old = new Date(Date.now() - 2 * ORPHAN_RETENTION_MS).toISOString();
  const occupied = path.join(directory, "1-a-occupied.pdf.json");
  const gone = path.join(directory, "2-b-gone.pdf.json");
  const noFile = (note: string, bytes: { size: number; contentHash: string }) => JSON.stringify({ kind: "annotations", originalPath: "Up37/old.pdf", orphanedAt: old, source: bytes, sidecar: { note } });
  await writeAt(occupied, noFile("kept", identity));
  await writeAt(gone, noFile("expired", { size: 3, contentHash: "cd".repeat(32) }));
  const files = [{ path: "Up37/back.pdf", size: sizeOf(BYTES) }, { path: "Up37/lost.pdf", size: sizeOf(OTHER_BYTES) }];
  const result = await reconcilePdfSidecars("Up37", files, { now: LATER() });
  assert.equal(result.reattached, 0);
  assert.ok(await exists(occupied), "work whose file is back stays for the user to decide");
  assert.ok(!(await exists(gone)), "work whose file nobody has is expired");
  assert.match(await readFile(annotations("Up37", "Up37/back.pdf"), "utf8"), /work of its own/);
}));

test("finding 37: expiry keeps set-aside ink whose file is back but matches two files", () => withTemporaryLibrary(["Up37b"], async () => {
  await writeLibraryFile("Up37b/copy-a.pdf", BYTES);
  await writeLibraryFile("Up37b/copy-b.pdf", BYTES);
  const source = await inkSourceOf("Up37b/copy-a.pdf");
  const orphans = orphanedSidecarsDirectoryPath("Up37b", "ink");
  const old = new Date(Date.now() - 2 * ORPHAN_RETENTION_MS).toISOString();
  const kept = path.join(orphans, "1-a");
  const expired = path.join(orphans, "2-b");
  await writeAt(path.join(kept, "record.json"), JSON.stringify({ originalPath: "Up37b/old.pdf", orphanedAt: old, source }));
  await writeAt(path.join(kept, "ink", inkFileName("page-0001", AUTHOR)), JSON.stringify(emptyInkAuthorFile({ key: AUTHOR }, FRAME, source)));
  await writeAt(path.join(expired, "record.json"), JSON.stringify({ originalPath: "Up37b/old2.pdf", orphanedAt: old, source: { size: 3, sha256: "ef".repeat(32) } }));
  await writeAt(path.join(expired, "ink", inkFileName("page-0001", AUTHOR)), JSON.stringify(emptyInkAuthorFile({ key: AUTHOR }, FRAME)));
  const files = [{ path: "Up37b/copy-a.pdf", size: sizeOf(BYTES) }, { path: "Up37b/copy-b.pdf", size: sizeOf(BYTES) }];
  const result = await reconcileInkFolders("Up37b", files, { now: LATER() });
  assert.equal(result.reattached, 0, "ambiguous: neither copy takes it");
  assert.ok(await exists(kept));
  assert.ok(!(await exists(expired)));
}));

test("finding 39: the slot test follows the caller's case rules, not lower-cased names", async () => {
  const hashes = new Map<string, Promise<string | null>>();
  await withTemporaryLibrary(["Up39"], async () => {
    await writeLibraryFile("Up39/foo.pdf", BYTES);
    const identity = await identityOf("Up39/foo.pdf");
    const candidates = [{ path: "Up39/foo.pdf", size: sizeOf(BYTES) }];
    // `Foo.pdf` having annotations does not occupy `foo.pdf` where the two are different slots.
    assert.equal(await matchByIdentity(identity, candidates, async (candidate) => candidate === "Up39/Foo.pdf", hashes), "Up39/foo.pdf");
    assert.equal(await matchByIdentity(identity, candidates, async (candidate) => candidate === "Up39/foo.pdf", hashes), null);
  });
});

/** Whether this volume tells `a` from `A`. */
async function caseSensitiveVolume() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-case-"));
  try {
    await writeFile(path.join(directory, "a"), "1");
    await writeFile(path.join(directory, "A"), "2");
    return (await readdir(directory)).length === 2;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("finding 39: on a case-sensitive volume Foo.pdf's annotations do not occupy foo.pdf", (t) => withTemporaryLibrary(["Up39b"], async () => {
  if (!(await caseSensitiveVolume())) { t.skip("this volume ignores case"); return; }
  await writeLibraryFile("Up39b/Foo.pdf", OTHER_BYTES);
  await writeLibraryFile("Up39b/foo.pdf", BYTES);
  const identity = await identityOf("Up39b/foo.pdf");
  await writeAt(annotations("Up39b", "Up39b/Foo.pdf"), annotationJson(await identityOf("Up39b/Foo.pdf"), "Foo's"));
  await writeAt(annotations("Up39b", "Up39b/old.pdf"), annotationJson(identity, "moved"));
  const files = [{ path: "Up39b/Foo.pdf", size: sizeOf(OTHER_BYTES) }, { path: "Up39b/foo.pdf", size: sizeOf(BYTES) }];
  assert.equal((await reconcilePdfSidecars("Up39b", files, { now: Date.now() })).reattached, 1);
  assert.match(await readFile(annotations("Up39b", "Up39b/foo.pdf"), "utf8"), /moved/);
  assert.match(await readFile(annotations("Up39b", "Up39b/Foo.pdf"), "utf8"), /Foo's/);
}));
