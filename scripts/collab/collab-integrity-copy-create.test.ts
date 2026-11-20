// Host-side regressions for the 2026-11-20 shared-notebook integrity review,
// package C1: an absent entry is an authoritative negative answer of the blob
// read (S24), a create or a blob write answers with the committed file's id and
// the path the layout gave it (S25), and a replacement names the file and the
// version it replaces and never creates or takes over another file (S30).
// Runs against a real host and server.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { FileBlobResponse, FileListResponse, FileOpRequest } from "../../src/lib/collab/local-api";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { closePeer, makePeer, register, tempRoot } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const b64 = (text: string) => Buffer.from(text).toString("base64");

test("host: absent is an answer, creates name the committed file, and a replacement is bound to a file and a version", { timeout: 180_000 }, async () => {
  const temp = tempRoot("libera-collab-integrity-copy-create-");
  const server = await startServerProcess();
  const auth = await register(server, "Alice");
  const alice = await makePeer(temp.dir, "alice", server, auth);
  try {
    const root = path.join(alice.library, "Notes");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "a.md"), "# A\n");
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Notes" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    const op = (request: FileOpRequest) => alice.router.call("POST", ControlRoutes.files(projectId), request);
    // The harness router passes no query string, which the blob route reads; call its handler with one.
    const blobRoute = (alice.router as unknown as { routes: { method: string; pattern: string[]; handler: (request: unknown) => Promise<{ status?: number; body: unknown }> }[] }).routes
      .find((route) => route.method === "GET" && route.pattern.at(-1) === "file-blob")!;
    const blob = async (relative: string) => {
      try {
        const response = await blobRoute.handler({ method: "GET", path: "", params: { projectId }, query: new URLSearchParams({ path: relative }), body: undefined });
        return { status: response.status ?? 200, body: response.body };
      } catch (error) {
        return { status: (error as { status?: number }).status ?? 500, body: { error: (error as Error).message } };
      }
    };
    const entries = async () => ((await alice.router.call("GET", ControlRoutes.fileEntries(projectId))).body as FileListResponse).entries;

    // S25: a blob create answers with the new file's id and its own path.
    const created = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("one"), createOnly: true });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const createdBody = created.body as { paths: string[]; fileId?: string };
    assert.ok(createdBody.fileId);
    assert.deepEqual(createdBody.paths, ["Notes/pic.png"]);
    assert.equal((await entries()).find((entry) => entry.path === "pic.png")?.fileId, createdBody.fileId);

    // S24: a path the manifest has no entry for answers "absent", not an error; a document is "not a binary file".
    const read = await blob("pic.png");
    assert.equal(read.status, 200);
    const current = read.body as FileBlobResponse;
    assert.equal(current.fileId, createdBody.fileId);
    assert.ok(current.blobHash);
    assert.deepEqual((await blob("never-there.png")).body, { contentBase64: null });
    assert.equal((await blob("a.md")).status, 409);

    // S30: a replacement needs the file id and the blob hash of the version it replaces.
    const noIdentity = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("two"), replaceOnly: true });
    assert.equal(noIdentity.status, 400, JSON.stringify(noIdentity.body));
    const halfIdentity = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("two"), replaceOnly: true, expectedFileId: createdBody.fileId });
    assert.equal(halfIdentity.status, 400, JSON.stringify(halfIdentity.body));
    const both = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("two"), replaceOnly: true, createOnly: true, expectedFileId: createdBody.fileId, expectedBlobHash: current.blobHash });
    assert.equal(both.status, 400, "a write is a create or a replacement, not both");

    const replaced = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("two"), replaceOnly: true, expectedFileId: createdBody.fileId, expectedBlobHash: current.blobHash });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal((replaced.body as { fileId?: string }).fileId, createdBody.fileId);
    const afterReplace = (await blob("pic.png")).body as FileBlobResponse;
    assert.equal(Buffer.from(afterReplace.contentBase64 ?? "", "base64").toString(), "two");

    // The same, stale version again: the file moved on.
    const stale = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("three"), replaceOnly: true, expectedFileId: createdBody.fileId, expectedBlobHash: current.blobHash });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));

    // Deleted by a collaborator: no new identity appears at the old path.
    assert.equal((await op({ op: "delete", path: "pic.png" })).status, 200);
    const afterDelete = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("four"), replaceOnly: true, expectedFileId: createdBody.fileId, expectedBlobHash: afterReplace.blobHash });
    assert.equal(afterDelete.status, 409, JSON.stringify(afterDelete.body));
    assert.equal((await entries()).some((entry) => entry.path === "pic.png"), false, "nothing was created");

    // Another file holds the path now: it is not replaced.
    const other = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("other file"), createOnly: true });
    const otherBody = other.body as { fileId?: string };
    assert.notEqual(otherBody.fileId, createdBody.fileId);
    const otherRead = (await blob("pic.png")).body as FileBlobResponse;
    const takeover = await op({ op: "write-blob", path: "pic.png", contentBase64: b64("mine"), replaceOnly: true, expectedFileId: createdBody.fileId, expectedBlobHash: otherRead.blobHash });
    assert.equal(takeover.status, 409, JSON.stringify(takeover.body));
    assert.equal(Buffer.from(((await blob("pic.png")).body as FileBlobResponse).contentBase64 ?? "", "base64").toString(), "other file");
  } finally {
    await closePeer(alice);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
