import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { GalleryContents, GalleryPhoto } from "../../src/lib/image-generation";

const photo = (id: string, starred = false): GalleryPhoto => ({
  id, name: `${id}.png`, path: `${id}.png`, folder: "", albumIds: [],
  createdAt: `2026-10-0${id === "first" ? 2 : 1}T00:00:00Z`, updatedAt: "1", size: 20,
  width: 1000, height: 800, starred, edited: false,
});

test("gallery sections and individual photos retain scroll, zoom and info state through panel switches", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Image", "CustomEvent"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(readonly callback: ResizeObserverCallback) {}
      observe(target: Element) { this.callback([{ target, contentRect: { width: 800 } }] as ResizeObserverEntry[], this as unknown as ResizeObserver); }
      disconnect() {}
    },
  });
  const contents: GalleryContents = { root: "/gallery", photos: [photo("first"), photo("second", true)], albums: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(contents);
  const { ImageGalleryView } = await import("../../src/components/libera/image-gallery-view");
  const { applyGallery } = await import("../../src/components/libera/gallery-store");
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  async function show(visible = true) { await act(async () => root.render(visible ? createElement(ImageGalleryView) : null)); }
  function button(label: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
    assert.ok(found, `Expected ${label}`); return found;
  }
  async function click(label: string) { await act(async () => button(label).click()); }
  function scroller() {
    const result = host.querySelector<HTMLElement>(".overflow-auto.pb-8"); assert.ok(result); return result;
  }
  async function scroll(top: number) { await act(async () => { scroller().scrollTop = top; scroller().dispatchEvent(new dom.window.Event("scroll")); }); }
  function image() { return document.querySelector<HTMLImageElement>('img[alt="first.png"]')!; }
  try {
    applyGallery(contents);
    await show();
    await scroll(620.25);
    await click("Starred");
    assert.equal(scroller().scrollTop, 0);
    await scroll(210.5);
    await click("Photos");
    assert.equal(scroller().scrollTop, 620.25);
    await show(false); await show();
    assert.equal(scroller().scrollTop, 620.25);
    await click("Open first.png");
    assert.ok(document.querySelector('[role="dialog"]'));
    await click("Zoom in");
    assert.match(image().style.transform, /scale\(1.5\)/);
    await act(async () => {
      const info = document.querySelector<HTMLElement>('[role="dialog"] aside')!;
      info.scrollTop = 130.5;
      info.dispatchEvent(new dom.window.Event("scroll"));
    });
    await click("Info");
    assert.equal(button("Info").getAttribute("aria-pressed"), "false");
    await click("Next photo");
    assert.match(document.querySelector<HTMLImageElement>('img[alt="second.png"]')!.style.transform, /scale\(1\)/);
    await click("Previous photo");
    assert.match(image().style.transform, /scale\(1.5\)/);
    await show(false); await show();
    assert.match(image().style.transform, /scale\(1.5\)/);
    assert.equal(button("Info").getAttribute("aria-pressed"), "false");
    await click("Info");
    assert.equal(document.querySelector<HTMLElement>('[role="dialog"] aside')!.scrollTop, 130.5);
    // Slideshow state must survive stepping to another photo.
    await click("Play slideshow");
    await click("Next photo");
    assert.ok(button("Pause slideshow"));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
