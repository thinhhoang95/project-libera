import assert from "node:assert/strict";
import test from "node:test";
import {
  createSaveQueue,
  hasUnsavedText,
  pathsUnderMovedFolder,
  planRetargets,
  reconcileMovedText,
  saveBase,
  type PlanTab,
} from "../../src/components/libera/tab-retarget";

const tab = (path: string, over: Partial<PlanTab> = {}): PlanTab => ({ path, draft: "text", saved: "text", status: "clean", inkDirty: false, file: true, ...over });
const move = (from: string, to: string, inkCollision = false) => ({ from, to, inkCollision });

// F22: a conflict keeps the baseline; replacing the disk version needs a decision.
test("F22: after a conflict, Save asks instead of writing against the replacement", () => {
  const conflicted = { saved: "my baseline", diskConflict: { text: "someone else's file" } };
  assert.deepEqual(saveBase(conflicted, false), { ask: true });
  // Only the explicit decision names the disk text as the version to replace.
  assert.deepEqual(saveBase(conflicted, true), { base: "someone else's file" });
  // No conflict: the tab's own baseline, as always.
  assert.deepEqual(saveBase({ saved: "my baseline" }, false), { base: "my baseline" });
  // A file that is gone cannot be replaced by a click: the guarded save is simply tried again.
  assert.deepEqual(saveBase({ saved: "b", diskConflict: { text: null } }, false), { base: "b", gone: true });
});

// F23: saves of one document never overlap.
test("F23: a second save of a document waits for the one in flight", async () => {
  const queue = createSaveQueue();
  const log: string[] = [];
  let release!: () => void;
  const first = queue.run("A/a.md", () => new Promise<string>((resolve) => { log.push("first start"); release = () => { log.push("first end"); resolve("one"); }; }));
  const second = queue.run("A/a.md", async () => { log.push("second start"); return "two"; });
  const other = queue.run("A/b.md", async () => { log.push("other"); return "other"; });
  assert.equal(await other, "other");
  assert.deepEqual(log, ["first start", "other"]);
  assert.equal(queue.busy("A/a.md"), true);
  release();
  assert.deepEqual([await first, await second], ["one", "two"]);
  assert.deepEqual(log, ["first start", "other", "first end", "second start"]);
  assert.equal(queue.busy("A/a.md"), false);
});

test("F23: a failed save does not block the next one", async () => {
  const queue = createSaveQueue();
  const failed = queue.run("A/a.md", async () => { throw new Error("nope"); });
  const next = queue.run("A/a.md", async () => "ok");
  await assert.rejects(failed);
  assert.equal(await next, "ok");
});

// F24: dual-open destinations.
test("F24: a clean moved tab merges into the tab already open at the destination", () => {
  const decisions = planRetargets([tab("Old/a.md"), tab("New/a.md", { draft: "typed", status: "dirty" })], [move("Old/a.md", "New/a.md")]);
  assert.deepEqual(decisions, [{ kind: "merge", from: "Old/a.md", to: "New/a.md" }]);
});

test("F24: equal drafts merge even when both are dirty", () => {
  const dirty = { draft: "same edit", status: "dirty" };
  assert.equal(planRetargets([tab("Old/a.md", dirty), tab("New/a.md", dirty)], [move("Old/a.md", "New/a.md")])[0].kind, "merge");
});

test("F24: different drafts keep both tabs, so no tab id is shared and no draft is overwritten", () => {
  const decisions = planRetargets(
    [tab("Old/a.md", { draft: "old edit", status: "dirty" }), tab("New/a.md", { draft: "new edit", status: "dirty" })],
    [move("Old/a.md", "New/a.md")],
  );
  assert.deepEqual(decisions, [{ kind: "keep", from: "Old/a.md", to: "New/a.md", reason: "drafts-differ" }]);
});

test("F24: a failed save in the moved tab counts as unsaved text", () => {
  const decisions = planRetargets(
    [tab("Old/a.md", { status: "error", draft: "x", saved: "x" }), tab("New/a.md", { draft: "y", saved: "y" })],
    [move("Old/a.md", "New/a.md")],
  );
  assert.equal(decisions[0].kind, "keep");
});

