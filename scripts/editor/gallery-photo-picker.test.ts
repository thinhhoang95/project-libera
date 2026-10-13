import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { applyGallery } from "../../src/components/libera/gallery-store";
import { GalleryPhotoPicker, galleryPhotoFile, isInsertableGalleryPhoto } from "../../src/components/libera/gallery-photo-picker";
import type { GalleryContents, GalleryPhoto } from "../../src/lib/image-generation";

const photo = (id: string, name: string, createdAt: string, albumIds: string[] = [], starred = false): GalleryPhoto => ({
  id, path: name, name, folder: "", albumIds, createdAt, updatedAt: createdAt, size: 10, starred, edited: false,
});
const fox = photo("p1", "fox.png", "2026-10-01T00:00:00.000Z", ["a1"]);
const owl = photo("p2", "owl.jpg", "2026-10-02T00:00:00.000Z", [], true);
const logo = photo("p3", "logo.svg", "2026-10-03T00:00:00.000Z");
const contents: GalleryContents = { root: "/test", photos: [fox, owl, logo], albums: [{ id: "a1", name: "Animals", folder: "Animals", count: 1, coverId: "p1", createdAt: fox.createdAt }] };

test("only image types a note accepts can be picked, and picked photos become files", async () => {
  assert.equal(isInsertableGalleryPhoto(fox), true);
  assert.equal(isInsertableGalleryPhoto(owl), true);
  assert.equal(isInsertableGalleryPhoto(logo), false);
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (url) => { requested = String(url); return new Response(new Blob(["png"], { type: "application/octet-stream" })); };
  try {
    const file = await galleryPhotoFile(owl);
    assert.equal(file.name, "owl.jpg");
    assert.equal(file.type, "image/jpeg");
    assert.match(requested, /^\/api\/gallery\/raw\/owl\.jpg\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the gallery picker browses sections and albums and inserts photos in the order picked", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(contents);
  const root = createRoot(document.getElementById("root")!);
  const inserted: string[][] = [];
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label)!;
  const tiles = () => [...document.querySelectorAll<HTMLButtonElement>("[role=checkbox]")].map((item) => item.getAttribute("aria-label"));
  try {
    applyGallery(contents);
    await act(async () => { root.render(createElement(GalleryPhotoPicker, { open: true, onClose: () => undefined, onInsert: (photos) => { inserted.push(photos.map((item) => item.name)); } })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(tiles(), ["owl.jpg", "fox.png"], "newest first, vector photos left out");
    assert.equal(button("Insert photo").disabled, true);

    await act(async () => { button("owl.jpg").click(); });
    await act(async () => { button("Starred").click(); });
    assert.deepEqual(tiles(), ["owl.jpg"]);
    await act(async () => { button("Albums").click(); });
    await act(async () => { button("Animals1 item").click(); });
    assert.deepEqual(tiles(), ["fox.png"]);
    await act(async () => { button("fox.png").click(); });
    assert.equal(document.querySelector("[aria-label='fox.png']")?.textContent, "2", "the badge shows the insertion order");
    await act(async () => { button("Insert 2 photos").click(); });
    assert.deepEqual(inserted, [["owl.jpg", "fox.png"]], "selection survives browsing between sections");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
