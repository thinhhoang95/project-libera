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
import { ReferenceRenderProvider } from "../../src/components/libera/references/reference-render-context";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { configureCitationFormatting } from "../../src/lib/references/format-client";
import { getRenderedSelectionMarkdown } from "../../src/lib/markdown-clipboard";
import { markdownPassageWords } from "../../src/lib/markdown-outline-navigation";
import { getMarkdownWordCountStats } from "../../src/lib/markdown-word-count";
import { embeddingText } from "../../src/lib/search/chunking";
import { biblatexCitation } from "../../src/lib/references/biblatex-export";
import { formatNotebookBibliography } from "../../src/lib/references/bibliography-export";
import { parseAnyCitation } from "../../src/lib/references/citation-syntax";
import {
  citationEntriesForDocument, formatCitationDocument, loadCitationFormatter, loadCslStyle, narrativeAuthorText,
} from "../../src/lib/references/format";
import { prepareLatexCitations } from "../../src/lib/references/latex-citations";
import type { Citation, CslItem, ReferenceEntry, ReferenceLibrary, ReferenceLibraryOp } from "../../src/lib/references/types";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { updateReferenceLibrary } from "../../src/lib/storage/references";
import { listCitations } from "../../src/lib/agent/fact-check/list-citations";
import { addWorks, makeContext, withLibrary, work, writeText } from "./references-factcheck-helpers";

// Narrative citations (`@key`, `@key [p. 33]`) beyond the grammar: citeproc's
// "Smith (2020)" in author-date and "Smith [3]" in numeric styles, LaTeX and
// biblatex, fact-check, the bibliography export, text consumers, rendering of
// resolved vs unresolved candidates, and the clipboard.

const NOW = "2026-10-18T00:00:00.000Z";

function entry(id: string, key: string, csl: Partial<CslItem>): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl } as CslItem, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {},
  };
}

const smith = entry("ref_1", "smith2020sparse", { title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] }, "container-title": "Journal of Tests" });
const team = entry("ref_2", "smith2021team", { title: "Team work", author: [{ family: "Smith", given: "Jane" }, { family: "Lee", given: "Ann" }, { family: "Doe", given: "Bo" }], issued: { "date-parts": [[2021]] } });
const lee = entry("ref_3", "lee2019graphs", { title: "Graphs", author: [{ family: "Lee", given: "Ann" }], issued: { "date-parts": [[2019]] } });

function library(style: string): ReferenceLibrary {
  return { version: 1, revision: 1, style, entries: Object.fromEntries([smith, team, lee].map((value) => [value.id, value])) };
}

function cites(...raws: string[]): Citation[] {
  return raws.map((raw) => {
    const citation = parseAnyCitation(raw);
    assert.ok(citation, raw);
    return citation;
  });
}

async function format(styleId: string, raws: string[], output: "html" | "text" = "text") {
  await loadCitationFormatter();
  const citations = cites(...raws);
  const keys = citations.flatMap((citation) => citation.items.map((item) => item.key));
  return formatCitationDocument({ citations, entries: citationEntriesForDocument(library(styleId), keys), style: await loadCslStyle(styleId), format: output });
}

// ---------------------------------------------------------------------------
// citeproc
// ---------------------------------------------------------------------------

test("author-date styles: narrative is Author (Year), with locators and et al.", async () => {
  const apa = await format("apa", ["@smith2020sparse", "@smith2020sparse [p. 33]", "@smith2021team [ch. 2, emphasis added]", "[@lee2019graphs]", "@ghost"]);
  assert.deepEqual(apa.citations, [
    "Smith (2020)",
    "Smith (2020, p. 33)",
    "Smith et al. (2021, Chapter 2, emphasis added)",
    "(Lee, 2019)",
    "@ghost",
  ]);
  assert.deepEqual(apa.unresolvedKeys, ["ghost"]);
  assert.equal(Object.keys(apa.bibliographyEntries).length, 3, "narrative works are in the bibliography");
  const chicago = await format("chicago-author-date", ["@smith2020sparse [p. 33]"]);
  assert.equal(chicago.citations[0], "Smith (2020, 33)");
  const html = await format("apa", ["@smith2021team"], "html");
  assert.equal(html.citations[0], "Smith et al. (2021)");
});

