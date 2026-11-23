// NX1 (2026-11-23 three-way sync review): Next's shared writes and identity.
// H21 batch move/delete verify identity, H24 a follower's save returns what it
// committed, H25 manifest paths compare the way the host does, M15 uploads and
// image pastes accept what the manifest has and a lagging disk has not.
// The collab host is a stub HTTP server with a manifest that can be ahead of the disk.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { POST as batchRoute } from "../../src/app/api/files/batch/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import type { FileListEntry, FileOpRequest } from "../../src/lib/collab/local-api";
import { manifestPathKey } from "../../src/lib/collab/protocol/schema";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { deleteSharedFolder, renameSharedFolder, saveSharedFileText, writeSharedMarkdownImageAsset, writeSharedUpload } from "../../src/lib/collab/shared-writes";
import { attachFileIds } from "../../src/lib/storage/tree";
import { attachSharedFileIdTo, resolveSharedActionFileId } from "../../src/lib/collab/tree-file-ids";
import type { LiberaFileNode } from "../../src/lib/types";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type Item = { fileId: string; kind: "doc" | "blob" | "folder"; bytes?: Buffer };

/** The host: a manifest (path -> item) keyed like the real host, with file operations that touch it, never the disk. */
class StubHost {
  readonly ops: FileOpRequest[] = [];
  readonly manifest = new Map<string, { path: string } & Item>();
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  add(manifestPath: string, item: Item) { this.manifest.set(manifestPathKey(manifestPath), { path: manifestPath, ...item }); }
  find(manifestPath: string) { return this.manifest.get(manifestPathKey(manifestPath)); }
  below(folder: string) { return [...this.manifest.values()].filter((entry) => manifestPathKey(entry.path).startsWith(`${manifestPathKey(folder)}/`)); }

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const send = (status: number, payload: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
        const url = new URL(request.url ?? "/", "http://host");
        if (request.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: { code: "unauthorized", message: "No." } });
        if (url.pathname === "/docs/resolve") return send(200, null);
        if (url.pathname.endsWith("/transitions")) return send(200, { transitions: [] });
        if (url.pathname.endsWith("/file-entries")) {
          const entries: FileListEntry[] = [...this.manifest.values()].map((entry) => ({ fileId: entry.fileId, path: entry.path, kind: entry.kind, updatedAt: 0, ...(entry.bytes ? { blobHash: sha(entry.bytes), size: entry.bytes.byteLength } : {}) }));
          return send(200, { entries });
        }
        if (url.pathname.endsWith("/file-blob")) {
          const entry = this.find(url.searchParams.get("path") ?? "");
          if (!entry) return send(200, { contentBase64: null });
          if (!entry.bytes) return send(409, { error: { code: "conflict", message: "not a binary file" } });
          return send(200, { fileId: entry.fileId, blobHash: sha(entry.bytes), contentBase64: entry.bytes.toString("base64") });
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        const existing = this.find(op.path);
        const refuse = (message: string) => send(409, { error: { code: "conflict", message } });
        if (op.op === "write-blob") {
          if (op.createOnly && existing) return refuse("exists");
          if (op.replaceOnly && !existing) return send(404, { error: { code: "not-found", message: "Not found." } });
          if (existing && op.expectedFileId && op.expectedFileId !== existing.fileId) return refuse("This file changed since it was read.");
          if (existing && op.expectedBlobHash && op.expectedBlobHash !== sha(existing.bytes ?? Buffer.alloc(0))) return refuse("stale version");
          const bytes = Buffer.from(op.contentBase64 ?? "", "base64");
          this.add(op.path, { fileId: existing?.fileId ?? `fil_new_${this.manifest.size}`, kind: "blob", bytes });
          return send(200, { paths: [`Shared/${op.path}`] });
        }
        if (op.op === "create-folder") { this.add(op.path, { fileId: `fld_${this.manifest.size}`, kind: "folder" }); return send(200, { paths: [`Shared/${op.path}`] }); }
        if (op.op === "rename" || op.op === "delete") {
          if (!existing && !this.below(op.path).length) return send(404, { error: { code: "not-found", message: "Not found." } });
          if (existing && op.expectedFileId && op.expectedFileId !== existing.fileId) return refuse("This file changed since it was read.");
          if (op.expectedDescendantIds) {
            const have = this.below(op.path).map((entry) => entry.fileId).sort();
            if (JSON.stringify(have) !== JSON.stringify([...op.expectedDescendantIds].sort())) return refuse("The folder changed since it was listed.");
          }
          if (op.op === "delete") { if (existing) this.manifest.delete(manifestPathKey(op.path)); for (const entry of this.below(op.path)) this.manifest.delete(manifestPathKey(entry.path)); }
          return send(200, { paths: [`Shared/${op.path}`] });
        }
        return send(400, { error: { code: "bad-request", message: "Unsupported." } });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }
  async stop() { await new Promise<void>((resolve) => this.server?.close(() => resolve())); }
}

