// Regressions for the 2026-11-12 audit's follower-authority findings: a
// follower's disk can lag the host's manifest, so new files must be created
// exclusively (DATA-5), exports and copies read the host's version (DATA-6),
// folder operations accept folders only the manifest has (DL-9), unchanged
// blob writes change nothing (SYNC-4) and a same-path replacement is heard
// when it reaches the disk (STALE-1).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";

import type { FetchLike } from "../../electron/collab/core";
import type { FileOpRequest } from "../../src/lib/collab/local-api";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { createSharedFolder, deleteSharedFolder, writeSharedMarkdownImageAsset, writeSharedUpload } from "../../src/lib/collab/shared-writes";
import { createNotebookZip } from "../../src/lib/storage/download";
import { getRawFile } from "../../src/lib/storage/files";
import { closePeer, invite, makePeer, register, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A host whose manifest knows files (blobs) and folders the disk does not have. */
class StubHost {
  readonly ops: FileOpRequest[] = [];
  readonly blobs = new Map<string, Buffer>();
  readonly folders = new Set<string>();
  /** Names (by suffix) the manifest holds that a createOnly write must be refused for. */
  readonly taken = new Set<string>();
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
        const url = new URL(request.url ?? "/", "http://host");
        if (request.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: { code: "unauthorized", message: "No." } });
        if (url.pathname === "/docs/resolve") return send(200, null);
        if (/\/projects\/[^/]+\/file-blob$/.test(url.pathname)) {
          const relative = url.searchParams.get("path") ?? "";
          if (this.folders.has(relative)) return send(409, { error: { code: "conflict", message: "This path is not a binary file." } });
          const bytes = this.blobs.get(relative);
          return send(200, bytes ? { fileId: `fil_${relative}`, blobHash: sha(bytes), contentBase64: bytes.toString("base64") } : { contentBase64: null });
        }
        if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
        const op = JSON.parse(body) as FileOpRequest;
        this.ops.push(op);
        if (op.op === "write-blob") {
          if (op.createOnly && (this.blobs.has(op.path) || [...this.taken].some((suffix) => op.path.endsWith(suffix)))) {
            return send(409, { error: { code: "conflict", message: `${op.path} already exists.` } });
          }
          this.blobs.set(op.path, Buffer.from(op.contentBase64 ?? "", "base64"));
        }
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

async function withShared(run: (fixture: { notebook: string; host: StubHost }) => Promise<void>) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-audit1112-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(notebook, { recursive: true });
  writeFileSync(path.join(notebook, "note.md"), "note\n");
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

test("DATA-5: an upload never replaces a manifest file the disk has not received", async () => {
  await withShared(async ({ host }) => {
    host.blobs.set("photo.png", Buffer.from("collaborator's photo"));
    await assert.rejects(writeSharedUpload("Shared", new File([Buffer.from("mine")], "photo.png")), (error: { status?: number }) => error.status === 409);
    assert.equal(host.ops[0].createOnly, true);
    assert.equal(host.blobs.get("photo.png")!.toString(), "collaborator's photo");
  });
});

test("DATA-5: a Markdown image takes the next free name when the manifest holds the first", async () => {
  await withShared(async ({ host }) => {
    host.taken.add("/pic.png");
    const saved = await writeSharedMarkdownImageAsset("Shared/note.md", new File([Buffer.from("png")], "pic.png"));
    assert.match(saved.assetPath, /pic-1\.png$/);
    assert.ok(host.ops.length >= 2 && host.ops.every((op) => op.createOnly === true));
  });
});

test("DATA-6: a notebook export and a raw read use the host's version of a lagging file", async () => {
  await withShared(async ({ notebook, host }) => {
    writeFileSync(path.join(notebook, "photo.png"), "stale bytes on disk");
    host.blobs.set("photo.png", Buffer.from("current shared bytes"));
    const archive = await JSZip.loadAsync((await createNotebookZip("Shared")).body);
    assert.equal(await archive.file("Shared/photo.png")!.async("string"), "current shared bytes");
    assert.equal(await archive.file("Shared/note.md")!.async("string"), "note\n", "a file the manifest does not hold comes from the disk");
    assert.equal((await getRawFile("Shared/photo.png")).body.toString(), "current shared bytes");
  });
});

test("DL-9: folders the manifest has but the disk has not received can be changed", async () => {
  await withShared(async ({ host }) => {
    host.folders.add("ghost");
    await createSharedFolder("Shared/ghost", "child");
    assert.deepEqual(host.ops.map((op) => [op.op, op.path]), [["create-folder", "ghost/child"]]);
    await deleteSharedFolder("Shared/ghost");
    assert.equal(host.ops.at(-1)?.op, "delete");
    await assert.rejects(deleteSharedFolder("Shared/never-shared"));
  });
});

test("SYNC-4 and STALE-1: unchanged blob writes cost nothing; a same-path replacement is heard on arrival", { timeout: 90_000 }, async () => {
  const temp = tempRoot("libera-audit1112-follower-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "Alice");
    let uploads = 0;
    const counting: FetchLike = async (url, init) => {
      if (init.method === "PUT" && url.includes("/blobs/")) uploads += 1;
      return fetch(url, init);
    };
    const alice = await makePeer(temp.dir, "alice", server, auth, { leaseTtlMs: 900, fetch: counting });
    peers.push(alice);
    const root = path.join(alice.library, "Research");
    writeTree(root, { "pic.png": Buffer.from([1, 2, 3]), "note.md": "hi\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "Research" });
    const { projectId } = shared.body as { projectId: string };
    await until(() => alice.service.project(projectId)?.follower === false, "alice to hold the folder");
    await alice.service.project(projectId)?.whenIdle();
    const files = ControlRoutes.files(projectId);
    const entryOf = () => (alice.service.project(projectId) as unknown as { readEntries(): Map<string, { path: string; blobHash?: string; updatedAt: number }> }).readEntries();
    const before = [...entryOf().values()].find((entry) => entry.path === "pic.png")!;
    const baseline = uploads;
    const same = await alice.router.call("POST", files, { op: "write-blob", path: "pic.png", contentBase64: Buffer.from([1, 2, 3]).toString("base64") });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(uploads, baseline, "identical bytes are not uploaded");
    assert.deepEqual([...entryOf().values()].find((entry) => entry.path === "pic.png"), before, "and the manifest entry is untouched");

    const twin = await makePeer(temp.dir, "alice-twin", server, auth, { library: alice.library, leaseTtlMs: 900, timings: { followerDiskMs: 40 } });
    peers.push(twin);
    await until(() => twin.service.project(projectId)?.follower === true, "the second installation to follow");
    await until(() => twin.service.resolvePath("Research/note.md") !== null, "the follower to know the file");
    twin.events.length = 0;
    const replaced = await twin.router.call("POST", files, { op: "write-blob", path: "pic.png", contentBase64: Buffer.from([9, 9, 9, 9]).toString("base64") });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    await until(() => twin.events.some((event) => event.t === "files-changed" && event.paths.includes("Research/pic.png")), "the follower to hear the replaced file reach the disk");
  } finally {
    for (const peer of peers) await closePeer(peer);
    await server.stop();
    removeDataDir(server.dataDir);
  }
});
