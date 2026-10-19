import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { act, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { prepareMarkdownPreview } from "../../src/lib/markdown-preview";
import { createMarkdownPreviewCache } from "../../src/lib/markdown-preview-patch";
import {
  CitationScope,
  REFERENCES_PENDING_ATTRIBUTE,
  ReferenceRenderProvider,
  waitForReferencesReady,
  type ReferenceAttachmentLocator,
} from "../../src/components/libera/references/reference-render-context";
import { closeReferenceMatches, resetCitationHoverCardCache } from "../../src/components/libera/references/citation-hover-card";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { citationFormatRunCount, configureCitationFormatting } from "../../src/lib/references/format-client";
import {
  REFERENCES_ADD_REQUEST_EVENT,
  REFERENCES_REVEAL_EVENT,
  type CslItem,
  type ReferenceAttachment,
  type ReferenceEntry,
  type ReferenceLibrary,
} from "../../src/lib/references/types";

const NOW = "2026-10-18T00:00:00.000Z";

function entry(id: string, key: string, csl: Partial<CslItem>, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl } as CslItem, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra,
  };
}

const PDF: ReferenceAttachment = { kind: "pdf", path: "Notes/papers/smith.pdf" };
const sparse = entry("ref_1", "smith2020sparse", {
  title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] },
  "container-title": "Journal of Tests", abstract: "We study *sparse* attention.",
}, { aliases: ["smith2020old"], notes: "**Key** point for chapter 2.", attachments: [PDF, { kind: "markdown", path: "Notes/papers/smith.md" }] });
const dense = entry("ref_2", "smith2020dense", { title: "Dense attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] } });
const lee = entry("ref_3", "lee2019graphs", { title: "Graphs", author: [{ family: "Lee", given: "Ann" }], issued: { "date-parts": [[2019]] } });

function library(style: string, ...entries: ReferenceEntry[]): ReferenceLibrary {
  return { version: 1, revision: 3, style, entries: Object.fromEntries(entries.map((value) => [value.id, value])) };
}

const LIBRARIES: Record<string, ReferenceLibrary> = {
  Notes: library("apa", sparse, dense, lee),
  Slides: library("ieee", sparse, dense, lee),
};

type Server = { citationIndex: Record<string, string[]> | null; requests: string[] };
const server: Server = { citationIndex: null, requests: [] };
let dom: JSDOM;

before(() => {
  dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent", "MutationObserver", "KeyboardEvent", "MouseEvent", "FocusEvent"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  configureCitationFormatting({ worker: false });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost/");
    server.requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/references") {
      const value = LIBRARIES[url.searchParams.get("notebook") ?? ""];
      return value ? Response.json({ library: value }) : Response.json({ error: "Not found" }, { status: 404 });
    }
    if (url.pathname === "/api/pdf-annotations" && url.searchParams.get("path") === PDF.path) {
      return Response.json({ path: PDF.path, annotations: [{ type: "highlight" }, { type: "text" }, { type: "highlight" }] });
    }
    if (url.pathname === "/api/references/citations" && server.citationIndex) {
      return Response.json({ byFile: {}, byKey: server.citationIndex });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }) as typeof fetch;
});

after(() => dom.window.close());

beforeEach(() => {
  resetReferenceLibraryCache();
  resetCitationHoverCardCache();
  server.citationIndex = null;
  server.requests = [];
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

const formatted = () => document.querySelectorAll(".libera-citation[data-formatted]").length;
const chips = () => [...document.querySelectorAll<HTMLElement>("#root .libera-citation")];

function withProvider(notebook: string, child: ReactNode, onOpenAttachment?: (attachment: ReferenceAttachment, locator?: ReferenceAttachmentLocator) => void) {
  return createElement(ReferenceRenderProvider, { notebook, onOpenAttachment }, child);
}

test("without a provider citations are raw chips in the contract's DOM, with no bibliography", () => {
  const content = "As shown [see @smith2020sparse, p. 3] and [@a<b&c].\n\n:::bibliography\n:::\n\nEnd";
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content }));
  assert.match(html, /<span class="libera-citation" data-libera-citation="\[see @smith2020sparse, p. 3\]" data-source-start="9" data-source-end="37">\[see @smith2020sparse, p. 3\]<\/span>/);
  assert.match(html, /<span class="libera-citation" data-libera-citation="\[@a&lt;b&amp;c\]" data-source-start="42" data-source-end="50">\[@a&lt;b&amp;c\]<\/span>/);
  assert.doesNotMatch(html, /<section|data-citation=|role="button"/);
  assert.doesNotMatch(html, /:::bibliography/, "The marker is never shown as text");
  const prepared = renderToStaticMarkup(createElement(MarkdownRenderer, { content, preparedTree: prepareMarkdownPreview(content) }));
  assert.equal(prepared, html);
});