test("numeric styles: narrative is Author [n], numbered with the other citations", async () => {
  const ieee = await format("ieee", ["[@lee2019graphs]", "@smith2020sparse", "@smith2020sparse [p. 3]", "@smith2021team", "[@smith2020sparse]"]);
  assert.deepEqual(ieee.citations, ["[1]", "Smith [2]", "Smith [2, p. 3]", "Smith et al. [3]", "[2]"]);
  const vancouver = await format("vancouver", ["@smith2020sparse", "@lee2019graphs"]);
  assert.deepEqual(vancouver.citations, ["Smith (1)", "Lee (2)"]);
  const nature = await format("nature", ["@lee2019graphs"], "html");
  assert.equal(nature.citations[0], "Lee <sup>1</sup>");
  assert.equal(narrativeAuthorText({ type: "book", author: [{ family: "Smith" }, { family: "Lee" }] }), "Smith and Lee");
  assert.equal(narrativeAuthorText({ type: "book", editor: [{ literal: "WHO" }] }), "WHO");
  assert.equal(narrativeAuthorText({ type: "book", title: "Anonymous classic" }), "Anonymous classic");
});

// ---------------------------------------------------------------------------
// LaTeX, biblatex, bibliography export, fact-check
// ---------------------------------------------------------------------------

test("biblatex writes narrative citations as \\textcite", () => {
  const entries = citationEntriesForDocument(library("apa"), ["smith2020sparse", "smith2021team"]);
  assert.equal(biblatexCitation(parseAnyCitation("@smith2020sparse")!, entries), "\\textcite{smith2020sparse}");
  assert.equal(biblatexCitation(parseAnyCitation("@smith2021team [p. 33]")!, entries), "\\textcite[p.~33]{smith2021team}");
});

const ADD: ReferenceLibraryOp[] = [smith, lee].map((value) => ({ op: "add", entry: { key: value.key, csl: value.csl } }));