test("F24: pending ink under the same key on both paths keeps the moved tab apart", () => {
  const decisions = planRetargets([tab("Old/a.md", { inkDirty: true }), tab("New/a.md", { inkDirty: true })], [move("Old/a.md", "New/a.md", true)]);
  assert.deepEqual(decisions, [{ kind: "keep", from: "Old/a.md", to: "New/a.md", reason: "ink-collision" }]);
});

test("F24: a swap is not a dual-open: both tabs follow their files", () => {
  const decisions = planRetargets(
    [tab("A/x.md", { draft: "x", status: "dirty" }), tab("A/y.md", { draft: "y", status: "dirty" })],
    [move("A/x.md", "A/y.md"), move("A/y.md", "A/x.md")],
  );
  assert.deepEqual(decisions.map((decision) => decision.kind), ["retarget", "retarget"]);
});

test("F24: a destination without an open tab, and non-file tabs, never block a retarget", () => {
  assert.equal(planRetargets([tab("Old/a.md")], [move("Old/a.md", "New/a.md")])[0].kind, "retarget");
  const gallery = tab("New/a.md", { file: false });
  assert.equal(planRetargets([tab("Old/a.md"), gallery], [move("Old/a.md", "New/a.md")])[0].kind, "retarget");
});

test("F24: two moved tabs sent to one destination do not both take it", () => {
  const decisions = planRetargets(
    [tab("A/a.md", { draft: "one", status: "dirty" }), tab("B/a.md", { draft: "two", status: "dirty" })],
    [move("A/a.md", "C/a.md"), move("B/a.md", "C/a.md")],
  );
  assert.deepEqual(decisions.map((decision) => decision.kind), ["retarget", "keep"]);
});

// F25 is a wiring fix (one snapshot of the tabs in the hook); what it relies on is that
// the decision is made from the tab list it is given, including a tab opened during the wait.
test("F25: planning uses the tabs it is handed, so a tab opened while the request ran is retargeted with its latest text", () => {
  const opened = tab("Old/a.md", { draft: "typed during the wait", saved: "text", status: "dirty" });
  const decisions = planRetargets([opened], [move("Old/a.md", "New/a.md")]);
  assert.deepEqual(decisions, [{ kind: "retarget", from: "Old/a.md", to: "New/a.md" }]);
  // Its draft survives the move untouched by reconciliation when the disk still matches the baseline.
  assert.deepEqual(reconcileMovedText({ saved: "text", draft: "typed during the wait", fetched: "text" }), { saved: "text", draft: "typed during the wait", conflict: null });
});

// F26: reconcile the fetched destination text.
test("F26: a clean tab reloads the text found at the destination", () => {
  assert.deepEqual(reconcileMovedText({ saved: "old", draft: "old", fetched: "new from disk" }), { saved: "new from disk", draft: "new from disk", conflict: null });
});

test("F26: a dirty tab keeps its edits and its baseline, with the disk text as a conflict", () => {
  assert.deepEqual(
    reconcileMovedText({ saved: "old", draft: "old plus mine", fetched: "new from disk" }),
    { saved: "old", draft: "old plus mine", conflict: "new from disk" },
  );
});

test("F26: a dirty tab whose disk text still matches its baseline has no conflict", () => {
  assert.deepEqual(reconcileMovedText({ saved: "old", draft: "mine", fetched: "old" }), { saved: "old", draft: "mine", conflict: null });
});

test("F26: unreadable destination and no rewrite leaves the tab alone", () => {
  assert.equal(reconcileMovedText({ saved: "old", draft: "old" }), null);
});

