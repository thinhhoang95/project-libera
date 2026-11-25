// Regressions for the 2026-11-20 shared-notebook review, findings S21 and S22:
// links and asset paths follow a move inside a shared notebook as they follow a
// local one. The plan is made against the layout the host committed; a shared
// note's text is read from the host and changes only through it (applyEdits,
// with the text just read as a precondition); a note this account cannot edit
// is reported, not written. A link that still resolves but would now open
// another file is rewritten to keep its target. Check Notebook is the oracle.
// The host is a stub that keeps the shared documents' text in a map (the
// source of truth for text) and mirrors it to the working copy on disk.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry, FileOpRequest, TextEdit } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { moveSharedFile, renameSharedFolder } from "../../src/lib/collab/shared-writes";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { moveFileToDirectory } from "../../src/lib/storage/files";
import { verifyNotebook } from "../../src/lib/storage/integrity";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { notebookSystemDirectoryPath } from "../../src/lib/storage/paths";
import type { LiberaLinkRewrites } from "../../src/lib/types";
import { assertNotebookSound } from "./notebook-test-helpers";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

const TEXT_EXTENSIONS = new Set([".md", ".tex", ".bib", ".txt"]);

class StubHost {
  /** The shared documents' text, by path inside the notebook: the source of truth for text. */
  readonly texts = new Map<string, string>();
  /** Files held as blobs (not shared text). */
  readonly blobs = new Set<string>();
  /** Paths whose text the host was asked to edit. */
  readonly edited: string[] = [];
  role = "editor";
  /** Called after the host answered a read of a document's text: lets a test make a collaborator type in between. */
  afterRead: ((relative: string, count: number) => void) | null = null;
  private readonly reads = new Map<string, number>();
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  constructor(readonly root: string) {}

