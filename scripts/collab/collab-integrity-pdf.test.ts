import assert from "node:assert/strict";
import { mkdirSync, promises as fsPromises, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as Y from "yjs";
import type { CollabHost } from "../../electron/collab/core/host";
import { PdfMarksRuntime, pdfDocId } from "../../electron/collab/notebooks/pdf-marks";
import { applyMarksDiff } from "../../src/lib/collab/pdf/model";
import { PDF_LIVE_SETTING } from "../../src/lib/collab/protocol/pdf";
import { ManifestKeys, type ManifestEntry } from "../../src/lib/collab/protocol/schema";
import { quietLogger, tempDir } from "./support/host-helpers";

// S37: one (file ID, path, blob version) tuple for a whole sidecar import. A rename or a new
// version while the sidecar is read discards what was read; it is never attributed through a
// path that moved under it.

const highlight = { id: "legacy-mark", type: "highlight", pageNumber: 1, color: "#fde047", rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: "words", createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" };
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string) {
  for (let index = 0; index < 200; index += 1) { if (check()) return; await tick(); }
  assert.fail(`timed out: ${label}`);
}

function fakeHost(imports: Array<{ docId: string; marks: Array<{ id: string }> }>) {
  const docs = new Map<string, Y.Doc>();
  const shared = {
    getStatus: () => ({ state: "saved-remote" }),
    observe: () => () => {},
    onStatus: () => () => {},
    onRejected: () => () => {},
    getDoc: (name: string) => { if (!docs.has(name)) docs.set(name, new Y.Doc()); return docs.get(name)!; },
    isClosed: false,
    hasOpened: true,
  };
  return {
    hubForTest: shared,
    store: { upsertDoc() {} },
    acquire: () => shared,
    release() {},
    api: { importPdf: async (docId: string, input: { marks: Array<{ id: string }> }) => { imports.push({ docId, marks: input.marks }); } },
  } as unknown as CollabHost;
}

function setup() {
  const temp = tempDir("libera-pdf-tuple-");
  const root = temp.file("notebook");
  mkdirSync(root);
  const imports: Array<{ docId: string; marks: Array<{ id: string }> }> = [];
  const manifest = new Y.Doc();
  manifest.getMap(ManifestKeys.settings).set(PDF_LIVE_SETTING, true);
  const host = fakeHost(imports);
  const hub = (host as unknown as { hubForTest: { isClosed: boolean; getDoc(name: string): Y.Doc } }).hubForTest;
  const runtime = new PdfMarksRuntime({ host, logger: quietLogger, projectId: "prj_test", notebook: "Notebook", root, writeMs: 60_000,
    role: () => "commenter", canWriteDisk: () => true, guard: () => ({ root, canCommit: async () => true }),
    authorityReady: () => true, recordLive: async () => {}, filesChanged() {}, commentsChanged() {}, manifest: () => manifest });
  const sync = (files: Array<{ fileId: string; path: string; blobHash?: string }>) => {
    const entries: ManifestEntry[] = files.map((file) => ({ fileId: file.fileId, path: file.path, kind: "blob", createdBy: "acc_me", createdAt: 1, updatedAt: 1, ...(file.blobHash ? { blobHash: file.blobHash } : {}) }));
    runtime.sync(entries, new Map(files.map((file) => [file.fileId, file.path])));
  };
  const legacySidecar = (name: string, notesTime: number, pdfName: string, pdfTime: number) => {
    const target = path.join(root, ".libera", "annotations", "pdf", "by-path", `${name}.json`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ annotations: [highlight] }));
    utimesSync(target, notesTime, notesTime);
    writeFileSync(path.join(root, pdfName), "%PDF-1.4\n% one\n%%EOF\n");
    utimesSync(path.join(root, pdfName), pdfTime, pdfTime);
  };
  /** Holds the first stat of `file` (the import has begun reading its sidecar) until released. */
  const pauseStat = (file: string) => {
    const original = fsPromises.stat;
    let release = () => {};
    let reached = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (fsPromises as { stat: unknown }).stat = async (target: string, ...rest: unknown[]) => {
      if (!reached && target === file) { reached = true; await gate; }
      return (original as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    };
    return { release, get reached() { return reached; }, restore: () => { (fsPromises as { stat: unknown }).stat = original; } };
  };
  return { root, imports, hub, runtime, sync, legacySidecar, pauseStat, cleanup: async () => { await runtime.stop(); manifest.destroy(); temp.cleanup(); } };
}

