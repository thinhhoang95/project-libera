// Regressions for the 2026-11-25 file-moving review, package B1 (batch moves and
// shared writes): L-H7, L-M2, U-H5 (server), S-H5, R-M3, S-M4 (renameSharedFolder),
// L-H4 (batch preflight names).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import type { FileListEntry, FileOpRequest } from "../../src/lib/collab/local-api";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { SharedOperationUnfinishedError } from "../../src/lib/collab/shared-outcomes";
import { renameSharedFolder } from "../../src/lib/collab/shared-writes";
import { pythonSidecarPath } from "../../src/lib/python/sidecar";
import {
  BatchRefusedError,
  moveFilesToDirectory,
  normalizeBatchPath,
  preflightLocalMove,
  preflightSharedMove,
} from "../../src/lib/storage/batch-files";
import { MoveCommittedError } from "../../src/lib/storage/files";
import { definitionsPath, filePathFromParts } from "../../src/lib/storage/paths";
import type { LiberaFileMovePayload, LiberaLinkRewrites } from "../../src/lib/types";
import { assertNotebookSound, withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";

const items = (...paths: string[]) => paths.map((item) => ({ path: item }));
const payloadAt = (to: string) => ({ file: { path: to, name: to.split("/").at(-1), notebook: to.split("/")[0] } }) as unknown as LiberaFileMovePayload;
const rewrite = { moved: [], assets: [] } as unknown as LiberaLinkRewrites["rewritten"][number]["rewrite"];
const links = (...paths: string[]): LiberaLinkRewrites => ({ rewritten: paths.map((p) => ({ path: p, rewrite })), skipped: [], unchecked: [] });

// ---- L-H7 / U-H5: one links step for a shared batch, covering unfinished items ----

test("L-H7: a batch with its own move runs its links step once, after every file, and reports it", async () => {
  const order: string[] = [];
  let calls = 0;
  const result = await moveFilesToDirectory(items("Shared/x/a.md", "Shared/x/b.md", "Shared/x/c.md"), "Shared/z", {
    preflight: async () => [],
    move: async (item, directory) => {
      const to = `${directory}/${item.path.split("/").at(-1)}`;
      order.push(`move ${item.path}`);
      if (item.path.endsWith("b.md")) throw new SharedOperationUnfinishedError("Moved, steps stayed behind.", [{ from: item.path, to }], ["the tags of the file"]);
      return payloadAt(to);
    },
    followLinks: async (moves) => {
      calls += 1;
      order.push(`links ${moves.length}`);
      return { links: links("Shared/other.md") };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(order, ["move Shared/x/a.md", "move Shared/x/b.md", "move Shared/x/c.md", "links 3"], "links after the last file, unfinished one included");
  assert.deepEqual(result.links?.rewritten.map((note) => note.path), ["Shared/other.md"]);
  assert.equal(result.moved[1].payload, null);
  assert.deepEqual(result.moved[1].unfinished, ["the tags of the file"]);
});

test("U-H5: an item that hit MoveCommittedError keeps its unfinished steps, and its links are reported", async () => {
  const result = await moveFilesToDirectory(items("Shared/x/a.md", "Shared/x/b.md"), "Shared/z", {
    preflight: async () => [],
    move: async (item, directory) => {
      const to = `${directory}/${item.path.split("/").at(-1)}`;
      if (item.path.endsWith("a.md")) throw new MoveCommittedError("Moved, result unreadable.", { from: item.path, to }, [{ step: "records", status: "failed", message: "its tags stayed" }]);
      return payloadAt(to);
    },
    followLinks: async () => ({ links: links("Shared/z/a.md") }),
  });
  assert.equal(result.failed?.path, "Shared/x/a.md");
  assert.deepEqual(result.moved[0].unfinished, ["its tags stayed"]);
  assert.deepEqual(result.links?.rewritten.map((note) => note.path), ["Shared/z/a.md"], "the moved file's own rewrite reaches the app");
});

// ---- R-M3 ----

test("R-M3: SharedOperationUnfinishedError carries the link rewrites that were applied, and drops an empty report", () => {
  const withLinks = new SharedOperationUnfinishedError("x", [], ["a"], links("Shared/n.md"));
  assert.equal(withLinks.links?.rewritten.length, 1);
  assert.equal(new SharedOperationUnfinishedError("x", [], ["a"], links()).links, undefined);
});

// ---- L-M2 / L-H4 / local preflight ----

test("L-M2: duplicate slashes name one file; a trailing-slash destination works", async () => {
  assert.equal(normalizeBatchPath("/Notes//a.md"), "Notes/a.md");
  assert.equal(normalizeBatchPath("Notes/sub/"), "Notes/sub");
  await withTemporaryLibrary(["Notes"], async () => {
    await writeLibraryFile("Notes/a.md");
    await writeLibraryFile("Notes/b.md");
    await mkdir(filePathFromParts("Notes", ["sub"]), { recursive: true });
    await assert.rejects(moveFilesToDirectory(items("Notes//a.md", "Notes/a.md"), "Notes/sub"), (error) => error instanceof BatchRefusedError && /twice/.test(error.message));
    const result = await moveFilesToDirectory(items("Notes//a.md", "/Notes/b.md"), "Notes/sub/");
    assert.equal(result.failed, null);
    assert.deepEqual(result.moved.map((moved) => moved.to), ["Notes/sub/a.md", "Notes/sub/b.md"]);
    await assertNotebookSound("Notes");
  });
});

test("L-H4: names that differ only in Unicode form from two folders are caught before anything moves", async () => {
  await withTemporaryLibrary(["Notes"], async () => {
    await writeLibraryFile("Notes/x/é.md");
    await writeLibraryFile("Notes/y/é.md");
    await mkdir(filePathFromParts("Notes", ["z"]), { recursive: true });
    const problems = await preflightLocalMove(items("Notes/x/é.md", "Notes/y/é.md"), "Notes/z");
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /would both be named/);
  });
});

test("L-M2: the local preflight refuses what a single move would refuse (a file where a record folder would go)", async () => {
  await withTemporaryLibrary(["Notes"], async () => {
    await writeLibraryFile("Notes/a.md");
    await mkdir(filePathFromParts("Notes", ["sub"]), { recursive: true });
    const blocker = path.dirname(definitionsPath("Notes", ["sub", "a.md"]));
    await mkdir(path.dirname(blocker), { recursive: true });
    await writeFile(blocker, "not a folder");
    const problems = await preflightLocalMove(items("Notes/a.md"), "Notes/sub");
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /can't be moved here/);
  });
});

// ---- S-H5 and S-M4: shared preflight and renameSharedFolder ----

class Watcher extends EventEmitter { close() { /* nothing watched */ } }

async function withShared(files: string[], run: (fixture: { ops: FileOpRequest[]; notebook: string }) => Promise<void>) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "libera-b1-")));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const notebook = path.join(dataDir, "users", "admin", "Shared");
  mkdirSync(notebook, { recursive: true });
  for (const file of files) {
    mkdirSync(path.dirname(path.join(notebook, file)), { recursive: true });
    writeFileSync(path.join(notebook, file), "text\n");
  }
  writeFileSync(path.join(notebook, ".libera-shared.json"), JSON.stringify({ projectId: "prj_test", serverUrl: "https://collab.example", accountId: "acc_me", manifestDocId: "doc_manifest", sharedAt: new Date().toISOString() }));
  invalidateSharedNotebookCache();
  const ops: FileOpRequest[] = [];
  const entries: FileListEntry[] = files.map((file) => ({ fileId: `fil_${file}`, path: file, kind: "doc", updatedAt: 1 }));
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const send = (status: number, payload: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
      const url = new URL(request.url ?? "", "http://host");
      if (/\/projects\/[^/]+\/file-entries$/.test(url.pathname)) return send(200, { entries });
      if (!/\/projects\/[^/]+\/files$/.test(url.pathname)) return send(404, { error: { code: "not-found", message: "No route." } });
      const op = JSON.parse(body) as FileOpRequest;
      ops.push(op);
      if (op.op === "rename" && op.to) renameSync(path.join(notebook, op.path), path.join(notebook, op.to));
      return send(200, { paths: [`Shared/${op.to ?? op.path}`] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.LIBERA_DATA_DIR = dataDir;
  process.env.LIBERA_COLLAB_HOST_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LIBERA_COLLAB_HOST_TOKEN = "test-token";
  mock.method(fs, "watch", () => new Watcher());
  try {
    await run({ ops, notebook });
  } finally {
    mock.restoreAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const listing = (...paths: string[]) => async () => paths.map((item) => ({ path: item }));

test("S-H5: a destination folder nobody has is refused before any file moves", () => withShared(["x/a.md"], async () => {
  const problems = await preflightSharedMove(items("Shared/x/a.md"), "Shared/nowhere", listing("Shared/x/a.md"));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, "Shared/nowhere");
  assert.match(problems[0].message, /Destination folder was not found/);
}));

test("S-H5: records left on this computer, and companions the manifest still lists, refuse the batch", () => withShared(["x/a.md", "x/b.md", "z/keep.md"], async ({ notebook }) => {
  // The Python code of an earlier z/a.md, on this computer.
  const code = pythonSidecarPath("Shared/z/a.md").split("/").slice(1);
  mkdirSync(path.join(notebook, ...code.slice(0, -1)), { recursive: true });
  writeFileSync(path.join(notebook, ...code), "print(1)\n");
  const local = await preflightSharedMove(items("Shared/x/a.md"), "Shared/z", listing("Shared/x/a.md", "Shared/z/keep.md"));
  assert.equal(local.length, 1);
  assert.match(local[0].message, /Python code/);
  // The manifest still lists the Python code of an earlier z/b.md.
  const listed = await preflightSharedMove(items("Shared/x/b.md"), "Shared/z", listing("Shared/x/b.md", "Shared/z/keep.md", pythonSidecarPath("Shared/z/b.md")));
  assert.equal(listed.length, 1);
  assert.match(listed[0].message, /Python code/);
  assert.deepEqual(await preflightSharedMove([], "Shared/z", listing("Shared/z/keep.md")), []);
}));

test("S-M4: renameSharedFolder checks the Python code its notes would meet at the new name", () => withShared(["f/n.md"], async ({ ops, notebook }) => {
  const code = pythonSidecarPath("Shared/g/n.md").split("/").slice(1);
  mkdirSync(path.join(notebook, ...code.slice(0, -1)), { recursive: true });
  writeFileSync(path.join(notebook, ...code), "print(1)\n");
  await assert.rejects(renameSharedFolder("Shared/f", "g"), (error: Error) => /Python code/.test(error.message));
  assert.deepEqual(ops, [], "the host was not asked to rename anything");
}));
