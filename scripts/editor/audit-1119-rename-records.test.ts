// Regressions for the 2026-11-19 sync audit, finding 13 (what is left of it):
// a renamed shared file or folder carries the records kept on this computer as
// a local rename does: the bibliography tether, and, for a folder, the per-file
// records of every file under it. Records move exclusively, and one that cannot
// move is reported, never left behind silently. The host is a stub: it renames
// the working copy on disk like the real one and lists the manifest's entries.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry, FileOpRequest } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { moveSharedFile, renameSharedFolder } from "../../src/lib/collab/shared-writes";
import { bibTetherStatePath, resetBibTethers, settleBibTether } from "../../src/lib/references/bib-tether";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { definitionsPath, imageAnnotationsPath } from "../../src/lib/storage/paths";

/** Runs while the host renames, as another process writing at the destination would. */
let onRename: (() => void) | null = null;

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

class StubHost {
  entries: FileListEntry[] = [];
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
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) return send(200, { entries: this.entries });
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        if (op.op === "rename" && op.to) {
          renameSync(path.join(this.notebook, op.path), path.join(this.notebook, op.to));
          onRename?.();
        }
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

async function withShared(run: (fixture: { notebook: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-audit-1119-records-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(path.join(notebook, "sub"), { recursive: true });
  writeFileSync(path.join(notebook, "sub", "photo.png"), "png bytes");
  writeFileSync(path.join(notebook, "sub", "note.md"), "note\n");
  writeFileSync(path.join(notebook, "sub", "refs.bib"), "@book{a,\n  title = {A}\n}\n");
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost(notebook);
  host.entries = ["sub/photo.png", "sub/note.md", "sub/refs.bib"].map(entry);
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  mock.method(fs, "watch", () => new Watcher());
  try {
    await run({ notebook });
  } finally {
    await settleBibTether("Shared").catch(() => undefined);
    resetBibTethers();
    resetBibMirrorScheduler();
    mock.restoreAll();
    onRename = null;
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// The tether's settings, written as tetherBibFile would (it reads the file through the host, which this stub is not).
function tetherTo(relative: string) {
  const config = { version: 1, target: { kind: "notebook", path: relative }, dialect: "bibtex", tetheredAt: "2026-11-19T00:00:00.000Z", prefer: "file", base: null, status: { state: "synced", warnings: [] } };
  writeRecord(bibTetherStatePath("Shared"), JSON.stringify(config));
}

const tetherTarget = () => (JSON.parse(readFileSync(bibTetherStatePath("Shared"), "utf8")) as { target: { path: string } }).target.path;

/** The tether follows a move from a "moved" event, in the background: wait for it. */
async function tetherSettled(expected: string) {
  for (let attempt = 0; attempt < 60 && tetherTarget() !== expected; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(tetherTarget(), expected);
}

function writeRecord(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test("13: a renamed shared .bib file keeps the notebook's tether", () => withShared(async () => {
  tetherTo("sub/refs.bib");
  await moveSharedFile("Shared/sub/refs.bib", "Shared/sub", "library.bib");
  await tetherSettled("sub/library.bib");
}));

test("13: a renamed shared folder moves the records of every file under it and the tether", () => withShared(async () => {
  const imageRecord = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  const definitions = definitionsPath("Shared", ["sub", "note.md"]);
  writeRecord(imageRecord, '{"annotations":[]}');
  writeRecord(definitions, '{"entries":[]}');
  tetherTo("sub/refs.bib");

  await renameSharedFolder("Shared/sub", "renamed");
  await tetherSettled("renamed/refs.bib");

  assert.equal(fs.existsSync(imageRecord), false, "the image annotations left the old folder's path");
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["renamed", "photo.png"]), "utf8"), '{"annotations":[]}');
  assert.equal(fs.existsSync(definitions), false);
  assert.equal(readFileSync(definitionsPath("Shared", ["renamed", "note.md"]), "utf8"), '{"entries":[]}');
}));

test("13: a record that cannot move is reported, and never replaces one at the destination", () => withShared(async () => {
  const taken = definitionsPath("Shared", ["renamed", "note.md"]);
  const source = definitionsPath("Shared", ["sub", "note.md"]);
  const image = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  writeRecord(source, '{"entries":["old"]}');
  writeRecord(image, '{"annotations":[]}');
  // Written after the rename's preflight (which refuses a name that holds records), while the host renames.
  onRename = () => writeRecord(taken, '{"entries":["mine"]}');

  await assert.rejects(renameSharedFolder("Shared/sub", "renamed"), /could not be moved[\s\S]*note\.md/);
  assert.equal(readFileSync(taken, "utf8"), '{"entries":["mine"]}');
  assert.equal(readFileSync(source, "utf8"), '{"entries":["old"]}', "the record that could not move stays at the old path");
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["renamed", "photo.png"]), "utf8"), '{"annotations":[]}', "the others still moved");
}));
