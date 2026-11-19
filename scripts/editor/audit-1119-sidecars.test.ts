import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chunkSidecarChanges, postSidecarChanges, SIDECAR_CHUNK } from "../../src/components/libera/collab/forward-search-changes";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { inkFileName } from "../../src/lib/ink/authors";
import { inkBlockChunk, inkBlockFrame, inkBlockSource } from "../../src/lib/ink/block";
import { emptyInkAuthorFile, encodeInkSamples, sampleBounds } from "../../src/lib/ink/codec";
import type { InkStroke } from "../../src/lib/ink/types";
import { readPdfAnnotations, readPdfCommentThreads, updatePdfCommentThreads, writePdfAnnotations } from "../../src/lib/storage/annotations";
import { inkAuthor, inkLibraryPath, resetInkStorageForTests, writeInk } from "../../src/lib/storage/ink";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts, getLocalLockDir, referenceLibraryPath } from "../../src/lib/storage/paths";
import { followSharedPdfChanges, replayPendingPdfMoves } from "../../src/lib/storage/pdf-sidecars";
import { readReferenceLibrary, updateReferenceLibrary } from "../../src/lib/storage/references";
import { pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { cachedPdfIdentity } from "../../src/lib/storage/pdf-identity";

// Sync audit 2026-11-19, findings 10, 14, 15 and 21 (storage side).

async function withLibrary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-audit-1119-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.LIBERA_DATA_DIR = path.join(root, "library");
  process.env.LIBERA_CONFIG_PATH = path.join(root, "user-data", "config.json");
  resetInkStorageForTests();
  invalidateSharedNotebookCache();
  try { await createNotebook("Notes"); await run(root); } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    resetInkStorageForTests();
    invalidateSharedNotebookCache();
    await rm(root, { recursive: true, force: true });
  }
}

async function pdf(relative: string, text: string) {
  const [notebook, ...parts] = relative.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
}

const note = (id: string) => [{ type: "text" as const, id, pageNumber: 1, text: id, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }];
const texts = async (relative: string) => (await readPdfAnnotations(relative)).annotations.map((mark) => mark.type === "text" ? mark.text : "");

// ---- Finding 10 ---------------------------------------------------------------

