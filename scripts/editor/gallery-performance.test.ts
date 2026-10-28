import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { galleryRows, visibleGalleryRows } from "../../src/lib/gallery-layout";
import { galleryPhotoSummary } from "../../src/lib/gallery-catalog";
import type { GalleryContents, GalleryPhoto } from "../../src/lib/image-generation";

const photo = (index: number): GalleryPhoto => ({ id: `p${index}`, name: `${String(index).padStart(5, "0")}.jpg`, path: `${index}.jpg`, folder: "", albumIds: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "v1", size: 4000000, width: 6000, height: 4000, starred: false, edited: false });

test("both layouts bound visible rows and locate photos that have never mounted", () => {
  const photos = Array.from({ length: 100_000 }, (_, index) => photo(index));
  for (const mode of ["grid", "justified"] as const) {
    const layout = galleryRows([{ photos }], mode, 1000, 136);
    const position = layout.photoTops.get("p99999")!;
    assert.ok(position.top > 100000);
    for (const top of [0, layout.height / 2, layout.height - 700]) {
      const visible = visibleGalleryRows(layout.rows, top, 700);
      assert.ok(visible.length < 25, `${mode}: only nearby rows are materialized`);
      assert.ok(visible.every((row) => row.top <= top + 1100 && row.top + row.height >= Math.max(0, top - 400)));
    }
    const last = visibleGalleryRows(layout.rows, position.top, 700);
    assert.ok(last.some((row) => row.end === photos.length));
  }
});

test("10,000 photos keep a bounded DOM through seeking and preview navigation", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Image", "CustomEvent", "Event"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class {
    constructor(readonly callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: { width: 1000 } }] as ResizeObserverEntry[], this as unknown as ResizeObserver); }
    disconnect() {}
  } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 700; } });
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    assert.ok(!this.hasAttribute("data-photo-id"), "timeline must not measure photo tiles");
    return originalRect.call(this);
  };
  const contents: GalleryContents = { root: "/gallery", albums: [], photos: Array.from({ length: 10_000 }, (_, index) => photo(index)) };
  const originalFetch = globalThis.fetch;
  const OriginalSearchParams = globalThis.URLSearchParams;
  let photoUrlCalls = 0;
  globalThis.URLSearchParams = class extends OriginalSearchParams {
    constructor(init?: ConstructorParameters<typeof URLSearchParams>[0]) {
      super(init);
      if (init && typeof init === "object" && "v" in init) photoUrlCalls++;
    }
  };
  const preloads: Array<{ url: string; signal: AbortSignal }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/gallery?")) return Response.json({ ...contents, photos: contents.photos.map(galleryPhotoSummary) });
    if (url.startsWith("/api/gallery/photos/details")) return Response.json(contents.photos.find((item) => item.id === new OriginalSearchParams(url.split("?")[1]).get("id")));
    if (url.startsWith("/api/gallery/raw/")) {
      preloads.push({ url, signal: init!.signal! });
      return new Response(new Blob(["preview"]));
    }
    return Response.json({});
  };
  const { ImageGalleryView } = await import("../../src/components/libera/image-gallery-view");
  const { applyGallery } = await import("../../src/components/libera/gallery-store");
  const root = createRoot(document.getElementById("root")!);
  const click = async (label: string) => act(async () => {
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(button, label); button.click();
  });
  const frame = () => act(async () => { await new Promise((resolve) => window.requestAnimationFrame(resolve)); });
  try {
    applyGallery(contents);
    await act(async () => root.render(createElement(ImageGalleryView)));
    const tileCount = () => document.querySelectorAll("[data-photo-id]").length;
    assert.ok(tileCount() > 0 && tileCount() < 100);
    const scroller = document.querySelector<HTMLElement>(".overflow-auto.pb-8")!;
    const totalHeight = parseFloat(document.querySelector<HTMLElement>("[data-gallery-virtual]")!.style.height);
    await act(async () => { scroller.scrollTop = totalHeight - 700; scroller.dispatchEvent(new dom.window.Event("scroll")); });
    await frame();
    assert.ok(tileCount() < 100);
    assert.ok(document.querySelector('[data-photo-id="p0"]'), "oldest photo appears without mounting the intervening collection");
    await act(async () => { scroller.scrollTop = 0; scroller.dispatchEvent(new dom.window.Event("scroll")); });
    await frame();
    await click("Open 09999.jpg");
    const image = () => document.querySelector<HTMLImageElement>('img[alt="09999.jpg"]')!;
    assert.match(image().src, /thumbnail=1/);
    assert.match(image().src, /size=(160|320|640|1280|2048)/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    assert.equal(preloads.length, 1, "first photo speculates only its next neighbor");
    photoUrlCalls = 0;
    await click("Next photo");
    assert.ok(photoUrlCalls < 50, `preview navigation must skip the grid (${photoUrlCalls} URL constructions)`);
    assert.equal(preloads[0].signal.aborted, true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    assert.equal(preloads.filter((request) => !request.signal.aborted).length, 2);
    assert.ok(preloads.every((request) => request.url.includes("thumbnail=1") && request.url.includes("size=2048")));
    await click("Previous photo");
    await click("Zoom in");
    assert.ok(!image().src.includes("thumbnail=1"), "zoom loads the original on demand");
    assert.ok(tileCount() < 100);
    await click("Back to gallery");
    assert.ok(preloads.every((request) => request.signal.aborted));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch; globalThis.URLSearchParams = OriginalSearchParams; dom.window.close();
  }
});
