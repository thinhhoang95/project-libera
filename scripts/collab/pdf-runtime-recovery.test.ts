import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as Y from "yjs";
import { CollabHost } from "../../electron/collab/core/host";
import { PdfMarksRuntime } from "../../electron/collab/notebooks/pdf-marks";
import { applyMarksDiff } from "../../src/lib/collab/pdf/model";
import { ManifestKeys, type ManifestEntry } from "../../src/lib/collab/protocol/schema";
import { PDF_LIVE_SETTING } from "../../src/lib/collab/protocol/pdf";
import { quietLogger, tempDir } from "./support/host-helpers";

for (const follower of [false, true]) for (const sameNotebook of [true, false]) test(`F10: terminal recovery with ${follower ? "a follower" : "a revoking writer"} ${sameNotebook ? "exports the latest marks" : "refuses a replaced notebook"}`, async () => {
  const temp = tempDir("libera-pdf-terminal-");
  const root = temp.file("notebook");
  mkdirSync(root);
  const host = new CollabHost({ dbPath: temp.file("host.sqlite"), appVersion: "test", installationId: "terminal-test", logger: quietLogger, compaction: false });
  host.start();
  const manifest = new Y.Doc();
  manifest.getMap(ManifestKeys.settings).set(PDF_LIVE_SETTING, true);
  let canWrite = !follower;
  const runtime = new PdfMarksRuntime({ host, logger: quietLogger, projectId: "prj_test", notebook: "Notebook", root, writeMs: 60_000,
    role: () => "commenter", canWriteDisk: () => canWrite,
    guard: (finalizing) => ({ root, canCommit: async () => sameNotebook && (finalizing === true || canWrite) }),
    authorityReady: () => true, filesChanged() {}, manifest: () => manifest });
  try {
    const entry: ManifestEntry = { fileId: "fil_pdf", path: "paper.pdf", kind: "blob", createdBy: "acc_me", createdAt: 1, updatedAt: 1 };
    runtime.sync([entry], new Map([[entry.fileId, entry.path]]));
    const resolved = runtime.resolve("paper.pdf")!;
    const hub = host.acquire(resolved.docId);
    const annotation = { id: "latest", type: "text" as const, pageNumber: 1, text: "newest unsent work", fontSize: 10, rect: { x: 0, y: 0, width: 0.2, height: 0.1 }, createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" };
    hub.applyLocalChange("annotations", (doc) => applyMarksDiff(doc, [], [annotation], { accountId: "acc_me" }, "local"));
    canWrite = false;
    const sidecar = path.join(root, ".libera", "annotations", "pdf", "by-path", "paper.pdf.json");
    mkdirSync(path.dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, JSON.stringify({ annotations: [] }));
    await runtime.stop({ local: true });
    const kept = JSON.parse(readFileSync(sidecar, "utf8"));
    assert.equal(kept.sharedCopy, undefined);
    if (sameNotebook) assert.deepEqual(kept.annotations.map((mark: { text: string }) => mark.text), ["newest unsent work"]);
    else assert.deepEqual(kept.annotations, [], "a different notebook is never overwritten by terminal recovery");
    host.release(resolved.docId);
  } finally { await runtime.stop(); await host.stop(); manifest.destroy(); temp.cleanup(); }
});
