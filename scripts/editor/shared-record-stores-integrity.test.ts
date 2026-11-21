// Regressions for the 2026-11-20 collaboration review, package B2 (S6, S7, S8, S9, S10, S11,
// S12, S15, S16 on the Next side) and two wiring items: the records this computer keeps in the
// local stores follow a shared file's committed moves and deletes. The host is a stub that keeps
// the log the real host keeps (electron/collab/notebooks/transition-log.ts); the harness is the one
// of shared-record-follow-integrity.test.ts.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import { hasReviewEntry, withReviewWrite } from "../../src/lib/agent/review-store";
import { listRunFiles, RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import type { FileListEntry, FileOpRequest, ManifestTransition } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { moveSharedFile } from "../../src/lib/collab/shared-writes";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { addReviewThreads, findReview, loadReview } from "../../src/lib/storage/markdown-reviews";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { definitionsPath, filePathFromParts, imageAnnotationsPath, pdfAnnotationsPath, pdfOutlinePath, referenceLibraryPath, splitFilePath } from "../../src/lib/storage/paths";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { drainSharedRecordTransitions, nudgeSharedRecordTransitions } from "../../src/lib/storage/shared-record-follow";
import { readWorkspaceMetadata, setFileTagsForPath } from "../../src/lib/storage/workspace-metadata";
import { writeReferenceLibrary } from "./notebook-test-helpers";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

/** A host that keeps a manifest list and the durable transition log, as the real one does. */
class StubHost {
  entries: FileListEntry[] = [];
  log: ManifestTransition[] = [];
  ops: FileOpRequest[] = [];
  private seq = 0;
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  constructor(private readonly notebook: string) {}

  rename(from: string, to: string, at = Date.now()) {
    const found = this.entries.find((item) => item.path === from);
    assert.ok(found, `${from} is in the manifest`);
    renameSync(path.join(this.notebook, from), path.join(this.notebook, to));
    found.path = to;
    this.log.push({ seq: ++this.seq, projectId: "prj_test", fileId: found.fileId, kind: "file", from: `Shared/${from}`, to: `Shared/${to}`, at });
  }

  remove(from: string, at = Date.now()) {
    const index = this.entries.findIndex((item) => item.path === from);
    assert.ok(index >= 0, `${from} is in the manifest`);
    rmSync(path.join(this.notebook, from), { force: true });
    const [gone] = this.entries.splice(index, 1);
    this.log.push({ seq: ++this.seq, projectId: "prj_test", fileId: gone.fileId, kind: "file", from: `Shared/${from}`, to: null, at });
  }

  /** What the host's displacedPath appends: a local-only file archived because an incoming entry claimed its path. */
  displace(from: string, to: string) {
    this.log.push({ seq: ++this.seq, projectId: "prj_test", fileId: "displaced-0123456789abcdef01234567", kind: "file", from: `Shared/${from}`, to: `Shared/${to}`, at: Date.now() });
  }

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const send = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.headers.authorization !== `Bearer ${this.token}`) return send(404, { error: { code: "not-found", message: "No route." } });
        const url = new URL(request.url ?? "", "http://host");
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) return send(200, { entries: this.entries });
        if (/\/projects\/[^/]+\/transitions$/.test(url.pathname)) {
          const after = Number(url.searchParams.get("after") ?? 0);
          return send(200, { transitions: this.log.filter((item) => item.seq > after), more: false });
        }
        if (/\/projects\/[^/]+\/transitions\/ack$/.test(url.pathname)) {
          const { seqs = [] } = JSON.parse(body) as { seqs?: number[] };
          const before = this.log.length;
          this.log = this.log.filter((item) => !seqs.includes(item.seq));
          return send(200, { removed: before - this.log.length });
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        if (op.op === "rename" && op.to) this.rename(op.path, op.to);
        if (op.op === "delete") this.remove(op.path);
        return send(200, { paths: [`Shared/${op.to ?? op.path}`] });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const entry = (relative: string): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind: "doc", updatedAt: 1 });

const FILES = ["sub/photo.png", "sub/other.png", "sub/note.md", "sub/a.md", "sub/b.md", "sub/d.md", "sub/e.md", "sub/doc.pdf", "sub/doc2.pdf"];

