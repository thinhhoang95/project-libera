// Round 2026-11-25, package K1 (shared-notebook link engine): R-C1, R-C2, R-H1 and the inbound-link part of S-M4.
//  R-C1: which shared notes are read and rewritten does not depend on the lagging local link index: `/api/files/raw/` embeds,
//        HTML anchors, charts under a renamed folder and text only the live document has are all found.
//  R-C2: a shared notebook's local `_archive/` notes are rewritten, and a link into `_archive/` is judged on disk.
//  R-H1: a shared note the host holds as a blob is written back through the blob path.
//  S-M4: local notes' links into a shared notebook follow a move a collaborator made (read from the host's log).
// The host is a stub like the one in shared-move-links-integrity.test.ts, with blob reads and writes and a transition log.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry, FileOpRequest, ManifestTransition, TextEdit } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { moveSharedFile, renameSharedFolder } from "../../src/lib/collab/shared-writes";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { drainSharedRecordTransitions } from "../../src/lib/storage/shared-record-follow";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookSystemDirectoryPath } from "../../src/lib/storage/paths";
import { assertNotebookSound } from "./notebook-test-helpers";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

const TEXT_EXTENSIONS = new Set([".md", ".tex", ".bib", ".txt"]);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

class StubHost {
  /** Shared documents' live text, by path inside the notebook. */
  readonly texts = new Map<string, string>();
  /** Files held as blobs, with their text (images have none). */
  readonly blobs = new Map<string, string>();
  readonly edited: string[] = [];
  readonly blobWrites: string[] = [];
  transitions: ManifestTransition[] = [];
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  constructor(readonly root: string) {}

