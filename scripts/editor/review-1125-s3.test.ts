// File-moving review 2026-11-25, package S3 (S-C2, S-H4, S-H3): a shared change the server has not acknowledged
// moves or removes nothing kept on this computer, a change it rolls back leaves the records where the restored
// manifest expects them, an acknowledged change is followed once, records are judged and ordered under the name
// rule (case and Unicode form), and the check does not call a pending change damage.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry, FileOpRequest, ManifestTransition } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { deleteSharedFile } from "../../src/lib/collab/shared-writes";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { imageAnnotationsPath } from "../../src/lib/storage/paths";
import { drainSharedRecordTransitions } from "../../src/lib/storage/shared-record-follow";
import { readManifestView } from "../../src/lib/storage/shared-manifest-view";
import { readWorkspaceMetadata, setFileTagsForPath } from "../../src/lib/storage/workspace-metadata";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

/** A host like the real one: a manifest list, a log that holds a change only once the server acknowledged it, and a rollback. */
class StubHost {
  entries: FileListEntry[] = [];
  log: ManifestTransition[] = [];
  /** Changes made but not acknowledged: the list shows them, the log does not. */
  pendingRows: Array<Omit<ManifestTransition, "seq">> = [];
  /** The list as it was before each unacknowledged change, for a rollback. */
  before: FileListEntry[] | null = null;
  deferAck = false;
  private seq = 0;
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  row(fileId: string, from: string, to: string | null): Omit<ManifestTransition, "seq"> {
    return { projectId: "prj_test", fileId, kind: "file", from: `Shared/${from}`, to: to === null ? null : `Shared/${to}`, at: Date.now() };
  }

  commit(row: Omit<ManifestTransition, "seq">) {
    if (this.deferAck) this.pendingRows.push(row); else this.log.push({ ...row, seq: ++this.seq });
  }

  /** The server acknowledges: the rows are recorded. */
  acknowledge() {
    for (const row of this.pendingRows) this.log.push({ ...row, seq: ++this.seq });
    this.pendingRows = [];
    this.before = null;
  }

