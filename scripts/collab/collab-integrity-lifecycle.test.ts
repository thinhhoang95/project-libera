// Collaboration integrity review S68-S70 and S73: the lifecycle reservation, transcript sidecars kept when the
// companion does not hold their version, local reviews mapped to files at share time, and root renames recorded once.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RESERVATION_LEASE_MS, ReservationConflictError, ReservationLostError, isReservedBy, reserveLifecycle } from "../../src/lib/collab/lifecycle-reservation";
import { completeRootTransition, pendingRootTransitions, recordRootTransition } from "../../src/lib/collab/root-transitions";
import { documentsToMigrate, readReviewFileIds, recordReviewFileIds, type MigratableDocument } from "../../electron/collab/control/review-migration";
import { convertLocalTranscripts, removableSidecars } from "../../electron/collab/notebooks/transcript-conversion";

const temp = () => mkdtempSync(path.join(tmpdir(), "libera-lc-"));

test("S68: a share and a local operation exclude each other, and a dead or lapsed holder blocks no one", () => {
  const dir = temp();
  const root = path.join(dir, "Notebook");
  try {
    const local = reserveLifecycle(dir, [root], "local");
    // Two local operations do not conflict (each has its own in-process guard); a share is refused at once.
    const second = reserveLifecycle(dir, [root], "local");
    assert.throws(() => reserveLifecycle(dir, [root], "share"), ReservationConflictError);
    second.release();
    local.revalidate();
    local.release();

    const share = reserveLifecycle(dir, [root], "share");
    assert.equal(isReservedBy(dir, root, "share"), true);
    assert.throws(() => reserveLifecycle(dir, [root], "local"), ReservationConflictError);
    share.release();
    assert.equal(isReservedBy(dir, root, "share"), false);
    reserveLifecycle(dir, [root], "local").release();

    // A holder whose process died: its record is ignored and removed.
    const probe = reserveLifecycle(dir, [root], "local");
    const probeName = readdirSync(path.join(dir, "reservations")).find((name) => name.endsWith(".json"))!;
    const record = JSON.parse(readFileSync(path.join(dir, "reservations", probeName), "utf8"));
    probe.release();
    const deadName = `${probeName.slice(0, probeName.indexOf("-") + 1)}deadholder.json`;
    writeFileSync(path.join(dir, "reservations", deadName), JSON.stringify({ ...record, kind: "share", pid: 2 ** 31 - 2, token: "deadholder" }));
    reserveLifecycle(dir, [root], "local").release();
    assert.equal(existsSync(path.join(dir, "reservations", deadName)), false);

    // A lapsed lease is not live, and the holder learns it lost the reservation at its next commit.
    const lapsing = reserveLifecycle(dir, [root], "local");
    const live = path.join(dir, "reservations", readdirSync(path.join(dir, "reservations")).find((name) => name.endsWith(".json"))!);
    const saved = JSON.parse(readFileSync(live, "utf8"));
    writeFileSync(live, JSON.stringify({ ...saved, renewedAt: Date.now() - RESERVATION_LEASE_MS - 1000 }));
    assert.throws(() => lapsing.revalidate(), ReservationLostError);
    reserveLifecycle(dir, [root], "share").release();
    lapsing.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const TRANSCRIPT = { version: 1, segments: [], speakers: [{ id: "s1", name: "Vy" }] };

test("S69: a sidecar the companion does not hold stays; a held one goes only after the upload is confirmed", async () => {
  const root = temp();
  try {
    const sidecars = path.join(root, ".libera", "transcripts", "by-path");
    mkdirSync(sidecars, { recursive: true });
    for (const name of ["a.m4a", "b.m4a", "c.m4a"]) {
      writeFileSync(path.join(root, name), "audio");
      writeFileSync(path.join(sidecars, `${name}.json`), JSON.stringify({ ...TRANSCRIPT, speakers: [{ id: "s1", name: name }], _liberaPendingShare: { create: true } }));
    }
    // a: no companion yet. b: an older companion left by a takedown. c: the same transcript, formatted differently.
    writeFileSync(path.join(root, "b.m4a.transcript"), JSON.stringify({ ...TRANSCRIPT, speakers: [{ id: "s1", name: "older" }] }));
    writeFileSync(path.join(root, "c.m4a.transcript"), JSON.stringify({ ...TRANSCRIPT, speakers: [{ id: "s1", name: "c.m4a" }] }, null, 2));
    const converted = await convertLocalTranscripts(root, { root, canCommit: async () => true });
    assert.deepEqual(converted.conflicts, ["b.m4a"]);
    assert.deepEqual(converted.sidecars.map((item) => item.companion).sort(), ["a.m4a.transcript", "c.m4a.transcript"]);
    assert.equal(JSON.parse(readFileSync(path.join(root, "b.m4a.transcript"), "utf8")).speakers[0].name, "older", "an existing companion is never replaced");

    const plan = (uploaded: boolean) => new Map(converted.sidecars.map((item) => [item.companion, { blobHash: item.companionSha256, uploaded }]));
    // Not uploaded yet: nothing is removed.
    assert.equal((await removableSidecars(converted, plan(false))).remove.length, 0);
    // Uploaded, but one sidecar was edited during the upload: that one stays.
    const edited = converted.sidecars[0].file;
    writeFileSync(edited, JSON.stringify({ ...TRANSCRIPT, speakers: [{ id: "s1", name: "edited meanwhile" }] }));
    const removal = await removableSidecars(converted, plan(true));
    assert.deepEqual(removal.remove, [converted.sidecars[1].file]);
    assert.deepEqual(removal.kept, [converted.sidecars[0].companion.replace(/\.transcript$/, "")]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("S70: local reviews are chosen by the file recorded at share time, not by the path they are stored under", () => {
  const dir = temp();
  try {
    const doc = (id: string, key: string): MigratableDocument => ({ id, key, revision: 1, threads: [{ id: `t_${id}`, messages: [{ id: "m", text: "x" }], anchor: { quote: "q" } } as never] } as unknown as MigratableDocument);
    // `moved` was renamed by someone else; its review is still stored under the old path, where `impostor` now lives.
    const db = { schemaVersion: 1 as const, documents: [doc("moved", "Nb/old.md"), doc("impostor", "Nb/other.md"), doc("elsewhere", "Other/x.md")] };
    recordReviewFileIds(dir, "prj_1", { moved: { fileId: "fil_1", docId: "doc_1" } });
    const map = readReviewFileIds(dir, "prj_1");
    assert.deepEqual(documentsToMigrate(db, "Nb", map).map((item) => item.id), ["moved"]);
    // No map (shared before it existed): the stored path, as before.
    assert.equal(readReviewFileIds(dir, "prj_unknown"), null);
    assert.deepEqual(documentsToMigrate(db, "Nb", null).map((item) => item.id).sort(), ["impostor", "moved"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S73: a root rename is recorded once and stays until it is applied", () => {
  const dir = temp();
  try {
    recordRootTransition(dir, { projectId: "prj_1", from: "Old", to: "New" });
    recordRootTransition(dir, { projectId: "prj_1", from: "Old", to: "New" });
    const pending = pendingRootTransitions(dir);
    assert.equal(pending.length, 1);
    assert.deepEqual([pending[0].from, pending[0].to], ["Old", "New"]);
    completeRootTransition(dir, pending[0].id);
    assert.equal(pendingRootTransitions(dir).length, 0);
    assert.equal(pendingRootTransitions(undefined).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