test("finding 10: process locks live outside the library, and a lock file inside it is never judged by PID", () => withLibrary(async (root) => {
  assert.ok(!getLocalLockDir().startsWith(path.join(root, "library")), "the lock directory is local");
  await pdf("Notes/paper.pdf", "pdf body");
  // A lock another computer's OneDrive delivered, naming a PID that is alive here.
  const target = referenceLibraryPath("Notes");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.lock`, String(process.pid));
  const lockDirectory = path.join(root, "library", "users", "admin", ".libera", "locks");
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(path.join(lockDirectory, "pdf-sidecar-foreign.lock"), String(process.pid));

  const library = await updateReferenceLibrary("Notes", 0, [{ op: "add", entry: { csl: { type: "book", title: "One" } } }]);
  assert.equal(library.revision, 1, "a synced lock file does not block the reference library");
  await writePdfAnnotations("Notes/paper.pdf", note("saved"));
  assert.deepEqual(await texts("Notes/paper.pdf"), ["saved"]);
  assert.equal(await readFile(`${target}.lock`, "utf8"), String(process.pid), "the foreign lock file is left alone");
  assert.equal((await readReferenceLibrary("Notes")).revision, 1);
}));

test("finding 10: a sidecar changed by another device while saving is merged, not replaced", () => withLibrary(async () => {
  await pdf("Notes/paper.pdf", "pdf body");
  await writePdfAnnotations("Notes/paper.pdf", note("mine"));
  const sidecar = pdfAnnotationsPath("Notes", ["paper.pdf"]);
  const first = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
  assert.equal(typeof first.revision, "number", "the sidecar carries a revision");
  let injected = false;
  await updatePdfCommentThreads("Notes/paper.pdf", (threads) => {
    if (!injected) {
      injected = true;
      // The other device's sidecar reaches this folder after this save read the old one.
      writeFileSync(sidecar, JSON.stringify({ ...first, annotations: [...(first.annotations as unknown[]), ...note("theirs")], revision: 50 }));
    }
    return { threads, result: undefined };
  });
  const after = JSON.parse(await readFile(sidecar, "utf8")) as { annotations: Array<{ text: string }>; revision: number };
  assert.deepEqual(after.annotations.map((mark) => mark.text).sort(), ["mine", "theirs"], "the other device's marks survive");
  assert.equal(after.revision, 51, "the merged write builds on the newer revision");
}));

// ---- Finding 14 ---------------------------------------------------------------

test("finding 14: sidecar changes go out in requests of at most 500 and a failed request is retried", async () => {
  const moves = Array.from({ length: 1_201 }, (_, index) => ({ from: `A/${index}.pdf`, to: `A/b${index}.pdf` }));
  const chunks = chunkSidecarChanges({ moves, removed: ["A/x.pdf", "A/y.pdf"] });
  assert.ok(chunks.every((chunk) => chunk.moves.length + chunk.removed.length <= SIDECAR_CHUNK));
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.moves.length + chunk.removed.length, 0), 1_203);

  const sizes: number[] = [];
  let failuresLeft = 1;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { moves: unknown[]; removed: unknown[] };
    if (failuresLeft > 0) { failuresLeft -= 1; return new Response("{}", { status: 503 }); }
    sizes.push(body.moves.length + body.removed.length);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await postSidecarChanges("/api/pdf-sidecars", { moves, removed: [] }, [0, 0]), true);
    assert.deepEqual(sizes, [500, 500, 201], "every chunk was accepted, the failed one after a retry");
    failuresLeft = 99;
    assert.equal(await postSidecarChanges("/api/pdf-sidecars", { moves: moves.slice(0, 1), removed: [] }, [0]), false, "a request that keeps failing reports it");
  } finally { globalThis.fetch = realFetch; }
});

test("finding 14: a move whose destination bytes arrive later is replayed", () => withLibrary(async (root) => {
  await mkdir(path.join(root, "library", "users", "admin", "Notes"), { recursive: true });
  const bytes = "the paper";
  const from = await pdf("Notes/old.pdf", bytes);
  await writePdfAnnotations("Notes/old.pdf", note("keep me"));
  const { sharedNotebookMarker } = await import("../../src/lib/collab/shared-notebook");
  void sharedNotebookMarker;
  // The host reports the move before the moved PDF's bytes are in this folder.
  assert.equal(await followSharedPdfChanges([{ from: "Notes/old.pdf", to: "Notes/new.pdf" }], []), 0);
  assert.equal(existsSync(pdfAnnotationsPath("Notes", ["new.pdf"])), false);
  // OneDrive delivers the bytes. Nothing re-announces the move; the replay picks it up.
  await pdf("Notes/new.pdf", bytes);
  void from;
  assert.ok(await replayPendingPdfMoves("Notes") >= 1);
  assert.deepEqual(await texts("Notes/new.pdf"), ["keep me"]);
  assert.deepEqual(await texts("Notes/old.pdf"), ["keep me"], "the source sidecar stays");
}));

// ---- Finding 15 ---------------------------------------------------------------

test("finding 15: a new PDF at an old name does not inherit the old PDF's notes", () => withLibrary(async () => {
  await pdf("Notes/paper.pdf", "first paper");
  await writePdfAnnotations("Notes/paper.pdf", note("old note"));
  assert.deepEqual(await texts("Notes/paper.pdf"), ["old note"]);
  await pdf("Notes/paper.pdf", "a different paper, same name");
  assert.deepEqual(await texts("Notes/paper.pdf"), [], "readers do not attach the old notes");
  assert.deepEqual((await readPdfCommentThreads("Notes/paper.pdf")).threads, []);
  // Saving starts clean and keeps the old notes recoverable beside the sidecar.
  await writePdfAnnotations("Notes/paper.pdf", note("new note"));
  assert.deepEqual(await texts("Notes/paper.pdf"), ["new note"]);
  const directory = path.dirname(pdfAnnotationsPath("Notes", ["paper.pdf"]));
  const kept = (await readdir(directory)).filter((name) => name.includes(".replaced-"));
  assert.equal(kept.length, 1);
  assert.match(await readFile(path.join(directory, kept[0]), "utf8"), /old note/);
}));

test("finding 15: the same PDF keeps its notes, and a legacy sidecar without a hash is trusted", () => withLibrary(async () => {
  const target = await pdf("Notes/paper.pdf", "stable");
  await writePdfAnnotations("Notes/paper.pdf", note("kept"));
  assert.deepEqual(await texts("Notes/paper.pdf"), ["kept"]);
  const sidecar = pdfAnnotationsPath("Notes", ["paper.pdf"]);
  const stored = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
  assert.equal((stored.source as { contentHash: string }).contentHash, (await cachedPdfIdentity(target)).contentHash);
  delete stored.source;
  await writeFile(sidecar, JSON.stringify(stored));
  assert.deepEqual(await texts("Notes/paper.pdf"), ["kept"]);
}));

test("finding 15: after a shared removal, a new PDF at that name starts clean and the old notes stay recoverable", () => withLibrary(async () => {
  await pdf("Notes/paper.pdf", "old paper");
  await writePdfAnnotations("Notes/paper.pdf", note("old note"));
  await rm(filePathFromParts("Notes", ["paper.pdf"]));
  await followSharedPdfChanges([], ["Notes/paper.pdf"]);
  // Kept in place: the host may restore these very bytes (a refused delete rolls back).
  assert.equal(existsSync(pdfAnnotationsPath("Notes", ["paper.pdf"])), true, "a removal keeps the sidecar");
  await pdf("Notes/paper.pdf", "new paper");
  assert.deepEqual(await texts("Notes/paper.pdf"), [], "the new PDF does not show the old PDF's notes");
  // A later removal event, with the new PDF already there, sets the old notes aside.
  await followSharedPdfChanges([], ["Notes/paper.pdf"]);
  assert.equal(existsSync(pdfAnnotationsPath("Notes", ["paper.pdf"])), false, "a name reused by other bytes retires the old sidecar");
}));

// ---- Finding 21 ---------------------------------------------------------------

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

class StubHost {
  readonly blobs = new Map<string, Buffer>();
  readonly writes: Array<{ path: string; expectedBlobHash?: string; createOnly?: boolean }> = [];
  /** Runs when a blob is read, to let "another device" publish meanwhile. */
  onRead: (path: string) => void = () => {};
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const send = (status: number, payload: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
        const url = new URL(request.url ?? "/", "http://host");
        if (request.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: { code: "unauthorized", message: "No." } });
        if (url.pathname === "/docs/resolve") return send(200, null);
        if (/\/projects\/[^/]+\/file-blob$/.test(url.pathname)) {
          const relative = url.searchParams.get("path") ?? "";
          const bytes = this.blobs.get(relative);
          const payload = bytes ? { fileId: `fil_${relative}`, blobHash: sha(bytes), contentBase64: bytes.toString("base64") } : { contentBase64: null };
          this.onRead(relative);
          return send(200, payload);
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as { op: string; path: string; contentBase64?: string; expectedBlobHash?: string; createOnly?: boolean };
        if (op.op === "write-blob") {
          this.writes.push({ path: op.path, expectedBlobHash: op.expectedBlobHash, createOnly: op.createOnly });
          const existing = this.blobs.get(op.path);
          if ((op.createOnly && existing) || (op.expectedBlobHash !== undefined && (!existing || sha(existing) !== op.expectedBlobHash))) {
            return send(409, { error: { code: "conflict", message: "Changed." } });
          }
          this.blobs.set(op.path, Buffer.from(op.contentBase64 ?? "", "base64"));
        }
        return send(200, { paths: [`Shared/${op.path}`] });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() { await new Promise<void>((resolve) => this.server?.close(() => resolve())); }
}

let counter = 0;
function stroke(): InkStroke {
  counter += 1;
  const samples = [{ x: 20, y: 20 + counter, pressure: 0.4 }, { x: 300, y: 30 + counter, pressure: 0.8 }];
  return { id: `s${counter}x`, brush: "pen", color: "#1f2328", opacity: 1, width: 2, lineStyle: "solid", points: encodeInkSamples(samples), bounds: sampleBounds(samples), createdAt: new Date(1_700_000_000_000 + counter).toISOString() };
}

async function withSharedInk(run: (fixture: { host: StubHost; other: string; chunk: string; source: string; fileFor: (strokes: InkStroke[]) => Buffer }) => Promise<void>) {
  const host = new StubHost();
  await host.start();
  await withLibrary(async (root) => {
    const notebook = path.join(root, "library", "users", "admin", "Shared");
    await mkdir(notebook, { recursive: true });
    await writeFile(path.join(notebook, "note.md"), "note\n");
    await writeFile(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
    invalidateSharedNotebookCache();
    process.env.LIBERA_COLLAB_HOST_URL = host.url;
    process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
    const id = "k3f9q2m8x1c4v7b0";
    const chunk = inkBlockChunk(id);
    const other = "othr4uthor1";
    const fileFor = (strokes: InkStroke[]) => Buffer.from(`${JSON.stringify({ ...emptyInkAuthorFile({ key: other }, inkBlockFrame()), strokes, revision: strokes.length })}\n`, "utf8");
    await run({ host, other, chunk, source: inkBlockSource("Shared/note.md", id), fileFor });
  });
  await host.stop();
}

test("finding 21: a shared ink save merges other authors' strokes from the host, not a lagging disk copy", async () => {
  await withSharedInk(async ({ host, other, chunk, source, fileFor }) => {
    const first = stroke();
    const second = stroke();
    const folder = path.join(process.env.LIBERA_DATA_DIR!, "users", "admin", "Shared", "_ink", "note.md");
    await mkdir(folder, { recursive: true });
    // The disk copy of the other author has only the first stroke; the host has both.
    await writeFile(path.join(folder, inkFileName(chunk, other)), fileFor([first]));
    host.blobs.set(inkLibraryPath("Shared", ["note.md"], inkFileName(chunk, other)).slice("Shared/".length), fileFor([first, second]));
    const saved = await writeInk("Shared/note.md", chunk, { add: [stroke()] }, inkBlockFrame(), { rendering: source });
    const ids = saved.chunks[0].strokes.map((item) => item.stroke.id);
    assert.ok(ids.includes(first.id) && ids.includes(second.id), "the host's strokes are merged");
    assert.ok((await inkAuthor()).key.length > 0);
  });
});

test("finding 21: a rendering published meanwhile is not replaced by an older merge", async () => {
  await withSharedInk(async ({ host, chunk, source }) => {
    host.blobs.set(source, Buffer.from("<svg>old</svg>"));
    // Another device publishes a newer rendering right after this save read the current one.
    host.onRead = (read) => { if (read === source) host.blobs.set(source, Buffer.from("<svg>newer</svg>")); };
    await writeInk("Shared/note.md", chunk, { add: [stroke()] }, inkBlockFrame(), { rendering: source });
    assert.equal(host.blobs.get(source)!.toString(), "<svg>newer</svg>", "the newer rendering stays");
    const write = host.writes.find((item) => item.path === source);
    assert.ok(write?.expectedBlobHash, "the rendering write carried the version it started from");
  });
});
