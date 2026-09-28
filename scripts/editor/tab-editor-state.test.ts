import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(emptyTree());
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
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.fetch = originalFetch;
  }
});
