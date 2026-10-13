import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

test("notebook image viewer has the Gallery viewer's features", async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLImageElement", "Element", "Node", "KeyboardEvent", "MouseEvent", "CustomEvent", "Image"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
  // The image fits the view at 500px wide; the file itself is 2000px wide.
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() { return (this as HTMLElement).classList.contains("libera-photo-frame") ? 500 : 0; },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() { return (this as HTMLElement).classList.contains("libera-photo-frame") ? 250 : 0; },
  });

  const { ImageViewer } = await import("../../src/components/libera/image-viewer");
  const { PhotoEditor } = await import("../../src/components/libera/photo-editor");
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const siblings = ["a.png", "b.png", "c.png"].map((name) => ({ path: `Notes/${name}`, src: `/raw/${name}` }));
  const shown: string[] = [];

  async function render(filePath: string) {
    await act(async () => root.render(createElement(ImageViewer, {
      key: filePath, src: `/raw/${filePath}`, alt: filePath, filePath, annotatable: false, siblings,
      details: { size: 2048, location: filePath },
      onShowSibling: (path: string) => { shown.push(path); },
    })));
  }

  const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  const press = (key: string) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

  async function loadImage() {
    const image = host.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 2000 });
    Object.defineProperty(image, "naturalHeight", { value: 1000 });
    await act(async () => { image.dispatchEvent(new dom.window.Event("load")); });
  }

  await t.test("steps through the images in the folder", async () => {
    await render("Notes/b.png");
    assert.match(host.textContent ?? "", /2 of 3/);
    await act(async () => button("Next image")!.click());
    await act(async () => button("Previous image")!.click());
    await press("ArrowRight");
    assert.deepEqual(shown, ["Notes/c.png", "Notes/a.png", "Notes/c.png"]);

    await render("Notes/c.png");
    assert.equal(button("Next image"), null, "The last image has no next");
    shown.length = 0;
  });

  await t.test("a slideshow carries over to the next image and wraps around", async () => {
    await render("Notes/b.png");
    await act(async () => button("Play slideshow")!.click());
    await press("ArrowRight");
    await render("Notes/c.png");
    assert.ok(button("Pause slideshow"), "The slideshow keeps playing on the next image");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4100)); });
    assert.equal(shown.at(-1), "Notes/a.png", "After the last image the slideshow starts over");
    await act(async () => button("Pause slideshow")!.click());
    shown.length = 0;
  });

  await t.test("zoom shows actual size and fits again", async () => {
    await render("Notes/a.png");
    await loadImage();
    assert.equal(button("Show actual size")!.textContent, "Fit");
    await act(async () => button("Show actual size")!.click());
    assert.equal(button("Fit to view")!.textContent, "100%");
    assert.match(host.querySelector<HTMLElement>(".libera-photo-frame")!.style.transform, /scale\(4\)/);
    await press("0");
    assert.equal(button("Show actual size")!.textContent, "Fit");
    await press("+");
    assert.equal(button("Fit to view")!.textContent, "38%");
  });

  await t.test("the Info panel lists the file's details and stays open", async () => {
    await render("Notes/a.png");
    await loadImage();
    await press("i");
    const info = host.querySelector('[aria-label="Image info"]')!;
    assert.match(info.textContent ?? "", /2000 × 1000/);
    assert.match(info.textContent ?? "", /2 KB/);
    assert.match(info.textContent ?? "", /Notes\/a\.png/);
    await render("Notes/b.png");
    await act(async () => { await Promise.resolve(); });
    assert.ok(host.querySelector('[aria-label="Image info"]'), "Info stays open for the next image");
    await act(async () => button("Info")!.click());
  });

  await t.test("editing is offered only when a copy can be saved", async () => {
    await render("Notes/a.png");
    assert.equal(button("Edit image"), null);
    await act(async () => root.render(createElement(ImageViewer, {
      key: "edit", src: "/raw/a.png", alt: "a", filePath: "Notes/a.png", annotatable: false,
      onSaveEditedCopy: async () => {},
    })));
    assert.ok(button("Edit image"));
    await act(async () => root.render(createElement(ImageViewer, {
      key: "svg", src: "/raw/a.svg", alt: "a", filePath: "Notes/a.svg", annotatable: false,
      onSaveEditedCopy: async () => {},
    })));
    assert.equal(button("Edit image"), null, "Vector images cannot be edited");

    await act(async () => root.render(createElement(PhotoEditor, { src: "/raw/a.png", copyOnly: true, onCancel: () => {}, onSave: async () => {} })));
    const labels = [...host.querySelectorAll("header button")].map((item) => item.textContent?.trim());
    assert.ok(labels.includes("Save as copy"));
    assert.ok(!labels.includes("Save"), "Copy-only editing never offers to overwrite the original");
  });

  await act(async () => root.unmount());
});