async function withShared(run: (fixture: { notebook: string; host: StubHost }) => Promise<void>) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-nx1-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(notebook, { recursive: true });
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost();
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  try {
    await run({ notebook, host });
  } finally {
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const post = (body: object) => batchRoute(new NextRequest("http://localhost/api/files/batch", {
  method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`, "content-type": "application/json" }, body: JSON.stringify(body),
}));

test("H21: a batch delete or move of a binary the tree row has no id for checks the disk copy against the manifest entry", () => withShared(async ({ notebook, host }) => {
  // The manifest's a.pdf and b.pdf are other files than the copies this lagging disk holds at those paths.
  host.add("a.pdf", { fileId: "fil_a", kind: "blob", bytes: Buffer.from("manifest A") });
  host.add("b.pdf", { fileId: "fil_b", kind: "blob", bytes: Buffer.from("manifest B") });
  host.add("dest", { fileId: "fld_dest", kind: "folder" });
  writeFileSync(path.join(notebook, "a.pdf"), "an older, other file");
  writeFileSync(path.join(notebook, "b.pdf"), "an older, other file");
  mkdirSync(path.join(notebook, "dest"));

  const removed = await post({ action: "delete", items: [{ path: "Shared/a.pdf" }] });
  const deleted = (await removed.json()) as { deleted: string[]; failed: { path: string; error: string }[] };
  assert.deepEqual(deleted.deleted, [], "the unverified copy is not deleted");
  assert.match(deleted.failed[0]?.error ?? "", /still being brought up to date by sync/);
  assert.ok(host.find("a.pdf"), "the manifest entry stays");

  const moved = await post({ action: "move", items: [{ path: "Shared/b.pdf" }], destinationDirectory: "Shared/dest" });
  const result = (await moved.json()) as { moved: unknown[]; failed: { error: string } | null };
  assert.deepEqual(result.moved, []);
  assert.match(result.failed?.error ?? "", /still being brought up to date by sync/);
  assert.equal(host.ops.some((op) => op.op === "rename" || op.op === "delete"), false, "the host was never asked");

  // A verified copy goes through, and the host gets the entry's id as its fence.
  writeFileSync(path.join(notebook, "a.pdf"), "manifest A");
  const ok = await post({ action: "delete", items: [{ path: "Shared/a.pdf" }] });
  assert.deepEqual(((await ok.json()) as { deleted: string[] }).deleted, ["Shared/a.pdf"]);
  assert.equal(host.ops.at(-1)?.expectedFileId, "fil_a");
}));

test("H24: saving a text file on a follower returns the text and version that were committed, not the old disk copy", () => withShared(async ({ notebook, host }) => {
  host.add("big.md", { fileId: "fil_big", kind: "blob", bytes: Buffer.from("old text\n") });
  writeFileSync(path.join(notebook, "big.md"), "old text\n"); // the disk is behind: the stub host never writes it
  const saved = await saveSharedFileText("Shared/big.md", "new text\n", { expectedFileId: "fil_big", expectedBlobHash: sha("old text\n") });
  assert.equal(saved.content, "new text\n");
  assert.equal(saved.version, sha("new text\n"), "the next save's expectedBlobHash is the committed one");
  assert.equal(readFileSync(path.join(notebook, "big.md"), "utf8"), "old text\n");
  // And the next save from that version is accepted.
  await saveSharedFileText("Shared/big.md", "newer\n", { expectedFileId: "fil_big", expectedBlobHash: saved.version! });
}));

test("H25: manifest paths match the host's key: folder rename and delete list their descendants, file ids attach, resolution finds the entry", () => withShared(async ({ notebook, host }) => {
  const nfc = "Café"; // the manifest's spelling
  const nfd = "Café"; // the spelling a macOS disk and its tree give
  host.add(nfc, { fileId: "fld_cafe", kind: "folder" });
  host.add(`${nfc}/note.pdf`, { fileId: "fil_note", kind: "blob", bytes: Buffer.from("N") });
  host.add(`${nfc}/inner`, { fileId: "fld_inner", kind: "folder" });
  mkdirSync(path.join(notebook, nfd, "inner"), { recursive: true });
  writeFileSync(path.join(notebook, nfd, "note.pdf"), "N");

  // File ids attach to a node whose path is spelled another way (and in another case).
  const node = { kind: "file", name: "NOTE.pdf", path: `Shared/${nfd}/NOTE.pdf`, notebook: "Shared", fileType: "pdf", createdAt: "", updatedAt: "", size: 1 } as LiberaFileNode;
  attachFileIds([node], [{ fileId: "fil_note", path: `Shared/${nfc}/note.pdf`, kind: "blob" as const }], () => true);
  assert.equal(node.fileId, "fil_note");
  assert.equal(node.fileIdState, undefined);

  // Resolution for an action finds the entry (and reads the one file: the disk copy is the entry's bytes).
  assert.equal(await resolveSharedActionFileId(`Shared/${nfd}/note.pdf`, undefined, "deleted", async () => [{ fileId: "fil_note", path: `Shared/${nfc}/note.pdf`, kind: "blob", updatedAt: 0, blobHash: sha("N") }]), "fil_note");
  const opened = { ...node, name: "note.pdf", path: `Shared/${nfd}/note.pdf` } as LiberaFileNode;
  await attachSharedFileIdTo(opened, undefined, async () => [{ fileId: "fil_note", path: `Shared/${nfc}/note.pdf`, kind: "doc", updatedAt: 0 }]);
  assert.equal(opened.fileId, "fil_note");

  await renameSharedFolder(`Shared/${nfd}`, "Tea");
  const rename = host.ops.find((op) => op.op === "rename");
  assert.deepEqual([...(rename?.expectedDescendantIds ?? [])].sort(), ["fil_note", "fld_inner"], "the descendants the host holds are all reviewed");

  await deleteSharedFolder(`Shared/${nfd}`).catch((error) => { assert.fail(`delete refused: ${(error as Error).message}`); });
  assert.deepEqual([...(host.ops.filter((op) => op.op === "delete").at(-1)?.expectedDescendantIds ?? [])].sort(), ["fil_note", "fld_inner"]);
}));

test("M15: an upload into a folder and an image pasted into a note that the manifest has and a lagging disk has not", () => withShared(async ({ notebook, host }) => {
  host.add("fresh", { fileId: "fld_fresh", kind: "folder" });
  host.add("fresh/note.md", { fileId: "fil_note", kind: "blob", bytes: Buffer.from("# note\n") });
  assert.equal(existsSync(path.join(notebook, "fresh")), false);

  const node = await writeSharedUpload("Shared", new File([Buffer.from("PDF")], "paper.pdf"), "Shared/fresh");
  assert.equal(node.name, "paper.pdf");
  assert.ok(host.find("fresh/paper.pdf"), "the upload went to the host");

  const image = await writeSharedMarkdownImageAsset("Shared/fresh/note.md", new File([Buffer.from("PNG")], "pic.png"));
  assert.match(image.assetPath, /pic\.png$/);
}));
