// Split layout for the document canvas. The layout is a binary tree: leaves are
// panes that each show one open tab (or nothing), and splits divide their area
// between two children. A tab is shown in at most one pane so two editors never
// edit the same draft at once.

export type CanvasSplitDirection = "row" | "column";
export type CanvasDropZone = "center" | "left" | "right" | "top" | "bottom";

export type CanvasPaneNode = { type: "pane"; id: string; tabId: string };
export type CanvasSplitNode = {
  type: "split";
  id: string;
  direction: CanvasSplitDirection;
  // Share of the split taken by `first`, between MIN_CANVAS_SPLIT_RATIO and 1 - MIN.
  ratio: number;
  first: CanvasLayoutNode;
  second: CanvasLayoutNode;
};
export type CanvasLayoutNode = CanvasPaneNode | CanvasSplitNode;

export type CanvasLayout = { root: CanvasLayoutNode; focusedPaneId: string };

export type CanvasRect = { x: number; y: number; width: number; height: number };
export type CanvasPaneRect = { pane: CanvasPaneNode; rect: CanvasRect };
export type CanvasSplitHandle = { split: CanvasSplitNode; rect: CanvasRect };

export const MIN_CANVAS_SPLIT_RATIO = 0.12;
// Drag payload shared by the tab strip, pane headers and pane drop zones.
export const TAB_DRAG_MIME = "application/x-libera-tab-id";

let idCounter = 0;
export function createCanvasId(prefix: string) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function createCanvasLayout(tabId = ""): CanvasLayout {
  const pane: CanvasPaneNode = { type: "pane", id: createCanvasId("pane"), tabId };
  return { root: pane, focusedPaneId: pane.id };
}

export function clampCanvasSplitRatio(ratio: number) {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(1 - MIN_CANVAS_SPLIT_RATIO, Math.max(MIN_CANVAS_SPLIT_RATIO, ratio));
}

export function listCanvasPanes(node: CanvasLayoutNode): CanvasPaneNode[] {
  return node.type === "pane" ? [node] : [...listCanvasPanes(node.first), ...listCanvasPanes(node.second)];
}

export function findCanvasPane(layout: CanvasLayout, paneId: string) {
  return listCanvasPanes(layout.root).find((pane) => pane.id === paneId);
}

export function findCanvasPaneByTab(layout: CanvasLayout, tabId: string) {
  return tabId ? listCanvasPanes(layout.root).find((pane) => pane.tabId === tabId) : undefined;
}

export function focusedCanvasPane(layout: CanvasLayout) {
  return findCanvasPane(layout, layout.focusedPaneId) ?? listCanvasPanes(layout.root)[0];
}

export function visibleCanvasTabIds(layout: CanvasLayout) {
  return listCanvasPanes(layout.root).map((pane) => pane.tabId).filter(Boolean);
}

