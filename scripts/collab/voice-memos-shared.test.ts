import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { copyFileIntoSharedDirectory, deleteSharedFile, moveSharedFile, sharedIncomingDirectory, writeSharedBlob } from "../../src/lib/collab/shared-writes";
import type { FileOpRequest } from "../../src/lib/collab/local-api";
import { audioPeaksPath, transcriptPath } from "../../src/lib/storage/paths";
import { getTree } from "../../src/lib/storage/tree";
import { followSharedAudioChanges, readTranscript, recordingForCompanion, writeTranscript } from "../../src/lib/storage/transcripts";
import { TRANSCRIPT_VERSION, type Transcript } from "../../src/lib/transcription/types";

const TRANSCRIPT: Transcript = {
  version: TRANSCRIPT_VERSION,
  createdAt: "2026-10-19T10:00:00.000Z",
  audio: { size: 9, modifiedAt: "", duration: 12 },
  engine: { kind: "local", model: "Parakeet TDT 0.6B v3" },
  language: "en",
  diarization: null,
  speakers: [{ name: "Vy", talkSeconds: 10, share: 1, segments: 1 }],
  segments: [{ start: 1, end: 5, speaker: 0, text: "The budget is approved." }],
  stats: { words: 4, chunks: 1, elapsedMs: 5 },
};

