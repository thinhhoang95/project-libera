// Regressions for the 2026-11-20 collaboration review, package B1 (S4, S5, S31,
// S35): the records this computer keeps for a shared file follow every manifest
// move through the host's durable log. A move whose response was lost, or that a
// collaborator made, is applied by the next drain; applying twice changes
// nothing; a record that may belong to a different file (the path was reused, or
// the record is newer than the move) is held, not moved or deleted. The host is
// a stub that keeps the log the real host keeps (electron/collab/notebooks/transition-log.ts).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry, FileOpRequest, ManifestTransition } from "../../src/lib/collab/local-api";
import { SharedOperationUnfinishedError } from "../../src/lib/collab/shared-outcomes";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { deleteSharedFile, moveSharedFile } from "../../src/lib/collab/shared-writes";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { addReviewThreads, findReview } from "../../src/lib/storage/markdown-reviews";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { imageAnnotationsPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { drainSharedRecordTransitions, drainSharedRecordTransitionsIfPending, nudgeSharedRecordTransitions } from "../../src/lib/storage/shared-record-follow";
import { readWorkspaceMetadata, setFileTagsForPath } from "../../src/lib/storage/workspace-metadata";
import { writeReferenceLibrary } from "./notebook-test-helpers";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

/** A host that keeps a manifest list and the durable transition log, as the real one does. */
class StubHost {
  entries: FileListEntry[] = [];
  log: ManifestTransition[] = [];
  /** Requests answered, by kind. */
  hits = { transitions: 0, ack: 0, entries: 0 };
  private seq = 0;
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  constructor(private readonly notebook: string) {}

  /** A move the manifest went through, on the disk and in the log (what a collaborator's rename does here too). */
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
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) { this.hits.entries += 1; return send(200, { entries: this.entries }); }
        if (/\/projects\/[^/]+\/transitions$/.test(url.pathname)) {
          this.hits.transitions += 1;
          const after = Number(url.searchParams.get("after") ?? 0);
          return send(200, { transitions: this.log.filter((item) => item.seq > after), more: false });
        }
        if (/\/projects\/[^/]+\/transitions\/ack$/.test(url.pathname)) {
          this.hits.ack += 1;
          const { seqs = [] } = JSON.parse(body) as { seqs?: number[] };
          const before = this.log.length;
          this.log = this.log.filter((item) => !seqs.includes(item.seq));
          return send(200, { removed: before - this.log.length });
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
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

async function withShared(run: (fixture: { host: StubHost; notebook: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-shared-record-follow-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(path.join(notebook, "sub"), { recursive: true });
  writeFileSync(path.join(notebook, "sub", "photo.png"), "png bytes");
  writeFileSync(path.join(notebook, "sub", "note.md"), "note\n");
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost(notebook);
  host.entries = ["sub/photo.png", "sub/note.md"].map(entry);
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  mock.method(fs, "watch", () => new Watcher());
  try {
    await createNotebook("Local");
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

const attachments = async () => Object.values((await readReferenceLibrary("Local")).entries).flatMap((value) => value.attachments.flatMap((attachment) => attachment.kind === "url" ? [] : [attachment.path]));
const tagsOf = async (liberaPath: string) => (await readWorkspaceMetadata()).fileTags[liberaPath];

test("S4: a move whose response was lost is applied by the next drain, and a second drain changes nothing", () => withShared(async ({ host }) => {
  const note = "Shared/sub/note.md";
  await setFileTagsForPath(note, ["draft"]);
  await addReviewThreads(note, "note\n", [{ range: { start: 0, end: 2 }, text: "comment" }]);
  await writeReferenceLibrary("Local", [{ key: "a2020", attachments: [note] }]);
  const record = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  writeRecord(record, '{"annotations":["mine"]}');

  // The host commits both moves; the process that asked never hears back, so no follow-up ran.
  host.rename("sub/note.md", "sub/renamed.md");
  host.rename("sub/photo.png", "sub/picture.png");
  assert.equal(host.log.length, 2);

  const first = await drainSharedRecordTransitions("Shared");
  assert.equal(first.reachable, true);
  assert.equal(first.applied, 2, JSON.stringify(first));
  assert.deepEqual(first.unfinished, []);
  assert.deepEqual(first.held, []);
  assert.deepEqual(await tagsOf("Shared/sub/renamed.md"), ["draft"]);
  assert.equal(await tagsOf(note), undefined);
  assert.ok(await findReview("Shared/sub/renamed.md"));
  assert.equal(await findReview(note), null);
  assert.deepEqual(await attachments(), ["Shared/sub/renamed.md"]);
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["sub", "picture.png"]), "utf8"), '{"annotations":["mine"]}');
  assert.ok(!fs.existsSync(record));
  assert.deepEqual(host.log, [], "the host's log was acknowledged and trimmed");

  const second = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(second.outcomes, []);
  assert.equal(second.applied, 0);
  assert.deepEqual(await tagsOf("Shared/sub/renamed.md"), ["draft"]);
}));

test("S31: a collaborator's rename and delete reach every record kept here", () => withShared(async ({ host }) => {
  const note = "Shared/sub/note.md";
  const photo = "Shared/sub/photo.png";
  await setFileTagsForPath(note, ["draft"]);
  await setFileTagsForPath(photo, ["figure"]);
  await addReviewThreads(note, "note\n", [{ range: { start: 0, end: 2 }, text: "comment" }]);
  await writeReferenceLibrary("Local", [{ key: "a2020", attachments: [note, photo] }]);
  writeRecord(imageAnnotationsPath("Shared", ["sub", "photo.png"]), '{"annotations":[]}');

  host.rename("sub/note.md", "sub/theirs.md");
  host.remove("sub/photo.png");
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.applied, 2, JSON.stringify(result));

  assert.deepEqual(await tagsOf("Shared/sub/theirs.md"), ["draft"]);
  assert.equal(await tagsOf(photo), undefined, "the deleted file's tags went with it");
  assert.ok(await findReview("Shared/sub/theirs.md"));
  assert.deepEqual(await attachments(), ["Shared/sub/theirs.md"]);
  assert.ok(!fs.existsSync(imageAnnotationsPath("Shared", ["sub", "photo.png"])));

  // The old path is free again: a new file there starts clean.
  assert.equal(await findReview(note), null);
  assert.equal(await tagsOf(note), undefined);
}));

test("S5: records at a path another file now holds are held, not moved or deleted", () => withShared(async ({ host, notebook }) => {
  const note = "Shared/sub/note.md";
  await setFileTagsForPath(note, ["draft"]);
  host.rename("sub/note.md", "sub/theirs.md");
  // A collaborator creates a new file at the old path, and this user tags it before the follow-up runs.
  writeFileSync(path.join(notebook, "sub", "note.md"), "new\n");
  host.entries.push({ fileId: "fil_other", path: "sub/note.md", kind: "doc", updatedAt: 2 });
  await setFileTagsForPath(note, ["theirs-now"]);

  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.held.length, 1, JSON.stringify(result));
  assert.match(result.held[0], /another file is at that path/);
  assert.deepEqual(await tagsOf(note), ["theirs-now"], "the new file's tags stay where they are");
  assert.equal(await tagsOf("Shared/sub/theirs.md"), undefined, "nothing was moved onto the renamed file");
  assert.deepEqual(host.log, [], "a held change is final: it is acknowledged and reported once");

  // The same for a delete.
  host.remove("sub/note.md");
  host.entries.push({ fileId: "fil_third", path: "sub/note.md", kind: "doc", updatedAt: 3 });
  const deleted = await drainSharedRecordTransitions("Shared");
  assert.equal(deleted.held.length, 1);
  assert.deepEqual(await tagsOf(note), ["theirs-now"], "tags at a reused path survive a delete of the earlier file");
}));

test("S5: a record written after the move is held, an earlier one follows", () => withShared(async ({ host }) => {
  const stale = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  writeRecord(stale, '{"annotations":["written later"]}');
  // The move happened a minute ago; the record at the old path was saved since, so it may be another file's.
  host.rename("sub/photo.png", "sub/picture.png", Date.now() - 60_000);
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.held.length, 1, JSON.stringify(result));
  assert.match(result.held[0], /written after/);
  assert.ok(fs.existsSync(stale), "the record stays where it was");
  assert.ok(!fs.existsSync(imageAnnotationsPath("Shared", ["sub", "picture.png"])));

  const old = new Date(Date.now() - 3_600_000);
  const earlier = imageAnnotationsPath("Shared", ["sub", "note.md"]);
  writeRecord(earlier, '{"annotations":["earlier"]}');
  utimesSync(earlier, old, old);
  host.rename("sub/note.md", "sub/renamed.md");
  const next = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(next.held, []);
}));