function mapCanvasNode(
  node: CanvasLayoutNode,
  change: (node: CanvasLayoutNode) => CanvasLayoutNode,
): CanvasLayoutNode {
  const changed = change(node);
  if (changed !== node || node.type === "pane") return changed;
  const first = mapCanvasNode(node.first, change);
  const second = mapCanvasNode(node.second, change);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

function setPaneTab(root: CanvasLayoutNode, paneId: string, tabId: string) {
  return mapCanvasNode(root, (node) =>
    node.type === "pane" && node.id === paneId && node.tabId !== tabId ? { ...node, tabId } : node,
  );
}

// Removes a pane and lets its sibling take over the parent's space.
function removePaneNode(root: CanvasLayoutNode, paneId: string): CanvasLayoutNode | null {
  if (root.type === "pane") return root.id === paneId ? null : root;
  const first = removePaneNode(root.first, paneId);
  const second = removePaneNode(root.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

// The pane that should take focus when `paneId` goes away: the closest pane in
// its sibling subtree, which is the one that grows into the freed space.
function neighbourPaneId(root: CanvasLayoutNode, paneId: string): string | undefined {
  if (root.type === "pane") return undefined;
  const inFirst = listCanvasPanes(root.first).some((pane) => pane.id === paneId);
  const [own, other] = inFirst ? [root.first, root.second] : [root.second, root.first];
  if (own.type === "pane") {
    const panes = listCanvasPanes(other);
    return (inFirst ? panes[0] : panes.at(-1))?.id;
  }
  return neighbourPaneId(own, paneId);
}

export function closeCanvasPane(layout: CanvasLayout, paneId: string): CanvasLayout {
  if (layout.root.type === "pane" || !findCanvasPane(layout, paneId)) return layout;
  const neighbour = neighbourPaneId(layout.root, paneId);
  const root = removePaneNode(layout.root, paneId) ?? layout.root;
  const focusedPaneId = layout.focusedPaneId === paneId
    ? neighbour ?? listCanvasPanes(root)[0].id
    : layout.focusedPaneId;
  return { root, focusedPaneId };
}

export function closeOtherCanvasPanes(layout: CanvasLayout, paneId: string): CanvasLayout {
  const pane = findCanvasPane(layout, paneId);
  return pane ? { root: pane, focusedPaneId: pane.id } : layout;
}

function zoneSplit(zone: Exclude<CanvasDropZone, "center">) {
  return {
    direction: (zone === "left" || zone === "right" ? "row" : "column") as CanvasSplitDirection,
    newFirst: zone === "left" || zone === "top",
  };
}

// Splits `targetPaneId` and places `tabId` in a new pane on the `zone` side. If
// the tab is already visible elsewhere it moves rather than being duplicated.
export function splitCanvasPane(
  layout: CanvasLayout,
  targetPaneId: string,
  zone: Exclude<CanvasDropZone, "center">,
  tabId = "",
): CanvasLayout {
  const target = findCanvasPane(layout, targetPaneId);
  if (!target) return layout;

  let current = layout;
  const existing = findCanvasPaneByTab(current, tabId);
  if (existing) {
    // Moving a pane's own tab to its own edge would leave an empty pane behind.
    if (existing.id === targetPaneId) return layout;
    current = closeCanvasPane(current, existing.id);
  }

  const { direction, newFirst } = zoneSplit(zone);
  const pane: CanvasPaneNode = { type: "pane", id: createCanvasId("pane"), tabId };
  const root = mapCanvasNode(current.root, (node) => {
    if (node.type !== "pane" || node.id !== targetPaneId) return node;
    return {
      type: "split",
      id: createCanvasId("split"),
      direction,
      ratio: 0.5,
      first: newFirst ? pane : node,
      second: newFirst ? node : pane,
    };
  });
  return { root, focusedPaneId: pane.id };
}

// Shows `tabId` in `paneId`. A tab already visible in another pane swaps places
// with the target's tab so both stay on screen.
export function placeCanvasTab(layout: CanvasLayout, paneId: string, tabId: string): CanvasLayout {
  const target = findCanvasPane(layout, paneId);
  if (!target) return layout;
  const existing = findCanvasPaneByTab(layout, tabId);
  let root = layout.root;
  if (existing && existing.id !== paneId) {
    root = setPaneTab(root, existing.id, target.tabId);
  }
  root = setPaneTab(root, paneId, tabId);
  return root === layout.root && layout.focusedPaneId === paneId ? layout : { root, focusedPaneId: paneId };
}

export function resizeCanvasSplit(layout: CanvasLayout, splitId: string, ratio: number): CanvasLayout {
  const nextRatio = clampCanvasSplitRatio(ratio);
  const root = mapCanvasNode(layout.root, (node) =>
    node.type === "split" && node.id === splitId && node.ratio !== nextRatio ? { ...node, ratio: nextRatio } : node,
  );
  return root === layout.root ? layout : { ...layout, root };
}

export function focusCanvasPane(layout: CanvasLayout, paneId: string): CanvasLayout {
  return layout.focusedPaneId === paneId || !findCanvasPane(layout, paneId) ? layout : { ...layout, focusedPaneId: paneId };
}

// Keeps the layout consistent with the open tabs and the workspace's active tab.
// `previousTabIds` lets renames (which replace a tab id in place) follow the tab
// into its pane instead of leaving the pane empty.
export function reconcileCanvasLayout(
  layout: CanvasLayout,
  options: { tabIds: string[]; previousTabIds: string[]; activeTabId: string },
): CanvasLayout {
  const { tabIds, previousTabIds, activeTabId } = options;
  const open = new Set(tabIds);
  let next = layout;

  if (previousTabIds.length === tabIds.length) {
    const previous = new Set(previousTabIds);
    previousTabIds.forEach((from, index) => {
      const to = tabIds[index];
      if (from === to || open.has(from) || previous.has(to)) return;
      const pane = findCanvasPaneByTab(next, from);
      if (pane) next = { ...next, root: setPaneTab(next.root, pane.id, to) };
    });
  }

  for (const pane of listCanvasPanes(next.root)) {
    if (!pane.tabId || open.has(pane.tabId)) continue;
    next = next.root.type === "pane"
      ? { ...next, root: setPaneTab(next.root, pane.id, "") }
      : closeCanvasPane(next, pane.id);
  }

  const focusLost = next.focusedPaneId !== layout.focusedPaneId;
  if (!findCanvasPane(next, next.focusedPaneId)) {
    next = { ...next, focusedPaneId: listCanvasPanes(next.root)[0].id };
  }

  const activeId = open.has(activeTabId) ? activeTabId : "";
  const showing = findCanvasPaneByTab(next, activeId);
  if (showing) {
    next = focusCanvasPane(next, showing.id);
  } else if (activeId || !focusLost) {
    next = { ...next, root: setPaneTab(next.root, next.focusedPaneId, activeId) };
  }
  // Otherwise the focused pane closed along with its tab and no tab is active:
  // keep the neighbour's document; the caller makes it the active tab.

  return next.root === layout.root && next.focusedPaneId === layout.focusedPaneId ? layout : next;
}

export function computeCanvasGeometry(root: CanvasLayoutNode) {
  const panes: CanvasPaneRect[] = [];
  const handles: CanvasSplitHandle[] = [];

  function visit(node: CanvasLayoutNode, rect: CanvasRect) {
    if (node.type === "pane") {
      panes.push({ pane: node, rect });
      return;
    }
    handles.push({ split: node, rect });
    if (node.direction === "row") {
      const firstWidth = rect.width * node.ratio;
      visit(node.first, { ...rect, width: firstWidth });
      visit(node.second, { ...rect, x: rect.x + firstWidth, width: rect.width - firstWidth });
    } else {
      const firstHeight = rect.height * node.ratio;
      visit(node.first, { ...rect, height: firstHeight });
      visit(node.second, { ...rect, y: rect.y + firstHeight, height: rect.height - firstHeight });
    }
  }

  visit(root, { x: 0, y: 0, width: 1, height: 1 });
  return { panes, handles };
}

function parseCanvasNode(value: unknown, seen: Set<string>): CanvasLayoutNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (typeof node.id !== "string" || !node.id || seen.has(node.id)) return null;
  seen.add(node.id);
  if (node.type === "pane") {
    return typeof node.tabId === "string" ? { type: "pane", id: node.id, tabId: node.tabId } : null;
  }
  if (node.type !== "split" || (node.direction !== "row" && node.direction !== "column") || typeof node.ratio !== "number") return null;
  const first = parseCanvasNode(node.first, seen);
  const second = parseCanvasNode(node.second, seen);
  if (!first || !second) return null;
  return { type: "split", id: node.id, direction: node.direction, ratio: clampCanvasSplitRatio(node.ratio), first, second };
}

// Restores a persisted layout. Anything malformed falls back to a single pane
// so a bad snapshot can never break opening a workspace.
export function parseCanvasLayout(value: unknown, tabIds: string[], activeTabId: string): CanvasLayout {
  const fallback = createCanvasLayout(activeTabId);
  if (!value || typeof value !== "object") return fallback;
  const root = parseCanvasNode((value as { root?: unknown }).root, new Set());
  if (!root) return fallback;
  const focusedPaneId = (value as { focusedPaneId?: unknown }).focusedPaneId;
  const layout: CanvasLayout = { root, focusedPaneId: typeof focusedPaneId === "string" ? focusedPaneId : "" };
  // Drop duplicate tabs (a tab may only be visible once) before reconciling.
  const seenTabs = new Set<string>();
  let deduped = layout;
  for (const pane of listCanvasPanes(root)) {
    if (!pane.tabId) continue;
    if (seenTabs.has(pane.tabId)) deduped = { ...deduped, root: setPaneTab(deduped.root, pane.id, "") };
    seenTabs.add(pane.tabId);
  }
  return reconcileCanvasLayout(deduped, { tabIds, previousTabIds: tabIds, activeTabId });
}

export function mapCanvasLayoutTabIds(layout: CanvasLayout, remap: (tabId: string) => string): CanvasLayout {
  const root = mapCanvasNode(layout.root, (node) => {
    if (node.type !== "pane" || !node.tabId) return node;
    const tabId = remap(node.tabId);
    return tabId === node.tabId ? node : { ...node, tabId };
  });
  return root === layout.root ? layout : { ...layout, root };
}
