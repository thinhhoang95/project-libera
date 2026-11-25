// Regressions for the 2026-11-25 file-moving review, package O1 (the check itself): O-H2, O-H4, O-M2 (the rest), O-M3.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { filePathFromParts } from "../../src/lib/storage/paths";
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { verifyNotebook, type IntegrityReport } from "../../src/lib/storage/integrity";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { linkIndexPath } from "../../src/lib/storage/notebook-links";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { citationIndexPath, CITATION_INDEX_VERSION } from "../../src/lib/storage/reference-citations";
import { assertNotebookSound, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

class StubHost {
  entries: FileListEntry[] = [];
  connection: "connected" | "offline" = "connected";
  reconcilePending = 0;
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  async start() {
    this.server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        const send = (status: number, payload: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
        if (request.headers.authorization !== `Bearer ${this.token}`) return send(404, { error: { code: "not-found", message: "No route." } });
        const url = new URL(request.url ?? "", "http://host");
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) return send(200, { entries: this.entries });
        if (url.pathname === "/status") return send(200, { hostVersion: 1, connection: this.connection, account: null, pendingCommands: 0, projects: [{ projectId: "prj_test", name: "Shared", role: "owner", notebook: "Shared", revoked: false, reconcilePending: this.reconcilePending }] });
        return send(404, { error: { code: "not-found", message: "No route." } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() { await new Promise<void>((resolve) => this.server?.close(() => resolve())); }
}

const OLD = 1;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const entry = (relative: string, extra: Partial<FileListEntry> = {}): FileListEntry => ({ fileId: `fil_${relative.replace(/\W/g, "_")}`, path: relative, kind: "doc", updatedAt: OLD, ...extra });

async function withShared(run: (fixture: { host: StubHost; root: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-o1-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const root = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost();
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  mock.method(fs, "watch", () => new Watcher());
  try {
    await createNotebook("Local");
    await run({ host, root });
  } finally {
    mock.restoreAll();
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function put(file: string, text: string | Buffer = "x") {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** The host's bookkeeping file (`.libera/collab/state.json`): what it last wrote for each file, and the reconciliations it holds open. */
function hostState(root: string, layout: Record<string, { path: string; kind: "doc" | "blob"; hash?: string; size?: number; mtimeMs?: number }>, reconciliations: Array<{ path: string }> = []) {
  put(path.join(root, ".libera", "collab", "state.json"), JSON.stringify({ version: 1, layout, reconciliations }));
}

const codes = (report: IntegrityReport, check: string) => report.findings.filter((finding) => finding.check === check).map((finding) => `${finding.severity}:${finding.code}:${finding.path}`).sort();
const old = (file: string) => { const time = new Date(Date.now() - 3 * 60 * 60 * 1000); utimesSync(file, time, time); return time.getTime(); };

test("O-H2: an empty working copy of a document the host wrote text to is reported", () => withShared(async ({ host, root }) => {
  const file = path.join(root, "doc.md");
  put(file, "");
  const mtimeMs = old(file);
  host.entries = [entry("doc.md")];
  hostState(root, { [host.entries[0].fileId]: { path: "doc.md", kind: "doc", hash: HASH_A, size: 12, mtimeMs } });
  assert.deepEqual(codes(await verifyNotebook("Shared"), "sharing"), ["warning:sharedFileEmpty:Shared/doc.md"]);
}));

test("O-H2: a same-size blob that is not the version the host wrote is reported, and an unchanged one is not", () => withShared(async ({ host, root }) => {
  const stale = path.join(root, "stale.png");
  const fine = path.join(root, "fine.png");
  put(stale, "12345");
  put(fine, "12345");
  const staleTime = old(stale);
  const fineTime = old(fine);
  host.entries = [entry("stale.png", { kind: "blob", blobHash: HASH_B, size: 5 }), entry("fine.png", { kind: "blob", blobHash: HASH_B, size: 5 })];
  hostState(root, {
    [host.entries[0].fileId]: { path: "stale.png", kind: "blob", hash: HASH_A, size: 5, mtimeMs: staleTime },
    [host.entries[1].fileId]: { path: "fine.png", kind: "blob", hash: HASH_B, size: 5, mtimeMs: fineTime },
  });
  assert.deepEqual(codes(await verifyNotebook("Shared"), "sharing"), ["warning:sharedFileReplaced:Shared/stale.png"]);
  // The host wrote this version, and the bytes were changed (the time moved) since.
  utimesSync(fine, new Date(), new Date(Date.now() - 60 * 60 * 1000));
  assert.deepEqual(codes(await verifyNotebook("Shared"), "sharing"), ["warning:sharedFileReplaced:Shared/fine.png", "warning:sharedFileReplaced:Shared/stale.png"]);
}));

test("O-H2: one unrelated open reconciliation does not excuse every gap", () => withShared(async ({ host, root }) => {
  put(path.join(root, "held.md"), "held");
  host.entries = [entry("held.md"), entry("gone.md"), entry("held-too.md")];
  host.reconcilePending = 1;
  hostState(root, {}, [{ path: "Shared/held-too.md" }]);
  assert.deepEqual(codes(await verifyNotebook("Shared"), "sharing"), [
    "info:sharedFileArriving:Shared/held-too.md",
    "warning:sharedFileMissingHere:Shared/gone.md",
  ], "only the file the reconciliation names is held; the other missing file is a real gap");
}));

test("O-H2: without the host's records the notebook-wide reading of a pending reconciliation stays", () => withShared(async ({ host }) => {
  host.entries = [entry("gone.md")];
  host.reconcilePending = 1;
  assert.deepEqual(codes(await verifyNotebook("Shared"), "sharing"), ["info:sharedFileArriving:Shared/gone.md"]);
}));

test("O-H2: a folder the manifest lists but this computer lacks is reported", () => withShared(async ({ host }) => {
  host.entries = [entry("Starred", { kind: "folder", fileId: "fol_starred" })];
  assert.deepEqual(codes(await verifyNotebook("Shared"), "sharing"), ["warning:sharedFolderMissingHere:Shared/Starred"]);
  host.connection = "offline";
  assert.deepEqual(codes(await verifyNotebook("Shared"), "sharing"), ["info:sharedFileArriving:Shared/Starred"]);
}));

test("O-H4: assertNotebookSound fails on a leftover note by default, and a test that expects it names it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/n.md", "# Note\n");
  const upload = await writeMarkdownImageAsset("Nb/n.md", new File(["photo-bytes"], "photo.png"));
  await writeLibraryFile("Nb/n.md", `# Note\n\n${upload.markdown}\n`);
  await assertNotebookSound("Nb");
  // The note is gone (moved away) and its upload stayed: an image no note shows, an info finding.
  await rm(filePathFromParts("Nb", ["n.md"]));
  await assert.rejects(() => assertNotebookSound("Nb"), /imageUnused|imageLeftBehind/);
  await assertNotebookSound("Nb", { allow: ["imageUnused"] });
}));

test("O-M2: a corrupt link or citation index is reported on an empty notebook", () => withTemporaryLibrary(["Nb"], async () => {
  await writeAt(linkIndexPath("Nb"), "{ not json");
  await writeAt(citationIndexPath("Nb"), "[1, 2");
  const report = await verifyNotebook("Nb");
  assert.deepEqual(report.findings.filter((finding) => finding.code === "indexCorrupt").map((finding) => finding.params?.index).sort(), ["citation index", "link index"]);
}));

test("O-M2: a heading anchor into a note of another notebook is checked", () => withTemporaryLibrary(["Nb", "Other"], async () => {
  await writeLibraryFile("Other/b.md", "# Real heading\n");
  await writeLibraryFile("Nb/a.md", "[good](../Other/b.md#real-heading) and [bad](../Other/b.md#no-such-heading)\n");
  const report = await verifyNotebook("Nb");
  assert.deepEqual(report.findings.filter((finding) => finding.check === "links").map((finding) => finding.code), ["linkHeadingMissingInFile"]);
}));

test("O-M2: notes under node_modules are read in a notebook that is not a linked folder", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/node_modules/pkg/readme.md", "[x](missing-file.md)\n");
  const report = await verifyNotebook("Nb");
  assert.deepEqual(report.findings.filter((finding) => finding.code === "linkNoFile").map((finding) => finding.path), ["Nb/node_modules/pkg/readme.md"]);
}));

test("O-M3: a note in a nested _archive folder is outside the citation index, as reference-citations.ts has it", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/sub/_archive/old.md", "# Old\n");
  await writeAt(citationIndexPath("Nb"), JSON.stringify({ version: CITATION_INDEX_VERSION, files: {} }));
  const report = await verifyNotebook("Nb");
  assert.deepEqual(report.findings.filter((finding) => finding.code === "citationIndexOutOfDate"), []);
}));

test("O-M3: the walk of notes counts every entry against the budget", () => withTemporaryLibrary(["Nb"], async () => {
  for (let index = 0; index < 30; index += 1) await writeLibraryFile(`Nb/data/file-${index}.bin`, "x");
  const report = await verifyNotebook("Nb", { limits: { entries: 20 } });
  assert.ok(report.statistics.entriesVisited > 20, "non-Markdown entries are counted");
  assert.equal(report.completeness, "partial");
}));
