import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as Y from "yjs";
import { CollabHost } from "../../electron/collab/core/host";
import { PdfCommentService } from "../../electron/collab/notebooks/pdf-comments";
import { PdfMarksRuntime } from "../../electron/collab/notebooks/pdf-marks";
import type { Thread } from "../../src/lib/collab/protocol/api";
import { ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { PDF_LIVE_SETTING } from "../../src/lib/collab/protocol/pdf";
import { quietLogger, tempDir } from "./support/host-helpers";

// Sync audit 2026-11-19, findings 15 and 41 (live PDF runtime).

type RuntimeInternals = {
  keepRejected(doc: unknown, text: string): Promise<boolean>;
  sidecarBelongsToPdf(doc: unknown, sidecar: unknown, sidecarFile: string): Promise<boolean | null>;
};

function withRuntime(run: (runtime: RuntimeInternals, root: string) => Promise<void>) {
  return async () => {
    const temp = tempDir("libera-audit-1119-pdf-");
    const root = temp.file("notebook");
    mkdirSync(root);
    const host = new CollabHost({ dbPath: temp.file("host.sqlite"), appVersion: "test", installationId: "audit-1119", logger: quietLogger, compaction: false });
    host.start();
    const manifest = new Y.Doc();
    manifest.getMap(ManifestKeys.settings).set(PDF_LIVE_SETTING, true);
    const runtime = new PdfMarksRuntime({ host, logger: quietLogger, projectId: "prj_test", notebook: "Notebook", root, writeMs: 60_000,
      role: () => "commenter", canWriteDisk: () => true, guard: () => ({ root, canCommit: async () => true }),
      authorityReady: () => true, recordLive: async () => {}, filesChanged() {}, commentsChanged() {}, manifest: () => manifest });
    try { await run(runtime as unknown as RuntimeInternals, root); }
    finally { await runtime.stop(); await host.stop(); manifest.destroy(); temp.cleanup(); }
  };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const doc = { fileId: "fil_pdf", docId: "doc_pdf", path: "paper.pdf" };

test("finding 41: the recovery backup is not rewritten when its content-addressed file exists", withRuntime(async (runtime, root) => {
  const text = JSON.stringify({ annotations: [] });
  assert.equal(await runtime.keepRejected(doc, text), true);
  const kept = path.join(root, ".libera", "collab", "rejected-pdf", `fil_pdf-${sha(text)}.json`);
  const old = new Date(2020, 0, 1);
  utimesSync(kept, old, old);
  assert.equal(await runtime.keepRejected(doc, text), true);
  assert.equal(statSync(kept).mtimeMs, old.getTime(), "an existing backup is left untouched");
}));

test("finding 41: the thread cache writes only the threads that changed", async () => {
  const stored = new Map<string, string>();
  let writes = 0;
  const thread = (id: string, updatedAt: string) => ({ id, docId: "doc_pdf", anchorId: `anc_${id}`, quote: "q", status: "open", messages: [], updatedAt, suggestionIds: [] } as unknown as Thread);
  let server = [thread("a", "1"), thread("b", "1")];
  const host = {
    api: { listThreads: async () => server },
    store: {
      listThreads: () => [...stored].map(([threadId, json]) => ({ threadId, docId: "doc_pdf", json: JSON.parse(json) as unknown, updatedAt: 0 })),
      putThread: (threadId: string, _docId: string, json: unknown) => { writes += 1; stored.set(threadId, JSON.stringify(json)); },
      deleteThread: (threadId: string) => { stored.delete(threadId); },
    },
    acquire: () => ({ getDoc: () => new Y.Doc() }),
    release: () => {},
    commands: { list: () => [] },
    commandOutcomes: { failed: () => [] },
  } as unknown as CollabHost;
  const service = new PdfCommentService(host, () => "acc_me");
  await service.list("doc_pdf");
  assert.equal(writes, 2, "the first list fills the cache");
  await service.list("doc_pdf");
  assert.equal(writes, 2, "an unchanged list writes nothing");
  server = [thread("a", "1"), thread("b", "2")];
  await service.list("doc_pdf");
  assert.equal(writes, 3, "only the changed thread is written");
});

test("finding 15: a sidecar recording other PDF bytes does not belong to the PDF", withRuntime(async (runtime, root) => {
  writeFileSync(path.join(root, "paper.pdf"), "the new PDF");
  const sidecarFile = path.join(root, "side.json");
  writeFileSync(sidecarFile, "{}");
  const source = (text: string) => ({ source: { size: text.length, contentHash: sha(text) } });
  assert.equal(await runtime.sidecarBelongsToPdf(doc, { annotations: [], ...source("the old PDF") }, sidecarFile), false, "another PDF's notes");
  assert.equal(await runtime.sidecarBelongsToPdf(doc, { annotations: [], ...source("the new PDF") }, sidecarFile), true, "the same PDF's notes");
  assert.equal(await runtime.sidecarBelongsToPdf(doc, { annotations: [], sharedCopy: "doc_pdf", ...source("the old PDF") }, sidecarFile), true, "this runtime's own copy");
}));

test("finding 15: a legacy sidecar without a hash is imported only if it is not older than the PDF", withRuntime(async (runtime, root) => {
  const pdf = path.join(root, "paper.pdf");
  const sidecarFile = path.join(root, "side.json");
  writeFileSync(pdf, "pdf");
  writeFileSync(sidecarFile, "{}");
  const early = new Date(2024, 0, 1);
  const late = new Date(2025, 0, 1);
  utimesSync(sidecarFile, early, early);
  utimesSync(pdf, late, late);
  assert.equal(await runtime.sidecarBelongsToPdf(doc, { annotations: [] }, sidecarFile), false, "written before this PDF existed");
  utimesSync(sidecarFile, late, late);
  utimesSync(pdf, early, early);
  assert.equal(await runtime.sidecarBelongsToPdf(doc, { annotations: [] }, sidecarFile), true, "written after the PDF");
}));
