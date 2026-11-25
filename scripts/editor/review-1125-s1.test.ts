// Package S1 of the 2026-11-25 file-moving round: a shared notebook's authority in Check Notebook, Try to fix and
// Acknowledge (O-C1, O-H1, E-H5, E-M4, O-M1, O-M2 for shared folders). Whether a path is judged against the manifest
// or the disk depends on the path (`isSharedNotebookPath`), not on the notebook being checked.

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
import { bibTetherStatePath } from "../../src/lib/references/bib-tether";
import { applyNotebookCleanup, planNotebookCleanup } from "../../src/lib/storage/cleanup";
import { sharedMayClear, verifyNotebook, type IntegrityReport } from "../../src/lib/storage/integrity";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { planNotebookRepair } from "../../src/lib/storage/repair";
import { readWorkspaceMetadata, setFileTagsForPath, setStarredFilePath } from "../../src/lib/storage/workspace-metadata";
import { assertNotebookSound, writeAt, writeReferenceLibrary } from "./notebook-test-helpers";

class Watcher extends EventEmitter { close() { /* nothing watched */ } }

class StubHost {
  entries: FileListEntry[] = [];
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
        if (url.pathname === "/status") return send(200, { hostVersion: 1, connection: "connected", account: null, pendingCommands: 0, projects: [{ projectId: "prj_test", name: "Shared", role: "owner", notebook: "Shared", revoked: false, reconcilePending: 0 }] });
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
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-review1125-s1-")));
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

test("O-C1: a displaced file in Shared/_archive is judged on the disk by the check, Try to fix and Acknowledge", () => withShared({}, async ({ host, root }) => {
  put(path.join(root, "paper.pdf"), "%PDF-1.4 collaborator");
  put(path.join(root, "_archive", "paper.pdf"), "%PDF-1.4 mine");
  put(path.join(root, "_archive", "note.md"), "mine\n");
  host.entries = [entry("paper.pdf", { kind: "blob", blobHash: "a".repeat(64), size: 21 })];
  await setStarredFilePath("Shared/_archive/note.md", true);
  await setFileTagsForPath("Shared/_archive/paper.pdf", ["mine"]);
  put(pdfAnnotationsPath("Shared", ["_archive", "paper.pdf"]), JSON.stringify({ annotations: [] }));

  const report = await verifyNotebook("Shared");
  assert.deepEqual(codes(report, "records"), [], "stars and tags of an intact archived file are not missing");
  assert.deepEqual(codes(report, "sidecars").filter((code) => code.includes("_archive")), [], "its side files are not orphaned");

  const repair = await planNotebookRepair("Shared");
  assert.deepEqual(repair.moves, [], "its records are not paired onto the collaborator's file of the same name");
  assert.deepEqual(repair.unmatched.filter((item) => item.from.includes("_archive")), []);

  const cleanup = await planNotebookCleanup("Shared");
  assert.deepEqual(cleanup.items.filter((item) => item.path.includes("_archive")), [], "nothing of the archived file is offered for deletion");
  assert.deepEqual((await readWorkspaceMetadata()).fileTags["Shared/_archive/paper.pdf"], ["mine"]);

  await assertNotebookSound("Shared");
}));

test("O-C1: an archived file really gone is still reported, and Acknowledge removes its records", () => withShared({}, async ({ host }) => {
  host.entries = [entry("keep.md")];
  await setFileTagsForPath("Shared/_archive/vanished.md", ["old"]);
  const report = await verifyNotebook("Shared");
  assert.deepEqual(codes(report, "records"), ["warning:taggedFileMissing:Shared/_archive/vanished.md"]);
  const plan = await planNotebookCleanup("Shared");
  assert.deepEqual(plan.items.map((item) => item.path), ["Shared/_archive/vanished.md"]);
  const result = await applyNotebookCleanup("Shared", plan.token);
  assert.equal(result.outcomes.removed, 1);
}));

test("O-H1: a manifest name matches under the name rule, and Acknowledge does not delete through an OS alias", () => withShared({}, async ({ host, root }) => {
  put(path.join(root, "Paper.md"), "p\n");
  host.entries = [entry("Paper.md")];
  // The record is spelled by case only: the same name under the round's rule.
  await setStarredFilePath("Shared/paper.md", true);
  const report = await verifyNotebook("Shared");
  assert.deepEqual(codes(report, "records"), [], "a case alias of a listed file is not missing");

  // The manifest no longer lists it, and the disk opens `paper.md` for the live `Paper.md` (case-insensitive disks only).
  host.entries = [];
  await setFileTagsForPath("Shared/paper.md", ["keep"]);
  const insensitive = fs.existsSync(path.join(root, "PAPER.MD"));
  const plan = await planNotebookCleanup("Shared");
  if (!plan.items.length) return;
  const result = await applyNotebookCleanup("Shared", plan.token);
  const tags = (await readWorkspaceMetadata()).fileTags["Shared/paper.md"];
  if (insensitive) assert.deepEqual(tags, ["keep"], "the live file's records are kept through the alias");
  assert.equal(result.outcomes.removed > 0, !insensitive);
}));

test("E-H5: an attachment in another notebook is judged on the disk, not against the shared manifest", () => withShared({}, async ({ host, root }) => {
  host.entries = [entry("keep.md")];
  put(path.join(root, "keep.md"), "k\n");
  // The local file is spelled by case only: the disk opens it for the attachment's name (case-insensitive disks), the exact listing does not have it.
  await writeAt(path.join(path.dirname(root), "Local", "paper.pdf"), "%PDF-1.4 here");
  const insensitive = fs.existsSync(path.join(path.dirname(root), "Local", "PAPER.PDF"));
  await writeReferenceLibrary("Shared", [{ key: "smith", attachments: ["Local/Paper.pdf", "Local/absent.pdf"] }]);
  const plan = await planNotebookCleanup("Shared");
  assert.ok(plan.items.some((item) => item.path === "Local/absent.pdf"), "an attachment missing on the disk is offered");
  const result = await applyNotebookCleanup("Shared", plan.token);
  const library = JSON.parse(fs.readFileSync(path.join(root, ".libera", "references", "library.json"), "utf8"));
  const kept = (Object.values(library.entries)[0] as { attachments: { path: string }[] }).attachments.map((attachment) => attachment.path);
  assert.ok(!kept.includes("Local/absent.pdf"), "the missing one is detached");
  if (insensitive) assert.ok(kept.includes("Local/Paper.pdf"), "a local attachment the disk opens under another spelling is held, not detached through the alias");
  assert.ok(result.outcomes.removed >= 1);
}));

test("E-M4: Acknowledge is not offered the set-aside live PDF marks and ink that Try to fix refuses", () => withShared({ pdfLive: true }, async () => {
  assert.equal(sharedMayClear({ type: "set-aside", file: "annotations/1-a.json" }, "Shared"), false);
  assert.equal(sharedMayClear({ type: "set-aside", file: "ink/abc/record.json" }, "Shared"), false);
  assert.equal(sharedMayClear({ type: "set-aside", file: "outline/1-a.json" }, "Shared"), true);
}));

test("E-M4: without live PDFs the set-aside annotations are this computer's", () => withShared({}, async () => {
  assert.equal(sharedMayClear({ type: "set-aside", file: "annotations/1-a.json" }, "Shared"), true);
  assert.equal(sharedMayClear({ type: "set-aside", file: "ink/abc/record.json" }, "Shared"), false);
}));

test("O-M1: the shared .bib tether follows the manifest, and what it reports can be cleared", () => withShared({}, async ({ host, root }) => {
  host.entries = [entry("keep.md"), entry("refs.bib")];
  put(path.join(root, "keep.md"), "k\n");
  await writeAt(bibTetherStatePath("Shared"), JSON.stringify({ version: 1, target: { kind: "notebook", path: "refs.bib" }, dialect: "bibtex", tetheredAt: new Date().toISOString(), prefer: "library", base: null, status: { state: "synced", warnings: [] } }));

  // Listed but not delivered yet: arriving, not missing.
  assert.deepEqual(codes(await verifyNotebook("Shared"), "references"), [], "an arriving shared .bib is not a false positive");

  // Retired by the host while a copy stays on the disk: reported, and Acknowledge can clear it.
  host.entries = [entry("keep.md")];
  put(path.join(root, "refs.bib"), "@article{a}\n");
  const report = await verifyNotebook("Shared");
  assert.deepEqual(codes(report, "references"), ["warning:tetherFileMissing:Shared/refs.bib"]);
  assert.ok(of(report, "references")[0].clear?.length, "it is clearable");
  const plan = await planNotebookCleanup("Shared");
  assert.equal(plan.items.length, 1);
}));

test("O-M2: a starred or tagged folder in a shared notebook is checked against the manifest's folders, and the disk for local ones", () => withShared({}, async ({ host, root }) => {
  host.entries = [entry("docs", { kind: "folder" }), entry("docs/a.md")];
  put(path.join(root, "docs", "a.md"), "a\n");
  mkdirSync(path.join(root, "mine"), { recursive: true });
  await setStarredFilePath("Shared/docs", true);
  await setFileTagsForPath("Shared/mine", ["local-only"]);
  assert.deepEqual(codes(await verifyNotebook("Shared"), "records"), []);
  await setStarredFilePath("Shared/nowhere", true);
  assert.deepEqual(codes(await verifyNotebook("Shared"), "records"), ["warning:starredFileMissing:Shared/nowhere"]);
}));
