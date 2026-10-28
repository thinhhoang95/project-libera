import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import type { Editor } from "@tiptap/core";
import { createRoot } from "react-dom/client";
import { emptyTree } from "../../src/components/libera/api-client";
import { normalizeMarkdownPreferences } from "../../src/lib/markdown-preferences";

test("tabs independently retain editing mode and Visual scroll across tab and mode switches", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "http://localhost", pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    innerHeight: 768, innerWidth: 1024,
  });
  Object.assign(dom.window.Range.prototype, {
    getClientRects: () => [],
    getBoundingClientRect: () => new dom.window.DOMRect(),
  });
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: false }) });
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  class PreviewWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    terminated = false;
    postMessage(request: { id: number; markdown: string }) {
      setTimeout(() => {
        if (!this.terminated) this.onmessage?.({ data: {
          id: request.id, offsets: [],
          children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: request.markdown }] }],
        } });
      }, 0);
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: PreviewWorker });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/api/recordings")
    ? Response.json({ recordings: [] })
    : Response.json(emptyTree());
  const host = document.getElementById("root")!;
  const root = createRoot(host);

  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  }
  async function click(button: HTMLButtonElement | undefined | null) {
    assert.ok(button, "Expected button to be mounted");
    await act(async () => { button.click(); });
    await settle();
  }
  let menuAction: string | null = null;
  window.liberaMenu = { popup: async () => menuAction };
  async function changeMode(mode: "Source" | "Visual") {
    menuAction = mode === "Source" ? "editor-source" : "editor-visual";
    await click(host.querySelector<HTMLButtonElement>('[aria-label="File actions"]'));
    menuAction = null;
  }
  function visualScroller() {
    const scroller = host.querySelector<HTMLElement>(".libera-tiptap")?.parentElement?.parentElement;
    assert.ok(scroller, "Visual document must be mounted before restoring scroll");
    return scroller;
  }
  async function scrollVisual(left: number, top: number) {
    await act(async () => {
      const scroller = visualScroller();
      // A reader's scroll starts with the wheel, which ends a restore still settling.
      scroller.dispatchEvent(new dom.window.WheelEvent("wheel"));
      scroller.scrollLeft = left;
      scroller.scrollTop = top;
      scroller.dispatchEvent(new dom.window.Event("scroll"));
    });
  }
  function assertVisualScroll(left: number, top: number) {
    assert.ok(host.querySelector(".libera-tiptap"), "Visual editor is mounted");
    assert.equal(visualScroller().scrollLeft, left);
    assert.equal(visualScroller().scrollTop, top);
  }

  try {
    const { LiberaApp } = await import("../../src/components/libera-app");
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(LiberaApp, {
        initialAuthenticated: true,
        markdownPreferences: normalizeMarkdownPreferences({
          wysiwygEditorFontFamily: "Aptos",
        }),
      })));
    });
    await settle();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="New untitled file"]'));
    const firstTab = host.querySelector<HTMLButtonElement>("[data-tab-id]")!;
    assert.match(visualScroller().style.fontFamily, /Aptos/);
    assertVisualScroll(0, 0);
    await act(async () => {
      const editor = (host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
      editor.commands.setContent("A paragraph with a saved cursor.", { contentType: "markdown" });
      editor.commands.setTextSelection({ from: 3, to: 12 });
    });
    await scrollVisual(24, 640);
    await changeMode("Source");
    assert.ok(host.querySelector("textarea"));
    await click(host.querySelector<HTMLButtonElement>('[aria-label="New untitled file"]'));
    const secondTab = host.querySelectorAll<HTMLButtonElement>("[data-tab-id]")[1];
    assertVisualScroll(0, 0);
    await scrollVisual(48, 1280);

    await click(firstTab);
    assert.ok(host.querySelector("textarea"));
    assert.equal(host.querySelector(".libera-tiptap"), null);
    await changeMode("Visual");
    assertVisualScroll(24, 640);
    const restoredEditor = (host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
    assert.equal(restoredEditor.state.selection.from, 3);
    assert.equal(restoredEditor.state.selection.to, 12);
    await click(secondTab);
    assertVisualScroll(48, 1280);
    await click(firstTab);
    assertVisualScroll(24, 640);

    // Scroll updates must not reapply the position from the previous mount.
    await scrollVisual(12, 320);
    await settle();
    assertVisualScroll(12, 320);
    await changeMode("Source");
    await changeMode("Visual");
    assertVisualScroll(12, 320);
    await click(secondTab);
    assertVisualScroll(48, 1280);

    // Both editors stay mounted in split view. Changing focus must not replay
    // either editor's initial scroll restoration.
    menuAction = "split-right";
    await click(host.querySelector<HTMLButtonElement>('[aria-label="File actions"]'));
    menuAction = null;
    await click(firstTab);
    const panes = [...host.querySelectorAll<HTMLElement>(".libera-canvas-pane")];
    assert.equal(panes.length, 2);
    const left = panes[0].querySelector<HTMLElement>(".libera-visual-page")!;
    const right = panes[1].querySelector<HTMLElement>(".libera-visual-page")!;
    assert.ok(left && right);
    await act(async () => {
      left.scrollTop = 900;
      left.dispatchEvent(new dom.window.Event("scroll"));
      right.scrollTop = 500;
      right.dispatchEvent(new dom.window.Event("scroll"));
    });
    await settle();
    for (const pane of [panes[0], panes[1], panes[0]]) {
      await act(async () => pane.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })));
      await settle();
      assert.equal(left.scrollTop, 900);
      assert.equal(right.scrollTop, 500);
    }

    // Source panes also keep their own refs while focus moves between them.
    await changeMode("Source");
    await act(async () => panes[1].dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })));
    await changeMode("Source");
    const sources = [...host.querySelectorAll<HTMLTextAreaElement>("textarea.markdown-editor-input")];
    assert.equal(sources.length, 2);
    await act(async () => {
      sources[0].scrollTop = 777.5; sources[0].scrollLeft = 17.25;
      sources[1].setSelectionRange(2, 8);
      sources[0].dispatchEvent(new dom.window.Event("scroll"));
      sources[1].scrollTop = 333.25; sources[1].scrollLeft = 9;
      sources[1].dispatchEvent(new dom.window.Event("scroll"));
    });
    // Focus before the queued scroll work runs.
    for (const pane of [panes[0], panes[1], panes[0]]) {
      await act(async () => pane.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })));
      await settle();
      assert.equal(sources[0].scrollTop, 777.5);
      assert.equal(sources[0].scrollLeft, 17.25);
      assert.equal(sources[1].selectionStart, 2);
      assert.equal(sources[1].selectionEnd, 8);
      assert.equal(sources[1].scrollTop, 333.25);
      assert.equal(sources[1].scrollLeft, 9);
    }

    // Closing a pane and immediately switching the remaining pane must also
    // preserve Source selection and preview offsets before their next frame.
    await click(panes[0].querySelector<HTMLButtonElement>('[aria-label="Close panel (the tab stays open)"]'));
    const remainingSource = host.querySelector<HTMLTextAreaElement>("textarea.markdown-editor-input")!;
    const remainingPreview = host.querySelector<HTMLElement>(".markdown-preview-pane")!;
    await act(async () => {
      remainingSource.scrollTop = 555.75;
      remainingSource.scrollLeft = 15.5;
      remainingSource.setSelectionRange(4, 11);
      remainingSource.dispatchEvent(new dom.window.Event("scroll"));
      remainingPreview.scrollTop = 888.25;
      remainingPreview.scrollLeft = 7.5;
      remainingPreview.dispatchEvent(new dom.window.Event("scroll"));
    });
    await click(secondTab);
    await click(firstTab);
    const restoredSource = host.querySelector<HTMLTextAreaElement>("textarea.markdown-editor-input")!;
    const restoredPreview = host.querySelector<HTMLElement>(".markdown-preview-pane")!;
    assert.equal(restoredSource.scrollTop, 555.75);
    assert.equal(restoredSource.scrollLeft, 15.5);
    assert.equal(restoredSource.selectionStart, 4);
    assert.equal(restoredSource.selectionEnd, 11);
    assert.equal(restoredPreview.scrollTop, 888.25);
    assert.equal(restoredPreview.scrollLeft, 7.5);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.fetch = originalFetch;
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
