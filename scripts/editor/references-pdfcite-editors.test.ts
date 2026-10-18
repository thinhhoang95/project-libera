import "./setup.cjs";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, createRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { MarkdownEditor } from "../../src/components/libera/markdown-editor";
import { MarkdownCodeMirrorEditor } from "../../src/components/libera/markdown-source/markdown-codemirror-editor";
import { TiptapMarkdownEditor } from "../../src/components/libera/tiptap-markdown-editor";
import { CitationPopup, type CitationPopupHandle } from "../../src/components/libera/references/citation-popup";
import { SEMANTIC_SEARCH_DEBOUNCE_MS } from "../../src/components/libera/references/citation-semantic";
import { rememberPdfPageLabels, resetPdfPageLabels } from "../../src/components/libera/references/pdf-page-labels";
import { hasPdfQuoteDrag, PdfQuoteCiteHost, pdfQuoteFromDrop, resetPdfQuoteCite, resolvePdfQuote } from "../../src/components/libera/references/pdf-quote-cite";
import { ReferenceRenderProvider } from "../../src/components/libera/references/reference-render-context";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import type { SearchResponse } from "../../src/lib/global-search";
import { CodeMirrorTextareaAdapter } from "../../src/lib/markdown-codemirror/textarea-adapter";
import { configureCitationFormatting } from "../../src/lib/references/format-client";
import { PDF_CITATION_MIME, type PdfQuoteSource } from "../../src/lib/references/pdf-quote";
import { resetRecentCitations } from "../../src/lib/references/reference-suggestions";
import { REFERENCES_UPDATED_EVENT, type ReferencesUpdatedDetail } from "../../src/lib/references/types";
import { installReferenceFetch, makeLibrary, referenceEntry, SMITH, type MockServer } from "./references-editors-fixtures";

/* Quote and cite from a PDF into the editors (drag and drop), the entry
 * lookup with its add-the-PDF confirmation and cross-notebook copy, and the
 * `@` popup's "From your library's meaning" section. */

let dom: JSDOM;
let restoreFetch: () => void = () => {};
let server: MockServer;
let searchResponse: (body: Record<string, unknown>) => SearchResponse | number = () => 404;
let searchSignals: AbortSignal[] = [];
let copyResponse: (body: Record<string, unknown>) => unknown = () => ({ keys: {} });

before(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "Event", "CustomEvent", "DOMRect", "PointerEvent", "FocusEvent", "InputEvent"] as const) {
    if (dom.window[key]) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
    Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, innerHeight: 768, innerWidth: 1024 });
  Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect(0, 0, 0, 0) });
  Object.assign(dom.window.HTMLElement.prototype, {
    scrollIntoView() {},
    attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
    detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
  });
  Object.assign(dom.window.Element.prototype, { getClientRects: () => [] });
  configureCitationFormatting({ worker: false, clearCache: true });
});
after(() => dom.window.close());

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The fixtures' reference routes, plus /api/search and /api/references/copy. */
function setup(libraries = { Notes: makeLibrary() }, resolve: MockServer["resolve"] = () => 500) {
  server = { libraries, requests: [], resolve };
  const restore = installReferenceFetch(server);
  const references = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (url.pathname === "/api/search") {
      server.requests.push({ method: "POST", url: url.pathname, body });
      searchSignals.push(init!.signal!);
      const result = searchResponse(body);
      return typeof result === "number" ? json({ error: "No index" }, result) : json(result);
    }
    if (url.pathname === "/api/references/copy") {
      server.requests.push({ method: "POST", url: url.pathname, body });
      return json(copyResponse(body));
    }
    return references(input, init);
  }) as typeof fetch;
  restoreFetch = restore;
}

afterEach(() => {
  restoreFetch();
  resetReferenceLibraryCache();
  resetRecentCitations();
  resetPdfQuoteCite();
  resetPdfPageLabels();
  searchResponse = () => 404;
  searchSignals = [];
  copyResponse = () => ({ keys: {} });
  document.body.replaceChildren();
});

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

const QUOTE: PdfQuoteSource = { quote: "Attention is sparse.", path: "Notes/papers/smith.pdf", page: 3 };

