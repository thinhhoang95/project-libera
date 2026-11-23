// Audit 2026-11-23, package PR2 (Next side): H5 (a binding can be deleted), H6 (a legacy binding
// accepts the upgraded marker), L1 (the binding key ignores case where the filesystem does),
// M2 (root transitions are ordered, chains collapse, nothing is dropped while unreadable) and
// M24 (a reservation's timestamp is taken per root, ties back out).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { ReservationConflictError, reserveLifecycle } from "../../src/lib/collab/lifecycle-reservation";
import {
  compatibleNotebookIdentity, deleteNotebookBinding, readNotebookBinding, recordNotebookBinding, type NotebookMarker,
} from "../../src/lib/collab/local-notebook-state";
import { pendingRootTransitions, recordRootTransition } from "../../src/lib/collab/root-transitions";
import { invalidateSharedNotebookCache, sharedNotebookMarker } from "../../src/lib/collab/shared-notebook";
import { getAdminRoot } from "../../src/lib/storage/paths";
import { applyPendingRootTransitions } from "../../src/lib/storage/root-transitions";

const marker = (over: Partial<NotebookMarker> = {}): NotebookMarker => ({
  projectId: "prj_1", serverUrl: "https://collab.example", accountId: "acc_1", manifestDocId: "doc_m", sharedAt: "2026-11-01T00:00:00.000Z", folderId: "fld_1", ...over,
});

async function withData(run: (lifecycle: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-audit-1123-bindings-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_COLLAB_LIFECYCLE_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  const lifecycle = path.join(directory, "lifecycle");
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_COLLAB_LIFECYCLE_DIR = lifecycle;
  for (const key of ["LIBERA_CONFIG_PATH", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const) delete process.env[key];
  invalidateSharedNotebookCache();
  try { await run(lifecycle); } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    invalidateSharedNotebookCache();
    await rm(directory, { recursive: true, force: true });
  }
}

test("H5: a binding can be deleted, and a deleted binding no longer guards the path", () => withData(async (lifecycle) => {
  const root = path.join(getAdminRoot(), "Old");
  await mkdir(root, { recursive: true });
  recordNotebookBinding(lifecycle, root, marker());
  assert.equal(sharedNotebookMarker("Old")?.projectId, "", "a bound folder without a marker is unreadable (fail closed)");
  deleteNotebookBinding(lifecycle, root);
  assert.equal(readNotebookBinding(lifecycle, root), null);
  invalidateSharedNotebookCache();
  assert.equal(sharedNotebookMarker("Old"), null, "the path is an ordinary folder again");
  deleteNotebookBinding(lifecycle, root);
}));

test("H6: a binding recorded from a legacy marker accepts the upgraded marker", () => withData(async (lifecycle) => {
  const root = path.join(getAdminRoot(), "Legacy");
  await mkdir(root, { recursive: true });
  const legacy = marker();
  delete legacy.folderId;
  recordNotebookBinding(lifecycle, root, legacy);
  const upgraded = marker({ folderId: "fld_new" });
  await writeFile(path.join(root, ".libera-shared.json"), JSON.stringify(upgraded));
  const seen = sharedNotebookMarker("Legacy");
  assert.equal(seen?.projectId, "prj_1", "the upgraded marker is the notebook's marker, not UNREADABLE");
  assert.equal(compatibleNotebookIdentity(legacy, upgraded), true);
  assert.equal(compatibleNotebookIdentity(upgraded, legacy), false, "the upgrade is one way");
  assert.equal(compatibleNotebookIdentity(legacy, { ...upgraded, projectId: "prj_2" }), false);
  assert.equal(compatibleNotebookIdentity(marker({ folderId: "fld_a" }), marker({ folderId: "fld_b" })), false);
}));

test("L1: the binding is found under another casing where the filesystem ignores case", { skip: process.platform !== "darwin" && process.platform !== "win32" }, () => withData(async (lifecycle) => {
  const root = path.join(getAdminRoot(), "Notes");
  recordNotebookBinding(lifecycle, root, marker());
  assert.equal(readNotebookBinding(lifecycle, path.join(getAdminRoot(), "notes"))?.projectId, "prj_1");
}));

test("L1: a binding written under the earlier, case-sensitive key is still found", () => withData(async (lifecycle) => {
  const root = path.join(getAdminRoot(), "Notes");
  mkdirSync(lifecycle, { recursive: true });
  // The earlier layout: sha256 of the resolved path, as written.
  const file = path.join(lifecycle, `binding-${createHash("sha256").update(path.resolve(root)).digest("hex")}.json`);
  writeFileSync(file, `${JSON.stringify({ version: 1, root: path.resolve(root), marker: marker() })}\n`);
  assert.equal(readNotebookBinding(lifecycle, root)?.projectId, "prj_1");
  deleteNotebookBinding(lifecycle, root);
  assert.equal(readNotebookBinding(lifecycle, root), null);
  assert.equal(existsSync(file), false, "the earlier file goes too");
}));

test("M2: pending transitions are ordered, and a chain A to B to C is one move A to C", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "libera-audit-1123-chain-"));
  try {
    let at = Date.parse("2026-11-20T00:00:00Z");
    const clock = mock.method(Date, "now", () => (at += 1000));
    recordRootTransition(directory, { projectId: "prj_2", from: "X", to: "Y" });
    recordRootTransition(directory, { projectId: "prj_1", from: "A", to: "B" });
    recordRootTransition(directory, { projectId: "prj_1", from: "B", to: "C" });
    clock.mock.restore();
    const pending = pendingRootTransitions(directory);
    const one = pending.find((item) => item.projectId === "prj_1")!;
    assert.deepEqual([one.from, one.to], ["A", "C"]);
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map((item) => item.at), [...pending.map((item) => item.at)].sort());
    assert.equal(readdirSync(path.join(directory, "root-transitions")).length, 3, "the files stay until applied");
  } finally { mock.restoreAll(); rmSync(directory, { recursive: true, force: true }); }
});

