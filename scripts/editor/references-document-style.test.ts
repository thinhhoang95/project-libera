import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { act, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { DocumentStylePicker } from "../../src/components/libera/references/document-style-picker";
import { CitationScope, ReferenceRenderProvider } from "../../src/components/libera/references/reference-render-context";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { configureCitationFormatting } from "../../src/lib/references/format-client";
import { formatNotebookBibliography } from "../../src/lib/references/bibliography-export";
import {
  DOCUMENT_STYLE_REQUEST_EVENT, documentStyleOverride, effectiveStyleSetting, isDocumentStyleSetting, readDocumentStyle,
  readDocumentStyleForPath, readSlidesDocumentStyle, textChange, writeDocumentStyle, writeDocumentStyleForPath, writeSlidesDocumentStyle,
  type DocumentStyleRequestDetail,
} from "../../src/lib/references/document-style";
import { prepareLatexCitations } from "../../src/lib/references/latex-citations";
import { parseMarkdownSlides } from "../../src/lib/markdown-slides";
import { yamlFrontMatterEnd } from "../../src/lib/remark-front-matter";
import { BUNDLED_CSL_STYLES, type CslItem, type ReferenceEntry, type ReferenceLibrary, type ReferenceLibraryOp } from "../../src/lib/references/types";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { updateReferenceLibrary } from "../../src/lib/storage/references";

// A per-document citation style: `citation-style` in YAML front matter (or
// `$citation-style` in a slide deck), read and written by document-style.ts
// and honored by the preview, slides, the bibliography export and the LaTeX
// export; the Document style control asks the open editor to change it.

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

test("readDocumentStyle reads the top-level citation-style key of YAML front matter", () => {
  assert.equal(readDocumentStyle("---\ncitation-style: ieee\n---\n\nText"), "ieee");
  assert.equal(readDocumentStyle("---\ntitle: X\ncitation-style: \"styles/my journal.csl\"  # custom\n...\nText"), "styles/my journal.csl");
  assert.equal(readDocumentStyle("---\r\ncitation-style: 'vancouver'\r\n---\r\n"), "vancouver");
  assert.equal(readDocumentStyle("---\ncitation-style: apa # the default\n---"), "apa");
  assert.equal(readDocumentStyle("---\nmeta:\n  citation-style: ieee\n---\n"), null, "nested keys are not the document's style");
  assert.equal(readDocumentStyle("Text\n---\ncitation-style: ieee\n---\n"), null, "front matter starts the document");
  assert.equal(readDocumentStyle("---\ncitation-style:\n---\n"), null);
  assert.equal(readDocumentStyle("No front matter"), null);
  assert.equal(readDocumentStyle("---\ncitation-style: ieee\nno closing line"), null);
  assert.equal(isDocumentStyleSetting("ieee"), true);
  assert.equal(isDocumentStyleSetting("styles/x.CSL"), true);
  assert.equal(isDocumentStyleSetting("harvard-cite-them-right"), true);
  assert.equal(isDocumentStyleSetting("mla"), false);
  assert.equal(documentStyleOverride("---\ncitation-style: mla\n---\n"), null, "an unknown style is ignored");
  assert.equal(effectiveStyleSetting("---\ncitation-style: mla\n---\n", "ieee"), "ieee");
  assert.equal(effectiveStyleSetting("---\ncitation-style: nature\n---\n", "ieee"), "nature");
  assert.equal(effectiveStyleSetting("Text", ""), "apa");
});

test("writeDocumentStyle changes only the style line, adding or removing front matter as needed", () => {
  assert.equal(writeDocumentStyle("Text [@a].", "ieee"), "---\ncitation-style: ieee\n---\n\nText [@a].");
  assert.equal(writeDocumentStyle("\n\nText", "ieee"), "---\ncitation-style: ieee\n---\n\nText");
  assert.equal(writeDocumentStyle("", "ieee"), "---\ncitation-style: ieee\n---\n");
  assert.equal(writeDocumentStyle("---\ntitle: X\n---\n\nText", "nature"), "---\ntitle: X\ncitation-style: nature\n---\n\nText");
  assert.equal(writeDocumentStyle("---\ntitle: X\ncitation-style: apa # old\nauthor: Y\n---\nText", "ieee"), "---\ntitle: X\ncitation-style: ieee\nauthor: Y\n---\nText");
  assert.equal(writeDocumentStyle("---\ntitle: X\ncitation-style: apa\n---\nText", null), "---\ntitle: X\n---\nText");
  assert.equal(writeDocumentStyle("---\ncitation-style: apa\n---\n\nText", null), "Text", "front matter that held only the style goes");
  assert.equal(writeDocumentStyle("Text", null), "Text");
  assert.equal(writeDocumentStyle("---\r\ntitle: X\r\n---\r\nText", "ieee"), "---\r\ntitle: X\r\ncitation-style: ieee\r\n---\r\nText", "line endings are kept");
  assert.equal(writeDocumentStyle("Text\r\n", "ieee"), "---\r\ncitation-style: ieee\r\n---\r\n\r\nText\r\n");
  assert.equal(writeDocumentStyle("Text", "styles/my journal.csl"), "---\ncitation-style: \"styles/my journal.csl\"\n---\n\nText");
  assert.equal(readDocumentStyle(writeDocumentStyle("Text", "styles/my journal.csl")), "styles/my journal.csl");
});

test("slide decks keep their style in a $citation-style metadata line", () => {
  const deck = "$title = \"Talk\"\n\n# Intro\n\n---\n\nSlide [@a]";
  const styled = writeSlidesDocumentStyle(deck, "ieee");
  assert.equal(styled, "$citation-style = \"ieee\"\n$title = \"Talk\"\n\n# Intro\n\n---\n\nSlide [@a]");
  assert.equal(readSlidesDocumentStyle(styled), "ieee");
  assert.equal(parseMarkdownSlides(styled).metadata["citation-style"], "ieee");
  assert.equal(writeSlidesDocumentStyle(styled, "nature"), "$citation-style = \"nature\"\n$title = \"Talk\"\n\n# Intro\n\n---\n\nSlide [@a]");
  assert.equal(writeSlidesDocumentStyle(styled, null), deck);
  assert.equal(readDocumentStyleForPath("Notes/talk.slides.md", styled), "ieee");
  assert.equal(writeDocumentStyleForPath("Notes/talk.slides.md", deck, "apa").startsWith("$citation-style = \"apa\""), true);
  assert.equal(writeDocumentStyleForPath("Notes/doc.md", "Text", "apa"), "---\ncitation-style: apa\n---\n\nText");
});

test("textChange finds the smallest edit", () => {
  assert.deepEqual(textChange("---\na: 1\n---\nText", "---\na: 1\nb: 2\n---\nText"), { from: 9, to: 9, insert: "b: 2\n" });
  assert.deepEqual(textChange("abc", "abc"), { from: 3, to: 3, insert: "" });
  assert.deepEqual(textChange("Text", "---\ncitation-style: x\n---\n\nText"), { from: 0, to: 0, insert: "---\ncitation-style: x\n---\n\n" });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const NOW = "2026-10-18T00:00:00.000Z";
function entry(id: string, key: string, csl: Partial<CslItem>): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl } as CslItem, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {},
  };
}
const smith = entry("ref_1", "smith2020", { title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] } });
const lee = entry("ref_2", "lee2019", { title: "Graphs", author: [{ family: "Lee", given: "Ann" }], issued: { "date-parts": [[2019]] } });
const LIBRARY: ReferenceLibrary = { version: 1, revision: 2, style: "apa", entries: { ref_1: smith, ref_2: lee } };

