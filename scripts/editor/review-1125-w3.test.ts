import assert from "node:assert/strict";
import test from "node:test";
import { renamePathPrefix, prefixRetargets, remapRecordKeys } from "../../src/components/libera/path-follow";
import { planRetargets } from "../../src/components/libera/tab-retarget";
import {
  composeCanvasRenames,
  createCanvasLayout,
  focusedCanvasPane,
  listCanvasPanes,
  reconcileCanvasLayout,
  splitCanvasPane,
  type CanvasLayout,
} from "../../src/lib/canvas-layout";

const tabsOf = (layout: CanvasLayout) => listCanvasPanes(layout.root).map((pane) => pane.tabId);
function splitAB() {
  const layout = createCanvasLayout("a");
  return splitCanvasPane(layout, layout.focusedPaneId, "right", "b");
}

// U-H10
test("a swap of two open files keeps each pane on the file it showed", () => {
  const layout = splitAB();
  // The tabs keep their order; their ids (paths) are exchanged.
  const next = reconcileCanvasLayout(layout, {
    tabIds: ["b", "a"],
    previousTabIds: ["a", "b"],
    activeTabId: "b",
    renames: new Map([["a", "b"], ["b", "a"]]),
  });
  assert.deepEqual(tabsOf(next), ["b", "a"]);
});

test("a merge in one batch does not close the pane of an unrelated rename", () => {
  const two = splitAB();
  const layout = splitCanvasPane(two, listCanvasPanes(two.root)[0].id, "bottom", "c");
  assert.equal(listCanvasPanes(layout.root).length, 3);
  assert.deepEqual(tabsOf(layout).sort(), ["a", "b", "c"]);
  // a merges into the already open b; c is renamed to d.
  const next = reconcileCanvasLayout(layout, {
    tabIds: ["b", "d"],
    previousTabIds: ["a", "b", "c"],
    activeTabId: "d",
    renames: new Map([["a", "b"], ["c", "d"]]),
  });
  assert.deepEqual(tabsOf(next).sort(), ["b", "d"], "c's pane became d, the duplicate b pane closed");
  assert.equal(focusedCanvasPane(next).tabId, "d");
});

test("renames compose when two retargets happen before a render", () => {
  const composed = composeCanvasRenames(new Map([["a", "b"]]), new Map([["b", "c"], ["x", "y"]]));
  assert.deepEqual([...composed].sort(), [["a", "c"], ["b", "c"], ["x", "y"]]);
});

test("without an explicit map the old positional inference still follows a plain rename", () => {
  const layout = splitAB();
  const next = reconcileCanvasLayout(layout, { tabIds: ["a", "b2"], previousTabIds: ["a", "b"], activeTabId: "b2" });
  assert.deepEqual(tabsOf(next), ["a", "b2"]);
});

// U-H9 / U-M6 helpers
test("a folder rename maps only the files inside it", () => {
  assert.equal(renamePathPrefix("Nb/Old/a.md", "Nb/Old", "Nb/New"), "Nb/New/a.md");
  assert.equal(renamePathPrefix("Nb/Older/a.md", "Nb/Old", "Nb/New"), "Nb/Older/a.md");
  assert.deepEqual(prefixRetargets(["Nb/Old/a.md", "Nb/Old/s/b.md", "Nb/x.md"], "Nb/Old", "Nb/New"), [
    { from: "Nb/Old/a.md", to: "Nb/New/a.md" },
    { from: "Nb/Old/s/b.md", to: "Nb/New/s/b.md" },
  ]);
});

test("file-keyed records follow a rename, and untouched records keep their object", () => {
  const record = { "Nb/Old/a.md": "t1", "Nb/x.md": "t2" };
  assert.deepEqual(remapRecordKeys(record, (p) => renamePathPrefix(p, "Nb/Old", "Nb/New")), { "Nb/New/a.md": "t1", "Nb/x.md": "t2" });
  assert.equal(remapRecordKeys(record, (p) => renamePathPrefix(p, "Zed", "Zee")), record);
});

test("a folder rename onto an open tab with different unsaved text is held, not duplicated", () => {
  const tab = (path: string, draft: string, saved = "s") => ({ path, draft, saved, status: "dirty", inkDirty: false, file: true });
  const decisions = planRetargets(
    [tab("Nb/Old/a.md", "mine"), tab("Nb/New/a.md", "other")],
    prefixRetargets(["Nb/Old/a.md"], "Nb/Old", "Nb/New").map((m) => ({ ...m, inkCollision: false })),
  );
  assert.equal(decisions[0].kind, "keep");
});
