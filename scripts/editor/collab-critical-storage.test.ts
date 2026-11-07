import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import sharp from "sharp";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import { writeBibMirror, resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers, tetherBibFile } from "../../src/lib/references/bib-tether";
import { updateReferenceLibrary } from "../../src/lib/storage/references";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { getGallery, getGalleryRoot } from "../../src/lib/storage/gallery";
import { audioSidecarPaths, filePathFromParts, notebookPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { followSharedPdfChanges } from "../../src/lib/storage/pdf-sidecars";
import { followSharedAudioChanges, pruneAudioSidecars } from "../../src/lib/storage/transcripts";
import { TRANSCRIPT_VERSION } from "../../src/lib/transcription/types";
import { copyLifecycleSidecar } from "../../src/lib/storage/sidecar-lifecycle";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "libera-critical-editor-"));
  const previous = process.env.LIBERA_DATA_DIR; process.env.LIBERA_DATA_DIR = path.join(directory, "data");
  invalidateSharedNotebookCache();
  try { await createNotebook("Notes"); await run(directory); }
  finally {
    mock.restoreAll(); resetBibTethers(); resetBibMirrorScheduler(); invalidateSharedNotebookCache();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}
async function write(target: string, bytes: string | Buffer) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
async function markShared(notebook: string) {
  await write(path.join(notebookPath(notebook), ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", manifestDocId: "doc_manifest", serverUrl: "https://collab.test", accountId: "acc_test", sharedAt: "2026-11-07T00:00:00Z", folderId: "fld_test", writer: "inst_other" }));
  invalidateSharedNotebookCache();
}

test("R10: generated mirrors refuse shared targets before touching bibliography bytes", () => fixture(async () => {
  await markShared("Notes"); const target = path.join(notebookPath("Notes"), "references.bib");
  const library = { ...emptyReferenceLibrary(), settings: { bibMirror: true } };
  await assert.rejects(writeBibMirror("Notes", library), /shared-document/);
  await assert.rejects(fs.readFile(target), { code: "ENOENT" });
  await write(target, "private collaborator bibliography");
  await assert.rejects(writeBibMirror("Notes", library), /shared-document/);
  assert.equal(await fs.readFile(target, "utf8"), "private collaborator bibliography");
}));

for (const symlink of [false, true]) test(`R10: tether writes guard ${symlink ? "absolute symlink destinations" : "shared notebook targets"}`, () => fixture(async (directory) => {
  await createNotebook("Shared");
  await updateReferenceLibrary("Notes", null, [{ op: "add", entry: { key: "local2026", csl: { type: "book", title: "Local bibliography entry" } } }]);
  const target = path.join(notebookPath("Shared"), "refs.bib"); await write(target, "% untouched\n"); await markShared("Shared");
  let input = target;
  if (symlink) { input = path.join(directory, "external-link.bib"); await fs.symlink(target, input); }
  const result = await tetherBibFile("Notes", input, { prefer: "library" });
  assert.equal(result?.state, "error");
  assert.equal(await fs.readFile(target, "utf8"), "% untouched\n");
}));

for (const failure of ["readdir", "stat"] as const) test(`R18: unavailable gallery ${failure} preserves indexed originals and ink`, () => fixture(async () => {
  const root = getGalleryRoot(); const photo = path.join(root, "Album", "photo.png");
  const body = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } }).png().toBuffer(); await write(photo, body);
  const stats = await fs.stat(photo); const id = "11111111-1111-1111-1111-111111111111";
  const original = path.join(root, ".originals", "original.png"); const ink = path.join(root, ".libera-ink", id, "photo.author.ink");
  await write(original, "original recovery bytes"); await write(ink, "ink recovery bytes");
  await write(path.join(root, ".libera-gallery.json"), JSON.stringify({ version: 2, photos: { [id]: { path: "Album/photo.png", createdAt: new Date().toISOString(), size: stats.size, mtimeMs: stats.mtimeMs, original: "original.png" } }, folders: ["Album"], albums: [{ id: "album", name: "Album", folder: "Album", createdAt: new Date().toISOString(), photoIds: [id] }], archive: {} }));
  if (failure === "readdir") {
    const read = fsp.readdir;
    mock.method(fsp, "readdir", (...args: Parameters<typeof fsp.readdir>) => {
      if (String(args[0]) === path.dirname(photo)) return Promise.reject(Object.assign(new Error("provider unavailable"), { code: "EIO" }));
      return read(...args);
    });
  } else {
    const stat = fsp.stat;
    mock.method(fsp, "stat", (...args: Parameters<typeof fsp.stat>) => {
      if (String(args[0]) === photo) return Promise.reject(Object.assign(new Error("provider unavailable"), { code: "EIO" }));
      return stat(...args);
    });
  }
  await assert.rejects(getGallery(), /provider unavailable/);
  assert.equal(await fs.readFile(original, "utf8"), "original recovery bytes");
  assert.equal(await fs.readFile(ink, "utf8"), "ink recovery bytes");
}));

