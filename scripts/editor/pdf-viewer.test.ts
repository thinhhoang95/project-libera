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
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "KeyboardEvent", "CustomEvent"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, "devicePixelRatio", { value: 2 });
  Object.assign(dom.window.HTMLElement.prototype, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
  const context = {} as CanvasRenderingContext2D;
  const scrolled: HTMLElement[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
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
    getTextContent: async () => {
      reads.set(i + 1, (reads.get(i + 1) ?? 0) + 1);
      return { items: (i === 4 ? ["Selectable PDF text", "Hidden nee", "dle", "across lines"] : ["Selectable PDF text"])
        .map((str) => ({ str, hasEOL: true })), styles: {} };
    },
    render: (options: typeof renders[number]) => { renders.push({ ...options, page: i + 1 }); return { promise: Promise.resolve(), cancel() {} }; },
  }));
  const pdf = { numPages: pages.length, getPage: async (n: number) => { pageRequests.push(n); return pages[n - 1]; } };
  require.cache[pdfModule] = { exports: {
    GlobalWorkerOptions: {},
    getDocument: () => { documentStarts++; return getDocumentImpl(); },
    TextLayer: class {
      textDivs: HTMLElement[] = [];
      constructor(readonly options: { container: HTMLElement; textContentSource: { items: { str: string }[] } }) {}
      async render() {
        this.textDivs = this.options.textContentSource.items.map((item) => {
          const span = document.createElement("span");
          span.textContent = item.str;
          this.options.container.append(span);
          return span;
        });
      }
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
      assert.equal(highlight.getAttribute("aria-pressed"), "true");
      assert.ok(host.querySelector(".pdf-highlight-outline"), "Selected highlights are outlined");
      assert.ok(host.querySelector('[aria-label="Highlight actions"]'), "Selected highlights offer recolor/remove");
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
    await t.test("annotation selection clears on Esc and click-away, and restyling touches one page", async () => {
      const note = (id: string, pageNumber: number): PdfAnnotation => ({
        id, type: "text", pageNumber, text: "Margin *note*", fontSize: 10,
        rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 }, createdAt: "2026-09-28", updatedAt: "2026-09-28",
      });
      normalLoad([
        { id: "highlight", type: "highlight", pageNumber: 1, color: "#ffe45c",
          rects: [{ x: 0.1, y: 0.5, width: 0.3, height: 0.02 }], createdAt: "2026-09-28", updatedAt: "2026-09-28" },
        note("note-1", 1), note("note-2", 2),
      ]);
      await mount();
      const lastSelection = () => changes.filter((change) => "selectedAnnotationId" in change).at(-1)?.selectedAnnotationId;
      const viewer = host.querySelector<HTMLElement>("[data-pdf-path]")!;
      viewer.focus();
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Select highlight"]')!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change to blue"]')!.click());
      assert.ok(host.querySelector('[aria-label="Change to blue"]')?.hasAttribute("data-active"), "chip recolors the highlight");
      await act(async () => viewer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      assert.equal(lastSelection(), "", "Esc deselects");
      assert.equal(host.querySelector('[aria-label="Highlight actions"]'), null);

      const resting = host.querySelector<HTMLElement>('[data-pdf-annotation-id="note-1"]')!;
      assert.equal(resting.querySelector("em")?.textContent, "note", "notes render Markdown");
      const scrollsBefore = scrolled.length;
      await act(async () => {
        resting.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
        resting.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 }));
      });
      assert.equal(lastSelection(), "note-1");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
      assert.equal(scrolled.length, scrollsBefore, "selecting on the page must not scroll the document");
      const before = pageComponentRenders;
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Red ink"]')!.click());
      assert.equal(resting.style.color, "rgb(198, 40, 40)");
      assert.equal(pageComponentRenders - before, 1, "only the edited note's page re-renders");

      const paper = host.querySelector('[data-pdf-page-content="2"] .pdf-text-layer')!;
      await act(async () => paper.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })));
      assert.equal(lastSelection(), "", "clicking the page lets go");
      await unmount();
    });
    await t.test("find searches unrendered pages, wraps, survives zoom, and clears on Escape", async () => {
      normalLoad();
      await mount();
      const viewer = host.querySelector<HTMLElement>("[data-pdf-path]")!;
      viewer.focus();
      const shortcut = new dom.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => viewer.dispatchEvent(shortcut));
      assert.ok(shortcut.defaultPrevented);
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Find in PDF"]')!;
      assert.equal(document.activeElement, input);
      async function query(value: string) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
          input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
      }
      await query("selectable");
      assert.equal(host.querySelector('[role="status"]')?.textContent, "1/5");
      assert.equal(host.querySelectorAll("canvas").length, 2, "Indexing must not render every page");
      await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
      assert.equal(host.querySelector('[role="status"]')?.textContent, "5/5");
      assert.ok(host.querySelector('[data-pdf-page-number="5"] .pdf-find-match-active'));
      assert.ok(scrolled.some((element) => element.classList.contains("pdf-find-match-active")));
      await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      assert.equal(host.querySelector('[role="status"]')?.textContent, "1/5");
      await query("across lines");
      assert.equal(host.querySelector('[role="status"]')?.textContent, "1/1");
      assert.equal(host.querySelector(".pdf-find-match-active")?.textContent, "across lines");
      const beforeZoomReads = Array.from(reads);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
      assert.equal(host.querySelector(".pdf-find-match-active")?.textContent, "across lines");
      assert.deepEqual(Array.from(reads), beforeZoomReads);
      await query("missing");
      assert.equal(host.querySelector('[role="status"]')?.textContent, "0/0");
      assert.equal(host.querySelector(".pdf-find-match"), null);
      assert.ok(host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.disabled);
      await query("selectable");
      await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      assert.equal(host.querySelector('[role="search"]'), null);
      assert.equal(host.querySelector(".pdf-find-match"), null);
      assert.equal(document.activeElement, viewer);
      const outside = document.createElement("input");
      document.body.append(outside);
      outside.focus();
      const outsideShortcut = new dom.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
      await act(async () => outside.dispatchEvent(outsideShortcut));
      assert.equal(outsideShortcut.defaultPrevented, false, "Do not capture find from other panes");
      assert.equal(host.querySelector('[role="search"]'), null);
      outside.remove();
      await act(async () => viewer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true })));
      assert.equal(host.querySelector<HTMLInputElement>('input[aria-label="Find in PDF"]')?.value, "selectable");
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
