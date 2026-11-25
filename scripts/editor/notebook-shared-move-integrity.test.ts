// Regressions for the 2026-11-20 move-integrity review, shared notebooks
// (findings 96, 97, 98): a shared move checks the records this computer keeps
// at the destination before the host moves anything, and reports the ones that
// could not follow; a shared delete removes the records kept here (review
// comments, reference attachments, ...) as a local delete does; copying shared
// text refuses when the host cannot give its current version. The host is a
// stub: it renames and deletes the working copy like the real one, and knows no
// shared documents.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry, FileOpRequest } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { deleteSharedFile, deleteSharedFolder, moveSharedFile, renameSharedFolder } from "../../src/lib/collab/shared-writes";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { copyFileToDirectory } from "../../src/lib/storage/files";
import { addReviewThreads, findReview } from "../../src/lib/storage/markdown-reviews";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { imageAnnotationsPath, notebookPath } from "../../src/lib/storage/paths";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { readWorkspaceMetadata, setFileTagsForPath } from "../../src/lib/storage/workspace-metadata";
import { writeReferenceLibrary } from "./notebook-test-helpers";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

class StubHost {
  entries: FileListEntry[] = [];
  /** The operations the host was asked to do. */
  ops: FileOpRequest[] = [];
  /** Runs while the host renames, as another process writing at the destination would. */
  onRename: (() => void) | null = null;
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
        this.ops.push(op);
        if (op.op === "rename" && op.to) {
          renameSync(path.join(this.notebook, op.path), path.join(this.notebook, op.to));
          // The manifest lists the file (or each file under the folder) at its new path, as the real host's list does once it committed (S-C2: records follow what the list shows).
          this.entries = this.entries.map((item) => item.path === op.path ? { ...item, path: op.to as string } : item.path.startsWith(`${op.path}/`) ? { ...item, path: `${op.to}${item.path.slice(op.path.length)}` } : item);
          this.onRename?.();
        }
        if (op.op === "delete") {
          rmSync(path.join(this.notebook, op.path), { recursive: true, force: true });
          this.entries = this.entries.filter((item) => item.path !== op.path && !item.path.startsWith(`${op.path}/`));
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

async function withShared(run: (fixture: { host: StubHost; notebook: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-shared-move-integrity-")));
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

test("96: a shared file moved onto a slot that holds this computer's records is refused before the host moves it", () => withShared(async ({ host, notebook }) => {
  const record = imageAnnotationsPath("Shared", ["sub", "moved.png"]);
  writeRecord(record, '{"annotations":["stale"]}');
  await setFileTagsForPath("Shared/sub/moved.png", ["stale"]);

  await assert.rejects(moveSharedFile("Shared/sub/photo.png", "Shared/sub", "moved.png"), /still has the .*annotations.*tags/);
  assert.deepEqual(host.ops, [], "the host was not asked to move anything");
  assert.ok(fs.existsSync(path.join(notebook, "sub", "photo.png")));
  assert.equal(readFileSync(record, "utf8"), '{"annotations":["stale"]}');
  assert.deepEqual((await readWorkspaceMetadata()).fileTags["Shared/sub/moved.png"], ["stale"]);
}));

test("96: a record that could not follow a shared move is reported, and never replaces one at the destination", () => withShared(async ({ host }) => {
  const source = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  const destination = imageAnnotationsPath("Shared", ["sub", "moved.png"]);
  writeRecord(source, '{"annotations":["mine"]}');
  // Written by another process after the preflight, while the host moves the file.
  host.onRename = () => writeRecord(destination, '{"annotations":["theirs"]}');

  await assert.rejects(moveSharedFile("Shared/sub/photo.png", "Shared/sub", "moved.png"), /moved, but these records could not be moved[\s\S]*already has one/);
  assert.equal(readFileSync(destination, "utf8"), '{"annotations":["theirs"]}');
  assert.equal(readFileSync(source, "utf8"), '{"annotations":["mine"]}', "the record that could not move stays where it was");
}));

test("96: a shared folder renamed onto a name that holds this computer's records is refused before the host renames it", () => withShared(async ({ host }) => {
  await setFileTagsForPath("Shared/renamed/note.md", ["stale"]);
  await assert.rejects(renameSharedFolder("Shared/sub", "renamed"), /still has the tags/);
  assert.deepEqual(host.ops, []);
}));

test("97: deleting a shared file removes its review comments and reference attachments", () => withShared(async () => {
  const note = "Shared/sub/note.md";
  await addReviewThreads(note, "note\n", [{ range: { start: 0, end: 2 }, text: "comment" }]);
  await writeReferenceLibrary("Local", [{ key: "a2020", attachments: [note, "Shared/sub/photo.png"] }]);
  writeRecord(imageAnnotationsPath("Shared", ["sub", "photo.png"]), '{"annotations":[]}');

  await deleteSharedFile(note);
  assert.equal(await findReview(note), null);
  assert.deepEqual(await attachments(), ["Shared/sub/photo.png"], "only the deleted file's attachment is detached");

  await deleteSharedFile("Shared/sub/photo.png");
  assert.deepEqual(await attachments(), []);
  assert.ok(!fs.existsSync(imageAnnotationsPath("Shared", ["sub", "photo.png"])), "the image's annotations went with it");
}));

test("97: deleting a shared folder removes the review comments and attachments under it", () => withShared(async () => {
  await addReviewThreads("Shared/sub/note.md", "note\n", [{ range: { start: 0, end: 2 }, text: "comment" }]);
  await writeReferenceLibrary("Local", [{ key: "a2020", attachments: ["Shared/sub/photo.png"] }]);

  await deleteSharedFolder("Shared/sub");
  assert.equal(await findReview("Shared/sub/note.md"), null);
  assert.deepEqual(await attachments(), []);
}));

test("98: copying shared text refuses when the host cannot give its current version", () => withShared(async () => {
  // The host answers no text read (the stub knows no shared documents) while the disk copy may lag.
  writeFileSync(path.join(notebookPath("Shared"), "sub", "note.md"), "behind\n");
  await assert.rejects(copyFileToDirectory("Shared/sub/note.md", "Local"), /not yet up to date on this device/);
  assert.deepEqual(readdirSync(notebookPath("Local")).filter((name) => name.endsWith(".md")), [], "no copy was made");
}));
