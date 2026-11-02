import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { InkSurface } from "../../src/components/libera/ink/ink-surface";
import { INK_MAX_CANVAS_DIMENSION, INK_MAX_CANVAS_PIXELS, inkCanvasRatio, sizeCanvas } from "../../src/components/libera/ink/ink-renderer";
import { inkTools } from "../../src/components/libera/ink/use-ink-tools";
import { PdfDrawingLayer, type PdfDrawingDraft } from "../../src/components/libera/pdf-drawing-layer";
import type { PdfDrawingAnnotation } from "../../src/lib/pdf-drawing";
import type { PdfAnnotation } from "../../src/lib/types";

function setup(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const replace = (target: object, key: string, value: unknown) => {
    const before = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    t.after(() => {
      if (before) Object.defineProperty(target, key, before);
      else Reflect.deleteProperty(target, key);
    });
  };
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, devicePixelRatio: 2,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) replace(globalThis, key, value);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const request = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; };
  const cancel = (id: number) => { frames.delete(id); };
  for (const target of [globalThis, dom.window]) {
    replace(target, "requestAnimationFrame", request);
    replace(target, "cancelAnimationFrame", cancel);
  }
  dom.window.Element.prototype.setPointerCapture = () => {};
  dom.window.Element.prototype.hasPointerCapture = () => false;
  dom.window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 }) as DOMRect;
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  return { dom, replace, container, root, frames, flush() {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach((callback) => callback(0));
  } };
}

test("photo ink backing stores obey pixel and dimension budgets at extreme zoom", () => {
  assert.equal(inkCanvasRatio(1000, 800, 2), 2);
  assert.equal(inkCanvasRatio(1000, 800, 2, 1, true), 1.5);
  for (const [width, height] of [[12000, 8000], [100000, 500], [500, 100000], [4000, 4000]]) {
    for (const zoom of [1, 8]) for (const onBattery of [false, true]) {
      const dpr = inkCanvasRatio(width, height, 2, zoom, onBattery);
      const canvas = { width: 0, height: 0 } as HTMLCanvasElement;
      sizeCanvas(canvas, { cssWidth: width, cssHeight: height, scale: 1, dpr });
      assert.ok(canvas.width * canvas.height <= INK_MAX_CANVAS_PIXELS);
      assert.ok(Math.max(canvas.width, canvas.height) <= INK_MAX_CANVAS_DIMENSION);
    }
  }
});

