// Regressions for the 2026-11-20 collaboration review, shared batches (findings
// S17, S18, S19, S20): the shared preflight checks the proposed layout with the
// host's reservation key and counts files that stay in the destination; a file
// whose host operation committed counts as moved or deleted even when a later
// step stayed behind; a selection that mixes storage domains is refused whole,
// in either order; and a batch delete does one bounded wait instead of one tree
// read and one disk wait per file. The host is a stub (it renames and deletes the
// working copy like the real one).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";

import { POST as batchRoute } from "../../src/app/api/files/batch/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import type { FileListEntry, FileOpRequest } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { SharedOperationUnfinishedError } from "../../src/lib/collab/shared-outcomes";
import { deleteSharedFile } from "../../src/lib/collab/shared-writes";
import {
  assertOneStorageDomain,
  BatchRefusedError,
  deleteFiles,
  moveFilesToDirectory,
  preflightSharedMove,
  type BatchDomain,
} from "../../src/lib/storage/batch-files";
import type { LiberaFileMovePayload } from "../../src/lib/types";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

class StubHost {
  entries: FileListEntry[] = [];
  ops: FileOpRequest[] = [];
  /** How many times the host's file list was asked for. */
  listings = 0;
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  constructor(private readonly notebook: string) {}

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
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) { this.listings += 1; return send(200, { entries: this.entries }); }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        if (op.op === "rename" && op.to) renameSync(path.join(this.notebook, op.path), path.join(this.notebook, op.to));
        if (op.op === "delete") rmSync(path.join(this.notebook, op.path), { recursive: true, force: true });
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

const entry = (relative: string, kind: FileListEntry["kind"] = "doc"): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind, updatedAt: 1 });

