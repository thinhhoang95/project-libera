// Review 2026-11-25, package S2 (S-C1 items 1 to 4): a shared PDF's local records follow it
// (rename moves them, delete retires them), a deliberate delete never leaves a record that
// blocks the name, and the path-free checks agree with what Check Notebook can clear.
// The host is a stub that keeps the manifest list and the durable transition log, as the real one does.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry, FileOpRequest, ManifestTransition } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { moveSharedFile } from "../../src/lib/collab/shared-writes";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { definitionsPath, orphanedSidecarsDirectoryPath, pdfAnnotationsPath, pdfOutlinePath } from "../../src/lib/storage/paths";
import { drainSharedRecordTransitions } from "../../src/lib/storage/shared-record-follow";
import { assertNotebookSound } from "./notebook-test-helpers";

const PDF_A = "the first paper";
const sourceOf = (bytes: string) => ({ size: Buffer.byteLength(bytes), contentHash: createHash("sha256").update(bytes).digest("hex") });

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

class StubHost {
  entries: FileListEntry[] = [];
  log: ManifestTransition[] = [];
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

const entry = (relative: string): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind: "blob", updatedAt: 1 });

async function withShared(run: (fixture: { host: StubHost; notebook: string }) => Promise<void>, pdfLive = false) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-review-1125-s2-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(notebook, { recursive: true });
  writeFileSync(path.join(notebook, "a.pdf"), PDF_A);
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", ...(pdfLive ? { pdfLive: true } : {}), sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost(notebook);
  host.entries = [entry("a.pdf")];
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

const names = (name: string) => [pdfAnnotationsPath("Shared", [name]), pdfOutlinePath("Shared", [name]), definitionsPath("Shared", [name])];
const present = (files: string[]) => files.map((file) => fs.existsSync(file));

/** The three local kinds of a PDF, recording its bytes, saved an hour ago. */
function seedRecords(name: string, bytes = PDF_A) {
  const [annotations, outline, definitions] = names(name);
  for (const [file, body] of [
    [annotations, { source: sourceOf(bytes), annotations: [] }],
    [outline, { version: 1, documentPath: "", source: sourceOf(bytes), entries: [] }],
    [definitions, { version: 1, documentPath: "", source: sourceOf(bytes), entries: [] }],
  ] as const) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(body)); }
  const old = new Date(Date.now() - 3_600_000);
  for (const file of names(name)) fs.utimesSync(file, old, old);
}

const orphanCount = () => (["annotations", "outline", "definitions"] as const).reduce((sum, kind) => {
  const directory = orphanedSidecarsDirectoryPath("Shared", kind);
  return sum + (fs.existsSync(directory) ? readdirSync(directory).length : 0);
}, 0);

test("S-C1 1: a confirmed rename moves annotations, outline and definitions; nothing stays at the old name", () => withShared(async ({ host }) => {
  seedRecords("a.pdf");
  host.rename("a.pdf", "b.pdf");
  const result = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(result.unfinished, [], JSON.stringify(result));
  assert.deepEqual(present(names("b.pdf")), [true, true, true]);
  assert.deepEqual(present(names("a.pdf")), [false, false, false], "moved, not copied");
  await assertNotebookSound("Shared", { partial: true });
}));

test("S-C1 2: a confirmed delete retires the records even though the PDF is already gone", () => withShared(async ({ host }) => {
  seedRecords("a.pdf");
  host.remove("a.pdf");
  const result = await drainSharedRecordTransitions("Shared");
  assert.deepEqual(result.unfinished, [], JSON.stringify(result));
  assert.deepEqual(present(names("a.pdf")), [false, false, false]);
  assert.ok(orphanCount() >= 3, "set aside the existing way, not erased");
  await assertNotebookSound("Shared", { partial: true });
}));

test("S-C1 3/4: on a pdfLive notebook a leftover live-marks sidecar no longer blocks reusing the name; Check Notebook is clean", () => withShared(async ({ host, notebook }) => {
  // What a delete used to leave behind: a sidecar at the deleted name.
  host.entries.push(entry("b.pdf"));
  writeFileSync(path.join(notebook, "b.pdf"), "the second paper");
  host.remove("a.pdf");
  const [annotations] = names("a.pdf");
  mkdirSync(path.dirname(annotations), { recursive: true });
  writeFileSync(annotations, JSON.stringify({ annotations: [], sharedCopy: "doc" }));
  await drainSharedRecordTransitions("Shared");
  // Rename b.pdf onto the freed name: must not be refused with 409.
  await moveSharedFile("Shared/b.pdf", "Shared", "a.pdf");
  assert.ok(fs.existsSync(path.join(notebook, "a.pdf")));
  await assertNotebookSound("Shared", { partial: true });
}, true));
