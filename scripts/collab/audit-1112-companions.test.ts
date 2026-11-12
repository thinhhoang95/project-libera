// Regressions for the 2026-11-12 sync audit's companion findings: transcript
// edits against the authoritative shared version (DATA-7), a pending local
// correction that reads keep showing (DATA-8), a recording's transcript moving
// and going in the recording's own manifest change (STALE-2), and PDF sidecar
// reconciliation in shared notebooks (DATA-19).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { FileOpRequest } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { ORPHAN_GRACE_MS, ORPHAN_RETENTION_MS, reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { editTranscriptSegments, readTranscript, renameTranscriptSpeakers } from "../../src/lib/storage/transcripts";
import { TRANSCRIPT_VERSION, type Transcript } from "../../src/lib/transcription/types";

const transcriptOf = (text: string, speaker = "Vy"): Transcript => ({
  version: TRANSCRIPT_VERSION,
  createdAt: "2026-10-19T10:00:00.000Z",
  audio: { size: 9, modifiedAt: "", duration: 12 },
  engine: { kind: "local", model: "Parakeet TDT 0.6B v3" },
  language: "en",
  diarization: null,
  speakers: [{ name: speaker, talkSeconds: 10, share: 1, segments: 1 }],
  segments: [{ start: 1, end: 5, speaker: 0, text }],
  stats: { words: 4, chunks: 1, elapsedMs: 5 },
});

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A host whose shared state (`authority`) is independent of the disk, which can lag behind it. */
class LaggingHost {
  readonly ops: FileOpRequest[] = [];
  readonly authority = new Map<string, Buffer>();
  refuse = false;
  /** Runs before the next write-blob is checked: another member saving first. */
  beforeWrite: (() => void) | null = null;
  private server: Server | null = null;
  url = "";
  readonly token = "test-token";