test("R20: occupied PDF/audio destinations, swaps and reused removal paths retain every sidecar", () => fixture(async () => {
  const a = pdfAnnotationsPath("Notes", ["a.pdf"]), b = pdfAnnotationsPath("Notes", ["b.pdf"]);
  const pdfBody = "same PDF bytes"; const hash = createHash("sha256").update(pdfBody).digest("hex");
  await write(filePathFromParts("Notes", ["a.pdf"]), pdfBody); await write(filePathFromParts("Notes", ["b.pdf"]), pdfBody);
  const first = JSON.stringify({ annotations: [{ id: "first", text: "first PDF work" }], source: { size: Buffer.byteLength(pdfBody), contentHash: hash } });
  const second = JSON.stringify({ annotations: [{ id: "second", text: "second PDF work" }], source: { size: Buffer.byteLength(pdfBody), contentHash: hash } });
  await write(a, first); await write(b, second);
  await followSharedPdfChanges([{ from: "Notes/a.pdf", to: "Notes/b.pdf" }, { from: "Notes/b.pdf", to: "Notes/a.pdf" }], []);
  assert.equal(await fs.readFile(a, "utf8"), first); assert.equal(await fs.readFile(b, "utf8"), second);
  await followSharedPdfChanges([], ["Notes/a.pdf"]);
  assert.equal(await fs.readFile(a, "utf8"), first, "a delayed removal cannot detach a replacement's annotations");
  await fs.rm(b);
  await followSharedPdfChanges([{ from: "Notes/a.pdf", to: "Notes/b.pdf" }], []);
  assert.equal(await fs.readFile(a, "utf8"), first, "an identity-checked transfer retains its recovery source");
  assert.equal(await fs.readFile(b, "utf8"), first);
  const audioA = audioSidecarPaths("Notes", ["a.m4a"])[0], audioB = audioSidecarPaths("Notes", ["b.m4a"])[0];
  await write(audioA, "first audio work"); await write(audioB, "second audio work");
  await followSharedAudioChanges([{ from: "Notes/a.m4a", to: "Notes/b.m4a" }], ["Notes/a.m4a"]);
  assert.equal(await fs.readFile(audioA, "utf8"), "first audio work"); assert.equal(await fs.readFile(audioB, "utf8"), "second audio work");
}));

test("R20: a suspended sidecar copy cannot overwrite a replacement notebook", () => fixture(async () => {
  const root = notebookPath("Notes"); const source = path.join(root, ".libera", "source.json"); const target = path.join(root, ".libera", "target.json"); await write(source, "original sidecar");
  const writeFile = fs.writeFile; let held = false; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (!held && String(args[0]).includes(".libera-tmp-")) { held = true; await gate; }
    return writeFile(...args);
  });
  const copying = copyLifecycleSidecar(source, target, root, async () => true);
  const rejected = assert.rejects(copying);
  try {
    for (let count = 0; !held && count < 100; count++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(held, true);
    await fs.rm(root, { recursive: true, force: true }); await write(target, "replacement notebook work");
    release(); await rejected;
    assert.equal(await fs.readFile(target, "utf8"), "replacement notebook work");
  } finally { release(); await rejected; }
}));


test("R20: identity-matched audio copies retain their source and shared recovery survives pruning", () => fixture(async () => {
  await markShared("Notes");
  const audio = "portable audio bytes";
  const hash = createHash("sha256").update(audio).digest("hex");
  await write(filePathFromParts("Notes", ["new.m4a"]), audio);
  const source = audioSidecarPaths("Notes", ["old.m4a"])[0], destination = audioSidecarPaths("Notes", ["new.m4a"])[0];
  const bytes = JSON.stringify({ version: TRANSCRIPT_VERSION, segments: [], speakers: [], audio: { contentHash: hash, size: Buffer.byteLength(audio) } });
  await write(source, bytes);
  assert.equal(await followSharedAudioChanges([{ from: "Notes/old.m4a", to: "Notes/new.m4a" }], []), 1);
  assert.equal(await fs.readFile(source, "utf8"), bytes);
  assert.equal(await fs.readFile(destination, "utf8"), bytes);
  await pruneAudioSidecars("Notes");
  assert.equal(await fs.readFile(source, "utf8"), bytes, "a missing cloud source does not erase recovery in the next library scan");
}));


test("R20: audio removal recovery survives subsequent local orphan pruning", () => fixture(async () => {
  const source = audioSidecarPaths("Notes", ["gone.m4a"])[0];
  await write(source, "unmerged local transcript");
  await followSharedAudioChanges([], ["Notes/gone.m4a"]);
  await pruneAudioSidecars("Notes");
  const directory = path.join(notebookPath("Notes"), ".libera", "collab", "sidecar-recovery");
  const records = await Promise.all((await fs.readdir(directory)).map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as { contentBase64: string }));
  assert.ok(records.some((record) => Buffer.from(record.contentBase64, "base64").toString("utf8") === "unmerged local transcript"));
}));