/** `setup` runs while the notebook is still a local one (reviews and run history are made before it is shared). */
async function withShared(run: (fixture: { host: StubHost; notebook: string }) => Promise<void>, setup?: (notebook: string) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-shared-record-stores-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(path.join(notebook, "sub"), { recursive: true });
  for (const file of FILES) writeFileSync(path.join(notebook, file), file.endsWith(".md") ? "note\n" : "bytes");
  process.env.LIBERA_DATA_DIR = dataDir;
  invalidateSharedNotebookCache();
  mock.method(fs, "watch", () => new Watcher());
  const host = new StubHost(notebook);
  try {
    await createNotebook("Local");
    await setup?.(notebook);
    writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
    invalidateSharedNotebookCache();
    host.entries = FILES.map(entry);
    await host.start();
    process.env.LIBERA_COLLAB_HOST_URL = host.url;
    process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
    await run({ host, notebook });
  } finally {
    resetBibTethers();
    resetBibMirrorScheduler();
    mock.restoreAll();
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function writeRecord(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const editNote = (notebook: string, name: string, run = "run-aaaa0001") => withReviewWrite(`Shared/sub/${name}`, "note\n", run, async () => { writeFileSync(path.join(notebook, "sub", name), "note edited\n"); });
const tagsOf = async (liberaPath: string) => (await readWorkspaceMetadata()).fileTags[liberaPath];

test("S6: a pending agent review follows a shared rename, is held when the destination has its own, and goes with a delete", () => withShared(async ({ host }) => {
  host.rename("sub/note.md", "sub/renamed.md");
  host.rename("sub/a.md", "sub/b.md");
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(await hasReviewEntry("Shared/sub/renamed.md"), true, "the review is at the note's new path");
  assert.equal(await hasReviewEntry("Shared/sub/note.md"), false, "and no longer blocks the old one");
  assert.equal(await hasReviewEntry("Shared/sub/b.md"), true, "the destination's own review is kept");
  assert.equal(await hasReviewEntry("Shared/sub/a.md"), true, "the review that could not move stays where it is");
  assert.equal(result.held.length, 1, JSON.stringify(result));
  assert.match(result.held[0], /pending agent changes of Shared\/sub\/a\.md/);

  // A delete discards the baseline, as a local delete does, so a note created at the name starts clean.
  host.remove("sub/renamed.md");
  const deleted = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(deleted.unfinished, []);
  assert.equal(await hasReviewEntry("Shared/sub/renamed.md"), false);
}, async (notebook) => {
  await editNote(notebook, "note.md");
  await editNote(notebook, "a.md");
  await editNote(notebook, "b.md", "run-bbbb0002");
}));

test("S7: undo history of a run made before sharing follows two renames and names the file where it is now", () => withShared(async ({ host }) => {
  host.rename("sub/note.md", "sub/mid.md");
  host.rename("sub/mid.md", "sub/final.md");
  const result = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(result.unfinished, [], JSON.stringify(result));
  const recorded = (await listRunFiles()).files.find((file) => file.runId === "run-undo-0001");
  assert.ok(recorded);
  assert.equal(recorded.recordedPath, "Shared/sub/note.md");
  assert.equal(recorded.path, "Shared/sub/final.md");
  // Undo is applied through the host (which this stub does not serve), against the file where it is now.
  const undone = await undoRun("run-undo-0001");
  assert.equal(undone[0].currentPath, "Shared/sub/final.md");
  assert.equal(undone[0].status, "conflict");
}, async () => {
  const run = new RunSnapshots("run-undo-0001");
  await run.recordOriginal("Shared/sub/note.md", "note\n");
  await run.recordWritten("Shared/sub/note.md", "note edited\n");
}));

test("S8: each note has one review document after a rename: an empty one at the destination gives way, one with comments is kept and the moving one stays", () => withShared(async ({ host }) => {
  const mine = await findReview("Shared/sub/d.md");
  host.rename("sub/d.md", "sub/e.md");
  host.rename("sub/a.md", "sub/b.md");
  const result = await drainSharedRecordTransitions("Shared");
  const moved = await findReview("Shared/sub/e.md");
  assert.equal(moved?.id, mine?.id, "the review that moved is the one with the comment");
  assert.equal(moved?.threads.length, 1);
  assert.equal(await findReview("Shared/sub/d.md"), null);
  assert.equal(result.held.length, 1, JSON.stringify(result));
  assert.match(result.held[0], /review comments of Shared\/sub\/a\.md \(Shared\/sub\/b\.md has comments of its own\)/);
  assert.equal((await findReview("Shared/sub/b.md"))?.threads.length, 1, "the destination's comments were not retargeted");
  assert.equal((await findReview("Shared/sub/a.md"))?.threads.length, 1, "the review that could not move is still at its path");
}, async () => {
  await addReviewThreads("Shared/sub/d.md", "note\n", [{ range: { start: 0, end: 2 }, text: "mine" }]);
  await loadReview("Shared/sub/e.md", "note\n");
  await addReviewThreads("Shared/sub/a.md", "note\n", [{ range: { start: 0, end: 2 }, text: "moving" }]);
  await addReviewThreads("Shared/sub/b.md", "note\n", [{ range: { start: 0, end: 2 }, text: "theirs" }]);
}));

test("S9: an attachment that could not be updated is reported, the move stays in the host's log, and the next drain finishes it", () => withShared(async ({ host }) => {
  await setFileTagsForPath("Shared/sub/note.md", ["draft"]);
  await writeReferenceLibrary("Local", [{ key: "a2020", attachments: ["Shared/sub/note.md"] }]);
  const library = referenceLibraryPath("Local");
  const rename = fsp.rename;
  mock.method(fsp, "rename", async (from: string, to: string) => {
    if (path.resolve(String(to)) === path.resolve(library)) throw Object.assign(new Error("disk error"), { code: "EIO" });
    return rename(from, to);
  });
  host.rename("sub/note.md", "sub/renamed.md");
  const first = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(first.unfinished, ["reference attachments"], JSON.stringify(first));
  assert.equal(first.applied, 0);
  assert.deepEqual(await tagsOf("Shared/sub/renamed.md"), ["draft"], "the other stores were still updated");
  assert.equal(host.log.length, 1, "the mapping is kept in the host's log for the store that failed");
  const attached = async () => Object.values((await readReferenceLibrary("Local")).entries).flatMap((value) => value.attachments.flatMap((attachment) => attachment.kind === "url" ? [] : [attachment.path]));
  assert.deepEqual(await attached(), ["Shared/sub/note.md"]);

  mock.restoreAll();
  mock.method(fs, "watch", () => new Watcher());
  const second = await nudgeSharedRecordTransitions("Shared");
  assert.equal(second.applied, 1, JSON.stringify(second));
  assert.deepEqual(await attached(), ["Shared/sub/renamed.md"]);
  assert.deepEqual(host.log, []);
}));

test("S10: a newer version saved at the old place while the record was copied is kept, and the destination has the earlier one", () => withShared(async ({ host }) => {
  const source = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  const destination = imageAnnotationsPath("Shared", ["sub", "moved.png"]);
  writeRecord(source, '{"annotations":["mine"]}');
  const link = fsp.link;
  mock.method(fsp, "link", async (existing: string, target: string) => {
    await link(existing, target);
    if (path.resolve(String(target)) === path.resolve(destination)) writeFileSync(source, '{"annotations":["newer, from an editor or a cloud folder"]}');
  });
  host.rename("sub/photo.png", "sub/moved.png");
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.held.length, 1, JSON.stringify(result));
  assert.match(result.held[0], /newer version was saved there while it moved/);
  assert.equal(readFileSync(source, "utf8"), '{"annotations":["newer, from an editor or a cloud folder"]}', "the newer record was not unlinked");
  assert.equal(readFileSync(destination, "utf8"), '{"annotations":["mine"]}', "the version that was copied is at the destination");
  assert.deepEqual(readdirSync(path.dirname(source)).filter((name) => name.endsWith(".retiring")), [], "nothing is left aside");
}));

test("S11: a case-only rename gives the local records the new spelling", () => withShared(async ({ host }) => {
  const old = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  writeRecord(old, '{"annotations":["mine"]}');
  host.rename("sub/photo.png", "sub/Photo.png");
  const result = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(result.held, [], JSON.stringify(result));
  assert.deepEqual(result.unfinished, []);
  const names = readdirSync(path.dirname(old));
  assert.ok(names.includes("Photo.png.json"), names.join(", "));
  assert.ok(!names.includes("photo.png.json"), "no record is left at the old spelling");
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["sub", "Photo.png"]), "utf8"), '{"annotations":["mine"]}');
}));