test("M2: a transition is deleted only once it applied or is proven obsolete, never on an unreadable marker", () => withData(async (lifecycle) => {
  const target = path.join(getAdminRoot(), "New");
  await mkdir(target, { recursive: true });
  recordRootTransition(lifecycle, { projectId: "prj_1", from: "Old", to: "New" });
  // The marker is half delivered: unreadable now, fine later.
  await writeFile(path.join(target, ".libera-shared.json"), "{\"projectId\": \"prj_");
  invalidateSharedNotebookCache();
  await applyPendingRootTransitions();
  assert.equal(pendingRootTransitions(lifecycle).length, 1, "kept while the marker is unreadable");
  // The folder holds another project: nothing to move to, proven obsolete.
  await writeFile(path.join(target, ".libera-shared.json"), JSON.stringify(marker({ projectId: "prj_other" })));
  invalidateSharedNotebookCache();
  await applyPendingRootTransitions();
  assert.equal(pendingRootTransitions(lifecycle).length, 0, "dropped once the folder is another project's");
  // A chain applies as one and removes every file it covered.
  recordRootTransition(lifecycle, { projectId: "prj_1", from: "Old", to: "Mid" });
  recordRootTransition(lifecycle, { projectId: "prj_1", from: "Mid", to: "New" });
  await writeFile(path.join(target, ".libera-shared.json"), JSON.stringify(marker()));
  invalidateSharedNotebookCache();
  await applyPendingRootTransitions();
  assert.equal(pendingRootTransitions(lifecycle).length, 0);
  assert.equal(readdirSync(path.join(lifecycle, "root-transitions")).filter((name) => name.endsWith(".json")).length, 0, "no file of the chain is left");
}));

test("M24: a reservation takes its timestamp per root, and a tie with a rival backs out", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "libera-audit-1123-reserve-"));
  const rootA = path.join(directory, "A");
  const rootB = path.join(directory, "B");
  const folder = path.join(directory, "reservations");
  try {
    let tick = 1_000_000;
    const clock = mock.method(Date, "now", () => tick++);
    const share = reserveLifecycle(directory, [rootA, rootB], "share");
    clock.mock.restore();
    const created = new Map(readdirSync(folder).map((name) => {
      const record = JSON.parse(readFileSync(path.join(folder, name), "utf8")) as { root: string; createdAt: number };
      return [record.root, record.createdAt] as const;
    }));
    assert.ok(created.get(path.resolve(rootB))! > created.get(path.resolve(rootA))! + 2, "the second root's timestamp is read just before its own write");
    share.release();

    // A rival that appears after the check, with the same timestamp: neither may go on.
    // The second clock read is the one between the check for rivals and our own write (before the fix: inside the
    // check; after it: our timestamp). A rival record with that same timestamp lands there.
    const { key } = { key: createHash("sha256").update(process.platform === "win32" || process.platform === "darwin" ? path.resolve(rootA).toLowerCase() : path.resolve(rootA)).digest("hex").slice(0, 32) };
    let calls = 0;
    mock.method(Date, "now", () => {
      const now = 2_000_000;
      calls += 1;
      if (calls === 2) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, `${key}-ffffffffffffffff.json`), JSON.stringify({
          version: 1, root: path.resolve(rootA), kind: "local", pid: process.pid, token: "ffffffffffffffff", createdAt: now, renewedAt: now,
        }));
      }
      return now;
    });
    assert.throws(() => reserveLifecycle(directory, [rootA], "share"), ReservationConflictError);
  } finally { mock.restoreAll(); rmSync(directory, { recursive: true, force: true }); }
});