  private write(relative: string, content: string) {
    const target = path.join(this.root, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  put(relative: string, content: string) {
    this.write(relative, content);
    if (TEXT_EXTENSIONS.has(path.extname(relative))) this.texts.set(relative, content);
    else this.blobs.set(relative, content);
  }

  /** A text file the host holds as a blob. */
  putBlobText(relative: string, content: string) {
    this.write(relative, content);
    this.blobs.set(relative, content);
  }

  /** The live text moves ahead of the working copy on disk (the disk is not written). */
  live(relative: string, text: string) {
    this.texts.set(relative, text);
  }

  /** What a collaborator, or Finder on the host's disk, does: the file is at another path; nothing here is told. */
  moveBehindOurBack(from: string, to: string) {
    const rename = (relative: string) => relative === from ? to : relative.startsWith(`${from}/`) ? `${to}${relative.slice(from.length)}` : relative;
    for (const [key, value] of [...this.texts]) { this.texts.delete(key); this.texts.set(rename(key), value); }
    for (const [key, value] of [...this.blobs]) { this.blobs.delete(key); this.blobs.set(rename(key), value); }
    mkdirSync(path.dirname(path.join(this.root, ...to.split("/"))), { recursive: true });
    renameSync(path.join(this.root, ...from.split("/")), path.join(this.root, ...to.split("/")));
  }

  private entries(): FileListEntry[] {
    return [
      ...[...this.texts.keys()].map((relative): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind: "doc", docId: relative, docKind: relative.endsWith(".tex") ? "latex" : "markdown", updatedAt: 1 })),
      ...[...this.blobs.keys()].map((relative): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind: "blob", updatedAt: 1 })),
    ];
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
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) return send(200, { entries: this.entries() });
        if (/\/projects\/[^/]+\/transitions$/.test(url.pathname)) return send(200, { transitions: this.transitions, more: false });
        if (/\/projects\/[^/]+\/transitions\/ack$/.test(url.pathname)) {
          const { seqs } = JSON.parse(body) as { seqs?: number[] };
          this.transitions = this.transitions.filter((t) => !seqs?.includes(t.seq));
          return send(200, { removed: seqs?.length ?? 0 });
        }
        if (/\/projects\/[^/]+\/file-blob$/.test(url.pathname)) {
          const relative = url.searchParams.get("path") ?? "";
          const content = this.blobs.get(relative);
          if (content === undefined) return send(200, { contentBase64: null });
          return send(200, { fileId: `fil_${relative}`, blobHash: sha(content), contentBase64: Buffer.from(content, "utf8").toString("base64") });
        }
        if (url.pathname === "/docs/resolve") {
          const relative = (url.searchParams.get("path") ?? "").split("/").slice(1).join("/");
          if (!this.texts.has(relative)) return send(200, null);
          return send(200, { docId: relative, projectId: "prj_test", fileId: `fil_${relative}`, path: `Shared/${relative}`, kind: "markdown", role: "editor", readOnly: false });
        }
        const doc = /^\/docs\/([^/]+)\/(text|edits)$/.exec(url.pathname);
        if (doc) {
          const relative = decodeURIComponent(doc[1]);
          const current = this.texts.get(relative);
          if (current === undefined) return send(404, { error: { code: "not-found", message: "Unknown document." } });
          if (doc[2] === "text") return send(200, { docId: relative, text: current, status: "synced" });
          const { edits } = JSON.parse(body) as { edits: TextEdit[] };
          if (edits.some((edit) => current.slice(edit.start, edit.end) !== edit.before)) return send(200, { applied: false, text: current, conflictAt: 0 });
          let next = current;
          for (const edit of [...edits].sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
          this.edited.push(relative);
          this.texts.set(relative, next);
          this.write(relative, next);
          return send(200, { applied: true, text: next });
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest & { contentBase64?: string; expectedFileId?: string; expectedBlobHash?: string };
        if (op.op === "rename" && op.to) {
          this.moveBehindOurBack(op.path, op.to);
          return send(200, { paths: [`Shared/${op.to}`] });
        }
        if (op.op === "write-blob") {
          const current = this.blobs.get(op.path);
          if (current === undefined || op.expectedFileId !== `fil_${op.path}` || op.expectedBlobHash !== sha(current)) return send(409, { error: { code: "conflict", message: "The file changed." } });
          const next = Buffer.from(op.contentBase64 ?? "", "base64").toString("utf8");
          this.blobWrites.push(op.path);
          this.blobs.set(op.path, next);
          this.write(op.path, next);
          return send(200, { paths: [`Shared/${op.path}`] });
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

async function withShared(run: (fixture: { host: StubHost; local: (relative: string, content: string) => void; read: (libraryPath: string) => string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-k1-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(notebook, { recursive: true });
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost(notebook);
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  mock.method(fs, "watch", () => new Watcher());
  const root = path.join(dataDir, "users", "admin");
  try {
    await createNotebook("Local");
    await run({
      host,
      local: (relative, content) => { const target = path.join(root, ...relative.split("/")); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); },
      read: (libraryPath) => readFileSync(path.join(root, ...libraryPath.split("/")), "utf8"),
    });
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

/** A link index that says every note links nowhere interesting: the lagging index the old pre-filter trusted. */
function staleIndex(notes: string[]) {
  mkdirSync(notebookSystemDirectoryPath("Shared"), { recursive: true });
  const files = Object.fromEntries(notes.map((note) => [`Shared/${note}`, { contentHash: "h", destinations: ["https://example.com"] }]));
  writeFileSync(path.join(notebookSystemDirectoryPath("Shared"), "notebook-links.json"), JSON.stringify({ version: 2, files }));
}

test("R-C1: a stale link index does not hide notes that embed or link the moved file by library address or HTML", () => withShared(async ({ host }) => {
  host.put("a/pic.png", "png");
  host.put("md-image.md", "![p](/api/files/raw/Shared/a/pic.png)\n");
  host.put("html-image.md", "<img src=\"/api/files/raw/Shared/a/pic.png\" alt=\"p\">\n");
  host.put("html-link.md", "<a href=\"a/pic.png\">the picture</a>\n");
  staleIndex(["md-image.md", "html-image.md", "html-link.md"]);

  await moveSharedFile("Shared/a/pic.png", "Shared", "moved.png");

  assert.equal(host.texts.get("md-image.md"), "![p](/api/files/raw/Shared/moved.png)\n");
  assert.equal(host.texts.get("html-image.md"), "<img src=\"/api/files/raw/Shared/moved.png\" alt=\"p\">\n");
  assert.equal(host.texts.get("html-link.md"), "<a href=\"moved.png\">the picture</a>\n");
  await assertNotebookSound("Shared");
}));

test("R-C1: a chart whose data sits under a renamed folder follows the folder, stale index or not", () => withShared(async ({ host }) => {
  host.put("sub/data.csv", "x,y\n1,2\n");
  host.put("top.md", "```chart\ndata: sub/data.csv\ntype: bar\n```\n");
  staleIndex(["top.md"]);

  await renameSharedFolder("Shared/sub", "renamed");

  assert.match(host.texts.get("top.md")!, /data: renamed\/data\.csv/);
  await assertNotebookSound("Shared");
}));

test("R-C1: a link only the live document has (the working copy is behind) is rewritten", () => withShared(async ({ host }) => {
  host.put("a/other.md", "# Other\n");
  host.put("note.md", "nothing yet\n");
  host.live("note.md", "nothing yet, now [other](a/other.md)\n");
  staleIndex(["note.md"]);

  await moveSharedFile("Shared/a/other.md", "Shared", "other.md");

  assert.equal(host.texts.get("note.md"), "nothing yet, now [other](other.md)\n");
  assert.deepEqual(host.edited, ["note.md"]);
  await assertNotebookSound("Shared");
}));

test("R-C2: local _archive notes of a shared notebook follow the move, and a link into _archive is judged on disk", () => withShared(async ({ host, read, local }) => {
  host.put("a/other.md", "# Other\n");
  host.put("a/note.md", "[old](../_archive/old.md) and [other](other.md)\n");
  local("Shared/_archive/old.md", "archived\n");
  local("Shared/_archive/linker.md", "[other](../a/other.md)\n");

  await moveSharedFile("Shared/a/note.md", "Shared", "note.md");

  assert.equal(host.texts.get("note.md"), "[old](_archive/old.md) and [other](a/other.md)\n", "a link into _archive keeps opening the archived file");
  await moveSharedFile("Shared/a/other.md", "Shared", "other.md");
  assert.equal(read("Shared/_archive/linker.md"), "[other](../other.md)\n", "an archived local note linking to the moved shared file is rewritten on disk");
  await assertNotebookSound("Shared");
}));

test("R-H1: a shared Markdown note the host holds as a blob is rewritten through the blob path", () => withShared(async ({ host }) => {
  host.put("a/other.md", "# Other\n");
  host.putBlobText("a/big.md", "[other](other.md)\n");

  const payload = await moveSharedFile("Shared/a/other.md", "Shared", "other.md");

  assert.equal(host.blobs.get("a/big.md"), "[other](../other.md)\n");
  assert.deepEqual(host.blobWrites, ["a/big.md"]);
  assert.deepEqual((payload as { links?: { skipped: unknown[] } }).links?.skipped, []);
  await assertNotebookSound("Shared");
}));

test("S-M4: a local note linking into a shared notebook follows a move a collaborator made", () => withShared(async ({ host, local, read }) => {
  host.put("a/other.md", "# Other\n");
  local("Local/n.md", "[shared](Shared/a/other.md)\n");
  local("Shared/_archive/linker.md", "[other](../a/other.md)\n");

  host.moveBehindOurBack("a/other.md", "other.md");
  host.transitions = [{ seq: 1, projectId: "prj_test", fileId: "fil_a/other.md", kind: "file", from: "Shared/a/other.md", to: "Shared/other.md", at: Date.now() }];
  await drainSharedRecordTransitions("Shared");

  assert.equal(read("Local/n.md"), "[shared](Shared/other.md)\n");
  assert.equal(read("Shared/_archive/linker.md"), "[other](../other.md)\n");
  assert.deepEqual(host.edited, [], "the shared notes are the mover's to follow");
  await assertNotebookSound("Local");
}));
