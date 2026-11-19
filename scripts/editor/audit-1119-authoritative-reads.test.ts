import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import JSZip from "jszip";
import { NextRequest } from "next/server";
import { GET as getTranscriptProgress } from "../../src/app/api/transcripts/progress/route";
import type { FileListEntry } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { inkFileName } from "../../src/lib/ink/authors";
import { inkBlockChunk, inkBlockFrame, inkBlockSource } from "../../src/lib/ink/block";
import { emptyInkAuthorFile, encodeInkSamples, sampleBounds } from "../../src/lib/ink/codec";
import type { InkStroke } from "../../src/lib/ink/types";
import { latexBuildPaths, stageSources } from "../../src/lib/latex/build";
import { createNotebookZip } from "../../src/lib/storage/download";
import { readCachedFileContentHash } from "../../src/lib/storage/file-signature";
import { inkLibraryPath, resetInkStorageForTests, writeInk } from "../../src/lib/storage/ink";
import { getMarkdownImageAssetBySource } from "../../src/lib/storage/markdown-assets";
import { filePathFromParts, transcriptPath } from "../../src/lib/storage/paths";
import { copyTranscript, followSharedAudioChanges, pruneAudioSidecars, readTranscript } from "../../src/lib/storage/transcripts";
import { TRANSCRIPT_VERSION, type Transcript } from "../../src/lib/transcription/types";

// Sync audit 2026-11-19, package P12: authoritative reads and exports
// (findings 26, 27, 42, plus the gaps of 21 and 14). The shared-notebook cases
// run against a stub collaboration host that holds a manifest listing, blobs
// and document texts.

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

class StubHost {
  /** The manifest, with paths relative to the notebook. */
  entries: FileListEntry[] = [];
  readonly blobs = new Map<string, Buffer>();
  readonly docs = new Map<string, string>();
  readonly writes: string[] = [];
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
        if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) return send(200, { entries: this.entries });
        const text = /^\/docs\/([^/]+)\/text$/.exec(url.pathname);
        if (text) return send(200, { docId: text[1], text: this.docs.get(text[1]) ?? "", status: "synced" });
        if (/\/projects\/[^/]+\/file-blob$/.test(url.pathname)) {
          const relative = url.searchParams.get("path") ?? "";
          if (this.entries.some((entry) => entry.path === relative && entry.kind === "doc")) return send(409, { error: { code: "conflict", message: "This path is not a binary file." } });
          const bytes = this.blobs.get(relative);
          return send(200, bytes ? { fileId: `fil_${relative}`, blobHash: sha(bytes), contentBase64: bytes.toString("base64") } : { contentBase64: null });
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as { op: string; path: string; contentBase64?: string };
        this.writes.push(op.path);
        if (op.op === "write-blob") this.blobs.set(op.path, Buffer.from(op.contentBase64 ?? "", "base64"));
        return send(200, { paths: [`Shared/${op.path}`], fileId: "fil_new" });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() { await new Promise<void>((resolve) => this.server?.close(() => resolve())); }
}

const entry = (relative: string, kind: FileListEntry["kind"], extra: Partial<FileListEntry> = {}): FileListEntry => ({ fileId: `fil_${relative}`, path: relative, kind, updatedAt: 1, ...extra });