/** A shared notebook `Shared` with the given files on disk and in the host's list, and its local archive with `_archive/old.md`. */
async function withShared(files: string[], run: (fixture: { host: StubHost; notebook: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-shared-batch-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(notebook, { recursive: true });
  for (const file of files) {
    mkdirSync(path.dirname(path.join(notebook, file)), { recursive: true });
    writeFileSync(path.join(notebook, file), "text\n");
  }
  mkdirSync(path.join(notebook, "_archive"), { recursive: true });
  writeFileSync(path.join(notebook, "_archive", "old.md"), "old\n");
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost(notebook);
  host.entries = files.map((file) => entry(file));
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  mock.method(fs, "watch", () => new Watcher());
  try {
    await run({ host, notebook });
  } finally {
    mock.restoreAll();
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const post = (body: object) => batchRoute(new NextRequest("http://localhost/api/files/batch", {
  method: "POST",
  headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`, "content-type": "application/json" },
  body: JSON.stringify(body),
}));

const items = (...paths: string[]) => paths.map((item) => ({ path: item }));
const listing = (...paths: string[]) => async () => paths.map((item) => ({ path: item }));
const payloadAt = (to: string) => ({ file: { path: to, name: to.split("/").at(-1), notebook: to.split("/")[0] } }) as unknown as LiberaFileMovePayload;

// ---- S17 ----

test("S17: composed and decomposed spellings of one name are refused before anything moves", async () => {
  const composed = "Shared/x/\u00e9.md";
  const decomposed = "Shared/y/e\u0301.md";
  const problems = await preflightSharedMove(items(composed, decomposed), "Shared/z", listing("Shared/x/\u00e9.md", "Shared/y/e\u0301.md"));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, decomposed);
  assert.match(problems[0].message, /would both be named/);
});

test("S17: a file already in the destination, selected or not, takes the name", async () => {
  const entries = ["Shared/z/a.md", "Shared/z/b.md", "Shared/x/A.md", "Shared/x/b.md", "Shared/Z/C.md"];
  // Not selected: the manifest knows it; the case differs, the host's key does not.
  const stationary = await preflightSharedMove(items("Shared/x/A.md"), "Shared/z", listing(...entries));
  assert.deepEqual(stationary.map((item) => item.message), ["Shared/z/a.md already exists."]);
  // Selected and staying: named as such.
  const selected = await preflightSharedMove(items("Shared/z/b.md", "Shared/x/b.md"), "Shared/z", listing(...entries));
  assert.equal(selected.length, 1);
  assert.match(selected[0].message, /Shared\/z\/b\.md is selected too but stays in Shared\/z/);
  // A folder holding the name counts too.
  const folder = await preflightSharedMove(items("Shared/x/b.md"), "Shared/z", async () => [{ path: "Shared/z/B.md" }]);
  assert.equal(folder.length, 1);
});

test("S17: a layout with no clash passes, and a manifest that cannot be read refuses", async () => {
  assert.deepEqual(await preflightSharedMove(items("Shared/x/a.md", "Shared/y/b.md"), "Shared/z", listing("Shared/x/a.md", "Shared/y/b.md", "Shared/z/c.md")), []);
  const refused = await preflightSharedMove(items("Shared/x/a.md"), "Shared/z", async () => { throw new Error("host is down"); });
  assert.equal(refused.length, 1);
  assert.match(refused[0].message, /could not be read \(host is down\)/);
});

test("S17: the route refuses the NFC/NFD pair and the stationary occupant without asking the host to move anything", () => withShared(["x/\u00e9.md", "y/e\u0301.md", "z/a.md", "x/A.md"], async ({ host }) => {
  const nfd = await post({ action: "move", items: items("Shared/x/\u00e9.md", "Shared/y/e\u0301.md"), destinationDirectory: "Shared/z" });
  assert.equal(nfd.status, 409);
  assert.match((await nfd.json()).error, /would both be named/);

  const occupied = await post({ action: "move", items: items("Shared/x/A.md"), destinationDirectory: "Shared/z" });
  assert.equal(occupied.status, 409);
  assert.match((await occupied.json()).error, /already exists/);
  assert.deepEqual(host.ops, [], "the host was not asked to move anything");
}));

// ---- S18 ----

const unfinished = (committed: SharedOperationUnfinishedError["committed"]) => new SharedOperationUnfinishedError("It was moved, but steps stayed behind.", committed, ["the tags of the file"]);

test("S18: a move the host committed counts as moved with its unfinished steps, and the batch goes on", async () => {
  const result = await moveFilesToDirectory(items("Shared/x/a.md", "Shared/x/b.md", "Shared/x/c.md"), "Shared/z", {
    preflight: async () => [],
    move: async (item, directory) => {
      const to = `${directory}/${item.path.split("/").at(-1)}`;
      if (item.path.endsWith("b.md")) throw unfinished([{ from: item.path, to }]);
      return payloadAt(to);
    },
  });
  assert.deepEqual(result.moved.map((moved) => [moved.from, moved.to]), [["Shared/x/a.md", "Shared/z/a.md"], ["Shared/x/b.md", "Shared/z/b.md"], ["Shared/x/c.md", "Shared/z/c.md"]]);
  assert.equal(result.moved[1].payload, null);
  assert.deepEqual(result.moved[1].unfinished, ["the tags of the file"]);
  assert.equal(result.moved[0].unfinished, undefined);
  assert.equal(result.failed, null, "a committed move is not a failure");
  assert.deepEqual(result.notMoved, []);
});

test("S18: an unfinished error that does not name the file as committed is a failure, and stops the batch", async () => {
  const result = await moveFilesToDirectory(items("Shared/x/a.md", "Shared/x/b.md"), "Shared/z", {
    preflight: async () => [],
    move: async (item) => { throw unfinished([{ from: "Shared/other.md", to: "Shared/z/other.md" }]); },
  });
  assert.deepEqual(result.moved, []);
  assert.equal(result.failed?.path, "Shared/x/a.md");
  assert.deepEqual(result.notMoved, ["Shared/x/b.md"]);
});

test("S18: a delete the host committed counts as deleted with its unfinished steps; a plain failure does not", async () => {
  const result = await deleteFiles(items("Shared/a.md", "Shared/b.md", "Shared/c.md"), {
    remove: async (item) => {
      if (item.path.endsWith("b.md")) throw unfinished([{ from: item.path, to: null }]);
      if (item.path.endsWith("c.md")) throw new Error("The host refused.");
    },
  });
  assert.deepEqual(result.deleted, ["Shared/a.md", "Shared/b.md"]);
  assert.deepEqual(result.unfinished, [{ path: "Shared/b.md", steps: ["the tags of the file"] }]);
  assert.deepEqual(result.failed, [{ path: "Shared/c.md", error: "The host refused." }]);
});

// ---- S19 ----

const domainOf = (item: string): BatchDomain => /\/_archive(\/|$)/.test(item) ? "archive" : "shared";

test("S19: a mixed selection is refused whole, in either order, naming each file's storage", () => {
  const archived = "Shared/_archive/old.md";
  const active = "Shared/a.md";
  for (const order of [[archived, active], [active, archived]]) {
    assert.throws(() => assertOneStorageDomain(items(...order), "Shared/z", domainOf), (error: unknown) =>
      error instanceof BatchRefusedError && /mixes files of the shared notebook with files in its archive/.test(error.message) &&
      error.problems.length === 2 && error.problems.every((problem) => problem.message.length > 0));
    assert.throws(() => assertOneStorageDomain(items(...order), null, domainOf), BatchRefusedError);
  }
});

test("S19: one storage passes, and a destination in the other storage is refused", () => {
  assertOneStorageDomain(items("Shared/a.md", "Shared/b.md"), "Shared/z", domainOf);
  assertOneStorageDomain(items("Shared/_archive/a.md"), "Shared/_archive/z", domainOf);
  assert.throws(() => assertOneStorageDomain(items("Shared/a.md"), "Shared/_archive", domainOf), /cannot be moved into its archive/);
  assert.throws(() => assertOneStorageDomain(items("Shared/_archive/a.md"), "Shared/z", domainOf), /cannot be moved into the shared notebook/);
});

test("S19: the route refuses the mixed selection in both orders, move and delete, before touching anything", () => withShared(["a.md", "z/keep.md"], async ({ host, notebook }) => {
  for (const order of [["Shared/_archive/old.md", "Shared/a.md"], ["Shared/a.md", "Shared/_archive/old.md"]]) {
    const move = await post({ action: "move", items: items(...order), destinationDirectory: "Shared/z" });
    assert.equal(move.status, 409);
    const body = await move.json();
    assert.match(body.error, /mixes files of the shared notebook with files in its archive/);
    assert.equal(body.problems.length, 2);

    const remove = await post({ action: "delete", items: items(...order) });
    assert.equal(remove.status, 409);
  }
  assert.deepEqual(host.ops, []);
  assert.ok(existsSync(path.join(notebook, "a.md")));
  assert.ok(existsSync(path.join(notebook, "_archive", "old.md")));
}));

test("S19: the route sends a shared file into the archive or an archived file into the shared folders nowhere", () => withShared(["a.md", "z/keep.md"], async ({ host }) => {
  const toArchive = await post({ action: "move", items: items("Shared/a.md"), destinationDirectory: "Shared/_archive" });
  assert.equal(toArchive.status, 409);
  assert.match((await toArchive.json()).error, /cannot be moved into its archive/);
  const fromArchive = await post({ action: "move", items: items("Shared/_archive/old.md"), destinationDirectory: "Shared/z" });
  assert.equal(fromArchive.status, 409);
  assert.match((await fromArchive.json()).error, /cannot be moved into the shared notebook/);
  assert.deepEqual(host.ops, []);
}));

// ---- S20 ----

test("S20: a batch delete reads no tree per file and the wrapper skips its own wait", () => withShared(["a.md", "b.md", "c.md"], async ({ host, notebook }) => {
  assert.equal(await deleteSharedFile("Shared/a.md", { deferRefresh: true }), null);
  assert.ok(!existsSync(path.join(notebook, "a.md")));

  const response = await post({ action: "delete", items: items("Shared/b.md", "Shared/c.md") });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.deleted, ["Shared/b.md", "Shared/c.md"]);
  assert.deepEqual(host.ops.map((op) => op.op), ["delete", "delete", "delete"]);
  // No tree read and no disk wait per file (what the wrapper used to add). The host's file list is read at most twice per
  // deleted file: for its ID when the request has none, and by the records follow-up (shared-record-follow.ts) to judge
  // ownership after the delete. Both are in-memory host reads, never a walk of the disk.
  assert.ok(host.listings <= 2 * host.ops.length, `${host.listings} file-list reads for ${host.ops.length} deletes`);
}));
