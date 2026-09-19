import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { PdfTabViewState } from "../../src/components/libera/types";
import type { PdfAnnotation } from "../../src/lib/types";
import { PDF_MAX_CANVAS_PIXELS } from "../../src/components/libera/pdf-rendering";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("PDF viewer performance and lifecycle regressions", async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "KeyboardEvent"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, "devicePixelRatio", { value: 2 });
  const context = {} as CanvasRenderingContext2D;
  dom.window.HTMLCanvasElement.prototype.getContext = (() => context) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  const observers: FakeObserver[] = [];
  class FakeObserver {
    constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
    observe() {}
    disconnect() {}
    show(pageNumber: number) {
      this.callback(Array.from(document.querySelectorAll("[data-pdf-page-number]")).map((target) => ({
        target, isIntersecting: Number(target.getAttribute("data-pdf-page-number")) === pageNumber,
      })) as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
    }
  }
  Object.assign(globalThis, { IntersectionObserver: FakeObserver });
  const require = createRequire(import.meta.url);
  const pdfModule = require.resolve("pdfjs-dist");
  const oldPdfModule = require.cache[pdfModule];
  let getDocumentImpl: () => unknown;
  let documentStarts = 0;
  const renders: { page: number; viewport: { width: number; height: number }; transform: number[] }[] = [];
  const reads = new Map<number, number>();
  const pageRequests: number[] = [];
  const pages = Array.from({ length: 5 }, (_, i) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale }),
    getTextContent: async () => { reads.set(i + 1, (reads.get(i + 1) ?? 0) + 1); return { items: [], styles: {} }; },
    render: (options: typeof renders[number]) => { renders.push({ ...options, page: i + 1 }); return { promise: Promise.resolve(), cancel() {} }; },
  }));
  const pdf = { numPages: pages.length, getPage: async (n: number) => { pageRequests.push(n); return pages[n - 1]; } };
  require.cache[pdfModule] = { exports: {
    GlobalWorkerOptions: {},
    getDocument: () => { documentStarts++; return getDocumentImpl(); },
    TextLayer: class {
      constructor(readonly options: { container: HTMLElement }) {}
      async render() { this.options.container.textContent = "Selectable PDF text"; }
      cancel() {}
    },
  } } as NodeModule;
  const annotationModule = require.resolve("../../src/components/libera/text-annotation-layer");
  const realAnnotations = require(annotationModule);
  const oldAnnotations = require.cache[annotationModule];
  let pageComponentRenders = 0;
  require.cache[annotationModule] = { exports: {
    ...realAnnotations,
    TextAnnotationLayer: (props: object) => { pageComponentRenders++; return createElement(realAnnotations.TextAnnotationLayer, props); },
  } } as NodeModule;
  const { createRoot } = await import("react-dom/client");
  const { PdfViewer } = await import("../../src/components/libera/pdf-viewer");
  const originalFetch = globalThis.fetch;
  const host = document.getElementById("root")!;
  let root = createRoot(host);
  let destroys = 0;
  let signals: AbortSignal[] = [];
  const changes: PdfTabViewState[] = [];
  function normalLoad(annotations: PdfAnnotation[] = []) {
    getDocumentImpl = () => ({ promise: Promise.resolve(pdf), destroy: async () => { destroys++; } });
    globalThis.fetch = async (input, init) => {
      signals.push(init?.signal as AbortSignal);
      return String(input).startsWith("/api/pdf-annotations")
        ? Response.json({ annotations }) : new Response(new Uint8Array([1]));
    };
  }
  async function mount(initialViewState?: PdfTabViewState) {
    await act(async () => root.render(createElement(PdfViewer, {
      src: "/paper.pdf", filePath: "paper.pdf", initialViewState,
      onViewStateChange: (patch) => changes.push(patch),
      // The workspace recreates these callbacks during its own state updates.
      onCancelScreenshotSnip: () => undefined,
      onCompleteScreenshotSnip: async () => undefined,
    })));
  }
  async function unmount() { await act(async () => root.unmount()); root = createRoot(host); }
  try {
    await t.test("zoom and page revisits reuse text, preserve CSS size, and skip page renders on parent updates", async () => {
      normalLoad();
      await mount({ zoom: 4 });
      assert.equal(host.querySelectorAll("canvas").length, 2);
      const canvas = host.querySelector("canvas")!;
      assert.ok(canvas.width * canvas.height <= PDF_MAX_CANVAS_PIXELS);
      assert.equal(canvas.style.width, "2448px");
      assert.equal(canvas.style.height, "3168px");
      const firstRender = renders.find((render) => render.page === 1)!;
      assert.equal(firstRender.transform[0] * firstRender.viewport.width, canvas.width);
      assert.equal(firstRender.transform[3] * firstRender.viewport.height, canvas.height);
      const count = pageComponentRenders;
      await mount({ zoom: 4, scrollTop: 100 });
      assert.equal(pageComponentRenders, count, "Parent scroll-state updates should skip unchanged page components");
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
      assert.equal(reads.get(1), 1);
      assert.equal(reads.get(2), 1);
      await act(async () => observers.at(-1)!.show(5));
      assert.equal(host.querySelector('[data-pdf-page-number="1"] canvas'), null);
      await act(async () => observers.at(-1)!.show(1));
      assert.equal(reads.get(1), 1);
      assert.ok(host.querySelector('[data-pdf-page-number="1"] .pdf-text-layer')?.textContent?.includes("Selectable"));
      assert.equal((host.querySelector(".pdf-text-layer") as HTMLElement).style.pointerEvents, "auto");
      await unmount();
      assert.equal(destroys, 1);
    });
    await t.test("scroll bursts coalesce and the final position flushes on unmount", async () => {
      normalLoad();
      await mount();
      changes.length = 0;
      const scroller = host.querySelector(".overflow-auto")!;
      await act(async () => {
        for (let i = 1; i <= 100; i++) {
          scroller.scrollTop = i;
          scroller.dispatchEvent(new dom.window.Event("scroll"));
        }
      });
      assert.equal(changes.length, 0);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 175)); });
      assert.deepEqual(changes, [{ scrollTop: 100, scrollLeft: 0 }]);
      await act(async () => { scroller.scrollTop = 123; scroller.dispatchEvent(new dom.window.Event("scroll")); });
      await unmount();
      assert.deepEqual(changes.at(-1), { scrollTop: 123, scrollLeft: 0 });
    });
    await t.test("annotations use display coordinates at capped resolution and selection tools still work", async () => {
      normalLoad([{
        id: "highlight", type: "highlight", pageNumber: 1, color: "#fde047",
        rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
        createdAt: "2026-09-18", updatedAt: "2026-09-18",
      }]);
      await mount({ zoom: 4 });
      const highlight = host.querySelector<HTMLButtonElement>('[aria-label="Select highlight"]')!;
      assert.equal(highlight.style.left, "244.8px");
      assert.equal(highlight.style.top, "633.6px");
      await act(async () => highlight.click());
      assert.equal(changes.at(-1)?.selectedAnnotationId, "highlight");
      assert.ok(highlight.className.includes("ring-2"));
      await act(async () => host.querySelector<HTMLButtonElement>('[data-viewer-tool="text"]')!.click());
      assert.equal((host.querySelector(".pdf-text-layer") as HTMLElement).style.pointerEvents, "none");
      await act(async () => host.querySelector<HTMLButtonElement>('[data-viewer-tool="select"]')!.click());
      const layer = host.querySelector<HTMLElement>(".pdf-text-layer")!;
      assert.equal(layer.style.pointerEvents, "auto");
      const range = document.createRange();
      range.selectNodeContents(layer);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      assert.equal(window.getSelection()!.toString(), "Selectable PDF text");
      await unmount();
    });
    await t.test("closing during fetch aborts both requests and never starts PDF.js", async () => {
      signals = [];
      const response = deferred<Response>();
      const before = documentStarts;
      globalThis.fetch = async (_input, init) => { signals.push(init?.signal as AbortSignal); return response.promise; };
      await mount();
      await unmount();
      assert.equal(signals.length, 2);
      assert.ok(signals.every((signal) => signal.aborted));
      await act(async () => response.resolve(Response.json({ annotations: [] })));
      assert.equal(documentStarts, before);
    });
    await t.test("closing while PDF.js loads destroys its task and prevents page discovery", async () => {
      normalLoad();
      const loading = deferred<typeof pdf>();
      const before = destroys;
      getDocumentImpl = () => ({ promise: loading.promise, destroy: async () => { destroys++; } });
      pageRequests.length = 0;
      await mount();
      await unmount();
      assert.equal(destroys, before + 1);
      await act(async () => loading.resolve(pdf));
      assert.deepEqual(pageRequests, []);
      assert.equal(destroys, before + 1);
    });
    await t.test("closing during page discovery stops before requesting another page", async () => {
      normalLoad();
      const pendingPage = deferred<typeof pages[number]>();
      pageRequests.length = 0;
      getDocumentImpl = () => ({ promise: Promise.resolve({ ...pdf, getPage: (n: number) => {
        pageRequests.push(n); return pendingPage.promise;
      } }), destroy: async () => { destroys++; } });
      await mount();
      assert.deepEqual(pageRequests, [1]);
      await unmount();
      await act(async () => pendingPage.resolve(pages[0]));
      assert.deepEqual(pageRequests, [1]);
    });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    if (oldPdfModule) require.cache[pdfModule] = oldPdfModule; else delete require.cache[pdfModule];
    require.cache[annotationModule] = oldAnnotations;
    dom.window.close();
  }
});
