// Three-way sync audit 2026-11-23, package TD: the owner's takedown export (C5) and PdfMarksRuntime's rename and
// close (H20). The takedown deletes the only server copy: whatever cannot be exported in full stops it.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import * as Y from "yjs";

import { ApiClientError } from "../../electron/collab/core/api-client";
import type { CollabHost } from "../../electron/collab/core/host";
import { ControlError } from "../../electron/collab/control/types";
import { PdfCommentService } from "../../electron/collab/notebooks/pdf-comments";
import { PdfMarksRuntime } from "../../electron/collab/notebooks/pdf-marks";
import { ControlRoutes, type ResolvedPdf } from "../../src/lib/collab/local-api";
import { applyMarksDiff, readAllMarks, visibleMarks } from "../../src/lib/collab/pdf/model";
import { PDF_LIVE_SETTING } from "../../src/lib/collab/protocol/pdf";
import { ManifestKeys, type ManifestEntry } from "../../src/lib/collab/protocol/schema";
import type { ProjectClosingResponse } from "../../src/lib/collab/protocol/api";
import type { PdfAnnotation } from "../../src/lib/types";
import { quietLogger, tempDir } from "./support/host-helpers";
import { closePeer, invite, makePeer, readText, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

const PDF = Buffer.from("%PDF-1.4\n% a paper\n%%EOF\n");
const mark = (id: string) => ({ id, type: "highlight", pageNumber: 1, color: "#fde047", rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: "words", createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" }) as PdfAnnotation;
const sidecarOf = (root: string, file: string) => path.join(root, ".libera", "annotations", "pdf", "by-path", `${file}.json`);

// ------------------------------------------------------------ PdfMarksRuntime (fake host)

function fakeRuntime() {
  const temp = tempDir("libera-audit-1123-pdf-");
  const root = temp.file("notebook");
  mkdirSync(root);
  const imports: Array<{ docId: string; marks: Array<{ id: string }> }> = [];
  const releases: string[] = [];
  const docs = new Map<string, Y.Doc>();
  const hub = {
    getStatus: () => ({ state: "saved-remote" }),
    observe: () => () => {},
    onStatus: () => () => {},
    onRejected: () => () => {},
    getDoc: (name: string) => { if (!docs.has(name)) docs.set(name, new Y.Doc()); return docs.get(name)!; },
    isClosed: false,
    hasOpened: true,
  };
  const host = {
    store: { upsertDoc() {} },
    acquire: () => hub,
    release: (docId: string) => { releases.push(docId); },
    api: { importPdf: async (docId: string, input: { marks: Array<{ id: string }> }) => { imports.push({ docId, marks: input.marks }); } },
  } as unknown as CollabHost;
  const manifest = new Y.Doc();
  manifest.getMap(ManifestKeys.settings).set(PDF_LIVE_SETTING, true);
  const listCalls: Array<{ strict?: boolean } | undefined> = [];
  const runtime = new PdfMarksRuntime({
    host, logger: quietLogger, projectId: "prj_test", notebook: "Notebook", root, writeMs: 60_000,
    role: () => "commenter", canWriteDisk: () => true, guard: () => ({ root, canCommit: async () => true }),
    authorityReady: () => true, recordLive: async () => {}, filesChanged() {}, commentsChanged() {}, manifest: () => manifest,
    listComments: async (_docId, options) => { listCalls.push(options); return []; },
  });
  const sync = (files: Array<{ fileId: string; path: string }>) => {
    const entries: ManifestEntry[] = files.map((file) => ({ fileId: file.fileId, path: file.path, kind: "blob", createdBy: "acc_me", createdAt: 1, updatedAt: 1 }));
    runtime.sync(entries, new Map(files.map((file) => [file.fileId, file.path])));
  };
  return { root, runtime, sync, imports, releases, hub, listCalls, cleanup: async () => { await runtime.stop(); manifest.destroy(); temp.cleanup(); } };
}

describe("PdfMarksRuntime", () => {
  test("H20: a renamed PDF imports the sidecar at its new path", { timeout: 30_000 }, async () => {
    const s = fakeRuntime();
    try {
      writeFileSync(path.join(s.root, "a.pdf"), PDF);
      s.sync([{ fileId: "fil_one", path: "a.pdf" }]);
      assert.ok(s.runtime.resolve("a.pdf"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The PDF moved and brought its notes along, as a synced folder delivers them.
      writeFileSync(path.join(s.root, "b.pdf"), PDF);
      mkdirSync(path.dirname(sidecarOf(s.root, "b.pdf")), { recursive: true });
      writeFileSync(sidecarOf(s.root, "b.pdf"), JSON.stringify({ annotations: [mark("moved-mark")] }));
      s.sync([{ fileId: "fil_one", path: "b.pdf" }]);
      await until(() => s.imports.some((call) => call.marks.some((entry) => entry.id === "moved-mark")), "the new path's sidecar was imported");
    } finally { await s.cleanup(); }
  });

  test("H20: closing twice releases the hub once", { timeout: 30_000 }, async () => {
    const s = fakeRuntime();
    try {
      writeFileSync(path.join(s.root, "a.pdf"), PDF);
      s.sync([{ fileId: "fil_one", path: "a.pdf" }]);
      assert.ok(s.runtime.resolve("a.pdf"));
      // The file leaves the manifest (a close with a final copy under way) while the app stops.
      s.sync([]);
      await s.runtime.stop();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(s.releases.length, 1, "one release for one acquire");
    } finally { await s.cleanup(); }
  });

  test("C5: a damaged existing sidecar is kept aside and the final export is still written", { timeout: 30_000 }, async () => {
    const s = fakeRuntime();
    try {
      writeFileSync(path.join(s.root, "a.pdf"), PDF);
      s.sync([{ fileId: "fil_one", path: "a.pdf" }]);
      assert.ok(s.runtime.resolve("a.pdf"));
      applyMarksDiff(s.hub.getDoc("annotations"), [], [mark("live-mark")], { accountId: "acc_me" }, "local");
      mkdirSync(path.dirname(sidecarOf(s.root, "a.pdf")), { recursive: true });
      writeFileSync(sidecarOf(s.root, "a.pdf"), "{ not json");
      await s.runtime.exportLocal();
      const kept = JSON.parse(readFileSync(sidecarOf(s.root, "a.pdf"), "utf8")) as { annotations: Array<{ id: string }> };
      assert.deepEqual(kept.annotations.map((record) => record.id), ["live-mark"]);
      const rejected = path.join(s.root, ".libera", "collab", "rejected-pdf");
      assert.ok(readdirSync(rejected).some((name) => readFileSync(path.join(rejected, name), "utf8") === "{ not json"), "the damaged text is kept");
      assert.ok(visibleMarks(readAllMarks(s.hub.getDoc("annotations"))).length === 1);
      assert.ok(s.listCalls.every((options) => options?.strict === true), "the takedown export asks for the server's comments strictly");
      assert.ok(s.listCalls.length > 0);
    } finally { await s.cleanup(); }
  });
});

describe("PdfCommentService.list", () => {
  function service(failure: unknown) {
    const hubDoc = new Y.Doc();
    const host = {
      api: { listThreads: async () => { throw failure; } },
      store: { listThreads: () => [], deleteThread() {}, putThread() {} },
      acquire: () => ({ getDoc: () => hubDoc }),
      release() {},
      commands: { list: () => [] },
      commandOutcomes: { failed: () => [] },
    } as unknown as CollabHost;
    return new PdfCommentService(host, () => "acc_me");
  }

  test("C5: a strict list fails on a network error instead of answering from the cache", async () => {
    const offline = new ApiClientError("network", 0, "offline");
    await assert.rejects(() => service(offline).list("doc_pdf", { strict: true }), /offline/);
    assert.deepEqual(await service(offline).list("doc_pdf"), [], "the ordinary list still shows the cache");
  });
});

// ------------------------------------------------------------ SharedProject takedown (real server)

interface Setup { server: ServerProcess; owner: Peer; member: Peer; projectId: string; ownerRoot: string; memberRoot: string; temp: ReturnType<typeof tempRoot>; }
interface PrepareProject {
  prepareLocalConversion(begin: () => Promise<ProjectClosingResponse>, options?: { acceptIncompleteExport?: boolean }): Promise<unknown>;
  pdfs: unknown;
  state: { layout: Record<string, { path: string; docId?: string }> };
  releaseDoc(docId: string): void;
}
interface PdfInternals { docs: Map<string, unknown>; close(doc: unknown, finalWrite: boolean): Promise<void> }

describe("takedown export", () => {
  let setup: Setup;
  before(async () => {
    const temp = tempRoot("libera-audit-1123-takedown-");
    const server = await startServerProcess();
    const ownerAuth = await register(server, "Owner");
    const memberAuth = await register(server, "Member");
    const timings = { pdfWriteMs: 40 };
    const owner = await makePeer(temp.dir, "owner", server, ownerAuth, { timings });
    const member = await makePeer(temp.dir, "member", server, memberAuth, { timings });
    const ownerRoot = path.join(owner.library, "Papers");
    writeTree(ownerRoot, { "paper.pdf": PDF, "note.md": "hello\n", "dir/two.md": "two\n" });
    const shared = await owner.router.call("POST", ControlRoutes.share, { notebook: "Papers" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    const joined = await member.router.call("POST", ControlRoutes.join, { invitation: await invite(server, ownerAuth, projectId, "member@example.test", "editor") });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const memberRoot = path.join(member.library, (joined.body as { notebook: string }).notebook);
    assert.equal((await owner.router.call("POST", ControlRoutes.pdfLive(projectId))).status, 204);
    await until(() => member.service.project(projectId)?.pdfs.enabled === true, "the member sees live PDFs");
    await until(() => existsSync(path.join(memberRoot, "note.md")) && existsSync(path.join(memberRoot, "dir", "two.md")), "the member's files");
    setup = { server, owner, member, projectId, ownerRoot, memberRoot, temp };
  });
  after(async () => {
    await closePeer(setup.owner).catch(() => undefined);
    await closePeer(setup.member).catch(() => undefined);
    await setup.server.stop().catch(() => undefined);
    removeDataDir(setup.server.dataDir);
    setup.temp.cleanup();
  });

  /** Runs the owner's takedown export with `sabotage` applied once the queue is held and the fence is up. */
  async function takedown(sabotage: (project: PrepareProject) => Promise<void> | void) {
    const project = setup.owner.service.project(setup.projectId) as unknown as PrepareProject;
    const api = setup.owner.host.api!;
    try {
      return await project.prepareLocalConversion(async () => { await sabotage(project); return api.closeProject(setup.projectId); });
    } finally { await api.reopenProject(setup.projectId).catch(() => undefined); }
  }

  test("C5: a PDF this device never opened still gets its marks written", { timeout: 60_000 }, async () => {
    const { member, memberRoot, owner, projectId, ownerRoot } = setup;
    const theirs = await member.service.resolvePdf(`${path.basename(memberRoot)}/paper.pdf`) as ResolvedPdf;
    const hub = member.host.acquire(theirs.docId);
    await until(() => hub.getStatus().state === "saved-remote", "the member's PDF opened");
    hub.applyLocalChange("annotations", (doc) => { applyMarksDiff(doc, [], [mark("member-mark")], { accountId: member.auth.account.id }, null); });
    await until(() => hub.getStatus().state === "saved-remote" && hub.pendingCount === 0, "the mark reached the server");
    await takedown(async (project) => {
      // As if the owner's device had missed this PDF's document: nothing open, no sidecar.
      const pdfs = project.pdfs as unknown as PdfInternals;
      for (const doc of [...pdfs.docs.values()]) await pdfs.close(doc, false);
      rmSync(sidecarOf(ownerRoot, "paper.pdf"), { force: true });
    });
    const written = JSON.parse(readFileSync(sidecarOf(ownerRoot, "paper.pdf"), "utf8")) as { annotations: Array<{ id: string }> };
    assert.ok(written.annotations.some((record) => record.id === "member-mark"), "the member's mark is in the owner's copy");
    member.host.release(theirs.docId);
    assert.ok(owner.service.project(projectId));
  });

  test("C5: the latest text is written even when this device lost the document and its disk copy is old", { timeout: 60_000 }, async () => {
    const { member, memberRoot, ownerRoot, projectId } = setup;
    writeFileSync(path.join(memberRoot, "note.md"), "member latest\n");
    await until(() => readText(ownerRoot, "note.md") === "member latest\n", "the owner has the text");
    await takedown((project) => {
      const record = Object.values(project.state.layout).find((item) => item.path === "note.md");
      assert.ok(record?.docId);
      project.releaseDoc(record.docId);
      writeFileSync(path.join(ownerRoot, "note.md"), "stale\n");
    });
    assert.equal(readText(ownerRoot, "note.md"), "member latest\n");
    assert.ok(member.service.project(projectId));
  });

  test("C5: a text document that cannot be written stops the takedown", { timeout: 60_000 }, async () => {
    const { ownerRoot } = setup;
    const outside = mkdtempSync(path.join(tmpdir(), "libera-audit-1123-outside-"));
    try {
      await assert.rejects(
        () => takedown(() => {
          // A symbolic link in the notebook: the write is refused, and the server copy must not be deleted after that.
          renameSync(path.join(ownerRoot, "dir"), path.join(ownerRoot, "dir.moved"));
          symlinkSync(outside, path.join(ownerRoot, "dir"));
        }),
        (error: unknown) => error instanceof ControlError && error.status === 409,
      );
    } finally {
      rmSync(path.join(ownerRoot, "dir"), { force: true });
      renameSync(path.join(ownerRoot, "dir.moved"), path.join(ownerRoot, "dir"));
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
