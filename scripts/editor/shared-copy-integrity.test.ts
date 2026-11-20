// Regressions for the 2026-11-20 shared-notebook integrity review, package C1
// (S23 to S30): a copy is built from the host's version of its source and does
// not need the follower's disk file (S23), a source the host no longer lists is
// refused instead of copied from stale disk bytes (S24), every follow-up uses
// the committed file id and path (S25), a copy into a shared notebook maps its
// citations (S26), rewrites image destinations only where they are parsed and
// removes the images it added when it fails (S27), brings the supported records
// (S28), refuses a name that still holds an earlier file's records (S29), and a
// whole-file save names the file and version it replaces (S30). The host is a
// stub that keeps a manifest in memory and writes the working copy like the real one.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileOpRequest } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { copyFileIntoSharedDirectory, createSharedMarkdownFile, saveSharedFileText, writeSharedUpload } from "../../src/lib/collab/shared-writes";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import { resetBibMirrorScheduler } from "../../src/lib/references/bib-mirror";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { copyFileToDirectory } from "../../src/lib/storage/files";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { addReviewThreads, findReview } from "../../src/lib/storage/markdown-reviews";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { imageAnnotationsPath, notebookPath } from "../../src/lib/storage/paths";
import type { ReferenceEntry } from "../../src/lib/references/types";
import { readReferenceLibrary, updateReferenceLibrary } from "../../src/lib/storage/references";
import { setFileTagsForPath } from "../../src/lib/storage/workspace-metadata";

class Watcher extends EventEmitter {
  close() { /* nothing watched */ }
}

type Item = { fileId: string; kind: "doc" | "blob"; text?: string; bytes?: Buffer };

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

class StubHost {
  /** The manifest, by path relative to the notebook. */
  items = new Map<string, Item>();
  ops: FileOpRequest[] = [];
  /** Where the host places a create (another member took the name first). */
  placeAs: ((relative: string) => string) | null = null;
  /** Refuses the write when it returns true. */
  failWrite: ((op: FileOpRequest) => boolean) | null = null;
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  constructor(private readonly notebook: string) {}

  add(relative: string, content: string | Buffer, kind: "doc" | "blob" = typeof content === "string" ? "doc" : "blob") {
    const item: Item = { fileId: `fil_${randomUUID()}`, kind, ...(kind === "doc" ? { text: String(content) } : { bytes: Buffer.from(content) }) };
    this.items.set(relative, item);
    return item;
  }

