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
  function modeButton(mode: string) {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Markdown editing mode"] button'))
      .find((button) => button.textContent === mode);
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
    assert.equal(modeButton("Visual")?.getAttribute("aria-pressed"), "true");
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
    await click(modeButton("Source"));
    assert.ok(host.querySelector("textarea"));
    await click(host.querySelector<HTMLButtonElement>('[aria-label="New untitled file"]'));
    const secondTab = host.querySelectorAll<HTMLButtonElement>("[data-tab-id]")[1];
    assertVisualScroll(0, 0);
    await scrollVisual(48, 1280);

    await click(firstTab);
    assert.equal(modeButton("Source")?.getAttribute("aria-pressed"), "true");
    assert.equal(host.querySelector(".libera-tiptap"), null);
    await click(modeButton("Visual"));
    assertVisualScroll(24, 640);
    await click(secondTab);
    assertVisualScroll(48, 1280);
    await click(firstTab);
    assertVisualScroll(24, 640);

    // Scroll updates must not reapply the position from the previous mount.
    await scrollVisual(12, 320);
    await settle();
    assertVisualScroll(12, 320);
    await click(modeButton("Source"));
    await click(modeButton("Visual"));
    assertVisualScroll(12, 320);
    await click(secondTab);
    assertVisualScroll(48, 1280);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.fetch = originalFetch;
  }
});
