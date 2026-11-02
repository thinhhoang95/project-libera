import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { retainPdfPage } from "../../src/components/libera/pdf-rendering";
import { usePdfDetailCanvas } from "../../src/components/libera/use-pdf-detail-canvas";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("PDF resources survive overlapping owners and renders, and evict once after the last lease", async () => {
  let cleanups = 0;
  const page = { cleanup: () => { cleanups++; return true; } } as PDFPageProxy;
  const releaseOwner = retainPdfPage(page);
  const releaseBase = retainPdfPage(page);
  const releaseDetail = retainPdfPage(page);
  releaseOwner(); releaseOwner(); releaseBase();
  await tick();
  assert.equal(cleanups, 0, "an outstanding detail render still needs the page");
  releaseDetail();
  await tick();
  assert.equal(cleanups, 1);
  releaseDetail();
  await tick();
  assert.equal(cleanups, 1, "duplicate releases cannot evict a reused page");
  const releaseRevisit = retainPdfPage(page);
  releaseRevisit();
  await tick();
  assert.equal(cleanups, 2, "revisiting the page starts a new resource lifetime");
});

test("an immediate PDF remount preserves cached resources without cleanup polling", async () => {
  let cleanups = 0;
  const page = { cleanup: () => { cleanups++; return true; } } as PDFPageProxy;
  retainPdfPage(page)();
  const release = retainPdfPage(page);
  await tick();
  assert.equal(cleanups, 0);
  release();
  await tick();
  assert.equal(cleanups, 1);
});

test("unmounted PDF detail renders retain page resources until cancellation settles", { timeout: 5000 }, async (t) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, key, before);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} disconnect() {} } });
  t.after(() => {
    if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });
  Object.defineProperty(dom.window, "devicePixelRatio", { value: 2 });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 2448, bottom: 3168, width: 2448, height: 3168 }) as DOMRect;
  const context = new Proxy({}, { get: () => () => {} });
  t.mock.method(dom.window.HTMLCanvasElement.prototype, "getContext", () => context as CanvasRenderingContext2D);
  let finish!: () => void;
  const rendering = new Promise<void>((resolve) => { finish = resolve; });
  let cleanups = 0;
  let cancels = 0;
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const page = {
    getViewport: () => ({ width: 2448, height: 3168 }),
    render: () => { started(); return { promise: rendering, cancel() { cancels++; } }; },
    cleanup: () => { cleanups++; return true; },
  } as unknown as PDFPageProxy;
  const pdf = { getPage: async () => page } as unknown as PDFDocumentProxy;
  function Harness({ document = pdf }: { document?: PDFDocumentProxy }) {
    const hostRef = useRef<HTMLDivElement>(null);
    usePdfDetailCanvas({ hostRef, pdfDocument: document, pageNumber: 1, scale: 4 });
    return createElement("div", { ref: hostRef });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    await start;
    await act(async () => root.unmount());
    assert.equal(cancels, 1);
    await tick();
    assert.equal(cleanups, 0, "cancel() alone does not mean PDF.js has finished");
    await act(async () => { finish(); await rendering; });
    await tick();
    assert.equal(cleanups, 1, "the completed cancellation releases the last page lease");
    let deliver!: (page: PDFPageProxy) => void;
    const latePdf = { getPage: () => new Promise<PDFPageProxy>((resolve) => { deliver = resolve; }) } as unknown as PDFDocumentProxy;
    const lateRoot = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => lateRoot.render(createElement(Harness, { document: latePdf })));
    await act(async () => lateRoot.unmount());
    await act(async () => { deliver(page); });
    await tick();
    assert.equal(cleanups, 2, "a page fetched after unmount is released immediately");
  } finally { finish(); dom.window.close(); }
});