  put(relative: string, content: string) {
    const target = path.join(this.root, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    if (TEXT_EXTENSIONS.has(path.extname(relative))) this.texts.set(relative, content);
    else this.blobs.add(relative);
  }

  /** A collaborator's edit: the text changes at the host, and the working copy follows. */
  type(relative: string, text: string) {
    this.texts.set(relative, text);
    writeFileSync(path.join(this.root, ...relative.split("/")), text);
  }

  private entries(): FileListEntry[] {
    return [
      ...[...this.texts.keys()].map((relative): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind: "doc", docId: relative, docKind: relative.endsWith(".tex") ? "latex" : "markdown", updatedAt: 1 })),
      ...[...this.blobs].map((relative): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind: "blob", updatedAt: 1 })),
    ];
  }

  private move(from: string, to: string) {
    const rename = (relative: string) => relative === from ? to : relative.startsWith(`${from}/`) ? `${to}${relative.slice(from.length)}` : relative;
    for (const [key, value] of [...this.texts]) { this.texts.delete(key); this.texts.set(rename(key), value); }
    for (const key of [...this.blobs]) { this.blobs.delete(key); this.blobs.add(rename(key)); }
    renameSync(path.join(this.root, ...from.split("/")), path.join(this.root, ...to.split("/")));
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
        if (url.pathname === "/docs/resolve") {
          const relative = (url.searchParams.get("path") ?? "").split("/").slice(1).join("/");
          if (!this.texts.has(relative)) return send(200, null);
          return send(200, { docId: relative, projectId: "prj_test", fileId: `fil_${relative}`, path: `Shared/${relative}`, kind: "markdown", role: this.role, readOnly: this.role === "viewer" });
        }
        const doc = /^\/docs\/([^/]+)\/(text|edits)$/.exec(url.pathname);
        if (doc) {
          const relative = decodeURIComponent(doc[1]);
          const current = this.texts.get(relative);
          if (current === undefined) return send(404, { error: { code: "not-found", message: "Unknown document." } });
          if (doc[2] === "text") {
            const count = (this.reads.get(relative) ?? 0) + 1;
            this.reads.set(relative, count);
            send(200, { docId: relative, text: current, status: "synced" });
            this.afterRead?.(relative, count);
            return;
          }
          const { edits } = JSON.parse(body) as { edits: TextEdit[] };
          if (edits.some((edit) => current.slice(edit.start, edit.end) !== edit.before)) return send(200, { applied: false, text: current, conflictAt: 0 });
          let next = current;
          for (const edit of [...edits].sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
          this.edited.push(relative);
          this.type(relative, next);
          return send(200, { applied: true, text: next });
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        if (op.op === "rename" && op.to) this.move(op.path, op.to);
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

async function withShared(run: (fixture: { host: StubHost; dataDir: string; local: (relative: string, content: string) => void; read: (libraryPath: string) => string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-shared-move-links-")));
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
      dataDir,
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

type Moved = { links?: LiberaLinkRewrites };
const linksOf = (payload: unknown) => (payload as Moved).links;

test("S21: links to a moved shared note follow it, through the host, in shared and local notes", () => withShared(async ({ host, local, read }) => {
  host.put("a/other.md", "# Intro\n");
  host.put("a/note.md", "see [other](other.md) and [again](other.md#intro)\n");
  host.put("top.md", "[root](Shared/a/other.md)\n");
  local("Local/n.md", "[shared](Shared/a/other.md)\n");

  const payload = await moveSharedFile("Shared/a/other.md", "Shared", "other.md");

  assert.equal(host.texts.get("a/note.md"), "see [other](../other.md) and [again](../other.md#intro)\n");
  assert.equal(host.texts.get("top.md"), "[root](Shared/other.md)\n");
  assert.deepEqual([...host.edited].sort(), ["a/note.md", "top.md"], "shared text changed only through the host's edits");
  assert.equal(read("Local/n.md"), "[shared](Shared/other.md)\n", "a local note linking in follows on disk");
  assert.deepEqual(linksOf(payload)?.rewritten.map((item) => item.path).sort(), ["Local/n.md", "Shared/a/note.md", "Shared/top.md"]);
  assert.deepEqual(linksOf(payload)?.skipped, []);
  await assertNotebookSound("Shared");
  await assertNotebookSound("Local");
}));

test("S21: a moved shared note's own text is rewritten at its new path, a chart's data file included", () => withShared(async ({ host }) => {
  host.put("a/note.md", "[sibling](sib.md)\n\n```chart\ndata: data.csv\ntype: bar\n```\n");
  host.put("a/sib.md", "sib\n");
  host.put("a/data.csv", "x,y\n1,2\n");
  host.put("b/keep.md", "keep\n");

  const payload = await moveSharedFile("Shared/a/note.md", "Shared/b");

  assert.match(host.texts.get("b/note.md")!, /\[sibling\]\(\.\.\/a\/sib\.md\)/);
  assert.match(host.texts.get("b/note.md")!, /data: \.\.\/a\/data\.csv/);
  assert.deepEqual(linksOf(payload)?.rewritten.map((item) => item.path), ["Shared/b/note.md"]);
  await assertNotebookSound("Shared");
}));

test("S21: a LaTeX dependency of a shared project follows a moved chapter, through the host", () => withShared(async ({ host }) => {
  host.put("paper/main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{chap/one}\n\\end{document}\n");
  host.put("paper/chap/one.tex", "one\n");
  host.put("paper/parts/readme.txt", "x");

  await moveSharedFile("Shared/paper/chap/one.tex", "Shared/paper/parts");

  assert.match(host.texts.get("paper/main.tex")!, /\\input\{parts\/one\}/);
  assert.deepEqual(host.edited, ["paper/main.tex"]);
  await assertNotebookSound("Shared");
}));

test("S21: a folder renamed in a shared notebook is followed by the links into it", () => withShared(async ({ host }) => {
  host.put("sub/n.md", "n\n");
  host.put("top.md", "[in](sub/n.md)\n");

  const payload = await renameSharedFolder("Shared/sub", "renamed");

  assert.equal(host.texts.get("top.md"), "[in](renamed/n.md)\n");
  assert.deepEqual(linksOf(payload)?.rewritten.map((item) => item.path), ["Shared/top.md"]);
  await assertNotebookSound("Shared");
}));

test("S21: a note this account cannot edit is reported as skipped and left as it is; Check Notebook shows the broken link", () => withShared(async ({ host }) => {
  host.put("a/other.md", "# Other\n");
  host.put("a/note.md", "[other](other.md)\n");
  host.role = "viewer";

  const payload = await moveSharedFile("Shared/a/other.md", "Shared");

  assert.equal(host.texts.get("a/note.md"), "[other](other.md)\n");
  assert.deepEqual(host.edited, []);
  assert.deepEqual(linksOf(payload)?.rewritten, []);
  assert.deepEqual(linksOf(payload)?.skipped, [{ path: "Shared/a/note.md", written: "other.md", reason: "read-only" }]);
  const report = await verifyNotebook("Shared");
  assert.ok(report.findings.some((finding) => finding.path === "Shared/a/note.md" && finding.message.includes('"other.md" finds no file')), "the skipped link is the verifier's broken-link finding");
}));

test("S21: a note edited while its links were updated is read again and planned once more; its other edits stay", () => withShared(async ({ host }) => {
  host.put("a/other.md", "# Other\n");
  host.put("a/note.md", "[other](other.md)\n");
  // Reads of the note: 1 is the plan, 2 the apply's, 3 the write's own check. A collaborator types after the apply's read.
  host.afterRead = (relative, count) => { if (relative === "a/note.md" && count === 2) host.type("a/note.md", "[other](other.md)\n\nA collaborator's line.\n"); };

  const payload = await moveSharedFile("Shared/a/other.md", "Shared");

  assert.equal(host.texts.get("a/note.md"), "[other](../other.md)\n\nA collaborator's line.\n");
  assert.deepEqual(linksOf(payload)?.skipped, []);
  await assertNotebookSound("Shared");
}));

test("S21: a note that keeps changing is reported (edited), and the collaborator's text is never overwritten", () => withShared(async ({ host }) => {
  host.put("a/other.md", "# Other\n");
  host.put("a/note.md", "[other](other.md)\n");
  host.afterRead = (relative, count) => {
    if (relative !== "a/note.md") return;
    if (count === 2) host.type("a/note.md", "[other](other.md)\n\nfirst\n");
    if (count === 4) host.type("a/note.md", "[other](other.md)\n\nsecond\n");
  };

  const payload = await moveSharedFile("Shared/a/other.md", "Shared");

  assert.equal(host.texts.get("a/note.md"), "[other](other.md)\n\nsecond\n");
  assert.deepEqual(linksOf(payload)?.skipped, [{ path: "Shared/a/note.md", written: "other.md", reason: "edited" }]);
}));

test("S22: a shared link that would now open the file at the notebook root is rewritten to keep its file", () => withShared(async ({ host }) => {
  host.put("Drafts/photo.png", "sibling");
  host.put("photo.png", "root");
  host.put("Drafts/index.md", "[photo](photo.png)\n");
  host.put("Archive/keep.md", "keep\n");

  const payload = await moveSharedFile("Shared/Drafts/photo.png", "Shared/Archive");

  assert.equal(host.texts.get("Drafts/index.md"), "[photo](../Archive/photo.png)\n");
  assert.deepEqual(linksOf(payload)?.skipped, []);
  await assertNotebookSound("Shared");
}));

test("S22: a shared note moved beside another file of the same name keeps the file its link opened", () => withShared(async ({ host }) => {
  host.put("Drafts/index.md", "[photo](photo.png)\n");
  host.put("Drafts/photo.png", "sibling");
  host.put("Other/photo.png", "other");
  host.put("Other/keep.md", "keep\n");

  await moveSharedFile("Shared/Drafts/index.md", "Shared/Other");

  assert.equal(host.texts.get("Other/index.md"), "[photo](../Drafts/photo.png)\n");
  await assertNotebookSound("Shared");
}));

test("S22: the same holds for a local move", () => withShared(async ({ read, local }) => {
  local("Local/Drafts/photo.png", "sibling");
  local("Local/photo.png", "root");
  local("Local/Drafts/index.md", "[photo](photo.png)\n");
  local("Local/Archive/keep.md", "keep\n");

  await moveFileToDirectory("Local/Drafts/photo.png", "Local/Archive");

  assert.equal(read("Local/Drafts/index.md"), "[photo](../Archive/photo.png)\n");
  await assertNotebookSound("Local");
}));

test("S21: a note the host cannot read as text is reported as not fully checked; the move stands", () => withShared(async ({ host }) => {
  host.put("a/other.md", "# Other\n");
  host.put("a/note.md", "[other](other.md)\n");
  // A blob to the host: its bytes cannot be had from the stub, so the notebook's notes are not all read.
  host.texts.delete("a/note.md");
  host.blobs.add("a/note.md");

  const payload = await moveSharedFile("Shared/a/other.md", "Shared");

  assert.ok(fs.existsSync(path.join(host.root, "other.md")));
  assert.deepEqual(linksOf(payload)?.unchecked, ["Shared"]);
}));

test("battery: every note is read once for a move, and only notes that name a moved item are written", () => withShared(async ({ host }) => {
  host.put("a/other.md", "# Other\n");
  host.put("a/note.md", "[other](other.md)\n");
  host.put("unrelated.md", "no links here\n");
  host.put("unindexed.md", "[other](a/other.md)\n");
  mkdirSync(notebookSystemDirectoryPath("Shared"), { recursive: true });
  const entry = (destinations: string[]) => ({ contentHash: "h", destinations });
  writeFileSync(path.join(notebookSystemDirectoryPath("Shared"), "notebook-links.json"), JSON.stringify({ version: 2, files: { "Shared/a/note.md": entry(["other.md"]), "Shared/unrelated.md": entry(["https://example.com"]), "Shared/a/other.md": entry([]) } }));
  const fetched = new Set<string>();
  host.afterRead = (relative) => { fetched.add(relative); };

  await moveSharedFile("Shared/a/other.md", "Shared");

  // R-C1 (2026-11-25): the lagging link index no longer narrows the search (it missed embeds, anchors, charts and live text), so every note is read once; none of them is written unless it names the moved file.
  assert.ok(fetched.has("unrelated.md"), "a note the index calls unrelated is still read: the index can lag the live text");
  assert.ok(!host.edited.includes("unrelated.md"), "a note that does not name the moved file is not written");
  assert.equal(host.texts.get("a/note.md"), "[other](../other.md)\n");
  assert.equal(host.texts.get("unindexed.md"), "[other](other.md)\n", "a note the index does not know yet is read");
}));
