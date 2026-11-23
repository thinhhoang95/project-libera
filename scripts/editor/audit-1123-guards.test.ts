// Three-way sync review, package NX2 (H22, M3, M21): a shared notebook's guard
// sees every spelling of its name and every direct write, and the record
// follow-up acknowledges in the sizes the host accepts and drains one at a time.

import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";

import type { FileListEntry, ManifestTransition } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache, isSharedNotebookPath, sharedNotebookMarker } from "../../src/lib/collab/shared-notebook";
import { legacyPythonSidecarPath, pythonSidecarPath } from "../../src/lib/python/sidecar";
import { migratePythonSidecar } from "../../src/lib/storage/markdown-assets";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { drainSharedRecordTransitions } from "../../src/lib/storage/shared-record-follow";
import { readWorkspaceMetadata, setFileTagsForPath } from "../../src/lib/storage/workspace-metadata";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

/** A host that keeps a manifest list and the durable transition log, with the page size and the acknowledgement limit of the real one. */
class StubHost {
  entries: FileListEntry[] = [];
  log: ManifestTransition[] = [];
  hits = { transitions: 0, ack: 0, entries: 0 };
  ackSizes: number[] = [];
  server: Server | null = null;
  url = "";
  token = "stub-token";
  private gateOn = 0;
  private gateHit: () => void = () => undefined;
  private released: Promise<void> = Promise.resolve();
  private gateRelease: () => void = () => undefined;

  /** Holds the answer of the Nth file-entries request (the list as it is at request time) until `release`. */
  arm(on: number) {
    this.gateOn = on;
    this.released = new Promise<void>((resolve) => { this.gateRelease = resolve; });
    const hit = new Promise<void>((resolve) => { this.gateHit = resolve; });
    return { hit, release: this.gateRelease };
  }

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", async () => {
        const send = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.headers.authorization !== `Bearer ${this.token}`) return send(404, { error: { code: "not-found", message: "No route." } });
        const url = new URL(request.url ?? "", "http://host");
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) {
          this.hits.entries += 1;
          const snapshot = JSON.stringify({ entries: this.entries });
          if (this.gateOn === this.hits.entries) {
            this.gateHit();
            await this.released;
          }
          response.writeHead(200, { "content-type": "application/json" });
          return response.end(snapshot);
        }
        if (/\/projects\/[^/]+\/transitions$/.test(url.pathname)) {
          this.hits.transitions += 1;
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 500);
          const rows = this.log.filter((item) => item.seq > after);
          return send(200, { transitions: rows.slice(0, limit), more: rows.length > limit });
        }
        if (/\/projects\/[^/]+\/transitions\/ack$/.test(url.pathname)) {
          this.hits.ack += 1;
          const { seqs = [] } = JSON.parse(body) as { seqs?: number[] };
          this.ackSizes.push(seqs.length);
          if (seqs.length > 5000) return send(400, { error: { code: "bad-request", message: "seqs must be a list of integers." } });
          const before = this.log.length;
          this.log = this.log.filter((item) => !seqs.includes(item.seq));
          return send(200, { removed: before - this.log.length });
        }
        return send(404, { error: { code: "not-found", message: "No route." } });
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

async function withShared(run: (fixture: { host: StubHost; notebook: string; adminRoot: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-audit-1123-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const adminRoot = path.join(dataDir, "users", "admin");
  const notebook = path.join(adminRoot, "Shared");
  mkdirSync(notebook, { recursive: true });
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  process.env.LIBERA_DATA_DIR = dataDir;
  invalidateSharedNotebookCache();
  const host = new StubHost();
  await host.start();
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  mock.method(fs, "watch", () => new Watcher());
  try {
    await createNotebook("Local");
    await run({ host, notebook, adminRoot });
  } finally {
    host.arm(0).release();
    resetBibTethers();
    resetBibMirrorScheduler();
    mock.restoreAll();
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("H22: a notebook name with trailing whitespace is still the shared notebook", () => withShared(async () => {
  assert.ok(sharedNotebookMarker("Shared"));
  assert.ok(sharedNotebookMarker("Shared "), "the marker of 'Shared ' is the marker of 'Shared'");
  assert.equal(isSharedNotebookPath("Shared/note.md"), true);
  assert.equal(isSharedNotebookPath("Shared /note.md"), true);
  assert.equal(isSharedNotebookPath("Shared \t/sub/note.md"), true);
  assert.equal(isSharedNotebookPath("Local/note.md"), false);
}));

test("H22: migrating a legacy Python sidecar never writes or deletes inside a shared notebook", () => withShared(async ({ notebook }) => {
  const document = "Shared/note.md";
  const legacy = path.join(notebook, ...legacyPythonSidecarPath(document).split("/").slice(1));
  mkdirSync(path.dirname(legacy), { recursive: true });
  writeFileSync(legacy, "print('legacy')\n");
  const canonical = path.join(notebook, ...pythonSidecarPath(document).split("/").slice(1));
  await migratePythonSidecar(document);
  await migratePythonSidecar("Shared /note.md");
  assert.equal(readFileSync(legacy, "utf8"), "print('legacy')\n", "the legacy file is left where it is");
  assert.equal(existsSync(canonical), false, "no canonical copy is written");
}));

test("M3: a log of more than 5,000 completed transitions is acknowledged in batches the host accepts", () => withShared(async ({ host }) => {
  const count = 5_100;
  for (let index = 1; index <= count; index += 1) {
    host.entries.push(entry(`f${index}.md`));
    // A removal of a file the manifest lists again: nothing to apply, final at once.
    host.log.push({ seq: index, projectId: "prj_test", fileId: `fil_f${index}.md`, kind: "file", from: `Shared/f${index}.md`, to: null, at: 1 });
  }
  const result = await drainSharedRecordTransitions("Shared");
  assert.equal(result.error, undefined, result.error);
  assert.equal(host.log.length, 0, "every transition was acknowledged");
  assert.ok(host.ackSizes.every((size) => size <= 5_000), JSON.stringify(host.ackSizes));
  assert.equal(host.ackSizes.reduce((sum, size) => sum + size, 0), count);
}));

test("M21: overlapping drains apply a transition once and never touch a file created since", () => withShared(async ({ host }) => {
  // a.md was deleted by the manifest; its records go with it.
  host.log.push({ seq: 1, projectId: "prj_test", fileId: "fil_old", kind: "file", from: "Shared/a.md", to: null, at: 1 });
  await setFileTagsForPath("Shared/a.md", ["old"]);
  const gate = host.arm(1);

  const first = drainSharedRecordTransitions("Shared");
  await gate.hit; // the first drain has the log and waits for the file list
  const second = drainSharedRecordTransitions("Shared");
  const winner = await Promise.race([second.then(() => "second"), new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 300))]);
  // Where drains overlap, the second finishes first; a file created at that path now (a new file ID) has records of its own.
  if (winner === "second") {
    host.entries.push(entry("a.md", "fil_new"));
    await setFileTagsForPath("Shared/a.md", ["new"]);
  }
  gate.release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].applied + results[1].applied, 1, `the transition is applied once: ${JSON.stringify(results.map((result) => result.applied))}`);
  if (winner === "second") assert.deepEqual((await readWorkspaceMetadata()).fileTags["Shared/a.md"], ["new"], "the new file's tags survive");
  assert.deepEqual(host.log, []);
}));