test("S12: a rename to another file type is refused before the host moves anything when local records could not follow", () => withShared(async ({ host }) => {
  const record = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  writeRecord(record, '{"annotations":["mine"]}');
  await assert.rejects(() => moveSharedFile("Shared/sub/photo.png", "Shared/sub", "photo.pdf"), /has annotations that a pdf file cannot keep/);
  assert.deepEqual(host.ops, [], "the host was not asked");
  assert.ok(existsSync(record));
  // Without records the same rename goes through.
  await moveSharedFile("Shared/sub/other.png", "Shared/sub", "other.pdf");
  assert.equal(host.ops.length, 1);
  // A collaborator's type change is not refused (it happened), but the record stays and is reported, never dropped.
  host.rename("sub/photo.png", "sub/photo2.pdf");
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.held.length, 1, JSON.stringify(result));
  assert.match(result.held[0], /image-annotations of Shared\/sub\/photo\.png \(a pdf file cannot keep it\)/);
  assert.ok(existsSync(record));
}));

test("S15, S16: a deleted shared file's ink, Python code and transcript are never removed from Next; its own records are", () => withShared(async ({ host, notebook }) => {
  const ink = path.join(inkFolderPath("Shared", ["sub", "note.md"]), "page-0001.ink");
  const pythonParts = splitFilePath(pythonSidecarPath("Shared/sub/note.md"));
  const python = filePathFromParts(pythonParts.notebook, pythonParts.pathParts);
  writeRecord(ink, "strokes the writer has not archived yet");
  writeRecord(python, "print('mine')\n");
  const photoRecord = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  writeRecord(photoRecord, '{"annotations":[]}');
  await setFileTagsForPath("Shared/sub/note.md", ["draft"]);
  host.remove("sub/note.md");
  host.remove("sub/photo.png");
  const result = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(result.unfinished, [], JSON.stringify(result));
  assert.equal(readFileSync(ink, "utf8"), "strokes the writer has not archived yet");
  assert.equal(readFileSync(python, "utf8"), "print('mine')\n");
  assert.ok(!existsSync(photoRecord), "a local record is removed with its file");
  assert.equal(await tagsOf("Shared/sub/note.md"), undefined);
  assert.ok(existsSync(notebook));
}));

