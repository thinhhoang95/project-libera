"use client";

import { useEffect, useMemo, useState } from "react";
import {
  closeCanvasPane,
  closeOtherCanvasPanes,
  createCanvasLayout,
  findCanvasPane,
  focusCanvasPane,
  focusedCanvasPane,
  listCanvasPanes,
  parseCanvasLayout,
  placeCanvasTab,
  reconcileCanvasLayout,
  resizeCanvasSplit,
  splitCanvasPane,
  type CanvasDropZone,
  type CanvasLayout,
} from "@/lib/canvas-layout";
import type { OpenTab } from "./types";

type CanvasState = { layout: CanvasLayout; tabIds: string[]; activeTabId: string };

export type CanvasLayoutControls = ReturnType<typeof useCanvasLayout>;

// Owns the split layout of the document canvas. The focused pane always shows
// the workspace's active tab, so everything that already works on "the active
// tab" (saving, toolbars, AI actions, the review flow) keeps working per pane.
export function useCanvasLayout(options: {
  tabs: OpenTab[];
  activeTabId: string;
  activateTab: (tabId: string) => void;
}) {
  const { tabs, activeTabId, activateTab } = options;
  const tabIdsKey = tabs.map((tab) => tab.id).join("\n");
  // Drafts change `tabs` on every keystroke; only ids matter to the layout.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabIdsKey]);
  const [state, setState] = useState<CanvasState>(() => ({
    layout: createCanvasLayout(),
    tabIds: [],
    activeTabId: "",
  }));

  let layout = state.layout;
  if (state.tabIds !== tabIds || state.activeTabId !== activeTabId) {
    // Reconcile during render so a newly activated tab never flashes in the
    // wrong pane for a frame.
    layout = reconcileCanvasLayout(state.layout, {
      tabIds,
      previousTabIds: state.tabIds,
      activeTabId,
    });
    setState({ layout, tabIds, activeTabId });
  }

  const focusedTabId = focusedCanvasPane(layout)?.tabId ?? "";

  // When the focused pane disappears with its tab (e.g. the file was deleted),
  // focus moves to its neighbour; make that neighbour's tab the active one.
  useEffect(() => {
    if (focusedTabId && focusedTabId !== activeTabId && tabIds.includes(focusedTabId)) {
      activateTab(focusedTabId);
    }
  }, [activateTab, activeTabId, focusedTabId, tabIds]);

  function commit(next: CanvasLayout) {
    if (next === layout) return;
    setState((current) => ({ ...current, layout: next }));
    const nextFocusedTabId = focusedCanvasPane(next)?.tabId ?? "";
    if (nextFocusedTabId !== activeTabId) activateTab(nextFocusedTabId);
  }

  return {
    layout,
    paneCount: listCanvasPanes(layout.root).length,
    focusPane(paneId: string) {
      const pane = findCanvasPane(layout, paneId);
      if (!pane || (paneId === layout.focusedPaneId && pane.tabId === activeTabId)) return;
      commit(focusCanvasPane(layout, paneId));
    },
    splitPane(paneId: string, zone: Exclude<CanvasDropZone, "center">, tabId?: string) {
      commit(splitCanvasPane(layout, paneId, zone, tabId ?? ""));
    },
    placeTab(paneId: string, tabId: string) {
      commit(placeCanvasTab(layout, paneId, tabId));
    },
    // Drag-and-drop entry point: the center shows the tab in the pane, an edge
    // opens it in a new pane on that side.
    dropTab(paneId: string, tabId: string, zone: CanvasDropZone) {
      commit(zone === "center" ? placeCanvasTab(layout, paneId, tabId) : splitCanvasPane(layout, paneId, zone, tabId));
    },
    closePane(paneId: string) {
      commit(closeCanvasPane(layout, paneId));
    },
    closeOtherPanes(paneId: string) {
      commit(closeOtherCanvasPanes(layout, paneId));
    },
    resizeSplit(splitId: string, ratio: number) {
      const next = resizeCanvasSplit(layout, splitId, ratio);
      if (next !== layout) setState((current) => ({ ...current, layout: next }));
    },
    // The tab to activate after `closing` tabs close: the tab in the pane that
    // grows into the freed space, so closing one side of a split never swaps
    // the document shown on the other side.
    nextActiveTabAfterClosing(closing: Set<string>) {
      let next = layout;
      for (const pane of listCanvasPanes(layout.root)) {
        if (closing.has(pane.tabId) && next.root.type !== "pane") next = closeCanvasPane(next, pane.id);
      }
      const tabId = focusedCanvasPane(next)?.tabId;
      return tabId && !closing.has(tabId) ? tabId : undefined;
    },
    restore(value: unknown, restoredTabIds: string[], restoredActiveTabId: string) {
      setState({
        layout: parseCanvasLayout(value, restoredTabIds, restoredActiveTabId),
        tabIds: restoredTabIds,
        activeTabId: restoredActiveTabId,
      });
    },
  };
}
