import assert from "node:assert/strict";
import test from "node:test";
import {
  closeCanvasPane,
  closeOtherCanvasPanes,
  computeCanvasGeometry,
  createCanvasLayout,
  focusedCanvasPane,
  listCanvasPanes,
  parseCanvasLayout,
  placeCanvasTab,
  reconcileCanvasLayout,
  resizeCanvasSplit,
  splitCanvasPane,
  visibleCanvasTabIds,
  type CanvasLayout,
} from "../../src/lib/canvas-layout";

function tabsOf(layout: CanvasLayout) {
  return listCanvasPanes(layout.root).map((pane) => pane.tabId);
}

function splitAB() {
  const layout = createCanvasLayout("a");
  return splitCanvasPane(layout, layout.focusedPaneId, "right", "b");
}

test("splitting places the tab on the requested side and focuses the new pane", () => {
  const layout = createCanvasLayout("a");
  const right = splitCanvasPane(layout, layout.focusedPaneId, "right", "b");
  assert.deepEqual(tabsOf(right), ["a", "b"]);
  assert.equal(focusedCanvasPane(right).tabId, "b");
  assert.equal(right.root.type === "split" && right.root.direction, "row");

  const above = splitCanvasPane(layout, layout.focusedPaneId, "top", "b");
  assert.deepEqual(tabsOf(above), ["b", "a"]);
  assert.equal(above.root.type === "split" && above.root.direction, "column");

  const empty = splitCanvasPane(layout, layout.focusedPaneId, "bottom");
  assert.deepEqual(tabsOf(empty), ["a", ""]);
});

test("a tab is never shown twice: splitting with a visible tab moves it", () => {
  let layout = splitAB();
  const paneA = listCanvasPanes(layout.root)[0];
  layout = splitCanvasPane(layout, paneA.id, "bottom", "c");
  // Move "b" below "c": its old pane closes rather than duplicating the tab.
  const paneC = listCanvasPanes(layout.root).find((pane) => pane.tabId === "c")!;
  const moved = splitCanvasPane(layout, paneC.id, "bottom", "b");
  assert.deepEqual(tabsOf(moved), ["a", "c", "b"]);
  // Dropping a pane's own tab on its own edge is a no-op.
  const paneB = listCanvasPanes(moved.root).find((pane) => pane.tabId === "b")!;
  assert.equal(splitCanvasPane(moved, paneB.id, "left", "b"), moved);
});

test("placing a visible tab into another pane swaps the two", () => {
  const layout = splitAB();
  const [paneA] = listCanvasPanes(layout.root);
  const swapped = placeCanvasTab(layout, paneA.id, "b");
  assert.deepEqual(tabsOf(swapped), ["b", "a"]);
  assert.equal(swapped.focusedPaneId, paneA.id);
});

test("closing a pane gives its space and focus to the neighbouring pane", () => {
  let layout = splitAB();
  const paneB = listCanvasPanes(layout.root)[1];
  layout = splitCanvasPane(layout, paneB.id, "bottom", "c");
  const paneC = listCanvasPanes(layout.root)[2];
  const closed = closeCanvasPane(layout, paneC.id);
  assert.deepEqual(tabsOf(closed), ["a", "b"]);
  assert.equal(focusedCanvasPane(closed).tabId, "b");
  // The last pane can't be closed.
  const single = closeOtherCanvasPanes(closed, listCanvasPanes(closed.root)[0].id);
  assert.deepEqual(tabsOf(single), ["a"]);
  assert.equal(closeCanvasPane(single, single.focusedPaneId), single);
});

test("reconcile follows the active tab, closed tabs and renamed tabs", () => {
  const layout = splitAB();
  const tabIds = ["a", "b", "c"];

  // Activating a hidden tab replaces the focused pane's document.
  const shown = reconcileCanvasLayout(layout, { tabIds, previousTabIds: tabIds, activeTabId: "c" });
  assert.deepEqual(tabsOf(shown), ["a", "c"]);

  // Activating a visible tab focuses its pane instead of duplicating it.
  const focusedA = reconcileCanvasLayout(layout, { tabIds, previousTabIds: tabIds, activeTabId: "a" });
  assert.deepEqual(tabsOf(focusedA), ["a", "b"]);
  assert.equal(focusedCanvasPane(focusedA).tabId, "a");

  // Renaming "b" to "b2" keeps it in its pane.
  const renamed = reconcileCanvasLayout(layout, { tabIds: ["a", "b2", "c"], previousTabIds: tabIds, activeTabId: "b2" });
  assert.deepEqual(tabsOf(renamed), ["a", "b2"]);

  // Closing the focused tab with nothing active collapses the split and keeps
  // the other side's document instead of blanking it.
  const deleted = reconcileCanvasLayout(layout, { tabIds: ["a", "c"], previousTabIds: tabIds, activeTabId: "" });
  assert.deepEqual(tabsOf(deleted), ["a"]);

  // A single pane simply shows whatever is active (or nothing).
  const single = createCanvasLayout("a");
  const cleared = reconcileCanvasLayout(single, { tabIds: [], previousTabIds: ["a"], activeTabId: "" });
  assert.deepEqual(tabsOf(cleared), [""]);
});

test("geometry covers the canvas and resize clamps the ratio", () => {
  let layout = splitAB();
  const paneB = listCanvasPanes(layout.root)[1];
  layout = splitCanvasPane(layout, paneB.id, "bottom", "c");
  const { panes, handles } = computeCanvasGeometry(layout.root);
  const area = panes.reduce((sum, { rect }) => sum + rect.width * rect.height, 0);
  assert.ok(Math.abs(area - 1) < 1e-9);
  assert.equal(handles.length, 2);

  const splitId = layout.root.type === "split" ? layout.root.id : "";
  const resized = resizeCanvasSplit(layout, splitId, 0.99);
  assert.equal(resized.root.type === "split" && resized.root.ratio, 0.88);
});

test("persisted layouts are validated and reconciled against the restored tabs", () => {
  const layout = splitAB();
  const restored = parseCanvasLayout(JSON.parse(JSON.stringify(layout)), ["a", "b"], "b");
  assert.deepEqual(tabsOf(restored), ["a", "b"]);
  assert.equal(focusedCanvasPane(restored).tabId, "b");

  const missingTab = parseCanvasLayout(layout, ["a"], "a");
  assert.deepEqual(visibleCanvasTabIds(missingTab), ["a"]);

  assert.deepEqual(tabsOf(parseCanvasLayout({ root: { type: "split" } }, ["a"], "a")), ["a"]);
  assert.deepEqual(tabsOf(parseCanvasLayout(undefined, [], "")), [""]);
});