test("battery detection resizes mounted ink; offscreen resize and power changes allocate no canvases", async (t) => {
  const harness = setup(t);
  const { dom, replace, container, root } = harness;
  const battery = new dom.window.EventTarget();
  let charging = false;
  Object.defineProperty(battery, "charging", { get: () => charging });
  let detect!: (battery: EventTarget) => void;
  replace(dom.window.navigator, "getBattery", () => new Promise((resolve) => { detect = resolve; }));
  let resize!: () => void;
  let show!: (entries: { isIntersecting: boolean }[]) => void;
  replace(globalThis, "ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  replace(globalThis, "IntersectionObserver", class { constructor(callback: typeof show) { show = callback; } observe() {} disconnect() {} });
  const context = new Proxy({}, { get: () => () => {} });
  t.mock.method(dom.window.HTMLCanvasElement.prototype, "getContext", () => context as CanvasRenderingContext2D);
  let width = 1000;
  let measurements = 0;
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => { measurements++; return width; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  const dimensions = () => [...container.querySelectorAll("canvas")].map((canvas) => [canvas.width, canvas.height]);
  try {
    await act(async () => root.render(createElement(InkSurface, {
      frame: { unit: "px", width: 1000, height: 800 }, strokes: [], tools: inkTools.get(),
      enabled: false, mouseDraws: false, onChange() {},
    })));
    assert.deepEqual(dimensions(), Array(3).fill([2000, 1600]));
    await act(async () => { detect(battery); });
    assert.deepEqual(dimensions(), Array(3).fill([1500, 1200]));
    await act(async () => { charging = true; battery.dispatchEvent(new dom.window.Event("chargingchange")); });
    assert.deepEqual(dimensions(), Array(3).fill([2000, 1600]));
    await act(async () => { show([{ isIntersecting: false }]); });
    assert.deepEqual(dimensions(), Array(3).fill([0, 0]));
    assert.equal(harness.frames.size, 0);
    await act(async () => {
      width = 1200; resize();
      charging = false; battery.dispatchEvent(new dom.window.Event("chargingchange"));
    });
    assert.deepEqual(dimensions(), Array(3).fill([0, 0]));
    assert.equal(harness.frames.size, 0);
    await act(async () => { show([{ isIntersecting: true }]); });
    assert.deepEqual(dimensions(), Array(3).fill([1800, 1200]));
    const canvases = [...container.querySelectorAll("canvas")];
    await act(async () => root.unmount());
    assert.ok(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
    const measured = measurements;
    charging = true;
    battery.dispatchEvent(new dom.window.Event("chargingchange"));
    assert.equal(measurements, measured, "unmount removes the power subscription");
    assert.equal(harness.frames.size, 0);
  } finally { dom.window.close(); }
});

test("PDF gesture frames preserve unchanged ink paths and commit the latest samples before paint", async (t) => {
  const { dom, container, root, frames, flush } = setup(t);
  let pathBuilds = 0;
  const annotations: PdfDrawingAnnotation[] = Array.from({ length: 100 }, (_, index) => {
    const points = Array.from({ length: 60 }, (_, step) => ({ x: step / 100, y: index / 200 }));
    points.map = function <U>(callback: (point: { x: number; y: number }, index: number, all: typeof points) => U, thisArg?: unknown): U[] {
      pathBuilds++;
      return Array.from(this, (point, step) => callback.call(thisArg, point, step, this));
    };
    return { id: `ink${index}`, type: "ink", pageNumber: 1, color: "#000000", strokeWidth: 2, points, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  });
  const added: Array<{ type: string; points?: unknown[] }> = [];
  const patches: Partial<PdfAnnotation>[] = [];
  let selected = "";
  const props = {
    annotations, markups: [], pageSize: { width: 1000, height: 800 }, selectedAnnotationId: "",
    style: { color: "#000000", shape: "line" as const, strokeWidth: 2 }, zoom: 1,
    onAdd: (draft: PdfDrawingDraft) => { added.push(draft); },
    onErase() {}, onSelect: (annotation: PdfAnnotation) => { selected = annotation.id; },
    onUpdate: (_id: string, patch: Partial<PdfAnnotation>) => { patches.push(patch); },
  };
  const pointer = (target: Element, type: string, x: number) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: 50 }); target.dispatchEvent(event);
  };
  try {
    await act(async () => root.render(createElement(PdfDrawingLayer, { ...props, mode: "draw" })));
    assert.equal(pathBuilds, 100);
    pathBuilds = 0;
    const surface = container.querySelector(".pdf-drawing-surface")!;
    await act(async () => { pointer(surface, "pointerdown", 10); });
    for (const x of [20, 30, 40]) await act(async () => { pointer(surface, "pointermove", x); });
    assert.equal(frames.size, 1, "a pointer burst queues one paint");
    await act(async () => { flush(); });
    assert.equal(pathBuilds, 0, "existing paths are not rebuilt for a new stroke");
    await act(async () => { pointer(surface, "pointermove", 50); pointer(surface, "pointerup", 50); });
    assert.equal(frames.size, 0);
    assert.equal(added[0].points?.length, 5, "release commits samples even before their paint");
    await act(async () => root.render(createElement(PdfDrawingLayer, { ...props, mode: "select" })));
    pathBuilds = 0;
    const hit = container.querySelector('[data-pdf-annotation-id="ink0"] .pdf-drawing-hit')!;
    await act(async () => { pointer(hit, "pointerdown", 10); });
    assert.equal(selected, "ink0");
    const svg = container.querySelector("svg")!;
    await act(async () => { pointer(svg, "pointermove", 40); flush(); });
    assert.equal(pathBuilds, 1, "only the moved stroke is visited to translate its points");
    await act(async () => { pointer(svg, "pointermove", 60); pointer(svg, "pointerup", 60); });
    assert.equal(frames.size, 0);
    const moved = patches[0] as { points: { x: number }[] };
    assert.equal(moved.points[0].x, 0.05, "drag commits its latest position without waiting for paint");
    await act(async () => { pointer(hit, "pointerdown", 10); pointer(svg, "pointermove", 40); });
    assert.equal(frames.size, 1);
  } finally {
    await act(async () => root.unmount());
    assert.equal(frames.size, 0, "unmount cancels queued paint");
    dom.window.close();
  }
});