test("F26: a server rewrite is authoritative: saved takes it, the draft gets the same rewrite", () => {
  const rewrite = (text: string) => text.replace("img/a.png", "Other/img/a.png");
  assert.deepEqual(
    reconcileMovedText({ saved: "![](img/a.png)", draft: "![](img/a.png) mine", fetched: "![](Other/img/a.png)", rewrite }),
    { saved: "![](Other/img/a.png)", draft: "![](Other/img/a.png) mine", conflict: null },
  );
  assert.deepEqual(
    reconcileMovedText({ saved: "![](img/a.png)", draft: "![](img/a.png)", rewrite }),
    { saved: "![](Other/img/a.png)", draft: "![](Other/img/a.png)", conflict: null },
  );
});

// F27: archive.
test("F27: a failed or running save counts as unsaved text", () => {
  assert.equal(hasUnsavedText({ draft: "a", saved: "a", status: "clean" }), false);
  assert.equal(hasUnsavedText({ draft: "a", saved: "a", status: "error" }), true);
  assert.equal(hasUnsavedText({ draft: "a", saved: "a", status: "saving" }), true);
  assert.equal(hasUnsavedText({ draft: "ab", saved: "a", status: "dirty" }), true);
});

test("F27: an archived folder's open files map under the archive path", () => {
  assert.deepEqual(
    pathsUnderMovedFolder(["Notes/Old/a.md", "Notes/Old/sub/b.md", "Notes/Other/c.md", "Notes/Older/d.md"], { from: "Notes/Old", to: "Notes/Archive/Old" }),
    [
      { from: "Notes/Old/a.md", to: "Notes/Archive/Old/a.md" },
      { from: "Notes/Old/sub/b.md", to: "Notes/Archive/Old/sub/b.md" },
    ],
  );
});

test("F27: a draft typed while the archive ran still differs from the baseline after retargeting", () => {
  // The tab is looked at after the request returns, so the typed text is its draft.
  const typed = { saved: "clean text", draft: "clean text, typed meanwhile", fetched: "clean text" };
  const outcome = reconcileMovedText(typed);
  assert.equal(outcome?.draft, typed.draft);
  assert.equal(outcome?.conflict, null);
});

// pending-saves: moving onto a key that is taken never overwrites it.
test("F24: moveUnsaved leaves a colliding view where it is instead of overwriting the destination's", async () => {
  const { pendingSaves, resetPendingSavesForTests } = await import("../../src/components/libera/pending-saves");
  resetPendingSavesForTests();
  const retargeted: string[] = [];
  const mine = { dirty: true, save: async () => undefined, retarget: (path: string) => { retargeted.push(`mine:${path}`); } };
  const theirs = { dirty: true, save: async () => undefined, retarget: (path: string) => { retargeted.push(`theirs:${path}`); } };
  const other = { dirty: true, save: async () => undefined, retarget: (path: string) => { retargeted.push(`other:${path}`); } };
  pendingSaves.register("Old/a.md", "ink", mine);
  pendingSaves.register("Old/a.md", "notes", other);
  pendingSaves.register("New/a.md", "ink", theirs);
  assert.equal(pendingSaves.collides("Old/a.md", "New/a.md"), true);
  pendingSaves.moveUnsaved("Old/a.md", "New/a.md");
  // The free key moved; the colliding one stayed and the destination's view is intact.
  assert.deepEqual(retargeted, ["other:New/a.md"]);
  assert.equal(pendingSaves.isDirty("Old/a.md"), true);
  assert.equal(pendingSaves.isDirty("New/a.md"), true);
  let savedOld = 0;
  let savedNew = 0;
  resetPendingSavesForTests();
  pendingSaves.register("Old/b.md", "ink", { dirty: true, save: async () => { savedOld++; } });
  pendingSaves.register("New/b.md", "ink", { dirty: true, save: async () => { savedNew++; } });
  pendingSaves.moveUnsaved("Old/b.md", "New/b.md");
  await pendingSaves.save("New/b.md");
  await pendingSaves.save("Old/b.md");
  assert.deepEqual([savedOld, savedNew], [1, 1]);
  assert.equal(pendingSaves.collides("Old/none.md", "New/b.md"), false);
  resetPendingSavesForTests();
});
