// Finding 35, desktop side: a manifest entry whose blob the server does not
// have (404) or cannot deliver is retried on a growing delay and reported as
// refused once, instead of being downloaded on every pass forever; and the
// entry parser is the shared definition the server also applies.
//
// A detached SharedProject (Object.create on the prototype, only the members
// the methods use), as in audit-1119-scan-liveness.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";

import * as Y from "yjs";

import { ApiClientError } from "../../electron/collab/core/api-client";
import { readManifest } from "../../electron/collab/notebooks/layout";
import { SharedProject } from "../../electron/collab/notebooks/project";
import { ManifestKeys, manifestEntryShapeError } from "../../src/lib/collab/protocol/schema";

const HASH = "c".repeat(64);

interface Probe {
  blobBytes(hash: string): Promise<Uint8Array | null>;
  blobBackingOff(hash: string): boolean;
  blobFailures: Map<string, { count: number; nextAt: number }>;
}

function detached(download: (hash: string) => Promise<Uint8Array>) {
  const warnings: string[] = [];
  const wakes: number[] = [];
  const project = Object.create(SharedProject.prototype) as SharedProject;
  Object.assign(project, {
    info: { projectId: "prj_x", notebook: "Thesis" },
    ctx: {
      timings: { retryMs: 5 },
      logger: { warn: (message: string) => { warnings.push(message); }, info() {}, error() {} },
      host: { store: { getBlob: () => null }, api: { downloadBlob: (_project: string, hash: string) => download(hash) } },
    },
    uploadedBlobs: new Map(),
    blobFailures: new Map(),
    refusedLogged: new Set<string>(),
    timers: new Set<ReturnType<typeof setTimeout>>(),
    stopped: false,
    scheduleManifest: () => { wakes.push(Date.now()); },
  });
  return { project: project as unknown as Probe, warnings, wakes };
}

test("a blob the server does not have is refused once and backs off instead of re-downloading each pass", async () => {
  let downloads = 0;
  const { project, warnings, wakes } = detached(async () => { downloads += 1; throw new ApiClientError("not-found", 404, "no such blob"); });
  assert.equal(await project.blobBytes(HASH), null);
  assert.equal(downloads, 1);
  assert.equal(warnings.filter((message) => message.includes("refused blob")).length, 1, "reported as refused at the first 404");
  assert.equal(project.blobBackingOff(HASH), true);
  // Passes inside the delay do not hit the server again.
  for (let pass = 0; pass < 5; pass += 1) assert.equal(await project.blobBytes(HASH), null);
  assert.equal(downloads, 1);
  // After the delay it is tried again, later still, and the refusal is not logged twice.
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(await project.blobBytes(HASH), null);
  assert.equal(downloads, 2);
  const first = project.blobFailures.get(HASH) as { count: number; nextAt: number };
  assert.equal(first.count, 2);
  assert.equal(warnings.filter((message) => message.includes("refused blob")).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(wakes.length >= 1, "the manifest pass is woken when a delay ends");
});

test("a download that fails repeatedly becomes refused, and one that succeeds clears the record", async () => {
  let fail = true;
  const bytes = new Uint8Array([1, 2, 3]);
  const { project, warnings } = detached(async () => { if (fail) throw new Error("network"); return bytes; });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await project.blobBytes(HASH), null);
    const record = project.blobFailures.get(HASH) as { count: number; nextAt: number };
    record.nextAt = 0; // skip the wait: only the count matters here
  }
  assert.equal(warnings.filter((message) => message.includes("refused blob")).length, 1, "refused after the fifth failure");
  fail = false;
  assert.equal(await project.blobBytes(HASH), bytes);
  assert.equal(project.blobFailures.has(HASH), false);
});

test("the desktop parses entries with the shared shape definition", () => {
  const doc = new Y.Doc();
  const files = doc.getMap(ManifestKeys.files);
  const good = { path: "a.md", kind: "doc", docKind: "markdown", docId: "doc_good00000001" };
  const bad = { path: "b.png", kind: "blob", blobHash: "nothex" };
  files.set("fil_good00000001", good);
  files.set("fil_bad000000001", bad);
  assert.equal(manifestEntryShapeError("fil_good00000001", good), null);
  assert.notEqual(manifestEntryShapeError("fil_bad000000001", bad), null);
  assert.deepEqual([...readManifest(doc).keys()], ["fil_good00000001"]);
});