/** Just enough of the collab host's control API: file operations on the working copy, as the host makes them. */
class FakeHost {
  readonly ops: FileOpRequest[] = [];
  readonly staged: string[] = [];
  refuse = false;
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
        if (request.headers.authorization !== `Bearer ${this.token}` || !/\/projects\/[^/]+\/files$/.test(request.url ?? "")) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        if (this.refuse) return send(403, { error: { code: "forbidden", message: "Your role cannot add, rename or delete files." } });
        const target = path.join(this.notebookRoot, ...op.path.split("/"));
        if (op.op === "write-blob") {
          let bytes: Buffer;
          if (op.stagedFile) {
            const staged = path.join(this.notebookRoot, ".libera", "collab", "incoming", op.stagedFile);
            bytes = readFileSync(staged);
            this.staged.push(op.stagedFile);
            rmSync(staged);
          } else {
            bytes = Buffer.from(op.contentBase64 ?? "", "base64");
          }
          if (op.createOnly && existsSync(target)) return send(409, { error: { code: "conflict", message: "Exists." } });
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, bytes);
          return send(200, { paths: [`Shared/${op.path}`] });
        }
        if (op.op === "rename") {
          if (!existsSync(target)) return send(404, { error: { code: "not-found", message: "Not found." } });
          renameSync(target, path.join(this.notebookRoot, ...(op.to ?? "").split("/")));
          return send(200, { paths: [`Shared/${op.path}`, `Shared/${op.to}`] });
        }
        if (op.op === "delete") {
          if (!existsSync(target)) return send(404, { error: { code: "not-found", message: "Not found." } });
          rmSync(target);
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

async function withSharedNotebook(run: (fixture: { root: string; host: FakeHost }) => Promise<void>) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-voice-shared-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const root = path.join(dataDir, "users", "admin");
  mkdirSync(path.join(root, "Shared", "memos"), { recursive: true });
  mkdirSync(path.join(root, "Local"), { recursive: true });
  writeFileSync(path.join(root, "Shared", "memos", "memo.m4a"), "m4a audio");
  writeFileSync(path.join(root, "Local", "talk.m4a"), "m4a audio");
  writeFileSync(path.join(root, "Shared", ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new FakeHost(path.join(root, "Shared"));
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  try {
    await run({ root, host });
  } finally {
    await host.stop();
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("a transcript in a shared notebook is a companion blob members receive, never listed as a file", async () => {
  await withSharedNotebook(async ({ root, host }) => {
    const result = await writeTranscript("Shared/memos/memo.m4a", TRANSCRIPT);
    assert.equal(result.shared, true);
    assert.deepEqual(host.ops.map((op) => [op.op, op.path]), [["write-blob", "memos/memo.m4a.transcript"]]);
    assert.ok(existsSync(path.join(root, "Shared", "memos", "memo.m4a.transcript")));
    assert.ok(!existsSync(transcriptPath("Shared", ["memos", "memo.m4a"])), "nothing is kept only on this computer");
    const read = await readTranscript("Shared/memos/memo.m4a");
    assert.equal(read.shared, true);
    assert.equal(read.transcript?.speakers[0].name, "Vy");

    const tree = await getTree();
    const shared = tree.notebooks.find((notebook) => notebook.name === "Shared")!;
    const names = JSON.stringify(shared.children);
    assert.ok(names.includes("memo.m4a"));
    assert.ok(!names.includes(".transcript"), "the companion is not a library file");
    assert.equal(recordingForCompanion("Shared/memos/memo.m4a.transcript"), "Shared/memos/memo.m4a");
    assert.equal(recordingForCompanion("Shared/notes.md"), null);
  });
});

test("renaming and deleting a shared recording carry its companion transcript and local waveform along", async () => {
  await withSharedNotebook(async ({ host }) => {
    await writeTranscript("Shared/memos/memo.m4a", TRANSCRIPT);
    const peaks = audioPeaksPath("Shared", ["memos", "memo.m4a"]);
    mkdirSync(path.dirname(peaks), { recursive: true });
    writeFileSync(peaks, "{}");
    host.ops.length = 0;

    await moveSharedFile("Shared/memos/memo.m4a", "Shared/memos", "standup.m4a");
    assert.deepEqual(host.ops.map((op) => [op.op, op.path, op.to]), [
      ["rename", "memos/memo.m4a", "memos/standup.m4a"],
      ["rename", "memos/memo.m4a.transcript", "memos/standup.m4a.transcript"],
    ]);
    assert.equal((await readTranscript("Shared/memos/standup.m4a")).transcript?.segments[0].text, "The budget is approved.");
    assert.ok(existsSync(audioPeaksPath("Shared", ["memos", "standup.m4a"])));
    assert.ok(!existsSync(peaks));

    host.ops.length = 0;
    await deleteSharedFile("Shared/memos/standup.m4a");
    assert.deepEqual(host.ops.map((op) => [op.op, op.path]), [["delete", "memos/standup.m4a"], ["delete", "memos/standup.m4a.transcript"]]);
    assert.ok(!existsSync(audioPeaksPath("Shared", ["memos", "standup.m4a"])));
  });
});

test("collaborators' renames and deletions move this computer's sidecars", async () => {
  await withSharedNotebook(async () => {
    const peaks = audioPeaksPath("Shared", ["memos", "memo.m4a"]);
    mkdirSync(path.dirname(peaks), { recursive: true });
    writeFileSync(peaks, "{}");
    assert.equal(await followSharedAudioChanges([{ from: "Shared/memos/memo.m4a", to: "Shared/memo.m4a" }], []), 1);
    assert.ok(existsSync(audioPeaksPath("Shared", ["memo.m4a"])));
    assert.equal(await followSharedAudioChanges([], ["Shared/memo.m4a"]), 1);
    assert.ok(!existsSync(audioPeaksPath("Shared", ["memo.m4a"])));
    assert.equal(await followSharedAudioChanges([{ from: "Shared/a.md", to: "Shared/b.md" }], []), 0);
  });
});

test("a member who may not change files keeps the transcript on this computer", async () => {
  await withSharedNotebook(async ({ host }) => {
    host.refuse = true;
    const result = await writeTranscript("Shared/memos/memo.m4a", TRANSCRIPT);
    assert.equal(result.shared, false);
    assert.ok(existsSync(transcriptPath("Shared", ["memos", "memo.m4a"])));
    const read = await readTranscript("Shared/memos/memo.m4a");
    assert.equal(read.shared, false);
    assert.equal(read.transcript?.speakers[0].name, "Vy");
  });
});

test("copying a recording into a shared notebook shares its transcript too", async () => {
  await withSharedNotebook(async ({ root, host }) => {
    await writeTranscript("Local/talk.m4a", TRANSCRIPT);
    await copyFileIntoSharedDirectory("Local/talk.m4a", "Shared/memos");
    assert.deepEqual(host.ops.map((op) => [op.op, op.path]), [["write-blob", "memos/talk copy.m4a"], ["write-blob", "memos/talk copy.m4a.transcript"]]);
    assert.ok(existsSync(path.join(root, "Shared", "memos", "talk copy.m4a.transcript")));
  });
});

test("recordings too large for a request are staged for the host and cleaned up", async () => {
  await withSharedNotebook(async ({ root, host }) => {
    const bytes = new Uint8Array(12 * 1024 * 1024).fill(7);
    await writeSharedBlob("Shared/memos/long.m4a", bytes);
    const [op] = host.ops;
    assert.equal(op.op, "write-blob");
    assert.equal(op.contentBase64, undefined);
    assert.match(op.stagedFile ?? "", /^[A-Za-z0-9_-]{8,80}$/);
    assert.equal(readFileSync(path.join(root, "Shared", "memos", "long.m4a")).byteLength, bytes.byteLength);
    assert.equal(sharedIncomingDirectory("Shared"), path.join(root, "Shared", ".libera", "collab", "incoming"));
    assert.ok(!existsSync(path.join(sharedIncomingDirectory("Shared"), op.stagedFile!)));
    await assert.rejects(writeSharedBlob("Shared/huge.m4a", new Uint8Array(101 * 1024 * 1024)), /too large/);
  });
});
