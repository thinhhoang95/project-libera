import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { OpenTab } from "../../src/components/libera/types";
import { PDF_CITATION_MIME, PDF_QUOTE_CITE_EVENT, type PdfQuoteCiteDetail } from "../../src/lib/references/pdf-quote";
import type { ReferenceEntry, ReferenceLibrary } from "../../src/lib/references/types";
import type { PdfAnnotation } from "../../src/lib/types";

/* Quote and cite from the PDF viewer (selection menu, highlight actions,
 * dragging a selection), the PDF outline's highlight menu, and how the
 * workspace inserts the quote into the target note or the clipboard. */

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLAnchorElement", "Element", "Node", "KeyboardEvent", "MouseEvent", "CustomEvent", "Event", "MutationObserver", "DOMRect", "Range", "NodeFilter"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
  Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, innerHeight: 768, innerWidth: 1024 });
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
Object.assign(dom.window.HTMLElement.prototype, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false, scrollIntoView() {} });
dom.window.HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
// Every text range is a line on the page, so the selection menu can place itself.
Object.assign(dom.window.Range.prototype, {
  getClientRects: () => [new dom.window.DOMRect(100, 120, 200, 16)],
  getBoundingClientRect: () => new dom.window.DOMRect(100, 120, 200, 16),
});
class FakeObserver { observe() {} unobserve() {} disconnect() {} }
Object.assign(globalThis, { IntersectionObserver: FakeObserver, ResizeObserver: FakeObserver });

const require = createRequire(import.meta.url);
const pdfModule = require.resolve("pdfjs-dist");
const oldPdfModule = require.cache[pdfModule];
const pages = [["Dense attention is costly."], ["Sparse heads matter."]].map((lines) => ({
  getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale }),
  getTextContent: async () => ({ items: lines.map((str) => ({ str, hasEOL: true })), styles: {} }),
  render: () => ({ promise: Promise.resolve(), cancel() {} }),
}));
const pdf = { numPages: pages.length, getPage: async (n: number) => pages[n - 1], getPageLabels: async () => ["ix", "x"] };
require.cache[pdfModule] = { exports: {
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => {} }),
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

const NOW = "2026-10-18T00:00:00.000Z";
const PDF_PATH = "Notes/papers/smith.pdf";
const HIGHLIGHT: PdfAnnotation = {
  id: "h1", type: "highlight", pageNumber: 1, color: "#fde047", quote: "Dense   attention is costly.",
  rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }], createdAt: NOW, updatedAt: NOW,
};
const SMITH: ReferenceEntry = {
  id: "ref_1", key: "smith2020", aliases: [], csl: { type: "article-journal", title: "Sparse attention", author: [{ family: "Smith" }], issued: { "date-parts": [[2020]] } },
  identifiers: {}, provenance: {}, status: "confirmed", attachments: [{ kind: "pdf", path: PDF_PATH }], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {},
};
const LIBRARY: ReferenceLibrary = { version: 1, revision: 2, style: "apa", entries: { ref_1: SMITH } };

let m: {
  createRoot: typeof import("react-dom/client").createRoot;
  PdfViewer: typeof import("../../src/components/libera/pdf-viewer").PdfViewer;
  PdfAnnotationsPanel: typeof import("../../src/components/libera/pdf-annotations-panel").PdfAnnotationsPanel;
  PdfQuoteCiteHost: typeof import("../../src/components/libera/references/pdf-quote-cite").PdfQuoteCiteHost;
  pdfPageLabelsFor: typeof import("../../src/components/libera/references/pdf-page-labels").pdfPageLabelsFor;
  useLiberaWorkspace: typeof import("../../src/components/libera/use-libera-workspace").useLiberaWorkspace;
  emptyTree: typeof import("../../src/components/libera/api-client").emptyTree;
  emptyWorkspaceLibrary: typeof import("../../src/lib/workspaces").emptyWorkspaceLibrary;
  resetReferenceLibraryCache: typeof import("../../src/components/libera/references/use-reference-library").resetReferenceLibraryCache;
};

