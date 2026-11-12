import assert from "node:assert/strict";
import { mkdirSync, promises as fs, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { HostStore } from "../../electron/collab/core/store";
import { STATE_DIRECTORY } from "../../electron/collab/notebooks/fs-ops";
import { clearMoveJournal, recoverInterruptedMoves, writeMoveJournal } from "../../electron/collab/notebooks/move-journal";
import { readState } from "../../electron/collab/notebooks/state";
import { tempRoot } from "./support/notebooks-harness";

async function stage(root: string, destination: string, bytes: string, staged = "fil_a-move_x"): Promise<string> {
  const moving = path.join(root, ...STATE_DIRECTORY, "moving");
  mkdirSync(moving, { recursive: true });
  writeFileSync(path.join(moving, staged), bytes);
  await writeMoveJournal(root, { fileId: "fil_a", source: "old/note.md", destination, staged, stagedAt: 1 });
  return path.join(moving, staged);
}

test("STALE-3: an interrupted move whose destination now differs is archived under a recognisable name", async () => {
  const temp = tempRoot("libera-move-journal-");
  try {
    const staged = await stage(temp.dir, "new/note.md", "external edit\n");
    mkdirSync(path.join(temp.dir, "new"), { recursive: true });
    writeFileSync(path.join(temp.dir, "new", "note.md"), "rematerialized\n");
    const recovered = await recoverInterruptedMoves(temp.dir);
    assert.deepEqual(recovered.map((item) => item.outcome), ["archived"]);
    assert.equal(recovered[0].archivedAs, "note (interrupted move).md");
    assert.equal(await fs.readFile(path.join(temp.dir, "_archive", "note (interrupted move).md"), "utf8"), "external edit\n");
    assert.equal(await fs.stat(staged).catch(() => null), null);
    assert.deepEqual(readdirSync(path.dirname(staged)), []);
    assert.equal(await fs.readFile(path.join(temp.dir, "new", "note.md"), "utf8"), "rematerialized\n");
  } finally { temp.cleanup(); }
});

test("STALE-3: a staged copy the destination already holds is removed, and a missing destination still archives it", async () => {
  const temp = tempRoot("libera-move-journal-");
  try {
    await stage(temp.dir, "same.md", "same bytes\n", "fil_a-move_dup");
    writeFileSync(path.join(temp.dir, "same.md"), "same bytes\n");
    await stage(temp.dir, "gone.md", "only copy\n", "fil_b-move_only");
    const recovered = await recoverInterruptedMoves(temp.dir);
    assert.deepEqual(recovered.map((item) => item.outcome).sort(), ["archived", "duplicate-removed"]);
    assert.equal(await fs.readFile(path.join(temp.dir, "_archive", "gone (interrupted move).md"), "utf8"), "only copy\n");
    assert.deepEqual(readdirSync(path.join(temp.dir, ...STATE_DIRECTORY, "moving")), []);
  } finally { temp.cleanup(); }
});

test("STALE-3: a cleared journal, an unreadable journal and an unjournalled staged file are never touched", async () => {
  const temp = tempRoot("libera-move-journal-");
  try {
    const moving = path.join(temp.dir, ...STATE_DIRECTORY, "moving");
    const placed = await stage(temp.dir, "x.md", "placed\n", "fil_p-move_p");
    await fs.rm(placed);
    await clearMoveJournal(temp.dir, "fil_p-move_p");
    writeFileSync(path.join(moving, "fil_legacy-move_l"), "legacy bytes");
    writeFileSync(path.join(moving, "fil_bad-move_b.journal"), "{not json");
    writeFileSync(path.join(moving, "fil_bad-move_b"), "kept");
    assert.deepEqual(await recoverInterruptedMoves(temp.dir), []);
    assert.deepEqual(readdirSync(moving).sort(), ["fil_bad-move_b", "fil_bad-move_b.journal", "fil_legacy-move_l"]);
    // A journal whose move never staged anything is dropped.
    await writeMoveJournal(temp.dir, { fileId: "fil_n", source: "a.md", destination: "b.md", staged: "fil_n-move_n", stagedAt: 1 });
    await recoverInterruptedMoves(temp.dir);
    assert.ok(!readdirSync(moving).includes("fil_n-move_n.journal"));
  } finally { temp.cleanup(); }
});

test("DL-6: the fence can be cleared explicitly and its reason is recorded", async () => {
  const store = new HostStore({ path: ":memory:" });
  try {
    store.requireExternalAdoption("prj_1");
    assert.equal(store.requiresExternalAdoption("prj_1"), true);
    store.clearExternalAdoption("prj_1");
    assert.equal(store.requiresExternalAdoption("prj_1"), false);
  } finally { store.close(); }
  const temp = tempRoot("libera-fence-reason-");
  try {
    assert.equal((await readState(temp.dir)).externalAdoptionReason, "missing-state");
    const directory = path.join(temp.dir, ...STATE_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "state.json"), "{broken");
    const invalid = await readState(temp.dir);
    assert.equal(invalid.externalAdoptionRequired, true);
    assert.equal(invalid.externalAdoptionReason, "invalid-state");
  } finally { temp.cleanup(); }
});