  /** The server refuses: the manifest is restored and no row is ever recorded. */
  rollback() {
    if (this.before) this.entries = this.before;
    this.pendingRows = [];
    this.before = null;
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
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) return send(200, { entries: this.entries, ...(this.pendingRows.length ? { awaitingServer: this.pendingRows.length } : {}) });
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
        if (op.op === "delete") {
          const index = this.entries.findIndex((item) => item.path === op.path);
          const [gone] = this.entries.splice(index, 1);
          if (this.deferAck && !this.before) this.before = [...this.entries.slice(0, index), gone, ...this.entries.slice(index)];
          this.commit(this.row(gone.fileId, op.path, null));
          return send(200, { paths: [`Shared/${op.path}`], moves: [{ fileId: gone.fileId, from: `Shared/${op.path}`, to: null }], acknowledged: !this.deferAck });
        }
        return send(400, { error: { code: "bad-request", message: "unsupported" } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const entry = (relative: string, fileId = `fil_${relative}`): FileListEntry => ({ fileId, path: relative, kind: "doc", updatedAt: 1 });

async function withShared(entries: FileListEntry[], run: (fixture: { host: StubHost; notebook: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-review-1125-s3-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(path.join(notebook, "sub"), { recursive: true });
  for (const item of entries) writeFileSync(path.join(notebook, item.path), "x\n");
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost();
  host.entries = entries;
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

const tagsOf = async (liberaPath: string) => (await readWorkspaceMetadata()).fileTags[liberaPath];

test("S-C2: a delete the server has not acknowledged removes nothing here, and is followed once when it is", () => withShared([entry("sub/note.md")], async ({ host }) => {
  const note = "Shared/sub/note.md";
  await setFileTagsForPath(note, ["draft"]);
  host.deferAck = true;
  const result = await deleteSharedFile(note);
  assert.ok(result);
  assert.deepEqual(await tagsOf(note), ["draft"], "nothing local is removed before the server has the change");
  const view = await readManifestView("Shared");
  assert.equal(view.state, "unavailable", "the check does not judge a pending change's records as leftovers");

  host.acknowledge();
  const followed = await drainSharedRecordTransitions("Shared");
  assert.equal(followed.applied, 1, JSON.stringify(followed));
  assert.equal(await tagsOf(note), undefined, "followed at the acknowledgement");
  assert.equal((await drainSharedRecordTransitions("Shared")).outcomes.length, 0, "followed once");
  assert.equal((await readManifestView("Shared")).state, "ok");
}));

test("S-C2: a delete the server rolls back leaves the records where the restored manifest expects them", () => withShared([entry("sub/note.md")], async ({ host }) => {
  const note = "Shared/sub/note.md";
  await setFileTagsForPath(note, ["draft"]);
  host.deferAck = true;
  await deleteSharedFile(note);
  host.rollback();
  const drained = await drainSharedRecordTransitions("Shared");
  assert.equal(drained.outcomes.length, 0);
  assert.deepEqual(await tagsOf(note), ["draft"]);
  assert.equal((await readManifestView("Shared")).state, "ok");
}));

test("S-C2: an acknowledged delete is followed at once, as before", () => withShared([entry("sub/note.md")], async () => {
  const note = "Shared/sub/note.md";
  await setFileTagsForPath(note, ["draft"]);
  await deleteSharedFile(note);
  assert.equal(await tagsOf(note), undefined);
}));

test("S-H4: a delete of Note.md never removes the live record of the file at note.md", () => withShared([entry("sub/note.md", "fil_2")], async ({ host }) => {
  const live = imageAnnotationsPath("Shared", ["sub", "note.md"]);
  mkdirSync(path.dirname(live), { recursive: true });
  writeFileSync(live, '{"annotations":["fil_2"]}');
  host.log.push({ seq: 1, projectId: "prj_test", fileId: "fil_1", kind: "file", from: "Shared/sub/Note.md", to: null, at: Date.now() });
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.held.length, 1, JSON.stringify(result));
  assert.equal(readFileSync(live, "utf8"), '{"annotations":["fil_2"]}', "fil_2's record is untouched");
}));

test("S-H4: a move of Note.md does not take the record of the file at note.md", () => withShared([entry("sub/note.md", "fil_2"), entry("sub/other.png", "fil_1")], async ({ host }) => {
  const live = imageAnnotationsPath("Shared", ["sub", "note.md"]);
  mkdirSync(path.dirname(live), { recursive: true });
  writeFileSync(live, '{"annotations":["fil_2"]}');
  host.log.push({ seq: 1, projectId: "prj_test", fileId: "fil_1", kind: "file", from: "Shared/sub/Note.md", to: "Shared/sub/other.md", at: Date.now() });
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.held.length, 1, JSON.stringify(result));
  assert.ok(fs.existsSync(live));
  assert.ok(!fs.existsSync(imageAnnotationsPath("Shared", ["sub", "other.md"])));
}));

test("S-H4: case-differing chained moves are ordered, so neither is lost to the other's record", () => withShared([entry("sub/Pic.png", "fil_1"), entry("sub/c.png", "fil_2")], async ({ host }) => {
  const first = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  const second = imageAnnotationsPath("Shared", ["sub", "pic.png"]);
  mkdirSync(path.dirname(first), { recursive: true });
  writeFileSync(first, '{"annotations":["one"]}');
  writeFileSync(second, '{"annotations":["two"]}');
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(first, old, old);
  fs.utimesSync(second, old, old);
  // fil_1: photo.png -> Pic.png, and fil_2 leaves pic.png for c.png (the same slot on a volume that ignores case).
  host.log.push({ seq: 1, projectId: "prj_test", fileId: "fil_1", kind: "file", from: "Shared/sub/photo.png", to: "Shared/sub/Pic.png", at: Date.now() });
  host.log.push({ seq: 2, projectId: "prj_test", fileId: "fil_2", kind: "file", from: "Shared/sub/pic.png", to: "Shared/sub/c.png", at: Date.now() });
  const result = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(result.unfinished, [], JSON.stringify(result));
  assert.deepEqual(result.held, [], JSON.stringify(result));
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["sub", "c.png"]), "utf8"), '{"annotations":["two"]}');
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["sub", "Pic.png"]), "utf8"), '{"annotations":["one"]}');
}));