async function withShared(run: (fixture: { host: StubHost; notebook: string }) => Promise<void>) {
  const host = new StubHost();
  await host.start();
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-audit-1119-reads-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  process.env.LIBERA_DATA_DIR = path.join(root, "library");
  process.env.LIBERA_CONFIG_PATH = path.join(root, "user-data", "config.json");
  const notebook = path.join(root, "library", "users", "admin", "Shared");
  await mkdir(notebook, { recursive: true });
  await writeFile(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  resetInkStorageForTests();
  invalidateSharedNotebookCache();
  try { await run({ host, notebook }); } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    resetInkStorageForTests();
    invalidateSharedNotebookCache();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function put(file: string, content: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

test("finding 26: a shared notebook's ZIP lists the manifest, not the disk", () => withShared(async ({ host, notebook }) => {
  host.entries = [
    entry("note.md", "doc", { docId: "d1", docKind: "markdown" }),
    entry("pics", "folder"),
    entry("pics/new.png", "blob", { blobHash: "h" }),
  ];
  host.docs.set("d1", "host text");
  host.blobs.set("pics/new.png", Buffer.from("png-new"));
  // The disk lags: the old text, a file the host deleted, and none of the new picture.
  await put(path.join(notebook, "note.md"), "stale text");
  await put(path.join(notebook, "deleted.md"), "gone on the host");
  // Never in the manifest: the local archive and hidden bookkeeping.
  await put(path.join(notebook, "_archive", "old.md"), "archived here");

  const { body } = await createNotebookZip("Shared");
  const zip = await JSZip.loadAsync(body);
  assert.equal(await zip.file("Shared/note.md")!.async("string"), "host text", "document text comes from the host");
  assert.equal(await zip.file("Shared/pics/new.png")!.async("string"), "png-new", "a file not yet on this disk is exported");
  assert.equal(zip.file("Shared/deleted.md"), null, "a path the manifest no longer lists is not exported from the disk");
  assert.equal(await zip.file("Shared/_archive/old.md")!.async("string"), "archived here", "local-only content still comes from the disk");
  assert.ok(zip.file("Shared/.libera-shared.json"), "bookkeeping the manifest never holds still comes from the disk");
}));

test("finding 27: a markdown copy reads its images from the host, a viewer from the disk", () => withShared(async ({ host, notebook }) => {
  const asset = "_assets/note/abc/img.png";
  await put(path.join(notebook, ...asset.split("/")), "old pixels");
  host.entries = [entry(asset, "blob", { blobHash: "h" })];
  host.blobs.set(asset, Buffer.from("new pixels"));
  const source = `/api/markdown-assets/raw?document=${encodeURIComponent("Shared/note.md")}&asset=${encodeURIComponent(asset)}`;
  assert.equal((await getMarkdownImageAssetBySource("Shared/note.md", source, { authoritative: true })).body.toString(), "new pixels");
  assert.equal((await getMarkdownImageAssetBySource("Shared/note.md", source)).body.toString(), "old pixels", "serving an image is unchanged");
}));

function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    version: TRANSCRIPT_VERSION,
    createdAt: "2026-10-19T10:00:00.000Z",
    audio: { size: 5, modifiedAt: "2026-10-19T09:00:00.000Z", duration: 20 },
    engine: { kind: "local", model: "m" },
    language: "en",
    diarization: null,
    speakers: [{ name: "Speaker 1", talkSeconds: 8, share: 1, segments: 1 }],
    segments: [{ start: 0, end: 4, speaker: 0, text: "Hello." }],
    stats: { words: 1, chunks: 1, elapsedMs: 1000 },
    ...overrides,
  };
}

test("finding 27: copying a recording's transcript does not need the copy on this disk", () => withShared(async ({ host, notebook }) => {
  await put(path.join(notebook, "a.wav"), "RIFFa");
  await put(path.join(notebook, "a.wav.transcript"), JSON.stringify(transcript()));
  // b.wav was committed through the host and OneDrive has not delivered it.
  await copyTranscript("Shared/a.wav", "Shared/b.wav");
  assert.ok(host.writes.includes("b.wav.transcript"), "the transcript went through the host");
  assert.equal(existsSync(path.join(notebook, "b.wav")), false);
}));

test("finding 27: LaTeX builds stage unopened inputs and bibliographies from the host", () => withShared(async ({ host, notebook }) => {
  host.entries = [
    entry("main.tex", "doc", { docId: "d_main", docKind: "latex" }),
    entry("chapter.tex", "doc", { docId: "d_chapter", docKind: "latex" }),
    entry("chapter2.tex", "doc", { docId: "d_chapter2", docKind: "latex" }),
    entry("refs.bib", "doc", { docId: "d_bib", docKind: "text" }),
    entry("figure.png", "blob", { blobHash: "h" }),
  ];
  host.docs.set("d_main", "\\input{chapter}");
  host.docs.set("d_chapter", "host chapter");
  host.docs.set("d_chapter2", "host chapter two");
  host.docs.set("d_bib", "@book{host}");
  await put(path.join(notebook, "chapter.tex"), "stale chapter");
  const request = { rootPath: "Shared/main.tex", drafts: { "Shared/chapter2.tex": "draft chapter two" } };
  const paths = latexBuildPaths(request.rootPath);
  try {
    await mkdir(paths.workDirectory, { recursive: true });
    const { rootSource, overrides } = await stageSources(paths, request);
    assert.equal(rootSource, "\\input{chapter}", "the main file is the host's when there is no draft");
    assert.equal(await readFile(path.join(paths.workDirectory, "chapter.tex"), "utf8"), "host chapter");
    assert.equal(await readFile(path.join(paths.workDirectory, "refs.bib"), "utf8"), "@book{host}");
    assert.equal(await readFile(path.join(paths.workDirectory, "chapter2.tex"), "utf8"), "draft chapter two", "an editor draft wins over the host");
    assert.deepEqual([...overrides].sort(), ["chapter.tex", "chapter2.tex", "refs.bib"]);
  } finally { await rm(paths.buildDirectory, { recursive: true, force: true }); }
}));

test("finding 42: transcript freshness hashes an unchanged recording once, and progress polls read no transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-audit-1119-progress-"));
  const saved = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(root, "library");
  const spy = mock.method(fs, "createReadStream");
  try {
    const audio = filePathFromParts("Notes", ["memo.wav"]);
    await put(audio, "RIFFmemo");
    const hash = sha(Buffer.from("RIFFmemo"));
    await put(transcriptPath("Notes", ["memo.wav"]), JSON.stringify(transcript({ audio: { size: 8, modifiedAt: "", duration: 1, contentHash: hash } })));
    spy.mock.resetCalls();
    for (let poll = 0; poll < 3; poll += 1) assert.equal((await readTranscript("Notes/memo.wav")).stale, false);
    assert.equal(spy.mock.calls.filter((call) => call.arguments[0] === audio).length, 1, "three requests read the recording once");
    assert.equal(await readCachedFileContentHash(audio), hash);
    // A recording that changes is hashed again.
    await put(audio, "RIFFnew!");
    assert.equal((await readTranscript("Notes/memo.wav")).stale, true);

    spy.mock.resetCalls();
    const response = await getTranscriptProgress(new NextRequest(`http://localhost/api/transcripts/progress?path=${encodeURIComponent("Notes/memo.wav")}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } }));
    assert.deepEqual(await response.json(), { path: "Notes/memo.wav", job: null }, "job status only: no transcript, no version");
    assert.equal(spy.mock.calls.length, 0, "the progress endpoint reads no file");
  } finally {
    spy.mock.restore();
    if (saved === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = saved;
    await rm(root, { recursive: true, force: true });
  }
});

let counter = 0;
function stroke(): InkStroke {
  counter += 1;
  const samples = [{ x: 20, y: 20 + counter, pressure: 0.4 }, { x: 300, y: 30 + counter, pressure: 0.8 }];
  return { id: `s${counter}x`, brush: "pen", color: "#1f2328", opacity: 1, width: 2, lineStyle: "solid", points: encodeInkSamples(samples), bounds: sampleBounds(samples), createdAt: new Date(1_700_000_000_000 + counter).toISOString() };
}

test("finding 21: a shared ink save merges authors listed by the host whose files are not on this disk", () => withShared(async ({ host, notebook }) => {
  await put(path.join(notebook, "note.md"), "note\n");
  const chunk = inkBlockChunk("k3f9q2m8x1c4v7b0");
  const other = "othr4uthor1";
  const theirs = stroke();
  const file = Buffer.from(`${JSON.stringify({ ...emptyInkAuthorFile({ key: other }, inkBlockFrame()), strokes: [theirs], revision: 1 })}\n`, "utf8");
  const relative = inkLibraryPath("Shared", ["note.md"], inkFileName(chunk, other)).slice("Shared/".length);
  // The author's file is in the manifest and the blob store, never on this disk.
  host.entries = [entry(relative, "blob", { blobHash: sha(file) })];
  host.blobs.set(relative, file);
  const saved = await writeInk("Shared/note.md", chunk, { add: [stroke()] }, inkBlockFrame(), { rendering: inkBlockSource("Shared/note.md", "k3f9q2m8x1c4v7b0") });
  assert.ok(saved.chunks[0].strokes.some((item) => item.stroke.id === theirs.id), "the author with no file here is merged");
}));

test("finding 14: an audio sidecar move whose recording arrives later is replayed on the next refresh", () => withShared(async ({ notebook }) => {
  const bytes = Buffer.from("RIFFmove");
  await put(path.join(notebook, "old.wav"), bytes);
  const previous = transcriptPath("Shared", ["old.wav"]);
  await put(previous, JSON.stringify(transcript({ audio: { size: bytes.length, modifiedAt: "", duration: 1, contentHash: sha(bytes) } })));
  // The host reports the rename before the renamed recording reaches this folder.
  assert.equal(await followSharedAudioChanges([{ from: "Shared/old.wav", to: "Shared/new.wav" }], []), 0);
  const moved = transcriptPath("Shared", ["new.wav"]);
  assert.equal(existsSync(moved), false);
  // OneDrive delivers the recording; nothing re-announces the move.
  await put(path.join(notebook, "new.wav"), bytes);
  await pruneAudioSidecars("Shared");
  assert.equal(JSON.parse(await readFile(moved, "utf8")).audio.contentHash, sha(bytes), "the transcript followed the recording");
  assert.ok(existsSync(previous), "the source sidecar stays");
}));