async function withData(style: string, run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-references-narrative-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await createNotebook("Refs");
    await updateReferenceLibrary("Refs", null, [...ADD, { op: "set-style", style }]);
    await run();
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("the LaTeX export formats resolved narrative citations and leaves @mentions as text", async () => {
  await withData("apa", async () => {
    const markdown = "As @smith2020sparse [p. 3] shows, and @alice agrees [@lee2019graphs].\n";
    const plan = (await prepareLatexCitations(markdown, "Refs"))!;
    assert.equal(plan.citations.size, 2);
    assert.match(plan.markdown, /^As ZCITE\w+Z shows, and @alice agrees ZCITE\w+Z\.\n$/);
    assert.deepEqual([...plan.citations.values()], ["Smith (2020, p. 3)", "(Lee, 2019)"]);
    const biblatex = (await prepareLatexCitations(markdown, "Refs", { mode: "biblatex" }))!;
    assert.deepEqual([...biblatex.citations.values()], ["\\textcite[p.~3]{smith2020sparse}", "\\parencite{lee2019graphs}"]);
    assert.equal(await prepareLatexCitations("Thanks @alice and @bob.\n", "Refs"), null, "unresolved candidates are not citations");
  });
});

test("the document bibliography counts resolved narrative citations only", async () => {
  const result = await formatNotebookBibliography({
    notebook: "Refs", library: library("apa"), format: "text", documentText: "@smith2020sparse says so, @alice agrees, `@lee2019graphs` is code.",
  });
  assert.equal(result.count, 1);
  assert.match(result.text, /^Smith, J\. \(2020\)\. Sparse attention\./);
  assert.deepEqual(result.unresolvedKeys, []);
});

test("fact-check lists narrative citations whose key is in the library", async () => {
  await withLibrary(async ({ root }) => {
    await writeText(root, "Research/narrative.md", "As @smith2020 [p. 2] shows, memory falls. Thanks @alice for comments [@lee2021].\n");
    await addWorks([work("smith2020", "Sparse attention", "Smith", 2020), work("lee2021", "Dense retrieval", "Lee", 2021)]);
    const { context } = makeContext("read-only");
    const listing = await listCitations(context, "Research/narrative.md");
    assert.deepEqual(listing.occurrences.map((occurrence) => [occurrence.id, occurrence.raw]), [["c1", "@smith2020 [p. 2]"], ["c2", "[@lee2021]"]]);
    assert.equal(listing.occurrences[0].claim, "As @smith2020 [p. 2] shows, memory falls.");
    assert.deepEqual(listing.occurrences[0].items.map((item) => [item.key, item.locator]), [["smith2020", "2"]]);
  });
});

// ---------------------------------------------------------------------------
// Text consumers
// ---------------------------------------------------------------------------

test("word count, search text and outline words treat a narrative citation as one cited work", () => {
  assert.equal(getMarkdownWordCountStats("@smith2020sparse [p. 33] argues this.").words, 3);
  assert.equal(embeddingText("markdown", "As @smith2020sparse [p. 12] shows."), "As smith2020sparse shows.");
  assert.equal(markdownPassageWords("As @smith2020sparse [p. 12] shows."), "as smith2020sparse shows.");
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let dom: JSDOM;

before(() => {
  dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent", "MutationObserver", "KeyboardEvent", "MouseEvent", "FocusEvent", "DOMParser"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  configureCitationFormatting({ worker: false });
});
after(() => dom.window.close());
beforeEach(() => {
  resetReferenceLibraryCache();
  document.body.innerHTML = "<div id='root'></div>";
});

function serveLibrary(value: ReferenceLibrary) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost/");
    if (url.pathname === "/api/references") return Response.json({ library: value });
    return Response.json({ error: "Not found" }, { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

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

const CONTENT = "@smith2020sparse [p. 3] argues; @alice disagrees [@lee2019graphs]. Mail me@example.com.";

test("without a provider a narrative candidate is plain text, never a chip", () => {
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, { content: CONTENT }));
  assert.doesNotMatch(html, /data-libera-narrative|data-libera-citation="@/);
  assert.match(html, />@smith2020sparse \[p\. 3\] argues; @alice disagrees <span class="libera-citation" data-libera-citation="\[@lee2019graphs\]"/);
});

test("with a library a resolved narrative citation renders formatted; an unresolved one stays text", async () => {
  const restore = serveLibrary(library("apa"));
  const root = await mount(createElement(ReferenceRenderProvider, { notebook: "Notes" }, createElement(MarkdownRenderer, { content: CONTENT })));
  try {
    await waitFor(() => document.querySelectorAll(".libera-citation[data-formatted]").length === 2, "formatted chips");
    const chips = [...document.querySelectorAll<HTMLElement>("#root .libera-citation")];
    assert.deepEqual(chips.map((chip) => [chip.textContent, chip.dataset.liberaCitation, chip.hasAttribute("data-libera-narrative")]), [
      ["Smith (2020, p. 3)", "@smith2020sparse [p. 3]", true],
      ["(Lee, 2019)", "[@lee2019graphs]", false],
    ]);
    const paragraph = document.querySelector("#root p")!;
    assert.match(paragraph.textContent!, /argues; @alice disagrees \(Lee, 2019\)/);
    assert.equal(document.querySelector(".libera-citation-unresolved"), null, "no red chip for @alice");
    const items = [...document.querySelectorAll("section.libera-bibliography .csl-entry")].map((element) => element.textContent);
    assert.deepEqual(items, ["Lee, A. (2019). Graphs.", "Smith, J. (2020). Sparse attention. Journal of Tests."]);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test("copying a rendered narrative citation writes its token", () => {
  const host = document.createElement("div");
  host.innerHTML = `<div class="markdown-body"><p><span class="libera-citation" data-libera-citation="@smith2020sparse [p. 3]" data-libera-narrative="">Smith (2020, p. 3)</span> argues, @alice agrees.</p></div>`;
  document.body.replaceChildren(host);
  const container = host.firstElementChild as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(container);
  assert.equal(getRenderedSelectionMarkdown(container, range), "@smith2020sparse [p. 3] argues, @alice agrees.");
});