/** A drop or dragover carrying a PDF quote (or only text). jsdom has no DragEvent. */
function dragEvent(type: "drop" | "dragover", data: Record<string, string>) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = {
    types: Object.keys(data),
    files: [] as File[],
    items: [] as DataTransferItem[],
    dropEffect: "none",
    getData: (format: string) => data[format] ?? "",
  };
  Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientX: { value: 1 }, clientY: { value: 1 } });
  return event as unknown as DragEvent;
}

const quoteDrag = (source: PdfQuoteSource = QUOTE) => ({ [PDF_CITATION_MIME]: JSON.stringify(source), "text/plain": source.quote });

// ---------------------------------------------------------------------------
// Resolving a quote
// ---------------------------------------------------------------------------

test("a quote cites the entry that has the PDF attached, at the printed page", async () => {
  setup({ Notes: makeLibrary([{ ...SMITH, csl: { ...SMITH.csl, page: "101-120" } }]) });
  const resolved = await resolvePdfQuote(QUOTE, "Notes");
  assert.equal(resolved?.markdown, "> Attention is sparse.\n>\n> [@smith2020sparse, p. 103]");
  // Labels the viewer read win over the range.
  rememberPdfPageLabels(QUOTE.path, ["i", "ii", "iii"]);
  assert.equal((await resolvePdfQuote(QUOTE, null))?.markdown, "> Attention is sparse.\n>\n> [@smith2020sparse, p. iii]");
  assert.equal(server.requests.filter((request) => request.url.startsWith("/api/references/copy")).length, 0, "same notebook: no copy");
});

test("a note in another notebook cites the entry copied into its library", async () => {
  setup({ Notes: makeLibrary() });
  copyResponse = (body) => ({ keys: { [String((body.keys as string[])[0])]: "smith2020sparseb" }, destinationRevision: 4 });
  const updates: ReferencesUpdatedDetail[] = [];
  const listener = (event: Event) => updates.push((event as CustomEvent<ReferencesUpdatedDetail>).detail);
  window.addEventListener(REFERENCES_UPDATED_EVENT, listener);
  try {
    const resolved = await resolvePdfQuote({ ...QUOTE, endPage: 4 }, "Thesis");
    assert.equal(resolved?.markdown, "> Attention is sparse.\n>\n> [@smith2020sparseb, pp. 3–4]");
    assert.deepEqual(server.requests.find((request) => request.url === "/api/references/copy")?.body, { from: "Notes", to: "Thesis", keys: ["smith2020sparse"] });
    assert.deepEqual(updates, [{ notebook: "Thesis", revision: 4 }], "the destination library reloads");
  } finally {
    window.removeEventListener(REFERENCES_UPDATED_EVENT, listener);
  }
});

test("a PDF without an entry offers to add it to References, then continues; cancelling inserts nothing", async () => {
  setup({ Notes: makeLibrary() }, () => ({
    candidates: [{ csl: { type: "article-journal", title: "A new paper", author: [{ family: "Novak" }], issued: { "date-parts": [[2024]] } } }],
    duplicates: [],
  }));
  const source = { ...QUOTE, path: "Notes/papers/novak.pdf" };
  assert.equal(await resolvePdfQuote(source, "Notes"), null, "without the host nothing can be asked");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(PdfQuoteCiteHost)));
  try {
    let pending = resolvePdfQuote(source, "Notes");
    await settle(20);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? "", /Add this PDF to References/);
    assert.match(dialog.textContent ?? "", /novak\.pdf is not in this notebook's References/);
    assert.match(dialog.textContent ?? "", /Novak \(2024\)/);
    assert.deepEqual(server.requests.find((request) => request.url === "/api/references/resolve")?.body, { notebook: "Notes", path: "Notes/papers/novak.pdf", webSearch: false });
    const add = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Add and cite")!;
    await act(async () => add.click());
    const resolved = await pending;
    assert.match(resolved?.markdown ?? "", /^> Attention is sparse\.\n>\n> \[@novak2024new\d+, p\. 3\]$/);
    const patch = server.requests.find((request) => request.method === "PATCH")!.body as { ops: Array<{ op: string; entry: { attachments: unknown[] } }> };
    assert.deepEqual(patch.ops[0].entry.attachments, [{ kind: "pdf", path: "Notes/papers/novak.pdf" }], "the new entry has the PDF attached");
    assert.equal(document.querySelector('[role="dialog"]'), null);

    pending = resolvePdfQuote({ ...source, path: "Notes/papers/other.pdf" }, "Notes");
    await settle(20);
    const cancel = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Cancel") as HTMLButtonElement;
    await act(async () => cancel.click());
    assert.equal(await pending, null);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a PDF that cannot be looked up can still be added under its file name", async () => {
  setup({ Notes: makeLibrary([]) }, () => 500);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(PdfQuoteCiteHost)));
  try {
    const pending = resolvePdfQuote({ ...QUOTE, path: "Notes/scan-042.pdf" }, null);
    await settle(20);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.querySelector("[role=alert]")?.textContent ?? "", /could not be looked up|Lookup failed/);
    const add = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Add with file name")!;
    await act(async () => add.click());
    assert.ok(await pending);
    const patch = server.requests.find((request) => request.method === "PATCH")!.body as { ops: Array<{ entry: { csl: { title: string }; status: string } }> };
    assert.equal(patch.ops[0].entry.csl.title, "scan-042");
    assert.equal(patch.ops[0].entry.status, "unresolved");
  } finally {
    await act(async () => root.unmount());
  }
});