  private write(relative: string, item: Item) {
    const target = path.join(this.notebook, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, item.kind === "doc" ? item.text ?? "" : item.bytes ?? Buffer.alloc(0));
  }

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const send = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        const error = (status: number, code: string, message: string) => send(status, { error: { code, message } });
        if (request.headers.authorization !== `Bearer ${this.token}`) return error(404, "not-found", "No route.");
        const url = new URL(request.url ?? "", "http://host");
        if (request.method === "GET") {
          if (url.pathname === "/projects") return send(200, [{ projectId: "prj_test", notebook: "Shared", pdfLive: false }]);
          if (/\/file-entries$/.test(url.pathname)) {
            return send(200, { entries: [...this.items].map(([relative, item]) => ({ fileId: item.fileId, path: relative, kind: item.kind, ...(item.kind === "doc" ? { docId: `doc_${item.fileId}` } : { blobHash: sha(item.bytes ?? Buffer.alloc(0)) }), updatedAt: 1 })) });
          }
          if (/\/file-blob$/.test(url.pathname)) {
            const item = this.items.get(url.searchParams.get("path") ?? "");
            if (!item) return send(200, { contentBase64: null });
            if (item.kind === "doc") return error(409, "conflict", "This path is not a binary file.");
            return send(200, { fileId: item.fileId, blobHash: sha(item.bytes!), contentBase64: item.bytes!.toString("base64") });
          }
          if (url.pathname === "/docs/resolve") {
            const relative = (url.searchParams.get("path") ?? "").replace(/^Shared\//, "");
            const item = this.items.get(relative);
            return send(200, item?.kind === "doc" ? { docId: `doc_${item.fileId}`, projectId: "prj_test", fileId: item.fileId, path: relative, kind: "markdown", role: "owner", readOnly: false } : null);
          }
          const text = /^\/docs\/doc_(.+)\/text$/.exec(url.pathname);
          if (text) {
            const item = [...this.items.values()].find((candidate) => candidate.fileId === decodeURIComponent(text[1]));
            return item ? send(200, { docId: `doc_${item.fileId}`, text: item.text ?? "", status: "synced" }) : error(404, "not-found", "No such document.");
          }
          return error(404, "not-found", "No route.");
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return error(404, "not-found", "No route.");
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        if (this.failWrite?.(op)) return error(409, "conflict", "The host refused this write.");
        const existing = this.items.get(op.path);
        if (op.op === "delete") {
          if (!existing) return error(404, "not-found", "Not in this notebook.");
          if (op.expectedFileId !== undefined && existing.fileId !== op.expectedFileId) return error(409, "conflict", "This file changed since it was read.");
          this.items.delete(op.path);
          rmSync(path.join(this.notebook, op.path), { force: true });
          return send(200, { paths: [`Shared/${op.path}`] });
        }
        if (op.op === "create-file" || (op.op === "write-blob" && !existing && !op.replaceOnly)) {
          if (existing) return error(409, "conflict", `${op.path} already exists.`);
          const placed = this.placeAs?.(op.path) ?? op.path;
          const item = op.op === "create-file" ? this.add(placed, op.content ?? "", "doc") : this.add(placed, Buffer.from(op.contentBase64 ?? "", "base64"), "blob");
          this.write(placed, item);
          return send(200, { paths: [`Shared/${placed}`], fileId: item.fileId });
        }
        if (op.op === "write-blob") {
          if (op.createOnly && existing) return error(409, "conflict", `${op.path} already exists.`);
          if (op.replaceOnly && (!op.expectedFileId || !op.expectedBlobHash)) return error(400, "bad-request", "Replacing a file needs the file id and blob hash.");
          if (op.replaceOnly && !existing) return error(409, "conflict", "Deleted or moved before it was saved.");
          if (op.expectedFileId !== undefined && existing?.fileId !== op.expectedFileId) return error(409, "conflict", "This file identity changed.");
          if (op.expectedBlobHash !== undefined && sha(existing?.bytes ?? Buffer.alloc(0)) !== op.expectedBlobHash) return error(409, "conflict", "This file changed.");
          existing!.bytes = Buffer.from(op.contentBase64 ?? "", "base64");
          this.write(op.path, existing!);
          return send(200, { paths: [`Shared/${op.path}`], fileId: existing!.fileId });
        }
        return error(400, "bad-request", "Unsupported in this stub.");
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

async function withShared(run: (fixture: { host: StubHost; notebook: string; dataDir: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-shared-copy-integrity-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(path.join(notebook, "sub"), { recursive: true });
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost(notebook);
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  mock.method(fs, "watch", () => new Watcher());
  try {
    await createNotebook("Local");
    await run({ host, notebook, dataDir });
  } finally {
    resetBibTethers();
    resetBibMirrorScheduler();
    mock.restoreAll();
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const localFiles = () => readdirSync(notebookPath("Local")).filter((name) => !name.startsWith("."));

test("S23: a copy out of a shared notebook is built from the host's text, with no disk file at the source", () => withShared(async ({ host }) => {
  host.add("sub/note.md", "host text\n");
  const copied = await copyFileToDirectory("Shared/sub/note.md", "Local");
  assert.equal(readFileSync(path.join(notebookPath("Local"), copied.file.name), "utf8"), "host text\n");
}));

test("S23: a copy into a shared notebook needs no disk file at the source and publishes the host's version", () => withShared(async ({ host, notebook }) => {
  host.add("sub/note.md", "host text\n");
  assert.equal(fs.existsSync(path.join(notebook, "sub", "note.md")), false);
  const copied = await copyFileIntoSharedDirectory("Shared/sub/note.md", "Shared/sub", "copy.md");
  assert.equal(copied.file.path, "Shared/sub/copy.md");
  assert.equal(host.items.get("sub/copy.md")?.text, "host text\n");
  assert.deepEqual(host.ops.map((op) => [op.op, op.path]), [["create-file", "sub/copy.md"]]);
}));

test("S24: a source the host no longer lists is refused, never copied from the bytes a lagging disk still holds", () => withShared(async ({ host, notebook }) => {
  writeFileSync(path.join(notebook, "sub", "gone.png"), "stale png");
  writeFileSync(path.join(notebook, "sub", "gone.md"), "stale note\n");
  host.add("sub/other.md", "x\n");
  for (const name of ["gone.png", "gone.md"]) {
    await assert.rejects(copyFileToDirectory(`Shared/sub/${name}`, "Local"), /deleted or moved by a collaborator/);
    await assert.rejects(copyFileIntoSharedDirectory(`Shared/sub/${name}`, "Shared/sub", `x-${name}`), /deleted or moved by a collaborator/);
  }
  assert.deepEqual(localFiles(), [], "nothing was copied out");
  assert.equal(host.ops.length, 0, "nothing was published");
}));

test("S24: a blob copies the host's bytes, not the working file's", () => withShared(async ({ host, notebook }) => {
  host.add("sub/photo.png", PNG);
  writeFileSync(path.join(notebook, "sub", "photo.png"), "older bytes on this disk");
  const copied = await copyFileToDirectory("Shared/sub/photo.png", "Local");
  assert.deepEqual(readFileSync(path.join(notebookPath("Local"), copied.file.name)), PNG);
}));

test("S24: with no shared authority (collaboration off here) the disk is the only copy", () => withShared(async ({ notebook }) => {
  writeFileSync(path.join(notebook, "sub", "disk.png"), PNG);
  delete process.env.LIBERA_COLLAB_HOST_URL;
  delete process.env.LIBERA_COLLAB_HOST_TOKEN;
  const copied = await copyFileToDirectory("Shared/sub/disk.png", "Local");
  assert.deepEqual(readFileSync(path.join(notebookPath("Local"), copied.file.name)), PNG);
}));

test("S25, S28: every follow-up of a copy uses the committed file id and the path the host chose, and its records come along", () => withShared(async ({ host }) => {
  host.add("sub/photo.png", PNG);
  const ink = "_ink/sub/photo.png/page-0001.aaaaaaaaaa.ink";
  host.add(ink, Buffer.from('{"strokes":[]}\n'));
  const record = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, '{"annotations":["mine"]}');
  host.placeAs = (relative) => relative.replace("dup.png", "dup (2).png");

  const copied = await copyFileIntoSharedDirectory("Shared/sub/photo.png", "Shared/sub", "dup.png");
  assert.equal(copied.file.path, "Shared/sub/dup (2).png", "the file the host created, not the requested name");
  const placed = host.items.get("sub/dup (2).png")!;
  assert.deepEqual(copied.unfinished, undefined);
  // The ink is published through the host, beside the committed file, owned by its id.
  const copiedInk = host.items.get("_ink/sub/dup (2).png/page-0001.aaaaaaaaaa.ink");
  assert.ok(copiedInk, "the ink of the copy");
  assert.equal(host.ops.find((op) => op.path.startsWith("_ink/sub/dup (2).png/"))?.ownerFileId, placed.fileId);
  assert.equal(host.items.has("_ink/sub/dup.png/page-0001.aaaaaaaaaa.ink"), false, "nothing at the requested name");
  // The annotations are this computer's record, at the placed path.
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["sub", "dup (2).png"]), "utf8"), '{"annotations":["mine"]}');
  assert.equal(fs.existsSync(imageAnnotationsPath("Shared", ["sub", "dup.png"])), false);
  assert.ok(host.items.has(ink), "the original keeps its ink");
}));

test("S25: when a collaborator moves the copy at once, its records are not given to whatever took its place", () => withShared(async ({ host }) => {
  host.add("sub/photo.png", PNG);
  const record = imageAnnotationsPath("Shared", ["sub", "photo.png"]);
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, '{"annotations":["mine"]}');
  // The host lists the copy under another id: it was replaced after the create answered.
  const created = host.placeAs;
  host.placeAs = (relative) => { setTimeout(() => { host.items.get(relative)!.fileId = "fil_replaced"; }, 0); return created ? created(relative) : relative; };
  const copied = await copyFileIntoSharedDirectory("Shared/sub/photo.png", "Shared/sub", "late.png");
  assert.equal(fs.existsSync(imageAnnotationsPath("Shared", ["sub", "late.png"])), false);
  assert.match(copied.unfinished?.[0]?.message ?? "", /moved or deleted by a collaborator/);
}));

test("S28: a note's Python code, review comments and ink are copied into a shared notebook as the copy's own", () => withShared(async ({ host }) => {
  host.add("sub/note.md", "host text\n");
  const code = pythonSidecarPath("Shared/sub/note.md").split("/").slice(1).join("/");
  host.add(code, "print(1)\n");
  host.add("_ink/sub/note.md/text.aaaaaaaaaa.ink", Buffer.from("{}\n"));
  await addReviewThreads("Shared/sub/note.md", "host text\n", [{ range: { start: 0, end: 4 }, text: "a comment" }]);

  const copied = await copyFileIntoSharedDirectory("Shared/sub/note.md", "Shared/sub", "n2.md");
  assert.deepEqual(copied.unfinished, undefined);
  const copiedCode = pythonSidecarPath("Shared/sub/n2.md").split("/").slice(1).join("/");
  assert.match(host.items.get(copiedCode)?.text ?? host.items.get(copiedCode)?.bytes?.toString("utf8") ?? "", /print\(1\)/);
  assert.ok(host.items.has("_ink/sub/n2.md/text.aaaaaaaaaa.ink"));
  const original = await findReview("Shared/sub/note.md");
  const review = await findReview("Shared/sub/n2.md");
  assert.equal(review?.threads.length, 1);
  assert.notEqual(review?.id, original?.id, "its own review document");
  assert.notEqual(review?.threads[0].id, original?.threads[0].id, "its own thread ids");
}));

test("S26: a note copied into a shared notebook cites the destination's references", () => withShared(async ({ host }) => {
  await createNotebook("Library");
  writeFileSync(path.join(notebookPath("Library"), "note.md"), "As shown [@smith] and again.\n");
  const now = new Date().toISOString();
  const reference = (id: string, title: string, family: string): ReferenceEntry => ({
    id, key: "smith", aliases: [], csl: { type: "article-journal", title, author: [{ family, given: "A." }], issued: { "date-parts": [[2020]] } }, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: now, updatedAt: now, fieldUpdatedAt: {},
  });
  await updateReferenceLibrary("Library", null, [{ op: "put", entry: reference("r_lib", "Effects of sleep on memory", "Smith") }]);
  // The shared library's @smith is a different work.
  await updateReferenceLibrary("Shared", null, [{ op: "put", entry: reference("r_shared", "A completely different book about cooking", "Smith") }]);

  const copied = await copyFileIntoSharedDirectory("Library/note.md", "Shared", "cited.md");
  const text = host.items.get("cited.md")?.text ?? "";
  assert.ok(!text.includes("[@smith]"), `the citation was mapped: ${text}`);
  assert.ok(copied.references && copied.references.copied.length === 1, "the entry was copied into the shared library");
  assert.ok(Object.values((await readReferenceLibrary("Shared")).entries).some((entry) => entry.csl.title === "Effects of sleep on memory"));
}));

test("S27: image destinations are rewritten where they are parsed, and a failed copy removes the images it added", () => withShared(async ({ host }) => {
  writeFileSync(path.join(notebookPath("Local"), "note.md"), "x\n");
  const first = await writeMarkdownImageAsset("Local/note.md", new File([PNG], "a.png", { type: "image/png" }));
  const second = await writeMarkdownImageAsset("Local/note.md", new File([Buffer.concat([PNG, Buffer.from([9])])], "b.png", { type: "image/png" }));
  const text = `![a](${first.assetPath})\n\n\`\`\`\n![a](${first.assetPath})\n\`\`\`\n\n![b](${second.assetPath})\n`;
  writeFileSync(path.join(notebookPath("Local"), "note.md"), text);

  // The second upload is refused: the first image is removed again and no note exists.
  let writes = 0;
  host.failWrite = (op) => op.op === "write-blob" && ++writes === 2;
  await assert.rejects(copyFileIntoSharedDirectory("Local/note.md", "Shared", "img.md"), /refused this write/);
  assert.equal(host.items.size, 0, "no image or note is left in the manifest");
  assert.ok(host.ops.some((op) => op.op === "delete" && op.path.includes("_assets") && op.expectedFileId), "the first image was removed by its id");

  host.failWrite = null;
  await copyFileIntoSharedDirectory("Local/note.md", "Shared", "img.md");
  const copy = host.items.get("img.md")?.text ?? "";
  assert.equal(copy.split(first.assetPath).length, 2, "only the code example keeps the address it was written with");
  const fence = copy.slice(copy.indexOf("```"));
  assert.ok(fence.includes(first.assetPath), "the code example is unchanged");
  assert.ok(!copy.slice(0, copy.indexOf("```")).includes(first.assetPath), "the image above it points at the copy's own asset");
  assert.equal([...host.items.keys()].filter((key) => key.startsWith("_assets/")).length, 2);
}));

test("S29: a new note or upload at a path that still has records of an earlier file is refused", () => withShared(async ({ host }) => {
  await setFileTagsForPath("Shared/sub/new.md", ["old"]);
  await assert.rejects(createSharedMarkdownFile("Shared", "new.md", "", "Shared/sub"), /still has the tags of a file that was there before.*then create again/);

  const record = imageAnnotationsPath("Shared", ["sub", "pic.png"]);
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, '{"annotations":["old"]}');
  await assert.rejects(writeSharedUpload("Shared", new File([PNG], "pic.png"), "Shared/sub"), /still has the annotations.*then upload again/);

  // Records the manifest still lists (a lagging disk has none of them).
  host.add("_ink/sub/up.png/page-0001.aaaaaaaaaa.ink", Buffer.from("{}\n"));
  await assert.rejects(writeSharedUpload("Shared", new File([PNG], "up.png"), "Shared/sub"), /still has the ink of a file that was there before/);
  assert.equal(host.ops.length, 0, "the host was not asked to create anything");

  // A free name still works.
  await writeSharedUpload("Shared", new File([PNG], "free.png"), "Shared/sub");
  assert.ok(host.items.has("sub/free.png"));
}));

test("S29: a copy skips a name that still holds an earlier file's records", () => withShared(async ({ host }) => {
  host.add("sub/photo.png", PNG);
  host.add("_ink/sub/copy.png/page-0001.aaaaaaaaaa.ink", Buffer.from("{}\n"));
  const copied = await copyFileIntoSharedDirectory("Shared/sub/photo.png", "Shared/sub", "copy.png");
  assert.equal(copied.file.path, "Shared/sub/copy-1.png");
}));

test("S30: a whole-file save of a blob-stored text file names the file and the version it replaces", () => withShared(async ({ host, notebook }) => {
  const item = host.add("sub/big.md", Buffer.from("original\n"), "blob");
  writeFileSync(path.join(notebook, "sub", "big.md"), "original\n");
  const hash = sha(item.bytes!);

  // Without the identity and the version there is nothing to replace.
  await assert.rejects(saveSharedFileText("Shared/sub/big.md", "edit\n"), /without the version it was opened from/);
  assert.equal(host.ops.length, 0);

  await saveSharedFileText("Shared/sub/big.md", "edit\n", { expectedFileId: item.fileId, expectedBlobHash: hash });
  assert.deepEqual([host.ops[0].op, host.ops[0].replaceOnly, host.ops[0].expectedFileId, host.ops[0].expectedBlobHash], ["write-blob", true, item.fileId, hash]);
  assert.equal(host.items.get("sub/big.md")?.bytes?.toString("utf8"), "edit\n");

  // The same stale version again: the file moved on.
  await assert.rejects(saveSharedFileText("Shared/sub/big.md", "stale\n", { expectedFileId: item.fileId, expectedBlobHash: hash }), (error: { status?: number }) => error.status === 409);

  // Deleted by a collaborator: no new identity is created at the old path.
  host.items.delete("sub/big.md");
  await assert.rejects(saveSharedFileText("Shared/sub/big.md", "again\n", { expectedFileId: item.fileId, expectedBlobHash: sha(Buffer.from("edit\n")) }), (error: { status?: number }) => error.status === 409);
  assert.equal(host.items.has("sub/big.md"), false);

  // Another file now holds the path: its bytes are not replaced.
  const other = host.add("sub/big.md", Buffer.from("someone else\n"), "blob");
  await assert.rejects(saveSharedFileText("Shared/sub/big.md", "mine\n", { expectedFileId: item.fileId, expectedBlobHash: sha(Buffer.from("edit\n")) }), (error: { status?: number }) => error.status === 409);
  assert.equal(host.items.get("sub/big.md")?.bytes?.toString("utf8"), "someone else\n");
  assert.equal(host.items.get("sub/big.md")?.fileId, other.fileId);
}));

test("S30: a caller that has just compared the text it merged against is bound to the host's version of that text", () => withShared(async ({ host, notebook }) => {
  const item = host.add("sub/refs.md", Buffer.from("merged against\n"), "blob");
  writeFileSync(path.join(notebook, "sub", "refs.md"), "merged against\n");
  await assert.rejects(saveSharedFileText("Shared/sub/refs.md", "x\n", { expectedText: "something else\n" }), /changed before it could be saved/);
  await saveSharedFileText("Shared/sub/refs.md", "x\n", { expectedText: "merged against\n" });
  assert.equal(host.ops.at(-1)?.expectedFileId, item.fileId);
  assert.equal(host.items.get("sub/refs.md")?.bytes?.toString("utf8"), "x\n");
}));
