import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import type { OpenTab } from "../../src/components/libera/types";

test("moving visible tabs between split panes snapshots positions before remount", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
  const { CanvasSplitView } = await import("../../src/components/libera/canvas-split-view");
  const { useCanvasLayout } = await import("../../src/components/libera/use-canvas-layout");
  const { listCanvasPanes } = await import("../../src/lib/canvas-layout");
  const { CodeEditor } = await import("../../src/components/libera/code-editor");
  let controls!: ReturnType<typeof useCanvasLayout>;
  function App() {
    const [tabs, setTabs] = useState<OpenTab[]>(() => ["a", "b"].map((id) => ({ id, file: { path: id, name: `${id}.txt`, fileType: "text" }, draft: "Line\n".repeat(300), saved: "", status: "clean" }) as OpenTab));
    const [activeTabId, activateTab] = useState("a");
    controls = useCanvasLayout({ tabs, activeTabId, activateTab });
    return createElement(CanvasSplitView, { layout: controls.layout, tabs,
      onFocusPane: controls.focusPane, onSplitPane: controls.splitPane, onClosePane: controls.closePane,
      onPlaceTab: controls.placeTab, onDropTab: controls.dropTab, onResizeSplit: controls.resizeSplit,
      renderPane: (pane) => {
        const tab = tabs.find((tab) => tab.id === pane.tabId);
        return tab ? createElement(CodeEditor, { key: tab.id, fileName: tab.file.name, value: tab.draft,
          fontFamily: "monospace", fontSizePx: 14, lineHeight: 1.5, saving: false,
          initialViewState: tab.viewState?.text,
          onChange: (draft) => setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, draft } : item)),
          onSave: () => {},
          onViewStateChange: (patch) => setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, viewState: { text: { ...item.viewState?.text, ...patch } } } : item)),
        }) : null;
      },
    });
  }
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)); }); }
  try {
    await act(async () => root.render(createElement(App)));
    await act(async () => controls.splitPane(controls.layout.focusedPaneId, "right", "b"));
    await settle();
    const scrollers = [...host.querySelectorAll<HTMLElement>(".cm-scroller")];
    assert.equal(scrollers.length, 2);
    // Do not emit scroll or wait for the editors' debounce: the layout action
    // must snapshot the live view before either tab mounts in its new pane.
    await act(async () => {
      const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
      view.dispatch({ changes: { from: 0, insert: "Unpublished edit\n" }, selection: { anchor: 8 } });
    });
    scrollers[0].scrollTop = 780.5; scrollers[0].scrollLeft = 18.25;
    scrollers[1].scrollTop = 430.75; scrollers[1].scrollLeft = 12;
    const [firstPane] = listCanvasPanes(controls.layout.root);
    await act(async () => controls.placeTab(firstPane.id, "b"));
    await settle();
    const moved = [...host.querySelectorAll<HTMLElement>(".cm-scroller")];
    assert.equal(moved[0].scrollTop, 430.75);
    assert.equal(moved[0].scrollLeft, 12);
    assert.equal(moved[1].scrollTop, 780.5);
    assert.equal(moved[1].scrollLeft, 18.25);
    const movedView = EditorView.findFromDOM(host.querySelectorAll<HTMLElement>(".cm-editor")[1])!;
    assert.ok(movedView.state.doc.toString().startsWith("Unpublished edit\n"));
    assert.equal(movedView.state.selection.main.head, 8);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