// ---------------------------------------------------------------------------
// Drops into the three editors
// ---------------------------------------------------------------------------

test("drag data: the quote MIME type is recognised and validated", () => {
  const drop = dragEvent("drop", quoteDrag());
  assert.equal(hasPdfQuoteDrag(drop.dataTransfer), true);
  assert.deepEqual(pdfQuoteFromDrop(drop.dataTransfer), QUOTE);
  assert.equal(hasPdfQuoteDrag(dragEvent("drop", { "text/plain": "x" }).dataTransfer), false);
  assert.equal(pdfQuoteFromDrop(dragEvent("drop", { [PDF_CITATION_MIME]: "{" }).dataTransfer), null);
});

function sourceProps(value: string, changes: string[]): ComponentProps<typeof MarkdownEditor> {
  return {
    activeFilePath: "Thesis/chapter.md", files: [], formatting: false, fontFamily: "monospace", fontSizePx: 14,
    imageConverting: false, lineHeightPx: 24, openTabs: [], recentFiles: [], textareaRef: createRef<HTMLTextAreaElement>(), value,
    onAiFormatSelection: async () => {}, onAiImageToMarkdown: async () => {}, onAiRewriteSelection: async () => {}, onAiWriteAt: async () => {},
    onChange: (text) => changes.push(text), onInsertFileLink: () => {}, onInsertImageFile: async () => {},
  };
}

/** Editors render inside the note's reference notebook ("Thesis"); the PDF is in "Notes". */
function inThesis(child: ReturnType<typeof createElement>) {
  return createElement(ReferenceRenderProvider, { notebook: "Thesis" }, child);
}

test("textarea editor: a dropped PDF quote is quoted and cited as a block; other drops are left alone", async () => {
  setup({ Notes: makeLibrary(), Thesis: makeLibrary([]) });
  copyResponse = () => ({ keys: { smith2020sparse: "smith2020sparse" }, destinationRevision: 1 });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const textareaRef = createRef<HTMLTextAreaElement>();
  await act(async () => root.render(inThesis(createElement(MarkdownEditor, { ...sourceProps("Intro paragraph.", []), textareaRef }))));
  await settle(5);
  const textarea = textareaRef.current!;
  try {
    const over = dragEvent("dragover", quoteDrag());
    await act(async () => { textarea.dispatchEvent(over); });
    assert.equal(over.defaultPrevented, true, "the quote is accepted");
    const plain = dragEvent("drop", { "text/plain": "Just text" });
    await act(async () => { textarea.dispatchEvent(plain); });
    assert.equal(plain.defaultPrevented, false, "a plain text drop keeps the browser's behavior");

    const drop = dragEvent("drop", quoteDrag());
    await act(async () => { textarea.dispatchEvent(drop); });
    await settle(30);
    assert.equal(drop.defaultPrevented, true);
    assert.equal(textarea.value, "Intro paragraph.\n\n> Attention is sparse.\n>\n> [@smith2020sparse, p. 3]");
    assert.deepEqual(server.requests.find((request) => request.url === "/api/references/copy")?.body, { from: "Notes", to: "Thesis", keys: ["smith2020sparse"] });
  } finally {
    await act(async () => root.unmount());
  }
});