test("Wiring: this user's own rename carries a legacy PDF's notes, a collaborator's does not", () => withShared(async ({ host }) => {
  const legacy = (name: string) => {
    for (const file of [pdfAnnotationsPath("Shared", ["sub", name]), pdfOutlinePath("Shared", ["sub", name]), definitionsPath("Shared", ["sub", name])]) {
      writeRecord(file, JSON.stringify({ annotations: [{ id: "n", text: "legacy note" }], entries: [] }));
      utimesSync(file, 1_000, 1_000);
    }
  };
  legacy("doc.pdf");
  legacy("doc2.pdf");
  await moveSharedFile("Shared/sub/doc.pdf", "Shared/sub", "own.pdf");
  assert.ok(existsSync(pdfAnnotationsPath("Shared", ["sub", "own.pdf"])), "an explicit move carries the legacy notes");

  host.rename("sub/doc2.pdf", "sub/theirs.pdf");
  await drainSharedRecordTransitions("Shared");
  assert.ok(!existsSync(pdfAnnotationsPath("Shared", ["sub", "theirs.pdf"])), "a collaborator's move of a PDF saved after the notes holds them");
}));

test("Wiring: a file the host archived because an incoming entry claimed its path takes this computer's records with it", () => withShared(async ({ host }) => {
  const old = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  writeRecord(old, '{"annotations":["the local file\'s"]}');
  await setFileTagsForPath("Shared/sub/photo.png", ["local"]);
  // The manifest still lists the claimant at sub/photo.png; the log says the local-only file went to the archive.
  host.displace("sub/photo.png", "_archive/photo.png");
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.applied, 1, JSON.stringify(result));
  assert.deepEqual(result.held, []);
  assert.deepEqual(await tagsOf("Shared/_archive/photo.png"), ["local"]);
  assert.equal(await tagsOf("Shared/sub/photo.png"), undefined, "the claimant does not inherit them");
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["_archive", "photo.png"]), "utf8"), '{"annotations":["the local file\'s"]}');
  assert.ok(!existsSync(old));
  assert.deepEqual(host.log, []);
}));