test("S4: a wrapper reports the committed mapping and what stayed behind; the log is not lost", () => withShared(async ({ host }) => {
  const destination = imageAnnotationsPath("Shared", ["sub", "moved.png"]);
  writeRecord(imageAnnotationsPath("Shared", ["sub", "photo.png"]), '{"annotations":["mine"]}');
  // Saved there after the preflight, while the host moves the file.
  const rename = host.rename.bind(host);
  host.rename = (from: string, to: string, at?: number) => { rename(from, to, at); writeRecord(destination, '{"annotations":["theirs"]}'); };

  const error = await moveSharedFile("Shared/sub/photo.png", "Shared/sub", "moved.png").then(() => null, (failure: unknown) => failure);
  assert.ok(error instanceof SharedOperationUnfinishedError, String(error));
  assert.deepEqual(error.committed.map(({ from, to }) => [from, to]), [["Shared/sub/photo.png", "Shared/sub/moved.png"]]);
  assert.equal(error.committed[0].fileId, "fil_sub/photo.png");
  assert.match(error.message, /moved, but these records could not be moved[\s\S]*already has one/);
  assert.equal(readFileSync(destination, "utf8"), '{"annotations":["theirs"]}');
}));

test("S4: a delete reports what stayed behind as a committed delete", () => withShared(async ({ host }) => {
  const note = "Shared/sub/note.md";
  await setFileTagsForPath(note, ["draft"]);
  await deleteSharedFile(note);
  assert.equal(await tagsOf(note), undefined);
  assert.equal(host.entries.some((item) => item.path === "sub/note.md"), false);
  assert.deepEqual(host.log, [], "the wrapper's own transition was acknowledged");
}));

test("Battery: a drain with nothing pending is one host call, and tree loads ask the host only when something may be pending", () => withShared(async ({ host }) => {
  // A window opening nudges: that is the one ask, and the notebook is idle after it (earlier tests in this process left it idle too).
  const first = await nudgeSharedRecordTransitions("Shared");
  assert.equal(first.reachable, true);
  assert.equal(host.hits.transitions, 1);
  assert.equal(host.hits.entries, 0, "nothing pending: the manifest is not read");
  for (let load = 0; load < 5; load++) assert.equal(await drainSharedRecordTransitionsIfPending("Shared"), null);
  assert.equal(host.hits.transitions, 1, "idle until the host nudges");

  host.rename("sub/note.md", "sub/other.md");
  const nudged = await nudgeSharedRecordTransitions("Shared");
  assert.equal(nudged.applied, 1);
  assert.equal(host.hits.transitions, 2);
  assert.equal(await drainSharedRecordTransitionsIfPending("Shared"), null, "idle again once applied");
}));
