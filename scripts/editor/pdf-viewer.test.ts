import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { PdfTabViewState } from "../../src/components/libera/types";
import type { PdfAnnotation } from "../../src/lib/types";
import { PDF_DETAIL_MARGIN, PDF_MAX_CANVAS_PIXELS } from "../../src/components/libera/pdf-rendering";
import { captureCanvasViewState } from "../../src/components/libera/canvas-view-state";

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
  Object.assign(globalThis, { IntersectionObserver: FakeObserver, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
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
  // JSDOM has no layout: model the viewer's fixed padding/gaps and each page's
  // actual CSS size, including pages outside the PDF render window. Sheets
  // stretch to the widest page, centred until they overflow the viewport.
  function installPdfGeometry(viewportWidth = 700) {
    const scroller = host.querySelector<HTMLElement>(".libera-pdf-viewer .overflow-auto")!;
    const sheets = [...host.querySelectorAll<HTMLElement>("[data-pdf-page-number]")];
    const size = (sheet: HTMLElement, axis: "width" | "height") => parseFloat((sheet.firstElementChild as HTMLElement).style[axis]);
    const height = (sheet: HTMLElement) => size(sheet, "height");
    const contentWidth = () => Math.max(...sheets.map((sheet) => size(sheet, "width")));
    scroller.getBoundingClientRect = () => ({ top: 80, left: 40, width: viewportWidth, height: 600 } as DOMRect);
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, get: () => viewportWidth },
      clientHeight: { configurable: true, get: () => 600 },
      scrollWidth: { configurable: true, get: () => Math.max(viewportWidth, contentWidth() + 32) },
      scrollHeight: { configurable: true, get: () => 48 + sheets.reduce((sum, sheet) => sum + height(sheet), 0) + (sheets.length - 1) * 20 },
    });
    for (const [index, sheet] of sheets.entries()) {
      sheet.getBoundingClientRect = () => {
        const top = 80 + 24 + sheets.slice(0, index).reduce((sum, previous) => sum + height(previous) + 20, 0) - scroller.scrollTop;
        const left = 40 + 16 + Math.max(0, (viewportWidth - 32 - contentWidth()) / 2) - scroller.scrollLeft;
        return { top, bottom: top + height(sheet), height: height(sheet), left, right: left + contentWidth(), width: contentWidth() } as DOMRect;
      };
    }
    return { scroller, sheets };
  }
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
    await t.test("high zoom keeps a full-resolution detail canvas over the visible part of the page", async () => {
      normalLoad();
      await mount({ zoom: 4 });
      const detailHost = host.querySelector<HTMLElement>('[data-pdf-page-number="1"] canvas + [aria-hidden]')!;
      assert.equal(detailHost.childElementCount, 0);
      // The page is scrolled 1000px down inside a 1024x768 window.
      detailHost.getBoundingClientRect = () => ({ left: 0, top: -1000, right: 2448, bottom: 2168, width: 2448, height: 3168 } as DOMRect);
      const before = renders.length;
      await act(async () => {
        document.dispatchEvent(new dom.window.Event("scroll"));
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      const detail = detailHost.querySelector("canvas")!;
      assert.equal(renders.length, before + 1);
      assert.deepEqual([detail.width, detail.height], [(1024 + PDF_DETAIL_MARGIN) * 2, (768 + PDF_DETAIL_MARGIN * 2) * 2]);
      assert.deepEqual(renders.at(-1)!.transform, [2, 0, 0, 2, -0, -(1000 - PDF_DETAIL_MARGIN) * 2]);
      assert.equal(detail.style.top, `${((1000 - PDF_DETAIL_MARGIN) / 3168) * 100}%`);

      // Small scrolls inside the rendered margin reuse it.
      detailHost.getBoundingClientRect = () => ({ left: 0, top: -1100, right: 2448, bottom: 2068, width: 2448, height: 3168 } as DOMRect);
      await act(async () => {
        document.dispatchEvent(new dom.window.Event("scroll"));
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      assert.equal(renders.length, before + 1);
      assert.equal(detailHost.querySelector("canvas"), detail);

      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')!.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
      assert.equal(detailHost.childElementCount, 0, "The page canvas is sharp at 100%, so the detail is dropped");
      await unmount();
    });
    await t.test("native scrolling and pinch never restart PDF rendering or install blocking gesture listeners", async () => {
      normalLoad();
      const added: { target: EventTarget; type: string; options: unknown }[] = [];
      const add = dom.window.EventTarget.prototype.addEventListener;
      dom.window.EventTarget.prototype.addEventListener = function (type, listener, options) {
        added.push({ target: this, type, options });
        return add.call(this, type, listener, options);
      };
      try {
        await mount();
      } finally {
        dom.window.EventTarget.prototype.addEventListener = add;
      }
      const scroller = host.querySelector<HTMLElement>(".libera-pdf-viewer .overflow-auto")!;
      assert.ok(!scroller.style.touchAction || scroller.style.touchAction.includes("pinch-zoom"));
      assert.equal(added.filter(({ target, type }) => target === scroller && ["wheel", "touchmove"].includes(type)).length, 0);
      const before = { renders: renders.length, observers: observers.length, changes: changes.length };
      for (let frame = 0; frame < 10; frame++) {
        await act(async () => {
          for (const ctrlKey of [false, true]) {
            const wheel = new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey, deltaY: -20 });
            scroller.dispatchEvent(wheel);
            assert.equal(wheel.defaultPrevented, false);
          }
          const touch = new dom.window.Event("touchmove", { bubbles: true, cancelable: true });
          Object.defineProperty(touch, "touches", { value: [{ clientX: 100, clientY: 200 }, { clientX: 250, clientY: 200 }] });
          scroller.dispatchEvent(touch);
          assert.equal(touch.defaultPrevented, false);
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      assert.equal(renders.length, before.renders);
      assert.equal(observers.length, before.observers);
      assert.equal(changes.length, before.changes);
      assert.ok(host.textContent?.includes("100%"));
      await unmount();
    });
    await t.test("toolbar page indicator follows the visible PDF page", async () => {
      normalLoad();
      await mount();
      await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
      const scroller = host.querySelector<HTMLElement>(".libera-pdf-viewer .overflow-auto")!;
      const pageIndicator = () => Array.from(host.querySelectorAll("span"))
        .find((element) => /^Page \d+\/5$/.test(element.textContent ?? ""))?.textContent;
      assert.equal(pageIndicator(), "Page 1/5");
      scroller.getBoundingClientRect = () => ({ top: 0, height: 600 } as DOMRect);
      for (const page of host.querySelectorAll<HTMLElement>("[data-pdf-page-number]")) {
        const pageNumber = Number(page.dataset.pdfPageNumber);
        page.getBoundingClientRect = () => {
          const top = 100 + (pageNumber - 1) * 812 - scroller.scrollTop;
          return { top, bottom: top + 792 } as DOMRect;
        };
      }
      await act(async () => {
        scroller.scrollTop = 820;
        scroller.dispatchEvent(new dom.window.Event("scroll"));
        await new Promise((resolve) => setTimeout(resolve, 175));
      });
      assert.equal(pageIndicator(), "Page 2/5");
      await act(async () => {
        scroller.scrollTop = 2470;
        scroller.dispatchEvent(new dom.window.Event("scroll"));
        await new Promise((resolve) => setTimeout(resolve, 175));
      });
      assert.equal(pageIndicator(), "Page 4/5");
      await unmount();
    });
    await t.test("scroll bursts coalesce and the final position flushes on unmount", async () => {
      normalLoad();
      await mount();
      await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
      changes.length = 0;
      const scroller = host.querySelector(".overflow-auto")!;
      let geometryReads = 0;
      const measure = scroller.getBoundingClientRect.bind(scroller);
      scroller.getBoundingClientRect = () => { geometryReads++; return measure(); };
      await act(async () => {
        for (let i = 1; i <= 100; i++) {
          scroller.scrollTop = i;
          scroller.dispatchEvent(new dom.window.Event("scroll"));
        }
      });
      assert.equal(changes.length, 0);
      assert.equal(geometryReads, 0, "Scroll handlers must not synchronously measure pages");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 175)); });
      assert.ok(geometryReads <= 2, "Page indicator geometry is coalesced with scroll persistence");
      assert.deepEqual(changes, [{ scrollTop: 100, scrollLeft: 0 }]);
      await act(async () => { scroller.scrollTop = 123; scroller.dispatchEvent(new dom.window.Event("scroll")); });
      await unmount();
      assert.deepEqual(changes.at(-1), { scrollTop: 123, scrollLeft: 0 });
    });
    await t.test("PDF tabs restore both scroll axes and zoom after a rapid switch", async () => {
      normalLoad();
      const proto = dom.window.HTMLElement.prototype;
      Object.defineProperties(proto, {
        scrollWidth: { configurable: true, get: () => 4000 },
        scrollHeight: { configurable: true, get: () => 20000 },
      });
      try {
        await mount({ zoom: 2, scrollTop: 1400.5, scrollLeft: 180.25 });
        await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
        const scroller = host.querySelector<HTMLElement>(".overflow-auto")!;
        assert.equal(scroller.scrollTop, 1400.5);
        assert.equal(scroller.scrollLeft, 180.25);
        assert.equal(host.querySelector("canvas")!.style.width, "1224px");
        await act(async () => {
          scroller.scrollTop = 2100.5;
          scroller.scrollLeft = 220.25;
          scroller.dispatchEvent(new dom.window.Event("scroll"));
        });
        await unmount();
        const saved = changes.at(-1)!;
        assert.deepEqual(saved, { scrollTop: 2100.5, scrollLeft: 220.25 });
        await mount({ ...saved, zoom: 2 });
        await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
        assert.equal(host.querySelector<HTMLElement>(".overflow-auto")!.scrollTop, 2100.5);
        assert.equal(host.querySelector<HTMLElement>(".overflow-auto")!.scrollLeft, 220.25);
        await unmount();
      } finally {
        Reflect.deleteProperty(proto, "scrollWidth");
        Reflect.deleteProperty(proto, "scrollHeight");
      }
    });
    await t.test("zoom preserves the visible point on mixed-size pages and saves it across immediate tab switches", async () => {
      normalLoad();
      const originalViewport = pages[1].getViewport;
      pages[1].getViewport = ({ scale }) => ({ width: 612 * scale, height: 900 * scale, scale });
      const proto = dom.window.HTMLElement.prototype;
      Object.defineProperties(proto, {
        scrollWidth: { configurable: true, get: () => 4000 },
        scrollHeight: { configurable: true, get: () => 20000 },
      });
      try {
        await mount();
        await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
        // Narrow enough that every page scrolls horizontally.
        const { scroller, sheets } = installPdfGeometry(400);
        // The viewport centre (40 + 200, 80 + 300) sits partway down page 3; page 2
        // has a different height and neither page is rendered. Padding and gaps
        // do not scale, so scaling the whole scroll offset would drift.
        const expectedTop = (zoom: number) => 24 + (792 + 900 + 127.5) * zoom + 2 * 20 - 300;
        const expectedLeft = (zoom: number) => (184 + 180.25) * zoom - 184;
        const near = (actual: number | undefined, expected: number, message?: string) =>
          assert.ok(Math.abs((actual ?? NaN) - expected) < 1e-6, `${message ?? "position"}: ${actual} != ${expected}`);
        await act(async () => {
          scroller.scrollTop = expectedTop(1);
          scroller.scrollLeft = 180.25;
          scroller.dispatchEvent(new dom.window.Event("scroll"));
        });
        changes.length = 0;
        for (const [button, zoom] of [["Zoom in", 1.25], ["Zoom out", 1], ["Zoom in", 1.25], ["Reset zoom", 1]] as const) {
          await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${button}"]`)!.click());
          near(scroller.scrollTop, expectedTop(zoom));
          near(scroller.scrollLeft, expectedLeft(zoom));
          const bounds = sheets[2].getBoundingClientRect();
          near(bounds.top + bounds.height * (127.5 / 792), 380, "The same PDF point stays at the viewport centre");
          near(bounds.left + bounds.width * (364.25 / 612), 240, "The same PDF point stays at the viewport centre");
          near(changes.at(-1)?.scrollTop, expectedTop(zoom), "Persist zoom-adjusted coordinates without waiting for a scroll event");
          near(changes.at(-1)?.scrollLeft, expectedLeft(zoom), "Persist zoom-adjusted coordinates without waiting for a scroll event");
        }
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 175)); });
        near(changes.at(-1)?.scrollTop, expectedTop(1), "The pre-zoom debounce must not save stale coordinates");
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
        await act(async () => captureCanvasViewState());
        near(changes.at(-1)?.scrollTop, expectedTop(1.25));
        near(changes.at(-1)?.scrollLeft, expectedLeft(1.25));
        await unmount(); // No scroll event or debounce wait after zoom.
        const saved = Object.assign({}, ...changes) as PdfTabViewState;
        assert.equal(saved.zoom, 1.25);
        near(saved.scrollTop, expectedTop(1.25));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 175)); });
        assert.deepEqual(Object.assign({}, ...changes), saved, "The old scroll debounce must not overwrite the zoomed position");
        await mount(saved);
        await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
        assert.equal(host.querySelector<HTMLElement>(".overflow-auto")!.scrollTop, saved.scrollTop);
        assert.equal(host.querySelector<HTMLElement>(".overflow-auto")!.scrollLeft, saved.scrollLeft);
        assert.equal(host.querySelector("canvas")!.style.height, "990px");
      } finally {
        await unmount();
        pages[1].getViewport = originalViewport;
        Reflect.deleteProperty(proto, "scrollWidth");
        Reflect.deleteProperty(proto, "scrollHeight");
      }
    });
    await t.test("zoom keeps the viewport centre across padding and page gaps, and clamps at both ends", async () => {
      normalLoad();
      await mount();
      await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
      const { scroller } = installPdfGeometry();
      // At the top, the centre is 276px into page 1.
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
      assert.equal(scroller.scrollTop, 24 + 276 * 1.25 - 300);
      assert.equal(scroller.scrollLeft, (612 * 1.25 + 32 - 700) / 2, "A centred page that starts to overflow stays centred");
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')!.click());
      assert.equal(scroller.scrollTop, 0);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
      assert.equal(scroller.scrollTop, 0, "Zooming out at the top clamps instead of going negative");
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')!.click());
      scroller.scrollTop = 24 + 792 + 10 - 300; // Centre halfway through the gap after page 1.
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
      assert.equal(scroller.scrollTop, 24 + 792 * 1.25 + 10 - 300);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')!.click());
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
      assert.equal(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight);
      assert.equal(scroller.style.overflowAnchor, "none", "Browser scroll anchoring must not apply a second adjustment");
      await unmount();
    });
    await t.test("zoom during loading leaves the pending tab scroll restoration intact", async () => {
      normalLoad();
      const pendingPdf = deferred<typeof pdf>();
      getDocumentImpl = () => ({ promise: pendingPdf.promise, destroy: async () => {} });
      const proto = dom.window.HTMLElement.prototype;
      Object.defineProperties(proto, {
        scrollWidth: { configurable: true, get: () => 4000 },
        scrollHeight: { configurable: true, get: () => 20000 },
      });
      try {
        await mount({ zoom: 2, scrollTop: 1400.5, scrollLeft: 180.25 });
        changes.length = 0;
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
        await act(async () => captureCanvasViewState());
        assert.deepEqual(changes, [{ zoom: 2.25 }], "Do not save the collapsed loading area's zero scroll offset");
        await act(async () => pendingPdf.resolve(pdf));
        await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
        const scroller = host.querySelector<HTMLElement>(".overflow-auto")!;
        assert.equal(scroller.scrollTop, 1400.5);
        assert.equal(scroller.scrollLeft, 180.25);
        assert.equal(host.querySelector("canvas")!.style.height, "1782px");
      } finally {
        await unmount();
        Reflect.deleteProperty(proto, "scrollWidth");
        Reflect.deleteProperty(proto, "scrollHeight");
      }
    });
    await t.test("LaTeX preview restores scroll and flushes switches before its debounce", async () => {
      normalLoad();
      const { LatexPdfPreview } = await import("../../src/components/libera/latex/latex-pdf-preview");
      Object.assign(pdf, { destroy: async () => {} });
      const proto = dom.window.HTMLElement.prototype;
      Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 800 });
      const positions: { top: number; left: number }[] = [];
      const props = {
        url: "/preview.pdf", zoom: 2, initialScrollTop: 1600.5, initialScrollLeft: 90.25,
        highlight: null, busy: false, downloadUrl: null, emptyState: "Empty",
        onZoomChange: () => {}, onInverseSync: () => {},
        onScrollChange: (top: number, left: number) => positions.push({ top, left }),
      };
      try {
        await act(async () => root.render(createElement(LatexPdfPreview, props)));
        const scroller = host.querySelector<HTMLElement>(".libera-latex-pdf-scroll")!;
        assert.equal(scroller.scrollTop, 1600.5);
        assert.equal(scroller.scrollLeft, 90.25);
        await act(async () => {
          scroller.scrollTop = 2400.75;
          scroller.scrollLeft = 140.5;
          scroller.dispatchEvent(new dom.window.Event("scroll"));
        });
        await unmount();
        assert.deepEqual(positions.at(-1), { top: 2400.75, left: 140.5 });
        await act(async () => root.render(createElement(LatexPdfPreview, { ...props, initialScrollTop: positions.at(-1)!.top, initialScrollLeft: positions.at(-1)!.left })));
        assert.equal(host.querySelector<HTMLElement>(".libera-latex-pdf-scroll")!.scrollTop, 2400.75);
        assert.equal(host.querySelector<HTMLElement>(".libera-latex-pdf-scroll")!.scrollLeft, 140.5);
        await unmount();
      } finally { Reflect.deleteProperty(proto, "clientWidth"); }
    });
    await t.test("image tabs restore zoom and pan after remounting", async () => {
      const { ImageViewer } = await import("../../src/components/libera/image-viewer");
      const states: import("../../src/components/libera/types").ImageTabViewState[] = [];
      const props = { src: "/photo.png", filePath: "photo.png", alt: "Photo", annotatable: false,
        initialViewState: { zoom: 2.5, panX: 42.5, panY: -90.25 },
        onViewStateChange: (patch: import("../../src/components/libera/types").ImageTabViewState) => states.push(patch) };
      await act(async () => root.render(createElement(ImageViewer, props)));
      assert.match(host.querySelector<HTMLElement>(".libera-photo-frame")!.style.transform, /translate\(42.5px, -90.25px\) scale\(2.5\)/);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
      const zoom = states.at(-1)!.zoom!;
      assert.ok(zoom > 2.5);
      await unmount();
      await act(async () => root.render(createElement(ImageViewer, { ...props, initialViewState: { ...props.initialViewState, zoom } })));
      assert.equal(host.querySelector<HTMLElement>(".libera-photo-frame")!.style.transform, `translate(42.5px, -90.25px) scale(${zoom})`);
      await unmount();
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
    await t.test("pen, shapes, eraser and markup styles save, and undo/redo step through them", async () => {
      normalLoad([{
        id: "highlight", type: "highlight", pageNumber: 1, color: "#ffe45c",
        rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }], createdAt: "2026-10-15", updatedAt: "2026-10-15",
      }]);
      // Echo saves so the debounced PATCH response keeps what was drawn.
      const loadFetch = globalThis.fetch;
      const saved: PdfAnnotation[][] = [];
      globalThis.fetch = async (input, init) => {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { annotations: PdfAnnotation[] };
          saved.push(body.annotations);
          return Response.json({ annotations: body.annotations });
        }
        return loadFetch(input, init);
      };
      await mount();
      const viewer = host.querySelector<HTMLElement>("[data-pdf-path]")!;
      viewer.focus();
      const key = (init: KeyboardEventInit) => act(async () => {
        viewer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      });
      const page = host.querySelector<HTMLElement>('[data-pdf-page-content="1"]')!;
      const surface = () => {
        const element = page.querySelector<HTMLElement>(".pdf-drawing-surface")!;
        element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 612, height: 792 } as DOMRect);
        return element;
      };
      const drag = (points: [number, number][]) => act(async () => {
        const target = surface();
        const [[x, y], ...rest] = points;
        target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
        for (const [clientX, clientY] of rest) {
          target.dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX, clientY }));
        }
        target.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0, clientX: rest.at(-1)![0], clientY: rest.at(-1)![1] }));
      });
      const drawings = (kind: string) => page.querySelectorAll(`[data-pdf-drawing="${kind}"]`).length;

      await act(async () => host.querySelector<HTMLButtonElement>('[data-viewer-tool="shape"]')!.click());
      assert.equal((page.querySelector(".pdf-text-layer") as HTMLElement).style.pointerEvents, "none", "drawing tools do not select text");
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Arrow"]')!.click());
      await drag([[100, 300], [200, 350], [300, 400]]);
      assert.equal(drawings("shape"), 1);
      assert.ok(page.querySelector('[data-pdf-drawing="shape"] polygon'), "arrows have a head");
      await drag([[100, 300], [101, 301]]);
      assert.equal(drawings("shape"), 1, "a click without a drag draws nothing");

      await key({ key: "p" });
      assert.equal(changes.at(-1)?.tool, "draw", "P picks the pen");
      await drag([[50, 50], [60, 70], [80, 90]]);
      assert.equal(drawings("ink"), 1);

      await key({ key: "z", metaKey: true });
      assert.equal(drawings("ink"), 0, "undo removes the stroke");
      await key({ key: "z", metaKey: true, shiftKey: true });
      assert.equal(drawings("ink"), 1, "redo brings it back");

      await key({ key: "e" });
      await drag([[40, 70], [70, 70], [100, 70]]);
      assert.equal(drawings("ink"), 0, "the eraser removes strokes it crosses");
      assert.equal(page.querySelectorAll(".pdf-highlight-mark").length, 1, "markup it never touched survives");
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click());
      assert.equal(drawings("ink"), 1);

      await key({ key: "Escape" });
      assert.equal(changes.at(-1)?.tool, "select", "Esc puts the eraser down");
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Select highlight"]')!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Change to underline"]')!.click());
      const mark = page.querySelector<HTMLElement>(".pdf-highlight-mark")!;
      assert.equal(mark.dataset.markup, "underline");
      assert.equal(mark.style.background, "", "line markup draws a stroke, not a band");
      assert.ok(host.querySelector('[aria-label="Change to red"]')?.hasAttribute("data-active"), "pastel ink swaps for a pen ink");

      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      const last = saved.at(-1)!;
      assert.deepEqual(last.map((annotation) => annotation.type).sort(), ["highlight", "ink", "shape"]);
      const arrow = last.find((annotation) => annotation.type === "shape");
      assert.equal(arrow?.type === "shape" && arrow.shape, "arrow");
      assert.ok(arrow?.type === "shape" && Math.abs(arrow.to.x - 300 / 612) < 1e-9);
      globalThis.fetch = loadFetch;
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
      const beforeZoomScrolls = scrolled.length;
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
      assert.equal(host.querySelector(".pdf-find-match-active")?.textContent, "across lines");
      assert.deepEqual(Array.from(reads), beforeZoomReads);
      assert.equal(scrolled.length, beforeZoomScrolls, "Rebuilding a search highlight after zoom must not navigate back to it");
      for (const button of ["Zoom out", "Reset zoom"]) {
        await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${button}"]`)!.click());
        assert.equal(scrolled.length, beforeZoomScrolls, `${button} must not navigate back to the active match`);
      }
      await query("selectable");
      const beforeNextMatch = scrolled.length;
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click());
      assert.equal(host.querySelector('[role="status"]')?.textContent, "2/5");
      assert.ok(scrolled.length > beforeNextMatch, "Explicit search navigation must still reveal the new match after zoom");
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
    await t.test("the command palette offers annotation styles and page moves whatever tool is in use", async () => {
      normalLoad();
      // The palette reads the topmost shown scope; jsdom lays nothing out.
      const getClientRects = dom.window.Element.prototype.getClientRects;
      dom.window.Element.prototype.getClientRects = function (this: Element) {
        return (this.closest("[hidden]") ? [] : [{}]) as unknown as DOMRectList;
      };
      host.setAttribute("data-command-scope", "1");
      Object.defineProperty(globalThis, "HTMLSelectElement", { configurable: true, value: dom.window.HTMLSelectElement });
      try {
        await mount({ tool: "select" });
        const { collectPaletteCommands } = await import("../../src/components/libera/command-palette/commands");
        const commands = () => collectPaletteCommands(null).filter((command) => command.group === "PDF");
        const find = (title: string) => {
          const found = commands().find((command) => command.title === title);
          assert.ok(found, `Expected ${title}`);
          return found;
        };
        // The toolbar's tools are read from the page, with their shortcut keys.
        assert.equal(find("Pen").shortcut, "P");
        // Pickers for other tools are hidden, but their choices are still listed.
        assert.equal(host.querySelector('[aria-label="Ink color"]'), null);
        assert.equal(find("Ink color: Red").checked, true);
        await act(async () => find("Shape: Ellipse").run());
        assert.equal(host.querySelector("[data-pdf-path]")!.getAttribute("data-pdf-tool"), "shape");
        assert.equal(find("Shape: Ellipse").checked, true);
        // With the picker shown, the registered entries replace its harvested ones.
        assert.equal(commands().filter((command) => command.title === "Ink color: Blue").length, 1);
        await act(async () => find("Ink color: Blue").run());
        assert.equal(find("Ink color: Blue").checked, true);
        await act(async () => find("Markup style: Underline").run());
        assert.equal(host.querySelector("[data-pdf-path]")!.getAttribute("data-pdf-markup"), "underline");
        assert.ok(find("Highlight color: Yellow"));
        assert.ok(find("Note font size: larger"));
        assert.equal(find("Previous page").disabled, true);
        scrolled.length = 0;
        find("Last page").run();
        assert.equal(scrolled.at(-1)?.getAttribute("data-pdf-page-number"), "5");
      } finally {
        await unmount();
        host.removeAttribute("data-command-scope");
        dom.window.Element.prototype.getClientRects = getClientRects;
      }
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
