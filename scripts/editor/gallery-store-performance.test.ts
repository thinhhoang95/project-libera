import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { galleryPhotoSummary } from "../../src/lib/gallery-catalog";
import type { GalleryPhoto } from "../../src/lib/image-generation";

const photo = (id: number, prompt = `prompt ${id}`): GalleryPhoto => ({ id: `cache${id}`, path: `${id}.png`, name: `${id}.png`, folder: "", albumIds: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "v1", size: 1, starred: false, edited: false, prompt });

test("detail cache evicts old photos, caps bytes, and never retains archived details", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const huge = "x".repeat(1024 * 1024 + 1);
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    const id = Number(new URL(url, "http://localhost").searchParams.get("id")!.replace("cache", ""));
    return Response.json(photo(id, id === 100 ? huge : `prompt ${id}`));
  };
  const { useGalleryPhotoDetails } = await import("../../src/components/libera/gallery-store");
  function Probe({ summary, archived }: { summary: GalleryPhoto; archived: boolean }) {
    const details = useGalleryPhotoDetails(summary, archived);
    return createElement("span", null, details.prompt?.slice(0, 30));
  }
  const root = createRoot(document.getElementById("root")!);
  const show = async (id: number, archived = false) => act(async () => root.render(createElement(Probe, { summary: galleryPhotoSummary(photo(id, id === 100 ? huge : `prompt ${id}`)), archived })));
  try {
    for (let id = 0; id < 70; id++) await show(id);
    const before = calls.length;
    await show(0); assert.equal(calls.length, before + 1, "oldest detail was evicted");
    await show(69); assert.equal(calls.length, before + 1, "recent detail was retained");
    await show(100); assert.equal(document.querySelector("span")!.textContent, "x".repeat(30));
    await show(69); await show(100);
    assert.equal(calls.filter((url) => url.endsWith("id=cache100")).length, 2, "oversized text is displayed but never cached");
    await show(300, true); await show(301, true); await show(300, true);
    assert.equal(calls.filter((url) => url.includes("archive/details?id=cache300")).length, 2);
  } finally { await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("pagination cannot overwrite a mutation completed while it was loading", async () => {
  const { applyGallery, loadedGallery, refreshGallery } = await import("../../src/components/libera/gallery-store");
  const originalFetch = globalThis.fetch;
  let answer!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>((resolve) => { answer = resolve; });
  try {
    applyGallery({ root: "/gallery", albums: [], photos: [photo(1)] });
    const pending = refreshGallery();
    applyGallery({ root: "/gallery", albums: [], photos: [photo(2)] });
    answer(Response.json({ root: "/gallery", albums: [], photos: [galleryPhotoSummary(photo(1))], revision: "old", cursor: null }));
    await pending;
    assert.deepEqual((await loadedGallery())!.photos.map((entry) => entry.id), ["cache2"]);
  } finally { globalThis.fetch = originalFetch; }
});