test("S37 control: a legacy sidecar is imported when nothing moves", async () => {
  const s = setup();
  try {
    s.legacySidecar("a.pdf", 2_000_000, "a.pdf", 1_000_000);
    s.sync([{ fileId: "fil_one", path: "a.pdf" }]);
    await until(() => s.imports.some((call) => call.marks.some((mark) => mark.id === "legacy-mark")), "the legacy sidecar was imported");
    assert.equal(s.imports[0].docId, pdfDocId("prj_test", "fil_one"));
  } finally { await s.cleanup(); }
});

test("S37: a rename and a reused name during a legacy sidecar read attribute nothing to either PDF", { timeout: 30_000 }, async () => {
  const s = setup();
  const pause = s.pauseStat(path.join(s.root, ".libera", "annotations", "pdf", "by-path", "a.pdf.json"));
  try {
    s.legacySidecar("a.pdf", 2_000_000, "a.pdf", 1_000_000);
    s.sync([{ fileId: "fil_one", path: "a.pdf" }]);
    await until(() => pause.reached, "the import has begun reading the sidecar");
    // The PDF is renamed (keeping its old time), and a newer, different PDF takes the name.
    renameSync(path.join(s.root, "a.pdf"), path.join(s.root, "b.pdf"));
    writeFileSync(path.join(s.root, "a.pdf"), "%PDF-1.4\n% another\n%%EOF\n");
    s.sync([{ fileId: "fil_one", path: "b.pdf" }, { fileId: "fil_two", path: "a.pdf" }]);
    pause.release();
    await tick(400);
    assert.deepEqual(s.imports.filter((call) => call.marks.length), [], "the old read is not attributed to the renamed PDF nor to the newcomer");
  } finally { pause.release(); pause.restore(); await s.cleanup(); }
});

test("S37: a new blob version during the read restarts the import instead of committing the old read", { timeout: 30_000 }, async () => {
  const s = setup();
  const pause = s.pauseStat(path.join(s.root, ".libera", "annotations", "pdf", "by-path", "a.pdf.json"));
  try {
    s.legacySidecar("a.pdf", 2_000_000, "a.pdf", 1_000_000);
    s.sync([{ fileId: "fil_one", path: "a.pdf", blobHash: "1".repeat(64) }]);
    await until(() => pause.reached, "reading");
    s.sync([{ fileId: "fil_one", path: "a.pdf", blobHash: "2".repeat(64) }]);
    pause.release();
    pause.restore();
    // The restarted import reads the same (unchanged) file again and commits under the new tuple.
    await until(() => s.imports.some((call) => call.marks.some((mark) => mark.id === "legacy-mark")), "imported under the new version");
  } finally { pause.release(); pause.restore(); await s.cleanup(); }
});

test("a revoked member's final local export is written even when the PDF hub closed first", { timeout: 30_000 }, async () => {
  const s = setup();
  try {
    s.sync([{ fileId: "fil_one", path: "a.pdf" }]);
    writeFileSync(path.join(s.root, "a.pdf"), "%PDF-1.4\n%%EOF\n");
    assert.ok(s.runtime.resolve("a.pdf"), "the PDF is open");
    applyMarksDiff(s.hub.getDoc("annotations"), [], [{ ...highlight, id: "latest-at-revoke" } as never], { accountId: "acc_me" }, "local");
    // Access ended: the hub is closed before the project stops.
    s.hub.isClosed = true;
    s.hub.getDoc("annotations").destroy(); // as a real hub does when it closes
    await s.runtime.stop({ local: true });
    const sidecar = path.join(s.root, ".libera", "annotations", "pdf", "by-path", "a.pdf.json");
    const kept = JSON.parse(readFileSync(sidecar, "utf8")) as { annotations: Array<{ id: string }>; sharedCopy?: string };
    assert.deepEqual(kept.annotations.map((record) => record.id), ["latest-at-revoke"]);
    assert.equal(kept.sharedCopy, undefined, "an ordinary sidecar the person keeps");
  } finally { await s.cleanup(); }
});
