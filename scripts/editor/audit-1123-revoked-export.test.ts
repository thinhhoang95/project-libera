import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { createNotebookZip } from "../../src/lib/storage/download";
import { readSharedAuthorityBytes, readSharedSourceSnapshot } from "../../src/lib/storage/shared-source";

// Three-way sync audit 2026-11-23, H18: a revoked notebook keeps its folder (marked revoked) so the person can
// export it. The host answers every read with 403 "access-revoked"; the ZIP, a binary copy and a LaTeX build
// then use the local folder instead of failing.

async function withRevoked(run: (notebook: string, reads: string[]) => Promise<void>) {
  const reads: string[] = [];
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      reads.push(request.url ?? "");
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "access-revoked", message: "Access to this notebook was revoked." } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-audit-1123-revoked-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.LIBERA_DATA_DIR = path.join(root, "library");
  process.env.LIBERA_CONFIG_PATH = path.join(root, "user-data", "config.json");
  process.env.LIBERA_COLLAB_HOST_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LIBERA_COLLAB_HOST_TOKEN = "test-token";
  const notebook = path.join(root, "library", "users", "admin", "Revoked");
  await mkdir(notebook, { recursive: true });
  await writeFile(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString(), revoked: true }));
  invalidateSharedNotebookCache();
  try { await run(notebook, reads); } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test("H18: a revoked notebook's ZIP is built from its local folder", () => withRevoked(async (notebook) => {
  await writeFile(path.join(notebook, "note.md"), "kept text");
  await mkdir(path.join(notebook, "pics"), { recursive: true });
  await writeFile(path.join(notebook, "pics", "a.png"), "kept pixels");
  const { body } = await createNotebookZip("Revoked");
  const zip = await JSZip.loadAsync(body);
  assert.equal(await zip.file("Revoked/note.md")!.async("string"), "kept text");
  assert.equal(await zip.file("Revoked/pics/a.png")!.async("string"), "kept pixels");
}));

test("H18: a binary read and a copy source fall back to the local folder when access was revoked", () => withRevoked(async () => {
  assert.equal(await readSharedAuthorityBytes("Revoked/pics/a.png"), null, "no authority: the caller reads the disk");
  assert.deepEqual(await readSharedSourceSnapshot("Revoked/pics/a.png", false), { authority: false });
  assert.deepEqual(await readSharedSourceSnapshot("Revoked/note.md", true), { authority: false });
}));
