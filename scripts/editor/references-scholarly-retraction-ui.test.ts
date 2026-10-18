import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { act, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { ReferenceRenderProvider } from "../../src/components/libera/references/reference-render-context";
import { resetCitationHoverCardCache } from "../../src/components/libera/references/citation-hover-card";
import { citationRetractionClass, RetractionBadge, retractionTone } from "../../src/components/libera/references/retraction-badge";
import { resetReferenceLibraryCache } from "../../src/components/libera/references/use-reference-library";
import { formatNotebookBibliography } from "../../src/lib/references/bibliography-export";
import { configureCitationFormatting } from "../../src/lib/references/format-client";
import type { CslItem, ReferenceEntry, ReferenceLibrary, RetractionStatus } from "../../src/lib/references/types";

// How retraction statuses show: badges, citation chip styles, the hover card
// and the bibliography preview; and that formatted exports never carry them.

const NOW = "2026-10-18T00:00:00.000Z";
const RETRACTED: RetractionStatus = { state: "retracted", checkedAt: NOW, notice: { doi: "10.1234/r.notice", url: "https://doi.org/10.1234/r.notice", date: "2025-03-04", label: "Retraction" } };
const CORRECTED: RetractionStatus = { state: "corrected", checkedAt: NOW, notice: { doi: "10.1234/c.notice", date: "2024-01-02", label: "Correction" } };
const CONCERN: RetractionStatus = { state: "expression-of-concern", checkedAt: NOW, notice: { label: "Expression of concern" } };

function entry(id: string, key: string, csl: Partial<CslItem>, retraction?: RetractionStatus): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl } as CslItem, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...(retraction ? { retraction } : {}),
  };
}

const bad = entry("ref_bad", "wake1998", { title: "Retracted paper", author: [{ family: "Wake", given: "A." }], issued: { "date-parts": [[1998]] }, "container-title": "The Lancet" }, RETRACTED);
const fixed = entry("ref_fixed", "cole2019", { title: "Corrected paper", author: [{ family: "Cole", given: "B." }], issued: { "date-parts": [[2019]] } }, CORRECTED);
const clean = entry("ref_clean", "lee2020", { title: "Clean paper", author: [{ family: "Lee", given: "C." }], issued: { "date-parts": [[2020]] } }, { state: "none", checkedAt: NOW });
const LIBRARY: ReferenceLibrary = { version: 1, revision: 1, style: "apa", entries: Object.fromEntries([bad, fixed, clean].map((value) => [value.id, value])) };

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
    if (url.pathname === "/api/references" && url.searchParams.get("notebook") === "Notes") return Response.json({ library: LIBRARY });
    return Response.json({ error: "Not found" }, { status: 404 });
  }) as typeof fetch;
});

after(() => dom.window.close());

