import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  annotationAnchorRect,
  annotationLinkLabel,
  findRememberedAnnotation,
  panCenteringRect,
  rememberFileAnnotations,
  scrollTopCenteringRect,
} from "../../src/lib/annotation-links";
import type { PdfHighlightAnnotation, PdfTextAnnotation } from "../../src/lib/types";

const highlight: PdfHighlightAnnotation = {
  id: "h1", type: "highlight", pageNumber: 2, color: "#ff0", quote: "The **key** finding",
  rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.02 }, { x: 0.05, y: 0.22, width: 0.3, height: 0.02 }],
  createdAt: "", updatedAt: "",
};
const note: PdfTextAnnotation = {
  id: "n1", type: "text", pageNumber: 1, text: "Check this", fontSize: 14,
  rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 }, createdAt: "", updatedAt: "",
};

test("annotation link labels and geometry", () => {
  rememberFileAnnotations("Papers/a.pdf", [highlight, note]);
  assert.equal(findRememberedAnnotation("Papers/a.pdf", "h1"), highlight);
  assert.equal(findRememberedAnnotation("Papers/b.pdf", "h1"), undefined);
  assert.equal(annotationLinkLabel(highlight, "Selected highlight"), "The key finding");
  assert.equal(annotationLinkLabel(undefined, "Selected note"), "Selected note");
  const rect = annotationAnchorRect(highlight);
  assert.deepEqual(
    Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
    { x: 0.05, y: 0.2, width: 0.55, height: 0.04 },
  );
  // Page at 1000px, 800px tall; rect middle at 0.22 → 1176, centered in a 600px viewport.
  assert.equal(scrollTopCenteringRect(1000, 800, rect, 600), 876);
  assert.equal(scrollTopCenteringRect(0, 800, { x: 0, y: 0, width: 0, height: 0 }, 600), 0);
  assert.deepEqual(panCenteringRect(note.rect, { width: 500, height: 250 }, 2), { x: -250, y: 125 });
});

test("following a link to an image note selects it, centers it once, then clears the request", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLImageElement", "Element", "Node", "KeyboardEvent", "MouseEvent", "CustomEvent", "Image"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    fetch: async () => new Response(JSON.stringify({ path: "Notes/a.png", annotations: [note] })),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() { return (this as HTMLElement).classList.contains("libera-photo-frame") ? 500 : 0; },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() { return (this as HTMLElement).classList.contains("libera-photo-frame") ? 250 : 0; },
  });

  const { ImageViewer } = await import("../../src/components/libera/image-viewer");
  const root = createRoot(document.getElementById("root")!);
  const patches: Record<string, unknown>[] = [];
  try {
    await act(async () => root.render(createElement(ImageViewer, {
      src: "/raw/a.png", alt: "a.png", filePath: "Notes/a.png",
      initialViewState: { zoom: 2, panX: 40, panY: 0, selectedAnnotationId: "n1", revealSelectedAnnotation: true },
      onViewStateChange: (patch) => { patches.push(patch); },
    })));
    const image = document.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 1000 });
    Object.defineProperty(image, "naturalHeight", { value: 500 });
    await act(async () => { image.dispatchEvent(new dom.window.Event("load")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    const reveals = patches.filter((patch) => "revealSelectedAnnotation" in patch);
    assert.equal(reveals.length, 1, "The request is handled exactly once");
    assert.deepEqual(reveals[0], { panX: -250, panY: 125, revealSelectedAnnotation: undefined, selectedAnnotationId: "n1" });
    assert.match(document.querySelector<HTMLElement>(".libera-photo-frame")!.style.transform, /translate\(-250px, 125px\) scale\(2\)/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
