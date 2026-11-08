// Regressions for the November 2026 collaboration review's Low findings in
// Next's shared-notebook writers: case-only renames (R43) and saving a text
// file the notebook holds as a file rather than a document (R44). The collab
// host is a stub HTTP server here.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { FileOpRequest } from "../../src/lib/collab/local-api";
import { SharedDocumentError, invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { moveSharedFile, renameSharedFolder, saveSharedFileText } from "../../src/lib/collab/shared-writes";

/** The host's file operations and path resolution: "doc.md" is a shared document, everything else a file. */
class StubHost {
  readonly ops: FileOpRequest[] = [];
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";
  constructor(private readonly notebookRoot: string) {}

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const send = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        const url = new URL(request.url ?? "/", "http://host");
        if (request.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: { code: "unauthorized", message: "No." } });
        if (url.pathname === "/docs/resolve") {
          const liberaPath = url.searchParams.get("path") ?? "";
          return send(200, liberaPath.endsWith("/doc.md") ? { docId: "doc_1", projectId: "prj_test", path: liberaPath, role: "editor", readOnly: false } : null);
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        const target = path.join(this.notebookRoot, ...op.path.split("/"));
        if (op.op === "write-blob") {
          writeFileSync(target, Buffer.from(op.contentBase64 ?? "", "base64"));
          return send(200, { paths: [`Shared/${op.path}`] });
        }
        if (op.op === "rename") {
          if (!existsSync(target)) return send(404, { error: { code: "not-found", message: "Not found." } });
          renameSync(target, path.join(this.notebookRoot, ...(op.to ?? "").split("/")));
          return send(200, { paths: [`Shared/${op.path}`, `Shared/${op.to}`] });
        }
        return send(400, { error: { code: "bad-request", message: "Unsupported." } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

async function withShared(run: (fixture: { notebook: string; host: StubHost; caseInsensitive: boolean }) => Promise<void>) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-review-low-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(path.join(notebook, "sub"), { recursive: true });
  writeFileSync(path.join(notebook, "note.md"), "note\n");
  writeFileSync(path.join(notebook, "big.md"), "large text\n");
  writeFileSync(path.join(notebook, "sub", "inner.md"), "inner\n");
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost(notebook);
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  try {
    await run({ notebook, host, caseInsensitive: existsSync(path.join(notebook, "NOTE.md")) });
  } finally {
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("R43: a shared file can be renamed by changing only its letter case", () => withShared(async ({ host, caseInsensitive }) => {
  await moveSharedFile("Shared/note.md", "Shared", "Note.md");
  // One operation: the host moves the file's ink in the same change.
  assert.deepEqual(host.ops.map((op) => [op.op, op.path, op.to]), [["rename", "note.md", "Note.md"]]);
  if (caseInsensitive) {
    // A folder's case cannot change through the host yet: said plainly, not "already exists".
    await assert.rejects(renameSharedFolder("Shared/sub", "Sub"), /letter case/);
  }
}));

test("R44: a text file held as a file saves through the host; a text document is refused", () => withShared(async ({ notebook, host }) => {
  const saved = await saveSharedFileText("Shared/big.md", "edited large text\n");
  assert.equal(saved.file.path, "Shared/big.md");
  assert.deepEqual(host.ops.map((op) => [op.op, op.path]), [["write-blob", "big.md"]]);
  assert.equal(readFileSync(path.join(notebook, "big.md"), "utf8"), "edited large text\n");

  writeFileSync(path.join(notebook, "doc.md"), "a document\n");
  await assert.rejects(saveSharedFileText("Shared/doc.md", "whole-file save"), SharedDocumentError);
  assert.equal(host.ops.length, 1, "nothing sent for the document");
}));