before(async () => {
  const [client, viewer, outline, quote, labels, workspace, api, workspaces, library] = await Promise.all([
    import("react-dom/client"),
    import("../../src/components/libera/pdf-viewer"),
    import("../../src/components/libera/pdf-annotations-panel"),
    import("../../src/components/libera/references/pdf-quote-cite"),
    import("../../src/components/libera/references/pdf-page-labels"),
    import("../../src/components/libera/use-libera-workspace"),
    import("../../src/components/libera/api-client"),
    import("../../src/lib/workspaces"),
    import("../../src/components/libera/references/use-reference-library"),
  ]);
  m = {
    createRoot: client.createRoot, PdfViewer: viewer.PdfViewer, PdfAnnotationsPanel: outline.PdfAnnotationsPanel, PdfQuoteCiteHost: quote.PdfQuoteCiteHost,
    pdfPageLabelsFor: labels.pdfPageLabelsFor, useLiberaWorkspace: workspace.useLiberaWorkspace, emptyTree: api.emptyTree,
    emptyWorkspaceLibrary: workspaces.emptyWorkspaceLibrary, resetReferenceLibraryCache: library.resetReferenceLibraryCache,
  };
});
after(() => {
  if (oldPdfModule) require.cache[pdfModule] = oldPdfModule; else delete require.cache[pdfModule];
  dom.window.close();
});

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

/** Collect PDF_QUOTE_CITE_EVENT requests. */
function watchQuotes() {
  const quotes: PdfQuoteCiteDetail[] = [];
  const listener = (event: Event) => quotes.push((event as CustomEvent<PdfQuoteCiteDetail>).detail);
  window.addEventListener(PDF_QUOTE_CITE_EVENT, listener);
  return { quotes, stop: () => window.removeEventListener(PDF_QUOTE_CITE_EVENT, listener) };
}

async function mountViewer(annotations: PdfAnnotation[] = [HIGHLIGHT]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input).startsWith("/api/pdf-annotations")
    ? Response.json({ annotations }) : new Response(new Uint8Array([1]))) as typeof fetch;
  const host = document.getElementById("root")!;
  const root = m.createRoot(host);
  await act(async () => root.render(createElement(m.PdfViewer, { src: "/raw/smith.pdf", filePath: PDF_PATH })));
  await settle(20);
  return { host, root };
}

function selectTextOf(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

test("the viewer records the PDF's page labels and offers Quote and cite on a highlight's actions", async () => {
  const { host, root } = await mountViewer();
  const watch = watchQuotes();
  try {
    assert.deepEqual(m.pdfPageLabelsFor(PDF_PATH), ["ix", "x"]);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Select highlight"]')!.click());
    const actions = host.querySelector('[aria-label="Highlight actions"]')!;
    await act(async () => actions.querySelector<HTMLButtonElement>('[aria-label="Quote and cite"]')!.click());
    assert.deepEqual(watch.quotes, [{ quote: "Dense attention is costly.", path: PDF_PATH, page: 1 }]);
  } finally {
    watch.stop();
    await act(async () => root.unmount());
  }
});

test("the selection menu's Quote and cite sends the selection with its page and label", async () => {
  const { host, root } = await mountViewer([]);
  const watch = watchQuotes();
  try {
    const layer = host.querySelector('[data-pdf-page-content="2"] .pdf-text-layer')!;
    selectTextOf(layer);
    const scroller = host.querySelector<HTMLElement>(".libera-pdf-viewer .overflow-auto")!;
    await act(async () => { scroller.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 })); });
    await settle(40);
    const menu = host.querySelector('[aria-label="Selection actions"]')!;
    assert.ok(menu.querySelector('[aria-label="Copy selection"]'));
    await act(async () => menu.querySelector<HTMLButtonElement>('[aria-label="Quote and cite"]')!.click());
    assert.equal(watch.quotes.length, 1);
    assert.match(watch.quotes[0].quote, /Sparse heads matter\./);
    assert.deepEqual({ ...watch.quotes[0], quote: "" }, { quote: "", path: PDF_PATH, page: 2, pageLabel: "x" });
    assert.equal(host.querySelector('[aria-label="Selection actions"]'), null, "the menu closes");
  } finally {
    watch.stop();
    await act(async () => root.unmount());
  }
});