let dom: JSDOM;
before(() => {
  dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLSelectElement", "Element", "Node", "Event", "CustomEvent", "MutationObserver", "KeyboardEvent", "MouseEvent", "FocusEvent"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  configureCitationFormatting({ worker: false });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost/");
    if (url.pathname === "/api/references") return Response.json({ library: LIBRARY });
    if (url.pathname === "/api/files") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ error: "Not found" }, { status: 404 });
  }) as typeof fetch;
});
after(() => dom.window.close());
beforeEach(() => {
  resetReferenceLibraryCache();
  document.body.innerHTML = "<div id='root'></div>";
});

async function mount(node: ReactNode) {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(node));
  return root;
}

async function waitFor(condition: () => unknown, message: string, timeoutMs = 20000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) assert.fail(`Timed out: ${message}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
}

const chipTexts = () => [...document.querySelectorAll<HTMLElement>("#root .libera-citation")].map((chip) => chip.textContent);

test("YAML front matter is not rendered; a --- heading --- that is not YAML still is", () => {
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: "---\ncitation-style: ieee\ntitle: X\n---\n\nBody text." }));
  assert.doesNotMatch(html, /citation-style|<hr|<h2/);
  assert.match(html, /Body text\./);
  const plain = renderToStaticMarkup(createElement(MarkdownRenderer, { content: "---\nJust a heading\n---\n\nBody" }));
  assert.match(plain, /<hr/);
  assert.equal(yamlFrontMatterEnd("---\ntitle: X\n---\nBody"), 16);
  assert.equal(yamlFrontMatterEnd("---\nJust a heading\n---\n"), 0);
});

test("the preview formats a document in its own style", async () => {
  const root = await mount(createElement(ReferenceRenderProvider, { notebook: "Notes" }, createElement("div", null,
    createElement(MarkdownRenderer, { content: "---\ncitation-style: ieee\n---\n\nAs [@lee2019] and @smith2020 show." }),
    createElement(MarkdownRenderer, { content: "Default [@lee2019]." }),
  )));
  try {
    await waitFor(() => document.querySelectorAll(".libera-citation[data-formatted]").length === 3, "formatted chips");
    assert.deepEqual(chipTexts(), ["[1]", "Smith [2]", "(Lee, 2019)"]);
    const bibliographies = [...document.querySelectorAll("section.libera-bibliography")].map((section) => section.textContent);
    assert.match(bibliographies[0]!, /\[1\]\s*A\. Lee/);
    assert.match(bibliographies[1]!, /Lee, A\. \(2019\)/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a custom .csl document style that cannot be read falls back to the notebook's style", async () => {
  const root = await mount(createElement(ReferenceRenderProvider, { notebook: "Notes" },
    createElement(MarkdownRenderer, { content: "---\ncitation-style: styles/missing.csl\n---\n\nAs [@lee2019]." })));
  try {
    await waitFor(() => document.querySelectorAll(".libera-citation[data-formatted]").length === 1, "formatted chip");
    assert.deepEqual(chipTexts(), ["(Lee, 2019)"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("slides: a CitationScope formats the deck in its own style", async () => {
  const sources = ["Slide one [@lee2019]", "Slide two [@smith2020]"];
  const root = await mount(createElement(ReferenceRenderProvider, { notebook: "Notes" }, createElement(CitationScope, { sources, documentStyle: "ieee" },
    ...sources.map((content, index) => createElement(MarkdownRenderer, { key: index, content, citationScopeIndex: index })))));
  try {
    await waitFor(() => document.querySelectorAll(".libera-citation[data-formatted]").length === 2, "formatted chips");
    assert.deepEqual(chipTexts(), ["[1]", "[2]"]);
  } finally {
    await act(async () => root.unmount());
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test("the document bibliography export honors the document's style unless a style is given", async () => {
  const documentText = "---\ncitation-style: ieee\n---\n\nAs [@smith2020] and [@lee2019].";
  const own = await formatNotebookBibliography({ notebook: "Notes", library: LIBRARY, format: "text", documentText });
  assert.match(own.text, /^\[1\]\s*J\. Smith/);
  const explicit = await formatNotebookBibliography({ notebook: "Notes", library: LIBRARY, format: "text", documentText, style: "apa" });
  assert.match(explicit.text, /^Lee, A\. \(2019\)/);
  const plain = await formatNotebookBibliography({ notebook: "Notes", library: LIBRARY, format: "text", documentText: "As [@smith2020] and [@lee2019]." });
  assert.match(plain.text, /^Lee, A\. \(2019\)/);
});

test("the LaTeX export honors the document's style in both modes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-references-document-style-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await createNotebook("Refs");
    const ops: ReferenceLibraryOp[] = [smith, lee].map((value) => ({ op: "add", entry: { key: value.key, csl: value.csl } }));
    await updateReferenceLibrary("Refs", null, ops);
    const markdown = "---\ncitation-style: ieee\n---\n\nAs [@lee2019] and @smith2020 show.\n";
    const formatted = (await prepareLatexCitations(markdown, "Refs"))!;
    assert.deepEqual([...formatted.citations.values()], ["{[1]}", "Smith [2]"]);
    assert.match(formatted.bibliography, /\\begin\{thebibliography\}/);
    const biblatex = (await prepareLatexCitations(markdown, "Refs", { mode: "biblatex" }))!;
    assert.equal(biblatex.biblatex?.style, "ieee");
    const notebookStyle = (await prepareLatexCitations("As [@lee2019].\n", "Refs"))!;
    assert.deepEqual([...notebookStyle.citations.values()], ["(Lee, 2019)"]);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The Document style control
// ---------------------------------------------------------------------------

test("the Document style control shows the document's style and asks its editor to change it", async () => {
  const requests: DocumentStyleRequestDetail[] = [];
  let handle = true;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DocumentStyleRequestDetail>).detail;
    requests.push({ ...detail });
    if (handle) detail.handled = true;
  };
  window.addEventListener(DOCUMENT_STYLE_REQUEST_EVENT, listener);
  const render = (props: Partial<Parameters<typeof DocumentStylePicker>[0]>) => createElement(DocumentStylePicker, {
    notebook: "Notes", documentPath: "Notes/doc.md", draft: "---\ncitation-style: ieee\n---\n\nText", styleFiles: ["Notes/styles/journal.csl"], ...props,
  });
  const root = await mount(render({}));
  try {
    await waitFor(() => /Notebook default \(APA/.test(document.querySelector("select")?.textContent ?? ""), "the notebook's style");
    const select = document.querySelector<HTMLSelectElement>("[data-document-style-picker] select")!;
    assert.equal(select.value, "ieee");
    const values = [...select.options].map((option) => option.value);
    assert.deepEqual(values, ["", ...BUNDLED_CSL_STYLES.map((style) => style.id), "Notes/styles/journal.csl"]);
    const choose = async (value: string) => {
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
    };
    await choose("nature");
    await choose("");
    assert.deepEqual(requests, [{ path: "Notes/doc.md", style: "nature" }, { path: "Notes/doc.md", style: null }]);
    assert.equal(document.querySelector("[data-document-style-picker] [role=alert]"), null);
    handle = false;
    await choose("vancouver");
    assert.match(document.querySelector("[data-document-style-picker] [role=alert]")!.textContent!, /Open this document in an editor/);

    await act(async () => root.render(render({ documentPath: null })));
    assert.equal(document.querySelector<HTMLSelectElement>("[data-document-style-picker] select")!.disabled, true, "untitled documents cannot be styled");
    await act(async () => root.render(render({ draft: "---\ncitation-style: mla\n---\n" })));
    assert.match(document.querySelector("[data-document-style-picker] [role=status]")!.textContent!, /not a bundled style/);
    await act(async () => root.render(render({ draft: null })));
    assert.equal(document.querySelector("[data-document-style-picker]"), null, "nothing without a Markdown document");
  } finally {
    window.removeEventListener(DOCUMENT_STYLE_REQUEST_EVENT, listener);
    await act(async () => root.unmount());
  }
});
