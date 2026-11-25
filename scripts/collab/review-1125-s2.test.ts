// Review 2026-11-25, package S2 (S-C1 item 2): deleting a live PDF closes its document without writing a
// fresh sidecar at the deleted path. A sidecar there would be a leftover record that blocks the name.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ControlRoutes, type ResolvedPdf } from "../../src/lib/collab/local-api";
import { applyMarksDiff, readAllMarks, visibleMarks } from "../../src/lib/collab/pdf/model";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";
import type { PdfHighlightAnnotation } from "../../src/lib/types";

const PDF = Buffer.from("%PDF-1.4\n% a paper\n%%EOF\n");
const sidecarPath = (root: string, file: string) => path.join(root, ".libera", "annotations", "pdf", "by-path", `${file}.json`);

function highlight(id: string): PdfHighlightAnnotation {
  return { id, type: "highlight", pageNumber: 1, color: "#fde047", rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], quote: "words", createdAt: "2026-11-06T10:00:00.000Z", updatedAt: "2026-11-06T10:00:00.000Z" };
}

test("S-C1: deleting a live PDF with an unwritten copy pending writes no sidecar at the deleted path", { timeout: 60_000 }, async () => {
  const temp = tempRoot("libera-review-1125-s2-");
  const server = await startServerProcess();
  const auth = await register(server, "Owner");
  // A long write delay: the copy of the last mark is still waiting when the file is deleted.
  const owner = await makePeer(temp.dir, "owner", server, auth, { timings: { pdfWriteMs: 600_000 } });
  try {
    const root = path.join(owner.library, "Papers");
    writeTree(root, { "paper.pdf": PDF });
    const shared = await owner.router.call("POST", ControlRoutes.share, { notebook: "Papers" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    const enabled = await owner.router.call("POST", ControlRoutes.pdfLive(projectId));
    assert.equal(enabled.status, 204, JSON.stringify(enabled.body));
    const resolved = (await owner.service.resolvePdf("Papers/paper.pdf")) as ResolvedPdf;
    const hub = owner.host.acquire(resolved.docId);
    await until(() => hub.getStatus().state === "saved-remote", "opened");
    const before = visibleMarks(readAllMarks(hub.getDoc("annotations")));
    hub.applyLocalChange("annotations", (doc) => { applyMarksDiff(doc, before, [...before, highlight("h1")], { accountId: owner.auth.account.id }, null); });
    await owner.service.fileOp(projectId, { op: "delete", path: "paper.pdf" });
    await until(() => hub.getMeta().readOnlyReason === "document-deleted", "the document closes");
    await sleep(300);
    assert.equal(existsSync(sidecarPath(root, "paper.pdf")), false, "nothing written at the deleted path");
    owner.host.release(resolved.docId);
  } finally {
    await closePeer(owner).catch(() => undefined);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