test("CodeMirror source editor: a dropped PDF quote is quoted and cited as a block", async () => {
  setup({ Notes: makeLibrary(), Thesis: makeLibrary([]) });
  copyResponse = () => ({ keys: { smith2020sparse: "smith2020" } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  const adapter = new CodeMirrorTextareaAdapter("Intro paragraph.\n\nNext.");
  await act(async () => root.render(inThesis(createElement(MarkdownCodeMirrorEditor, { ...sourceProps("Intro paragraph.\n\nNext.", changes), adapter }))));
  await settle(5);
  const view = adapter.editorView!;
  try {
    const over = dragEvent("dragover", quoteDrag());
    await act(async () => { view.contentDOM.dispatchEvent(over); });
    assert.equal(over.defaultPrevented, true);
    const drop = dragEvent("drop", quoteDrag({ ...QUOTE, page: 2, pageLabel: "17" }));
    await act(async () => { view.contentDOM.dispatchEvent(drop); });
    await settle(30);
    assert.equal(drop.defaultPrevented, true);
    assert.match(view.state.doc.toString(), /^Intro paragraph\.\n\n> Attention is sparse\.\n>\n> \[@smith2020, p\. 17\]\n\n/);
    assert.match(view.state.doc.toString(), /Next\.$/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("Visual editor: a dropped PDF quote becomes a blockquote with a citation node", async () => {
  setup({ Notes: makeLibrary(), Thesis: makeLibrary([]) });
  copyResponse = () => ({ keys: { smith2020sparse: "smith2020sparse" } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changes: string[] = [];
  await act(async () => root.render(inThesis(createElement(TiptapMarkdownEditor, {
    documentPath: "Thesis/chapter.md", value: "Intro paragraph.", fontSizePx: 16, lineHeight: 1.75, markdownZoom: 100, onMarkdownZoomChange: () => {},
    onChange: (text: string) => changes.push(text), onSave: async () => {}, onOpenFileLink: async () => false,
  }))));
  await settle(50);
  const editor = host.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror")!.editor!;
  try {
    const view = editor.view;
    const plain = dragEvent("drop", { "text/plain": "Just text" });
    assert.ok(!view.someProp("handleDrop", (handler) => handler(view, plain, Slice.empty, false)), "other drops go to ProseMirror");
    const drop = dragEvent("drop", quoteDrag());
    let handled: boolean | undefined;
    await act(async () => { handled = view.someProp("handleDrop", (handler) => handler(view, drop, Slice.empty, false)); });
    await settle(50);
    assert.equal(handled, true);
    assert.equal(drop.defaultPrevented, true);
    const markdown = editor.getMarkdown();
    assert.match(markdown, /Intro paragraph\.\n\n> Attention is sparse\.\n>\n> \[@smith2020sparse, p\. 3\]/);
    assert.equal(host.querySelectorAll("blockquote .libera-citation").length, 1, "the citation is a node in the quote");
  } finally {
    await act(async () => root.unmount());
  }
});

// ---------------------------------------------------------------------------
// The `@` popup's semantic section
// ---------------------------------------------------------------------------

type Insert = [string, { locator: boolean; pageLocator?: string }];

async function mountPopup(query: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<CitationPopupHandle>();
  const inserts: Insert[] = [];
  const render = async (next: string) => {
    await act(async () => {
      root.render(createElement(ReferenceRenderProvider, { notebook: "Notes" }, createElement(CitationPopup, {
        ref: handle, query: next, x: 0, y: 0, onInsert: (key, options) => inserts.push([key, options]), onClose: () => {},
      })));
    });
  };
  await render(query);
  return { host, handle, inserts, render, dispose: async () => act(async () => root.unmount()) };
}

const PDF_ENTRY = referenceEntry("ref_pdf", "lee2021dense", { title: "Dense retrieval", author: [{ family: "Lee" }], issued: { "date-parts": [[2021]] }, page: "200-230" }, {
  attachments: [{ kind: "pdf", path: "Notes/papers/lee.pdf" }],
});

function hitsResponse(mode: SearchResponse["mode"] = "hybrid"): SearchResponse {
  return {
    mode, terms: ["heads"], tookMs: 1,
    results: [
      { key: "Notes/papers/lee.pdf", source: "library", kind: "pdf", name: "lee.pdf", path: "Notes/papers/lee.pdf", score: 2,
        hits: [{ chunkId: 1, score: 2, semantic: true, keyword: false, text: "Pruned heads in my highlight.", location: { page: 4, section: "Highlight" } }] },
      { key: "reference:Notes/ref_1", source: "references", kind: "reference", name: "Sparse attention", path: "Notes", reference: { notebook: "Notes", entryId: "ref_1", key: "smith2020sparse" }, score: 1,
        hits: [{ chunkId: 2, score: 1, semantic: true, keyword: false, text: "We prune attention heads.", location: { section: "Abstract" } }] },
    ],
  };
}

test("the popup searches the library's meaning for longer queries, debounced and abortable", async () => {
  setup({ Notes: makeLibrary([SMITH, PDF_ENTRY]) });
  searchResponse = () => hitsResponse();
  const popup = await mountPopup("that-paper-about");
  try {
    await settle(5);
    await popup.render("that-paper-about-pruned");
    await settle(5);
    await popup.render("that-paper-about-pruned-heads");
    await settle(SEMANTIC_SEARCH_DEBOUNCE_MS - 60);
    assert.equal(searchSignals.length, 0, "nothing is sent while typing");
    assert.ok(popup.host.querySelector('[data-citation-semantic="loading"]'), "the section says it is searching");
    await settle(120);
    assert.equal(searchSignals.length, 1, "only the last query is sent");
    const request = server.requests.find((item) => item.url === "/api/search")!.body as Record<string, unknown>;
    assert.deepEqual(request.within, { notebooks: ["Notes"], paths: ["Notes/papers/lee.pdf", "Notes/papers/smith.pdf"] });
    assert.deepEqual(request.parts, [{ type: "text", text: "that paper about pruned heads" }]);
    await settle(10);
    assert.match(popup.host.querySelector('[data-citation-semantic="header"]')?.textContent ?? "", /From your library's meaning/);
    const rows = [...popup.host.querySelectorAll<HTMLElement>('[data-citation-semantic="row"]')];
    assert.deepEqual(rows.map((row) => [row.dataset.citationKey, row.dataset.pageLocator]), [["lee2021dense", "203"], ["smith2020sparse", undefined]]);
    assert.match(rows[0].textContent ?? "", /p\. 203 · Highlight/);
    assert.match(rows[0].textContent ?? "", /Pruned heads in my highlight/);
    assert.match(rows[1].textContent ?? "", /Abstract/);
    await act(async () => { rows[0].click(); });
    assert.deepEqual(popup.inserts, [["lee2021dense", { locator: false, pageLocator: "203" }]]);

    // A new query aborts a search still in flight.
    searchResponse = () => hitsResponse();
    await popup.render("another-long-query");
    await settle(SEMANTIC_SEARCH_DEBOUNCE_MS + 20);
    const inFlight = searchSignals.at(-1)!;
    await popup.render("short");
    assert.equal(inFlight.aborted, true);
    assert.equal(popup.host.querySelector('[data-citation-semantic="header"]'), null, "one word: no section");
  } finally {
    await popup.dispose();
  }
});

test("without a semantic model the section shows keyword matches; without an index it hides", async () => {
  setup({ Notes: makeLibrary([SMITH, PDF_ENTRY]) });
  searchResponse = () => hitsResponse("keyword");
  const popup = await mountPopup("pruned-heads");
  try {
    await settle(SEMANTIC_SEARCH_DEBOUNCE_MS + 40);
    assert.match(popup.host.querySelector('[data-citation-semantic="header"]')?.textContent ?? "", /keyword matches/);
    // Two words with library matches: no search.
    const before = searchSignals.length;
    await popup.render("sparse attention");
    await settle(SEMANTIC_SEARCH_DEBOUNCE_MS + 40);
    assert.equal(searchSignals.length, before);
    assert.ok(popup.host.querySelector("[data-citation-key=smith2020sparse]"));

    searchResponse = () => ({ results: [], mode: "keyword", terms: [], tookMs: 0, warning: "There is no search index yet." });
    await popup.render("no-such-words-here");
    await settle(SEMANTIC_SEARCH_DEBOUNCE_MS + 40);
    assert.equal(popup.host.querySelector('[data-citation-semantic="header"]'), null);
    assert.equal(popup.host.querySelector('[data-citation-semantic="loading"]'), null);
    assert.match(popup.host.textContent ?? "", /No matches/);
    // Enter still works on the footer; Tab on a semantic row would open the locator.
    assert.equal(popup.handle.current!.handleKey({ key: "ArrowDown" }), true);
  } finally {
    await popup.dispose();
  }
});