  async start() {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const send = (status: number, payload: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.headers.authorization !== `Bearer ${this.token}`) return send(404, { error: { code: "not-found", message: "No route." } });
        const url = new URL(request.url ?? "", "http://host");
        if (request.method === "GET" && /\/file-blob$/.test(url.pathname)) {
          const bytes = this.authority.get(url.searchParams.get("path") ?? "");
          return send(200, bytes ? { fileId: "fil_1", blobHash: sha(bytes), contentBase64: bytes.toString("base64") } : { fileId: null, blobHash: null, contentBase64: null });
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        if (this.refuse) return send(403, { error: { code: "forbidden", message: "Your role cannot add, rename or delete files." } });
        if (op.op === "write-blob") {
          this.beforeWrite?.();
          this.beforeWrite = null;
          const existing = this.authority.get(op.path);
          if (op.createOnly && existing) return send(409, { error: { code: "conflict", message: "Exists." } });
          if (op.expectedBlobHash !== undefined && (!existing || sha(existing) !== op.expectedBlobHash)) return send(409, { error: { code: "conflict", message: "This file changed before the upload began." } });
          this.authority.set(op.path, Buffer.from(op.contentBase64 ?? "", "base64"));
          return send(200, { paths: [`Shared/${op.path}`] });
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

async function withShared(run: (fixture: { root: string; host: LaggingHost; companion: string }) => Promise<void>) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-audit-1112-companions-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const root = path.join(dataDir, "users", "admin");
  mkdirSync(path.join(root, "Shared", "memos"), { recursive: true });
  writeFileSync(path.join(root, "Shared", "memos", "memo.m4a"), "m4a audio");
  writeFileSync(path.join(root, "Shared", ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new LaggingHost();
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  try {
    await run({ root, host, companion: path.join(root, "Shared", "memos", "memo.m4a.transcript") });
  } finally {
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const RECORDING = "Shared/memos/memo.m4a";
const COMPANION = "memos/memo.m4a.transcript";
const shared = (host: LaggingHost) => JSON.parse(host.authority.get(COMPANION)!.toString("utf8")) as Transcript;

test("DATA-7: a speaker rename is made on the host's newer transcript, not the stale disk copy", async () => {
  await withShared(async ({ host, companion }) => {
    writeFileSync(companion, JSON.stringify(transcriptOf("old text")));
    host.authority.set(COMPANION, Buffer.from(JSON.stringify(transcriptOf("newer text from another member"))));
    await renameTranscriptSpeakers(RECORDING, { 0: "Dana" });
    const written = shared(host);
    assert.equal(written.speakers[0].name, "Dana");
    assert.equal(written.segments[0].text, "newer text from another member");
    const op = host.ops.find((entry) => entry.op === "write-blob")!;
    assert.ok(op.expectedBlobHash, "the replacement names the version it was based on");
  });
});

test("DATA-7: a transcript saved by someone else between read and write is not overwritten", async () => {
  await withShared(async ({ host }) => {
    host.authority.set(COMPANION, Buffer.from(JSON.stringify(transcriptOf("first"))));
    host.beforeWrite = () => host.authority.set(COMPANION, Buffer.from(JSON.stringify(transcriptOf("second, saved concurrently"))));
    await editTranscriptSegments(RECORDING, [{ start: 1, end: 5, speaker: 0, text: "my correction" }]);
    // The edit was made again on top of the concurrent version, never over it silently.
    assert.equal(host.ops.filter((entry) => entry.op === "write-blob").length, 2);
    assert.equal(shared(host).segments[0].text, "my correction");
    assert.equal(shared(host).speakers[0].name, "Vy");
  });
});

test("DATA-8: a correction that could not be shared stays the version read, until it is shared", async () => {
  await withShared(async ({ host, companion }) => {
    const older = transcriptOf("older companion");
    host.authority.set(COMPANION, Buffer.from(JSON.stringify(older)));
    writeFileSync(companion, JSON.stringify(older));
    host.refuse = true;
    await renameTranscriptSpeakers(RECORDING, { 0: "Kept Locally" });
    const read = await readTranscript(RECORDING);
    assert.equal(read.transcript?.speakers[0].name, "Kept Locally", "the companion on disk does not hide it");
    assert.equal(read.pending, true);
    assert.equal(read.shared, false);
    assert.equal(JSON.parse(readFileSync(companion, "utf8")).speakers[0].name, "Vy", "the shared copy is untouched");

    host.refuse = false;
    await renameTranscriptSpeakers(RECORDING, { 0: "Shared Now" });
    assert.equal(shared(host).speakers[0].name, "Shared Now");
    writeFileSync(companion, JSON.stringify(shared(host)));
    const after = await readTranscript(RECORDING);
    assert.equal(after.pending, undefined);
    assert.equal(after.transcript?.speakers[0].name, "Shared Now");
    assert.equal(after.shared, true);
  });
});

test("DATA-8: a pending correction is not shared over a newer shared transcript", async () => {
  await withShared(async ({ host, companion }) => {
    const older = transcriptOf("older companion");
    host.authority.set(COMPANION, Buffer.from(JSON.stringify(older)));
    writeFileSync(companion, JSON.stringify(older));
    host.refuse = true;
    await renameTranscriptSpeakers(RECORDING, { 0: "Mine" });
    host.refuse = false;
    host.authority.set(COMPANION, Buffer.from(JSON.stringify(transcriptOf("newer from someone else"))));
    await renameTranscriptSpeakers(RECORDING, { 0: "Mine Again" });
    assert.equal(shared(host).segments[0].text, "newer from someone else", "the newer shared transcript is not replaced");
    assert.equal((await readTranscript(RECORDING)).transcript?.speakers[0].name, "Mine Again", "nothing of the local work is lost");
  });
});

test("DATA-19: a shared notebook's PDF sidecar is not re-attached to another PDF with the same bytes", async () => {
  await withShared(async ({ root }) => {
    const bytes = "%PDF-1.4 identical\n";
    writeFileSync(path.join(root, "Shared", "b.pdf"), bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const sidecar = pdfAnnotationsPath("Shared", ["a.pdf"]);
    mkdirSync(path.dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, JSON.stringify({ version: 1, annotations: [], source: { size: bytes.length, contentHash: digest } }));
    const now = Date.now();
    await reconcilePdfSidecars("Shared", [{ path: "Shared/b.pdf", size: bytes.length }], { now });
    await reconcilePdfSidecars("Shared", [{ path: "Shared/b.pdf", size: bytes.length }], { now: now + ORPHAN_GRACE_MS + ORPHAN_RETENTION_MS });
    assert.ok(existsSync(sidecar), "the original PDF may only be late: its sidecar stays");
    assert.ok(!existsSync(pdfAnnotationsPath("Shared", ["b.pdf"])));
  });
});

test("STALE-2: a recording's transcript moves and goes in the recording's own manifest change", { timeout: 120_000 }, async () => {
  const { readManifest } = await import("../../electron/collab/notebooks/layout");
  const { ControlRoutes } = await import("../../src/lib/collab/local-api");
  const { closePeer, makePeer, register, tempRoot, writeTree } = await import("./support/notebooks-harness");
  const { removeDataDir, startServerProcess } = await import("./support/server-process");
  const temp = tempRoot("libera-audit-1112-stale2-");
  const server = await startServerProcess();
  try {
    const auth = await register(server, "CompanionOwner");
    const owner = await makePeer(temp.dir, "companion-1", server, auth, {});
    try {
      writeTree(path.join(owner.library, "Memos"), { "a.m4a": "audio a", "a.m4a.transcript": "{}", "b.m4a": "audio b", "b.m4a.transcript": "{}", "c.m4a": "audio c", "c.m4a.transcript": "{}" });
      const sharedNotebook = await owner.service.share({ notebook: "Memos" });
      const project = owner.service.project(sharedNotebook.projectId)!;
      await project.whenIdle();
      const paths = () => {
        const hub = owner.host.acquire(project.info.manifestDocId);
        try { return [...readManifest(hub.getDoc("manifest")).values()].map((entry) => entry.path).sort(); } finally { owner.host.release(project.info.manifestDocId); }
      };
      const call = (body: object) => owner.router.call("POST", ControlRoutes.files(sharedNotebook.projectId), body);
      assert.equal((await call({ op: "rename", path: "a.m4a", to: "z.m4a" })).status, 200);
      assert.ok(paths().includes("z.m4a.transcript") && !paths().includes("a.m4a.transcript"), paths().join(", "));
      assert.equal((await call({ op: "delete", path: "b.m4a" })).status, 200);
      assert.ok(!paths().includes("b.m4a.transcript"), paths().join(", "));
      assert.equal((await call({ op: "rename", path: "c.m4a", to: "c.png" })).status, 200);
      assert.ok(!paths().includes("c.m4a.transcript"), paths().join(", "));
    } finally {
      await closePeer(owner).catch(() => undefined);
    }
  } finally {
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
