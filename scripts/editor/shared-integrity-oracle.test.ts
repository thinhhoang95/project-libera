// Regressions for the 2026-11-20 collaboration integrity review, package V (findings S63 to S67): Check Notebook,
// Try to fix and Acknowledge on a shared notebook. The host is a stub that answers the manifest listing, its status
// and a live PDF's marks; the notebook's working copy is a plain folder, as on a follower.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { createMarkdownFileLinkDestination } from "../../src/lib/markdown-file-links";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { verifyNotebook, type IntegrityReport } from "../../src/lib/storage/integrity";
import { reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { imageAnnotationsPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { applyNotebookRepair, planNotebookRepair } from "../../src/lib/storage/repair";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

class StubHost {
  entries: FileListEntry[] = [];
  /** The host's answer to the file list: 200, or another status. */
  listStatus = 200;
  /** Called with each listing (1-based): may change `entries` to simulate a view that moves during the check. */
  onList: ((count: number) => void) | null = null;
  lists = 0;
  connection: "connected" | "offline" = "connected";
  reconcilePending = 0;
  statusAvailable = true;
  /** Ids of the live PDF's marks; null: the snapshot fails. */
  marks: string[] | null = [];
  snapshots = 0;
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
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) {
          this.lists += 1;
          this.onList?.(this.lists);
          return this.listStatus === 200 ? send(200, { entries: this.entries }) : send(this.listStatus, { error: { code: "offline", message: "The notebook's file list has not loaded yet." } });
        }
        if (url.pathname === "/status") {
          if (!this.statusAvailable) return send(503, { error: { code: "offline", message: "No status." } });
          return send(200, { hostVersion: 1, connection: this.connection, account: null, pendingCommands: 0, projects: [{ projectId: "prj_test", name: "Shared", role: "owner", notebook: "Shared", revoked: false, reconcilePending: this.reconcilePending }] });
        }
        if (url.pathname === "/pdf-docs/resolve") return send(200, { docId: "doc_pdf", projectId: "prj_test", fileId: "fil_pdf", path: "Shared/p.pdf", role: "owner", readOnly: false, accountId: "acc_me" });
        if (url.pathname === "/pdf-docs/doc_pdf/snapshot") {
          this.snapshots += 1;
          return this.marks ? send(200, { marks: this.marks.map((id) => ({ id })) }) : send(503, { error: { code: "offline", message: "Not loaded." } });
        }
        return send(404, { error: { code: "not-found", message: "No route." } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() { await new Promise<void>((resolve) => this.server?.close(() => resolve())); }
}

const OLD = 1;
const entry = (relative: string, extra: Partial<FileListEntry> = {}): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind: "doc", updatedAt: OLD, ...extra });

async function withShared(options: { pdfLive?: boolean }, run: (fixture: { host: StubHost; root: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-shared-oracle-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const root = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString(), ...(options.pdfLive ? { pdfLive: true } : {}) }));
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

const of = (report: IntegrityReport, check: string) => report.findings.filter((finding) => finding.check === check);
const codes = (report: IntegrityReport, check: string) => of(report, check).map((finding) => `${finding.severity}:${finding.code}:${finding.path}`).sort();
const status = (report: IntegrityReport, check: string) => report.checks.find((item) => item.id === check)?.status;

test("S63: manifest-only, disk-only and differing files, with sync lag told from real gaps", () => withShared({}, async ({ host, root }) => {
  put(path.join(root, "here.md"), "here\n");
  put(path.join(root, "extra.md"), "extra\n");
  put(path.join(root, "pic.png"), "12345");
  host.entries = [entry("here.md"), entry("late.md"), entry("pic.png", { kind: "blob", blobHash: "a".repeat(64), size: 99 })];

  const report = await verifyNotebook("Shared");
  assert.deepEqual(codes(report, "sharing"), [
    "info:sharedFileNotListed:Shared/extra.md",
    "warning:sharedFileDiffers:Shared/pic.png",
    "warning:sharedFileMissingHere:Shared/late.md",
  ]);
  assert.equal(status(report, "sharing"), "findings", "the host answered, so the comparison was made");
  assert.equal(host.lists, 2, "one listing for the comparison and one to see that it held still");

  host.connection = "offline";
  assert.deepEqual(codes(await verifyNotebook("Shared"), "sharing"), [
    "info:sharedFileArriving:Shared/late.md",
    "info:sharedFileArriving:Shared/pic.png",
    "info:sharedFileNotListed:Shared/extra.md",
  ], "while the host is not connected the gaps are sync still bringing the files");

  host.connection = "connected";
  host.statusAvailable = false;
  const unknown = await verifyNotebook("Shared");
  assert.equal(status(unknown, "sharing"), "incomplete", "a gap that can't be told from lag makes the check partial");
  assert.equal(unknown.completeness, "partial");
}));

test("S63: no host answer, or a view that changes during the check, is partial and never passes; records of files only the host lists are not called missing", () => withShared({}, async ({ host, root }) => {
  put(path.join(root, "kept.md"), "kept\n");
  host.entries = [entry("kept.md"), entry("sub/arriving.md")];
  await setStarredFilePath("Shared/sub/arriving.md", true);
  await setStarredFilePath("Shared/gone.md", true);

  let report = await verifyNotebook("Shared");
  assert.deepEqual(codes(report, "records"), ["warning:starredFileMissing:Shared/gone.md"], "a star of a listed file that has not arrived is not missing; one the manifest lacks is");
  assert.ok(of(report, "records")[0].clear?.length, "a confirmed obsolete local record can be acknowledged");

  host.listStatus = 503;
  report = await verifyNotebook("Shared");
  assert.equal(report.completeness, "partial");
  assert.equal(status(report, "sharing"), "incomplete");
  assert.equal(status(report, "records"), "incomplete");
  assert.deepEqual(codes(report, "records"), []);
  assert.ok(report.findings.every((finding) => !finding.clear), "with no manifest nothing is offered for removal");

  host.listStatus = 200;
  host.onList = (count) => { if (count % 2 === 0) host.entries = [entry("kept.md")]; };
  host.lists = 0;
  report = await verifyNotebook("Shared");
  assert.equal(status(report, "sharing"), "incomplete", "the list changed between the two readings");
  assert.ok(report.findings.every((finding) => !finding.clear && finding.repairable === false));
  assert.equal(host.lists, 2, "no retry loop");
}));

test("S64: a live PDF's marks come from the live document; unknown is partial; one snapshot per PDF", () => withShared({ pdfLive: true }, async ({ host, root }) => {
  put(path.join(root, "p.pdf"), "%PDF-1");
  put(path.join(root, "b.md"), "placeholder\n");
  const link = (id: string) => createMarkdownFileLinkDestination({ sourcePath: "Shared/b.md", targetPath: "Shared/p.pdf", metadata: { v: 1, fileType: "pdf", viewState: { pdf: { selectedAnnotationId: id } } } });
  put(path.join(root, "b.md"), `[a](${link("live-1")}) [b](${link("live-1")}) [c](${link("removed")})\n`);
  host.entries = [entry("p.pdf", { kind: "blob", blobHash: "b".repeat(64), size: 6 }), entry("b.md")];
  // A stale sidecar that still has the removed mark and lacks the live one.
  put(pdfAnnotationsPath("Shared", ["p.pdf"]), JSON.stringify({ annotations: [{ id: "removed", type: "highlight", page: 1, rects: [{ x: 0, y: 0, width: 1, height: 1 }], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }));
  host.marks = ["live-1"];

  let report = await verifyNotebook("Shared");
  assert.deepEqual(of(report, "links").map((finding) => finding.code), ["linkAnnotationGone"]);
  assert.match(of(report, "links")[0].message, /removed|annotation/);
  assert.equal(host.snapshots, 1, "one snapshot for the PDF, however many links point into it");

  host.marks = null;
  report = await verifyNotebook("Shared");
  assert.equal(status(report, "links"), "incomplete", "marks that can't be had are partial, never read from the lagging sidecar");
  assert.deepEqual(of(report, "links"), []);
}));

test("S65: the check promises no reattachment the shared upkeep skips, and the upkeep agrees", () => withShared({}, async ({ host, root }) => {
  const bytes = Buffer.from("%PDF-1 same bytes");
  put(path.join(root, "new", "paper.pdf"), bytes);
  const { createHash } = await import("node:crypto");
  const identity = { size: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") };
  put(pdfAnnotationsPath("Shared", ["old", "paper.pdf"]), JSON.stringify({ annotations: [], source: identity }));
  host.entries = [entry("new/paper.pdf", { kind: "blob", blobHash: identity.contentHash, size: bytes.length })];

  const report = await verifyNotebook("Shared");
  assert.deepEqual(of(report, "sidecars").map((finding) => finding.code), ["orphanSideFile"], "no 'goes to it the next time' for a shared notebook");
  const result = await reconcilePdfSidecars("Shared", [{ path: "Shared/new/paper.pdf", size: bytes.length }], { now: Date.now() + 10 * 60_000 });
  assert.deepEqual(result, { reattached: 0, setAside: 0 }, "the upkeep does what the check said");
  assert.ok(fs.existsSync(pdfAnnotationsPath("Shared", ["old", "paper.pdf"])));
}));

test("S66: Try to fix pairs this computer's records with the one file of the name the host lists, and refuses the rest", () => withShared({}, async ({ host, root }) => {
  put(path.join(root, "b", "photo.png"), "png");
  host.entries = [entry("b/photo.png", { kind: "blob", blobHash: "c".repeat(64), size: 3 })];
  put(imageAnnotationsPath("Shared", ["a", "photo.png"]), JSON.stringify({ annotations: [] }));
  await setFileTagsForPath("Shared/a/photo.png", ["draft"]);
  put(path.join(root, ".libera", "ink", "a", "photo.png", "x"), "ink");

  const report = await verifyNotebook("Shared");
  assert.ok(of(report, "records").some((finding) => finding.repairable === true), "the report offers Try to fix for a tag it can pair");

  const plan = await planNotebookRepair("Shared");
  assert.equal(plan.moves.length, 1);
  assert.deepEqual([plan.moves[0].from, plan.moves[0].to], ["Shared/a/photo.png", "Shared/b/photo.png"]);
  assert.ok(plan.moves[0].records.includes("tags"));

  // The old path comes back in the manifest before the apply: nothing is paired.
  host.entries = [...host.entries, entry("a/photo.png")];
  await assert.rejects(applyNotebookRepair("Shared", plan.token), /changed|confirm/);
  assert.deepEqual((await readWorkspaceMetadata()).fileTags["Shared/a/photo.png"], ["draft"]);
  host.entries = [entry("b/photo.png", { kind: "blob", blobHash: "c".repeat(64), size: 3 })];

  const fresh = await planNotebookRepair("Shared");
  const result = await applyNotebookRepair("Shared", fresh.token);
  assert.equal(result.moved.length, 1);
  assert.deepEqual((await readWorkspaceMetadata()).fileTags["Shared/b/photo.png"], ["draft"]);
  assert.ok(fs.existsSync(imageAnnotationsPath("Shared", ["b", "photo.png"])));

  // Fail closed when the host can't say.
  host.listStatus = 503;
  await assert.rejects(planNotebookRepair("Shared"), /can't confirm/);
}));

test("S67: Acknowledge removes this computer's obsolete records on a confirmed manifest and nothing else", () => withShared({}, async ({ host, root }) => {
  put(path.join(root, "keep.md"), "keep\n");
  host.entries = [entry("keep.md"), entry("sub/arriving.md")];
  await setFileTagsForPath("Shared/gone.md", ["old"]);
  await setStarredFilePath("Shared/gone2.md", true);
  await setFileTagsForPath("Shared/sub/arriving.md", ["new"]);
  // Host-owned leftovers are never offered.
  put(path.join(root, "_assets", "gone.py"), "print(1)\n");

  const plan = await planNotebookCleanup("Shared");
  assert.deepEqual(plan.items.map((item) => item.path).sort(), ["Shared/gone.md", "Shared/gone2.md"], "a record awaiting delivery and host-owned code are not offered");
  const result = await applyNotebookCleanup("Shared", plan.token);
  assert.equal(result.outcomes.removed, 2);
  const metadata = await readWorkspaceMetadata();
  assert.equal(metadata.fileTags["Shared/gone.md"], undefined);
  assert.deepEqual(metadata.fileTags["Shared/sub/arriving.md"], ["new"]);
  assert.ok(fs.existsSync(path.join(root, "_assets", "gone.py")));

  // Fail closed: a host that can't confirm removes nothing.
  await setFileTagsForPath("Shared/gone3.md", ["old"]);
  const again = await planNotebookCleanup("Shared");
  host.listStatus = 503;
  await assert.rejects(applyNotebookCleanup("Shared", again.token), /can't confirm|changed/);
  assert.deepEqual((await readWorkspaceMetadata()).fileTags["Shared/gone3.md"], ["old"]);
}));
