import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { captureCanvasViewState } from "../../src/components/libera/canvas-view-state";
import type { ImageTabViewState } from "../../src/components/libera/types";
import type { GalleryPhoto } from "../../src/lib/image-generation";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("image and photo pan/zoom reach the stored view state when the gesture settles", async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLImageElement", "Element", "Node", "KeyboardEvent", "MouseEvent", "CustomEvent", "Image", "MutationObserver", "DOMParser"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
  Object.assign(dom.window.HTMLElement.prototype, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
  const host = document.getElementById("root")!;
  let root = createRoot(host);
  async function unmount() { await act(async () => root.unmount()); root = createRoot(host); }

  await t.test("image viewer: wheel zoom and pointer pans write nothing until they settle, then once", async () => {
    const { ImageViewer } = await import("../../src/components/libera/image-viewer");
    const states: ImageTabViewState[] = [];
    const props = { src: "/photo.png", filePath: "photo.png", alt: "Photo", annotatable: false,
      onViewStateChange: (patch: ImageTabViewState) => states.push(patch) };
    await act(async () => root.render(createElement(ImageViewer, props)));
    const frameNow = () => host.querySelector<HTMLElement>(".libera-photo-frame")!;
    const stageNow = () => frameNow().parentElement!;
    const frame = frameNow();
    const before = states.length;

    await act(async () => {
      for (let i = 0; i < 40; i++) stageNow().dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -20, bubbles: true, cancelable: true }));
    });
    assert.equal(states.length, before, "40 wheel events produce no view-state write");
    assert.doesNotMatch(frame.style.transform, /scale\(1\)/, "the image still follows the gesture");
    await act(async () => { await wait(250); });
    assert.equal(states.length, before + 1, "one write once the wheel pauses");
    const zoom = states.at(-1)!.zoom!;
    assert.ok(zoom > 1);

    states.length = 0;
    const pointer = (type: string, x: number) => stageNow().dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 0 }));
    await act(async () => {
      pointer("pointerdown", 0);
      for (let i = 1; i <= 50; i++) pointer("pointermove", i);
    });
    assert.equal(states.length, 0, "50 pan moves produce no view-state write");
    await act(async () => { pointer("pointerup", 50); });
    assert.equal(states.length, 1, "pointer up stores the settled pan");
    assert.equal(states[0].panX, 50);
    await act(async () => { await wait(250); });
    assert.equal(states.length, 1, "nothing is written twice");

    // Unmounting mid-gesture flushes the final position.
    states.length = 0;
    await act(async () => { pointer("pointerdown", 0); pointer("pointermove", 7); });
    assert.equal(states.length, 0);
    await unmount();
    assert.equal(states.length, 1);
    assert.equal(states[0].panX, 57);

    // A view-state capture (tab switch, layout change, quit) flushes too.
    states.length = 0;
    await act(async () => root.render(createElement(ImageViewer, props)));
    await act(async () => { pointer("pointerdown", 0); pointer("pointermove", 9); });
    assert.equal(states.length, 0);
    await act(async () => captureCanvasViewState());
    assert.equal(states.length, 1);
    assert.equal(states[0].panX, 9);
    await unmount();
    assert.equal(states.length, 1, "unmount after a capture does not repeat the write");
  });

  await t.test("photo viewer: zoom writes wait for the pause and flush on unmount", async () => {
    const { PhotoViewer } = await import("../../src/components/libera/photo-viewer");
    const photo: GalleryPhoto = { id: "p1", path: "p1.png", name: "p1.png", folder: "", albumIds: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", size: 10, width: 100, height: 100, starred: false, edited: false };
    const states: { transform: { scale: number; x: number; y: number } }[] = [];
    const props = { photos: [photo], index: 0, albums: [], onNavigate: () => undefined, onClose: () => undefined,
      actions: { onDelete: () => undefined }, onViewStateChange: (state: { transform: { scale: number; x: number; y: number } }) => states.push(state) };
    await act(async () => root.render(createElement(PhotoViewer, props)));
     const stage = document.querySelector<HTMLElement>("[role=dialog] .touch-none")!;
    assert.ok(stage);
    // The viewer reports its opening state once.
    const before = states.length;
    await act(async () => {
      for (let i = 0; i < 30; i++) stage.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -20, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    });
    assert.equal(states.length, before, "wheel ticks write nothing while they continue");
    await act(async () => { await wait(250); });
    assert.equal(states.length, before + 1);
    assert.ok(states.at(-1)!.transform.scale > 1);

    await act(async () => { stage.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -20, bubbles: true, cancelable: true })); });
    const mid = states.length;
    await unmount();
    assert.equal(states.length, mid + 1, "unmount mid-gesture stores the final transform");
  });
});
