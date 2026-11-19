// Regressions for the 2026-11-19 sync audit's host identity findings:
// rename and delete name the file the UI saw (1), a shared rename carries the
// records a local rename does (13), a rename never changes a file's kind or
// drops its records (20), and a create answers with the id and path the layout
// gave the new file (25). The shared-writes cases run against a stub control
// API; the host cases against a real host and server.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { entryRecord } from "../../electron/collab/notebooks/layout";
import type { FileListResponse, FileOpRequest } from "../../src/lib/collab/local-api";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import type { FetchLike } from "../../electron/collab/core";
import { ManifestKeys } from "../../src/lib/collab/protocol/schema";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { createSharedMarkdownFile, deleteSharedFile, moveSharedFile } from "../../src/lib/collab/shared-writes";
import { definitionsPath, imageAnnotationsPath } from "../../src/lib/storage/paths";
import { closePeer, makePeer, readText, register, tempRoot, until } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

// ------------------------------------------------------------ shared-writes against a stub host

class StubHost {
  readonly ops: FileOpRequest[] = [];
  /** Which file id each path holds on the host. */
  readonly ids = new Map<string, string>();
  /** What a create answers (paths as the host's layout placed them). */
  createdPaths: string[] | null = null;
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
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        if (op.expectedFileId !== undefined && this.ids.get(op.path) !== op.expectedFileId) {
          return send(409, { error: { code: "conflict", message: "This file changed since it was read. Refresh it before changing it." } });
        }
        if (op.op === "create-file") return send(200, { paths: this.createdPaths ?? [`Shared/${op.path}`], fileId: "fil_new" });
        return send(200, { paths: [`Shared/${op.path}`] });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

async function withShared(run: (fixture: { dataDir: string; notebook: string; host: StubHost }) => Promise<void>) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-audit-1119-identity-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(path.join(notebook, "pics"), { recursive: true });
  writeFileSync(path.join(notebook, "note.md"), "note\n");
  writeFileSync(path.join(notebook, "pics", "photo.png"), "png bytes");
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const host = new StubHost();
  await host.start();
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = host.url;
  process.env.LIBERA_COLLAB_HOST_TOKEN = host.token;
  try {
    await run({ dataDir, notebook, host });
  } finally {
    await host.stop();
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("1: rename and delete send the file id the caller saw, and a reassigned path is refused", () => withShared(async ({ notebook, host }) => {
  host.ids.set("note.md", "fil_a");
  await moveSharedFile("Shared/note.md", "Shared", "renamed.md", { expectedFileId: "fil_a" });
  assert.equal(host.ops.at(-1)?.expectedFileId, "fil_a");
  assert.equal(host.ops.at(-1)?.op, "rename");

  // The path now belongs to another file: nothing is renamed or deleted.
  host.ids.set("note.md", "fil_b");
  await assert.rejects(moveSharedFile("Shared/note.md", "Shared", "again.md", { expectedFileId: "fil_a" }), (error: { status?: number }) => error.status === 409);
  await assert.rejects(deleteSharedFile("Shared/note.md", { expectedFileId: "fil_a" }), (error: { status?: number }) => error.status === 409);
  await deleteSharedFile("Shared/note.md", { expectedFileId: "fil_b" });
  assert.equal(host.ops.at(-1)?.expectedFileId, "fil_b");
  assert.equal(host.ops.at(-1)?.op, "delete");

  // Callers without an id act on the path, as before.
  await deleteSharedFile("Shared/note.md");
  assert.equal(host.ops.at(-1)?.expectedFileId, undefined);
  assert.ok(existsSync(notebook));
}));

test("13: a shared rename moves the records kept on this computer, never over an existing one", () => withShared(async ({ host }) => {
  const imageRecord = imageAnnotationsPath("Shared", ["pics", "photo.png"]);
  const definitions = definitionsPath("Shared", ["note.md"]);
  mkdirSync(path.dirname(imageRecord), { recursive: true });
  mkdirSync(path.dirname(definitions), { recursive: true });
  writeFileSync(imageRecord, '{"annotations":[]}');
  writeFileSync(definitions, '{"entries":[]}');

  await moveSharedFile("Shared/pics/photo.png", "Shared/pics", "photo2.png");
  assert.equal(existsSync(imageRecord), false, "the image annotations left the old path");
  assert.equal(readFileSync(imageAnnotationsPath("Shared", ["pics", "photo2.png"]), "utf8"), '{"annotations":[]}');

  // A record already at the destination is kept; the source stays where it is.
  const occupied = definitionsPath("Shared", ["taken.md"]);
  writeFileSync(occupied, '{"entries":["mine"]}');
  await moveSharedFile("Shared/note.md", "Shared", "taken.md");
  assert.equal(readFileSync(occupied, "utf8"), '{"entries":["mine"]}');
  assert.equal(readFileSync(definitions, "utf8"), '{"entries":[]}');
  assert.equal(host.ops.filter((op) => op.op === "rename").length, 2);
}));

test("25: a create returns the path the host's layout gave the file", () => withShared(async ({ host }) => {
  host.createdPaths = ["Shared/fresh (2).md"];
  const created = await createSharedMarkdownFile("Shared", "fresh.md", "text");
  assert.equal(created.file.path, "Shared/fresh (2).md");
}));

// ------------------------------------------------------------ a real host

test("host: rename keeps a file's kind and records, moves a note's Python, and creates answer with id and path", { timeout: 180_000 }, async () => {
  const temp = tempRoot("libera-audit-1119-host-");
  const server = await startServerProcess();
  let injected = false;
  const injections: Array<() => void> = [];
  const racing: FetchLike = async (input, init) => {
    const url = input;
    if (!injected && init?.method === "POST" && /\/documents$/.test(new URL(url).pathname) && injections.length) {
      injected = true;
      injections.shift()!();
    }
    return fetch(input as never, init);
  };
  const auth = await register(server, "Alice");
  const alice = await makePeer(temp.dir, "alice", server, auth, { fetch: racing });
  try {
    const root = path.join(alice.library, "Notes");
    mkdirSync(path.join(root, "_assets", "a.md"), { recursive: true });
    writeFileSync(path.join(root, "a.md"), "# A\n");
    writeFileSync(path.join(root, "_assets", "a.md", "a.py"), "print('hi')\n");
    writeFileSync(path.join(root, "pic.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), Buffer.from("pixels")]));
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Notes" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    const files = ControlRoutes.files(projectId);
    const op = (request: FileOpRequest) => alice.router.call("POST", files, request);

    // 20: a document never becomes a binary file, a binary never becomes a document.
    const toPng = await op({ op: "rename", path: "a.md", to: "a.png" });
    assert.equal(toPng.status, 409, JSON.stringify(toPng.body));
    const toMd = await op({ op: "rename", path: "pic.png", to: "pic.md" });
    assert.equal(toMd.status, 409, JSON.stringify(toMd.body));
    const toTxt = await op({ op: "rename", path: "a.md", to: "a.txt" });
    assert.equal(toTxt.status, 409, "a docKind change is refused too");

    // 13: the note's Python code follows it in the same host operation.
    const renamed = await op({ op: "rename", path: "a.md", to: "b.md" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    await until(() => readText(root, "_assets/b.md/b.py") === "print('hi')\n", "the Python code at the renamed note's path");
    assert.equal(existsSync(path.join(root, "_assets", "a.md", "a.py")), false);

    // Another markdown extension keeps the Python code too.
    const dropped = await op({ op: "rename", path: "b.md", to: "b.markdown" });
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
    await until(() => readText(root, "_assets/b.markdown/b.py") === "print('hi')\n", "the Python code follows to .markdown");

    // 20: ink and a transcript are never deleted by a rename that cannot keep them.
    const bytes = (text: string) => Buffer.from(text).toString("base64");
    for (const [name, content] of [["_ink/pic.png/stroke.json", "{}"], ["memo.m4a", "audio"], ["memo.m4a.transcript", "{}"]]) {
      const added = await op({ op: "write-blob", path: name, contentBase64: bytes(content) });
      assert.equal(added.status, 200, JSON.stringify(added.body));
    }
    const inkLoss = await op({ op: "rename", path: "pic.png", to: "pic.jpg" });
    assert.equal(inkLoss.status, 409, JSON.stringify(inkLoss.body));
    const transcriptLoss = await op({ op: "rename", path: "memo.m4a", to: "memo.png" });
    assert.equal(transcriptLoss.status, 409, JSON.stringify(transcriptLoss.body));
    const kept = await op({ op: "rename", path: "memo.m4a", to: "memo.mp3" });
    assert.equal(kept.status, 200, "a recording renamed to another audio type keeps its transcript");
    await until(() => existsSync(path.join(root, "memo.mp3.transcript")), "the transcript beside the renamed recording");
    assert.ok(existsSync(path.join(root, "_ink", "pic.png", "stroke.json")), "the ink was not deleted");

    // 25: a create names the new file's id and its path.
    const created = await op({ op: "create-file", path: "fresh.md", content: "x\n" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const body = created.body as { paths: string[]; fileId?: string };
    assert.ok(body.fileId, "the created file's id is returned");
    assert.deepEqual(body.paths, ["Notes/fresh.md"]);

    // The authoritative file list names the same id at the same path, and keeps the renamed files under their new names.
    const listed = await alice.router.call("GET", ControlRoutes.fileEntries(projectId));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const listedEntries = (listed.body as FileListResponse).entries;
    assert.equal(listedEntries.find((entry) => entry.path === "fresh.md")?.fileId, body.fileId);
    assert.equal(listedEntries.find((entry) => entry.path === "fresh.md")?.kind, "doc");
    assert.ok(listedEntries.some((entry) => entry.path === "memo.mp3" && entry.kind === "blob" && entry.blobHash));
    assert.equal(listedEntries.some((entry) => entry.path === "a.md" || entry.path === "memo.m4a"), false, "renamed-away paths are not listed");

    // 25: the name is taken by another file while the create is in flight: both are kept, and the answer is the created file's own (suffixed) path, never the other's.
    const hub = alice.host.acquire(JSON.parse(readFileSync(path.join(root, ".libera-shared.json"), "utf8")).manifestDocId);
    injections.push(() => {
      hub.applyLocalChange("manifest", (doc) => {
        const entry = { fileId: "fil_other", path: "race.md", kind: "folder" as const, createdBy: auth.account.id, createdAt: 1, updatedAt: 1 };
        doc.getMap<unknown>(ManifestKeys.files).set(entry.fileId, entryRecord(entry));
      }, { source: "typing" });
    });
    const raced = await op({ op: "create-file", path: "race.md", content: "mine\n" });
    assert.equal(raced.status, 200, JSON.stringify(raced.body));
    const racedBody = raced.body as { paths: string[]; fileId?: string };
    assert.ok(racedBody.fileId && racedBody.fileId !== "fil_other");
    assert.deepEqual(racedBody.paths, ["Notes/race (2).md"], "the earlier entry keeps the name; this one is suffixed");
    alice.host.release(JSON.parse(readFileSync(path.join(root, ".libera-shared.json"), "utf8")).manifestDocId);
  } finally {
    await closePeer(alice);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