beforeEach(() => {
  resetReferenceLibraryCache();
  resetCitationHoverCardCache();
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

test("RetractionBadge shows the state, links the notice and puts the details in its tooltip", () => {
  const html = renderToStaticMarkup(createElement(RetractionBadge, { status: RETRACTED }));
  assert.equal(html, '<a class="libera-retraction-badge libera-retraction-warning" data-retraction-state="retracted" href="https://doi.org/10.1234/r.notice" target="_blank" rel="noopener noreferrer" title="Retracted (Retraction, 2025-03-04) · Checked 2026-10-18">Retracted</a>');
  assert.match(renderToStaticMarkup(createElement(RetractionBadge, { status: CORRECTED })), /libera-retraction-note.*href="https:\/\/doi.org\/10.1234\/c.notice".*>Corrected</);
  assert.match(renderToStaticMarkup(createElement(RetractionBadge, { status: CONCERN })), /^<span class="libera-retraction-badge libera-retraction-warning"[^>]*>Expression of concern<\/span>$/);
  assert.match(renderToStaticMarkup(createElement(RetractionBadge, { status: { state: "withdrawn", checkedAt: NOW }, compact: true })), />\[Withdrawn\]</);
  assert.equal(renderToStaticMarkup(createElement(RetractionBadge, { status: { state: "none", checkedAt: NOW } })), "");
  assert.equal(renderToStaticMarkup(createElement(RetractionBadge, { status: undefined })), "");
  assert.equal(retractionTone(CONCERN), "warning");
  assert.equal(citationRetractionClass([clean, fixed]), "libera-citation-corrected");
  assert.equal(citationRetractionClass([fixed, bad, undefined]), "libera-citation-retracted");
  assert.equal(citationRetractionClass([clean, undefined]), null);
});

test("chips warn for retracted works and note corrected ones; the hover card shows the badge; the bibliography marks retractions", async () => {
  const root = await mount(createElement(ReferenceRenderProvider, { notebook: "Notes" }, createElement(MarkdownRenderer, {
    content: "A [@wake1998] and [@cole2019] and [@lee2020; @wake1998] and [@lee2020].",
    documentPath: "Notes/doc.md",
  })));
  try {
    await waitFor(() => document.querySelectorAll(".libera-citation[data-formatted]").length === 4, "formatted chips");
    const chips = [...document.querySelectorAll<HTMLElement>("#root .libera-citation")];
    assert.deepEqual(chips.map((chip) => chip.className), [
      "libera-citation libera-citation-retracted",
      "libera-citation libera-citation-corrected",
      "libera-citation libera-citation-retracted",
      "libera-citation",
    ]);

    await act(async () => chips[0].focus());
    const card = document.getElementById(chips[0].getAttribute("aria-describedby")!)!;
    const badge = card.querySelector<HTMLAnchorElement>(".citation-card-retraction .libera-retraction-badge")!;
    assert.equal(badge.textContent, "Retracted");
    assert.equal(badge.href, "https://doi.org/10.1234/r.notice");
    assert.match(card.querySelector(".citation-card-retraction")!.textContent!, /Retracted \(Retraction, 2025-03-04\)/);
    await act(async () => chips[0].blur());

    const section = document.querySelector("section.libera-bibliography")!;
    const items = [...section.querySelectorAll(".libera-bibliography-item")];
    assert.equal(items.length, 3, "Rendered entry by entry when one is retracted");
    const marked = items.filter((item) => item.querySelector(".libera-retraction-badge"));
    assert.equal(marked.length, 1, "Only the retracted entry; a correction is not marked here");
    assert.match(marked[0].querySelector(".csl-entry")!.textContent!, /Retracted paper/);
    assert.equal(marked[0].querySelector(".libera-retraction-badge")!.textContent, "[Retracted]");
    assert.match(marked[0].querySelector(".libera-retraction-badge")!.getAttribute("title")!, /Retraction, 2025-03-04/);
    assert.ok(section.querySelector(".csl-bib-body"), "The citeproc body class is kept");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a bibliography without retracted works renders exactly as before", async () => {
  const root = await mount(createElement(ReferenceRenderProvider, { notebook: "Notes" }, createElement(MarkdownRenderer, {
    content: "Only [@lee2020] and [@cole2019].",
    documentPath: "Notes/doc.md",
  })));
  try {
    await waitFor(() => document.querySelectorAll(".libera-citation[data-formatted]").length === 2, "formatted chips");
    const section = document.querySelector("section.libera-bibliography")!;
    assert.equal(section.querySelectorAll(".libera-bibliography-item").length, 0);
    assert.equal(section.querySelectorAll(".csl-entry").length, 2);
    assert.equal(section.querySelector(".libera-retraction-badge"), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test("formatted exports and the PDF export never carry the preview badge", async () => {
  for (const format of ["text", "markdown", "html"] as const) {
    const exported = await formatNotebookBibliography({ notebook: "Notes", library: LIBRARY, format, documentText: "[@wake1998]" });
    assert.equal(exported.count, 1);
    assert.doesNotMatch(exported.text, /Retracted\]|retraction-badge/, format);
  }
  const css = readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
  assert.match(css, /\.markdown-pdf-export-document \.libera-retraction-badge \{\s*display: none;/);
  assert.match(css, /@media print \{\s*\.libera-retraction-badge \{\s*display: none;/);
});