test("dragging a selection carries application/x-libera-citation and plain text", async () => {
  const { host, root } = await mountViewer([]);
  try {
    const layer = host.querySelector('[data-pdf-page-content="1"] .pdf-text-layer')!;
    selectTextOf(layer);
    const data = new Map<string, string>();
    const event = new dom.window.Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "all" } });
    await act(async () => { layer.firstElementChild!.dispatchEvent(event); });
    const payload = JSON.parse(data.get(PDF_CITATION_MIME)!);
    assert.match(payload.quote, /Dense attention is costly\./);
    assert.deepEqual({ ...payload, quote: "" }, { quote: "", path: PDF_PATH, page: 1, pageLabel: "ix" });
    assert.match(data.get("text/plain")!, /Dense attention is costly\./);

    // Without a selection a drag carries nothing of ours.
    window.getSelection()!.removeAllRanges();
    const plain = new Map<string, string>();
    const other = new dom.window.Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(other, "dataTransfer", { value: { setData: (type: string, value: string) => plain.set(type, value) } });
    await act(async () => { layer.firstElementChild!.dispatchEvent(other); });
    assert.equal(plain.size, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("the PDF annotations panel's highlight context menu quotes and cites", async () => {
  globalThis.fetch = (async () => Response.json({ annotations: [HIGHLIGHT, { ...HIGHLIGHT, id: "h2", quote: undefined, pageNumber: 2 }] })) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = m.createRoot(host);
  const watch = watchQuotes();
  const activeTab = { id: "t", file: { kind: "file", name: "smith.pdf", path: PDF_PATH, notebook: "Notes", fileType: "pdf", createdAt: NOW, updatedAt: NOW, size: 1 }, draft: "", saved: "", status: "clean" } as OpenTab;
  try {
    await act(async () => root.render(createElement(m.PdfAnnotationsPanel, { activeTab, onOpenFile: async () => {} })));
    await settle(10);
    const rows = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => /p\. \d/.test(button.textContent ?? ""));
    assert.equal(rows.length, 2);
    // A highlight without a quote has nothing to quote.
    await act(async () => { rows[1].dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    assert.equal(host.querySelector('[role="menu"]'), null);
    await act(async () => { rows[0].dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const item = host.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]')!;
    assert.equal(item.textContent, "Quote and cite");
    await act(async () => item.click());
    assert.deepEqual(watch.quotes, [{ quote: "Dense attention is costly.", path: PDF_PATH, page: 1 }]);
    assert.equal(host.querySelector('[role="menu"]'), null);
  } finally {
    watch.stop();
    await act(async () => root.unmount());
    host.remove();
  }
});

// ---------------------------------------------------------------------------
// The workspace: target note, source and visual, clipboard
// ---------------------------------------------------------------------------

test("the workspace quotes into the last active note, in the visual or the source editor, or else to the clipboard", async () => {
  m.resetReferenceLibraryCache();
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("/api/workspaces")) return Response.json(init?.method === "PUT" ? { saved: true } : m.emptyWorkspaceLibrary());
    if (target.startsWith("/api/references?")) return Response.json({ library: LIBRARY });
    return Response.json({ ...m.emptyTree(), root: "/test/references" });
  }) as typeof fetch;
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  let workspace!: ReturnType<typeof m.useLiberaWorkspace>["workspace"];
  function Harness() {
    workspace = m.useLiberaWorkspace(true).workspace;
    return createElement(m.PdfQuoteCiteHost);
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = m.createRoot(host);
  const quote = (detail: PdfQuoteCiteDetail) => act(async () => { window.dispatchEvent(new dom.window.CustomEvent(PDF_QUOTE_CITE_EVENT, { detail })); });
  try {
    await act(async () => root.render(createElement(Harness)));
    await settle();

    await quote({ quote: "Dense attention is costly.", path: PDF_PATH, page: 1, pageLabel: "ix" });
    await settle(20);
    assert.deepEqual(copied, ["> Dense attention is costly.\n>\n> [@smith2020, p. ix]"], "no note open: the clipboard");
    assert.match(document.querySelector("[data-pdf-quote-notice]")?.textContent ?? "", /copied to the clipboard/);

    await act(async () => { workspace.createUntitledFile("", undefined, { fileName: "Draft.md", content: "First paragraph.\n\nSecond." }); });
    await settle();
    const tabId = workspace.activeTab!.id;
    await quote({ quote: "Sparse heads matter.", path: PDF_PATH, page: 2, endPage: 3 });
    await settle(20);
    const pending = workspace.pendingVisualInsertions[tabId];
    // Page 3 has no label, so the range is cited by page index.
    assert.equal(pending?.markdown, "> Sparse heads matter.\n>\n> [@smith2020, pp. 2–3]");
    assert.equal(pending?.inline, undefined, "the visual editor inserts a block");
    assert.match(document.querySelector("[data-pdf-quote-notice]")?.textContent ?? "", /Quoted into Draft\.md/);

    await act(async () => { workspace.setActiveTabViewState({ markdown: { editorMode: "source" } }); });
    const textarea = document.createElement("textarea");
    textarea.value = workspace.activeTab!.draft;
    document.body.append(textarea);
    textarea.setSelectionRange(3, 3);
    workspace.textareaRef.current = textarea;
    await quote({ quote: "Dense attention is costly.", path: PDF_PATH, page: 1 });
    await settle(20);
    // The viewer recorded this PDF's page labels earlier: page 1 prints as "ix".
    assert.equal(workspace.activeTab!.draft, "First paragraph.\n\n> Dense attention is costly.\n>\n> [@smith2020, p. ix]\n\nSecond.");
    textarea.remove();
    assert.equal(copied.length, 1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
