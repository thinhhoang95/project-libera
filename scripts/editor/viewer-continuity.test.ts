import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { JSDOM } from "jsdom";
import type { LatexTabViewState } from "../../src/components/libera/types";

test("source editors retain exact scroll and selection through rapid tab switches", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["Window", "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "CustomEvent"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
  const { LatexEditor } = await import("../../src/components/libera/latex/latex-editor");
  const { CodeEditor } = await import("../../src/components/libera/code-editor");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ snippets: [] });
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const states = new Map<string, LatexTabViewState>();
  const value = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
  async function show(id: string, latex: boolean) {
    const common = {
      key: id, fileName: latex ? "main.tex" : "notes.txt", value,
      fontFamily: "monospace", fontSizePx: 14, lineHeight: 1.5,
      initialViewState: states.get(id), onChange: () => {},
      onViewStateChange: (patch: LatexTabViewState) => states.set(id, { ...states.get(id), ...patch }),
    };
    await act(async () => root.render(createElement(StrictMode, null, latex
      ? createElement(LatexEditor, { ...common, documentPath: id, diagnostics: [], project: { labels: [], bibEntries: [], files: [] }, editorRef: { current: null }, onEdit: () => {}, onCompile: () => {}, onForwardSync: () => {}, onAiError: () => {}, onAddSnippet: () => {} })
      : createElement(CodeEditor, { ...common, saving: false, onSave: () => {} }))));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)); });
  }
  function scroller() { return host.querySelector<HTMLElement>(".cm-scroller")!; }
  async function position(top: number, left: number, anchor: number) {
    await act(async () => {
      const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
      view.dispatch({ selection: { anchor } });
      scroller().scrollTop = top;
      scroller().scrollLeft = left;
      scroller().dispatchEvent(new dom.window.Event("scroll"));
    });
  }
  try {
    await show("latex-a", true);
    await position(640.5, 12.25, 200);
    await show("text-b", false);
    assert.equal(states.get("latex-a")?.editorScrollTop, 640.5);
    assert.equal(states.get("latex-a")?.selectionStart, 200);
    await position(1280, 24, 400);
    await show("latex-a", true);
    assert.equal(scroller().scrollTop, 640.5);
    assert.equal(scroller().scrollLeft, 12.25);
    await position(0, 0, 300);
    await show("text-b", false);
    assert.equal(scroller().scrollTop, 1280);
    assert.equal(scroller().scrollLeft, 24);
    await show("latex-a", true);
    assert.equal(scroller().scrollTop, 0, "saved zero must not recenter the cursor");
    assert.equal(scroller().scrollLeft, 0);
    assert.equal(EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!.state.selection.main.head, 300);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