test("with a provider chips show formatted citations and the bibliography is appended at the end", async () => {
  const root = await mount(withProvider("Notes", createElement(MarkdownRenderer, {
    content: "Intro [@smith2020sparse, p. 3] and [@lee2019graphs; @nope].\n\nAgain [-@smith2020old] and [@missing].\n\nLast paragraph.",
    documentPath: "Notes/doc.md",
  })));
  try {
    const renderer = document.querySelector<HTMLElement>(".markdown-renderer")!;
    assert.equal(renderer.getAttribute(REFERENCES_PENDING_ATTRIBUTE), "true", "Pending until the library, style and formatting are ready");
    await waitFor(() => formatted() === 4, "formatted chips");
    assert.equal(renderer.getAttribute(REFERENCES_PENDING_ATTRIBUTE), null);
    const [first, second, third, fourth] = chips();
    assert.equal(first.textContent, "(Smith, 2020, p. 3)");
    assert.equal(first.className, "libera-citation");
    assert.equal(first.dataset.liberaCitation, "[@smith2020sparse, p. 3]");
    assert.equal(first.dataset.sourceStart, "6");
    assert.equal(first.dataset.sourceEnd, "30");
    assert.equal(first.getAttribute("role"), "button");
    assert.equal(first.tabIndex, 0);
    assert.equal(second.textContent, "(Lee, 2019; @nope?)");
    assert.equal(second.className, "libera-citation libera-citation-unresolved");
    assert.equal(second.querySelector(".csl-unresolved")?.textContent, "@nope?");
    assert.equal(third.textContent, "(2020)", "Aliases resolve; suppress-author");
    assert.equal(fourth.textContent, "[@missing]");
    assert.equal(fourth.className, "libera-citation libera-citation-unresolved");

    const section = renderer.lastElementChild as HTMLElement;
    assert.equal(section.tagName, "SECTION");
    assert.equal(section.getAttribute("class"), "libera-bibliography");
    assert.equal(section.getAttribute("data-libera-bibliography"), "");
    assert.equal(section.querySelector("h2")?.textContent, "References");
    const items = [...section.querySelectorAll(".csl-entry")].map((element) => element.textContent);
    assert.deepEqual(items, ["Lee, A. (2019). Graphs.", "Smith, J. (2020). Sparse attention. Journal of Tests."]);
    assert.equal(document.querySelectorAll("section.libera-bibliography").length, 1);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a :::bibliography marker places the bibliography; a document without citations has none", async () => {
  const root = await mount(withProvider("Notes", createElement(MarkdownRenderer, {
    content: "Intro [@lee2019graphs].\n\n:::bibliography\n:::\n\nAfter the references.",
  })));
  try {
    await waitFor(() => document.querySelector("section.libera-bibliography .csl-entry"), "bibliography");
    const renderer = document.querySelector(".markdown-renderer")!;
    const blocks = [...renderer.children].map((element) => element.tagName);
    assert.deepEqual(blocks, ["P", "SECTION", "P"]);
    const section = renderer.children[1] as HTMLElement;
    assert.equal(section.dataset.sourceStart, "25");
    assert.equal(section.dataset.sourceEnd, "44");
    assert.equal(section.dataset.sourceBlock, "true");
    assert.equal(renderer.textContent?.includes(":::"), false);

    const runs = citationFormatRunCount();
    await act(async () => root.render(withProvider("Notes", createElement(MarkdownRenderer, { content: "No citations, just an email a@b.c.\n\n:::bibliography\n:::" }))));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(document.querySelector("section"), null);
    assert.equal(document.querySelector(".libera-citation"), null);
    assert.equal(citationFormatRunCount(), runs, "Nothing to format");
  } finally {
    await act(async () => root.unmount());
  }
});

test("typing that leaves citations alone does not reformat; changing one does", async () => {
  const content = (text: string, key = "lee2019graphs") => `${text} [@${key}] and [@smith2020sparse].`;
  const element = (text: string, key?: string) => withProvider("Notes", createElement(MarkdownRenderer, { content: content(text, key) }));
  const root = await mount(element("Start"));
  try {
    await waitFor(() => formatted() === 2, "formatted");
    const runs = citationFormatRunCount();
    for (const text of ["Start typing", "Start typing more", "Start typing more words"]) {
      await act(async () => root.render(element(text)));
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    assert.equal(citationFormatRunCount(), runs);
    assert.equal(formatted(), 2, "Chips stay formatted while typing");
    assert.equal(chips()[0].dataset.sourceStart, String("Start typing more words ".length));
    await act(async () => root.render(element("Start typing more words", "smith2020dense")));
    await waitFor(() => chips()[0].textContent === "(Smith, 2020a)", "reformatted");
    assert.equal(citationFormatRunCount(), runs + 1);
    assert.equal(chips()[1].textContent, "(Smith, 2020b)");
  } finally {
    await act(async () => root.unmount());
  }
});

test("the hover card shows the work, opens its PDF at the cited page, and dispatches panel events", async () => {
  const opened: Array<[ReferenceAttachment, ReferenceAttachmentLocator | undefined]> = [];
  const revealed: unknown[] = [];
  const added: unknown[] = [];
  const onReveal = (event: Event) => revealed.push((event as CustomEvent).detail);
  const onAdd = (event: Event) => added.push((event as CustomEvent).detail);
  window.addEventListener(REFERENCES_REVEAL_EVENT, onReveal);
  window.addEventListener(REFERENCES_ADD_REQUEST_EVENT, onAdd);
  const root = await mount(withProvider("Notes", createElement(MarkdownRenderer, {
    content: "See [@smith2020sparse, p. 12] and [@lee2019graphs, ch. 2; @smith2020dense] and [@smith2020spars].",
  }), (attachment, locator) => opened.push([attachment, locator])));
  try {
    await waitFor(() => formatted() === 3, "formatted");
    const [chip, multi, unresolved] = chips();

    await act(async () => chip.focus());
    const card = document.getElementById(chip.getAttribute("aria-describedby")!)!;
    assert.ok(card, "Focus opens the card, described by the chip");
    assert.equal(card.getAttribute("role"), "dialog");
    assert.equal(card.closest("#root"), null, "The card is portaled out of the document");
    assert.match(card.querySelector(".citation-card-reference")!.textContent!, /^Smith, J\. \(2020b\)\. Sparse attention\. Journal of Tests\.$/);
    assert.equal(card.querySelector(".citation-card-markdown em")?.textContent, "sparse", "The abstract is rendered Markdown");
    assert.equal(card.querySelectorAll(".citation-card-markdown")[1].querySelector("strong")?.textContent, "Key", "Notes are rendered Markdown");
    const buttons = () => [...card.querySelectorAll("button")].map((button) => button.textContent);
    assert.deepEqual(buttons(), ["Open PDF at p. 12", "Open smith.md", "Show in References"]);
    await waitFor(() => card.textContent?.includes("2 highlights"), "highlight count");
    assert.equal(card.textContent?.includes("Cited in"), false, "No citation index (404): the row is hidden");

    await act(async () => (card.querySelector("button") as HTMLButtonElement).click());
    assert.deepEqual(opened, [[PDF, { label: "page", locator: "12", page: 12 }]]);
    await act(async () => [...card.querySelectorAll("button")].find((button) => button.textContent === "Show in References")!.click());
    assert.deepEqual(revealed, [{ notebook: "Notes", entryId: "ref_1", key: "smith2020sparse" }]);

    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(chip.getAttribute("aria-describedby"), null, "Esc closes the card");
    assert.equal(document.querySelector(".citation-hover-card"), null);

    // Several works: one section each; a non-page locator opens the PDF without a page.
    resetCitationHoverCardCache();
    server.citationIndex = { smith2020sparse: ["Notes/a.md", "Notes/b.md"], smith2020old: ["Notes/b.md", "Notes/c.md"], lee2019graphs: ["Notes/a.md"] };
    await act(async () => multi.click());
    const pinned = document.querySelector<HTMLElement>(".citation-hover-card")!;
    assert.equal(pinned.dataset.pinned, "true");
    assert.equal(multi.getAttribute("aria-expanded"), "true");
    assert.equal(pinned.querySelectorAll(".citation-card-item").length, 2);
    await waitFor(() => pinned.textContent?.includes("Cited in 1 document"), "citing documents");
    await act(async () => multi.click());
    assert.equal(document.querySelector(".citation-hover-card"), null, "A second click unpins");

    await act(async () => chip.click());
    await waitFor(() => document.querySelector(".citation-hover-card")?.textContent?.includes("Cited in 3 documents"), "aliases count once per document");
    await act(async () => chip.click());

    // An unresolved key: close matches and Add to library.
    await act(async () => unresolved.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const missing = document.querySelector<HTMLElement>(".citation-hover-card")!;
    assert.match(missing.textContent!, /Not in this notebook's references/);
    const matches = [...missing.querySelectorAll(".citation-card-match-key")].map((element) => element.textContent);
    assert.equal(matches[0], "@smith2020sparse");
    assert.ok(matches.length <= 3);
    assert.equal(document.activeElement, missing.querySelector("button"), "Pinning from the keyboard moves focus into the card");
    await act(async () => [...missing.querySelectorAll("button")].find((button) => button.textContent === "Add to library…")!.click());
    assert.deepEqual(added, [{ notebook: "Notes", query: "smith2020spars" }]);
    await act(async () => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(document.querySelector(".citation-hover-card"), null);
    assert.equal(document.activeElement, unresolved, "Esc returns focus to the chip");
  } finally {
    window.removeEventListener(REFERENCES_REVEAL_EVENT, onReveal);
    window.removeEventListener(REFERENCES_ADD_REQUEST_EVENT, onAdd);
    await act(async () => root.unmount());
  }
});

test("close matches rank keys and titles against an unresolved key", () => {
  const graphs = entry("ref_9", "vaswani2017attention", { title: "Attention is all you need", author: [{ family: "Vaswani" }], issued: { "date-parts": [[2017]] } });
  const pool = [sparse, dense, lee, graphs];
  assert.deepEqual(closeReferenceMatches("smith2020sprase", pool).map((match) => match.key).slice(0, 2), ["smith2020sparse", "smith2020dense"]);
  assert.equal(closeReferenceMatches("vaswaniAttention", pool)[0].key, "vaswani2017attention");
  assert.deepEqual(closeReferenceMatches("zzz", pool), []);
});

test("the worker-prepared preview renders citations exactly like the synchronous renderer", async () => {
  const content = "# Title\n\nIntro [see @smith2020sparse, p. 3] and [@lee2019graphs; @nope].\n\n> Quoted [@smith2020dense;\n> @lee2019graphs]\n\n| A | B |\n| - | - |\n| [@smith2020old] | x |\n\nLast.";
  const patch = createMarkdownPreviewCache().patch(prepareMarkdownPreview(content));
  assert.deepEqual(patch.citations.map((citation) => citation.citation.raw), ["[see @smith2020sparse, p. 3]", "[@lee2019graphs; @nope]", "[@smith2020dense;\n> @lee2019graphs]", "[@smith2020old]"]);
  assert.deepEqual(patch.citations.map((citation) => citation.citation.items.map((item) => item.key)), [["smith2020sparse"], ["lee2019graphs", "nope"], ["smith2020dense", "lee2019graphs"], ["smith2020old"]]);
  const tree = { type: "root" as const, children: patch.children.map((node) => node as Exclude<typeof node, number>) };
  const root = await mount(createElement("div", null,
    withProvider("Notes", createElement("div", { id: "sync" }, createElement(MarkdownRenderer, { content }))),
    withProvider("Notes", createElement("div", { id: "worker" }, createElement(MarkdownRenderer, { content, preparedTree: tree, preparedSources: patch.sources, preparedCitations: patch.citations }))),
  ));
  try {
    await waitFor(() => formatted() === 8, "both renderers formatted");
    const sync = document.getElementById("sync")!.innerHTML;
    const worker = document.getElementById("worker")!.innerHTML.replace(/ data-preview-source-id="[^"]*"/g, "");
    assert.equal(worker, sync);
    assert.match(sync, /libera-bibliography/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("worker previews reuse unchanged blocks when a citation changes, and the bibliography follows", async () => {
  const cache = createMarkdownPreviewCache();
  let previous: ReturnType<typeof prepareMarkdownPreview>["children"] = [];
  const render = (content: string) => {
    const patch = cache.patch(prepareMarkdownPreview(content));
    const children = patch.children.map((node) => typeof node === "number" ? previous[node] : node);
    previous = children;
    return { patch, element: withProvider("Notes", createElement(MarkdownRenderer, { content, preparedTree: { type: "root", children }, preparedSources: patch.sources, preparedCitations: patch.citations })) };
  };
  const first = render("One [@lee2019graphs].\n\nTwo [@smith2020sparse].\n\nThree.");
  const root = await mount(first.element);
  try {
    await waitFor(() => /Sparse/.test(document.querySelector("section.libera-bibliography")?.textContent ?? ""), "first bibliography");
    const paragraph = document.querySelector("p")!;
    const second = render("One [@lee2019graphs].\n\nTwo [@smith2020dense].\n\nThree.");
    // Root children: p, newline, p, newline, p, section.
    assert.equal(second.patch.children[0], 0, "The unchanged block is reused");
    assert.equal(typeof second.patch.children[2], "object", "The edited block is sent again");
    assert.equal(second.patch.children[5], 5, "The appended bibliography node is reused; its contents come from formatting");
    await act(async () => root.render(second.element));
    await waitFor(() => /Dense/.test(document.querySelector("section.libera-bibliography")?.textContent ?? ""), "updated bibliography");
    assert.doesNotMatch(document.querySelector("section.libera-bibliography")!.textContent!, /Sparse/);
    assert.equal(document.querySelector("p"), paragraph, "The reused block keeps its DOM");
    assert.equal(chips()[0].textContent, "(Lee, 2019)");
    assert.equal(chips()[1].textContent, "(Smith, 2020)");

    // Text inserted above shifts offsets; chips in reused blocks still find their citation.
    const third = render("Inserted paragraph.\n\nOne [@lee2019graphs].\n\nTwo [@smith2020dense].\n\nThree.");
    await act(async () => root.render(third.element));
    assert.equal(chips()[0].textContent, "(Lee, 2019)");
    assert.equal(chips()[1].textContent, "(Smith, 2020)");
  } finally {
    await act(async () => root.unmount());
  }
});

test("slides number citations across the deck and place the bibliography only at a marker", async () => {
  const slides = ["# One\n\nFirst [@smith2020sparse].", "# Two\n\nThen [@lee2019graphs] and [@smith2020sparse].", "# Refs\n\n:::bibliography\n:::"];
  const root = await mount(withProvider("Slides", createElement(CitationScope, { sources: slides },
    ...slides.map((content, index) => createElement(MarkdownRenderer, { key: index, content, citationScopeIndex: index })))));
  try {
    await waitFor(() => formatted() === 3, "formatted slides");
    assert.deepEqual(chips().map((chip) => chip.textContent), ["[1]", "[2]", "[1]"]);
    const sections = document.querySelectorAll("section.libera-bibliography");
    assert.equal(sections.length, 1, "No bibliography appended to every slide");
    assert.ok(sections[0].closest(".markdown-renderer") === document.querySelectorAll(".markdown-renderer")[2]);
    assert.equal(sections[0].querySelectorAll(".csl-entry").length, 2);
  } finally {
    await act(async () => root.unmount());
  }
});

test("PDF export waits for the library, the style and formatting", async () => {
  const root = await mount(withProvider("Notes", createElement("article", { id: "export" }, createElement(MarkdownRenderer, { content: "Cited [@lee2019graphs]." }))));
  try {
    const article = document.getElementById("export")!;
    assert.ok(article.querySelector(`[${REFERENCES_PENDING_ATTRIBUTE}]`));
    let ready = false;
    const waiting = waitForReferencesReady(article).then(() => { ready = true; });
    await waitFor(() => ready, "ready");
    await waiting;
    assert.equal(chips()[0].textContent, "(Lee, 2019)");
    assert.match(article.querySelector("section.libera-bibliography")!.textContent!, /Graphs/);
    assert.equal(article.querySelector(`[${REFERENCES_PENDING_ATTRIBUTE}]`), null);

    // A notebook without a library does not hold the export back.
    await act(async () => root.render(withProvider("Missing", createElement("article", { id: "export" }, createElement(MarkdownRenderer, { content: "Cited [@lee2019graphs]." })))));
    await waitFor(() => !document.querySelector(`[${REFERENCES_PENDING_ATTRIBUTE}]`), "library error settles");
    await waitForReferencesReady(document.getElementById("export")!);
    assert.equal(chips()[0].textContent, "[@lee2019graphs]");
  } finally {
    await act(async () => root.unmount());
  }
});
