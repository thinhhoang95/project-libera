import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as copyRoute } from "../../src/app/api/references/copy/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { locatorPages as factCheckLocatorPages } from "../../src/lib/agent/fact-check/list-citations";
import { parseCitationToken } from "../../src/lib/references/citation-syntax";
import { copyReferenceEntries } from "../../src/lib/references/copy-entries";
import { locatorPages, pdfPageForPrinted, pdfPagesLocator, printedPageForPdf, printedPageLabel, printedRange } from "../../src/lib/references/pages";
import {
  blockquoteLines,
  buildPdfQuoteMarkdown,
  entryForAttachment,
  parsePdfQuoteSource,
  pdfQuoteLocator,
  pdfQuoteMarkdown,
  quoteBlockInsertion,
} from "../../src/lib/references/pdf-quote";
import { citationInsertion } from "../../src/lib/references/reference-suggestions";
import type { CslItem, ReferenceEntry, ReferenceLibrary } from "../../src/lib/references/types";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { pendingReferenceReattach, readReferenceLibrary, resetReferenceReattachSchedule, updateReferenceLibrary } from "../../src/lib/storage/references";
import { citationRawForTrigger } from "../../src/lib/tiptap-citation";

const NOW = "2026-10-18T00:00:00.000Z";

function entry(id: string, key: string, csl: Partial<CslItem>, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl }, identifiers: {}, provenance: {}, status: "confirmed",
    attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra,
  };
}

const SMITH = entry("ref_smith", "smith2020", { title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] }, page: "340-360" }, {
  attachments: [{ kind: "pdf", path: "Papers/smith.pdf" }],
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

test("printed pages: the CSL range maps PDF pages both ways, and fact-check uses the same helpers", () => {
  assert.deepEqual(printedRange({ csl: { page: "340-360" } }), { first: 340, last: 360 });
  assert.deepEqual(printedRange({ csl: { page: "345–52" } }), { first: 345, last: 352 });
  assert.equal(printedRange({ csl: { page: "e1234" } }), undefined);
  assert.equal(printedPageForPdf({ first: 340, last: 360 }, 1), 340);
  assert.equal(printedPageForPdf({ first: 340, last: 360 }, 21), 360);
  assert.equal(printedPageForPdf({ first: 340, last: 360 }, 22), undefined, "past the work's last page");
  assert.equal(pdfPageForPrinted({ printed: { first: 340, last: 360 } }, 30, 345), 6);
  assert.equal(factCheckLocatorPages, locatorPages, "fact-check re-exports the shared helper");
  assert.deepEqual(locatorPages({ locator: "12-14" }), [12, 13, 14]);
});

test("a page's printed label: the PDF's own labels, else the CSL range, else the page index", () => {
  assert.equal(printedPageLabel(3, { labels: ["i", "ii", "iii", "1"], printed: { first: 340, last: 360 } }), "iii");
  assert.equal(printedPageLabel(3, { labels: null, printed: { first: 340, last: 360 } }), "342");
  assert.equal(printedPageLabel(3, { labels: ["", "", " "] }), "3", "blank labels fall through");
  assert.equal(printedPageLabel(30, { printed: { first: 340, last: 360 } }), "30", "outside the range: the page index");
  assert.equal(pdfPagesLocator(2, 3, { printed: { first: 12, last: 20 } }), "13–14");
  assert.equal(pdfPagesLocator(4, 4, {}), "4");
});

// ---------------------------------------------------------------------------
// Building the Markdown
// ---------------------------------------------------------------------------

test("quote and cite: page labels, the range mapping and the page index give the locator", () => {
  const source = { quote: "Attention is sparse.", path: "Papers/smith.pdf", page: 3 };
  assert.equal(buildPdfQuoteMarkdown({ ...source, pageLabel: "17" }, "smith2020", SMITH), "> Attention is sparse.\n>\n> [@smith2020, p. 17]");
  assert.equal(buildPdfQuoteMarkdown(source, "smith2020", SMITH), "> Attention is sparse.\n>\n> [@smith2020, p. 342]");
  assert.equal(buildPdfQuoteMarkdown(source, "smith2020", entry("x", "x", {})), "> Attention is sparse.\n>\n> [@smith2020, p. 3]");
  assert.equal(buildPdfQuoteMarkdown({ ...source, pageLabel: "xii" }, "smith2020"), "> Attention is sparse.\n>\n> [@smith2020, p. xii]");
});

test("a selection across pages cites a page range", () => {
  const source = { quote: "First page.\n\nSecond page.", path: "Papers/smith.pdf", page: 12, endPage: 13 };
  assert.equal(buildPdfQuoteMarkdown(source, "k", null), "> First page.\n>\n> Second page.\n>\n> [@k, pp. 12–13]");
  assert.equal(pdfQuoteLocator(source, SMITH), "351–352");
  assert.equal(pdfQuoteLocator({ ...source, pageLabel: "7", endPageLabel: "8" }, SMITH), "7–8");
  // One labelled end is not enough: mixing labels and indexes would name the wrong pages.
  assert.equal(pdfQuoteLocator({ ...source, pageLabel: "7" }, SMITH), "351–352");
  const token = /\[@k, pp\. 12–13\]/.exec(buildPdfQuoteMarkdown(source, "k"))![0];
  assert.deepEqual(parseCitationToken(token)?.items, [{ key: "k", locator: "12–13", label: "page" }]);
});

test("blockquote lines keep paragraphs and Markdown", () => {
  assert.equal(blockquoteLines("  **Bold** claim\n\n- a list\r\n"), "> **Bold** claim\n>\n> - a list");
  assert.equal(pdfQuoteMarkdown("", "[@k]"), "> [@k]");
});

test("drag payloads are validated", () => {
  assert.deepEqual(parsePdfQuoteSource(JSON.stringify({ quote: "Q", path: "A/b.pdf", page: 2, pageLabel: " 7 ", endPage: 3, endPageLabel: "8" })),
    { quote: "Q", path: "A/b.pdf", page: 2, pageLabel: "7", endPage: 3, endPageLabel: "8" });
  assert.deepEqual(parsePdfQuoteSource({ quote: "Q", path: "A/b.pdf", page: 2, endPage: 2 }), { quote: "Q", path: "A/b.pdf", page: 2 });
  assert.equal(parsePdfQuoteSource("not json"), null);
  assert.equal(parsePdfQuoteSource({ quote: "Q", path: "A/b.md", page: 2 }), null, "only PDFs");
  assert.equal(parsePdfQuoteSource({ quote: " ", path: "A/b.pdf", page: 2 }), null);
  assert.equal(parsePdfQuoteSource({ quote: "Q", path: "A/b.pdf", page: 0 }), null);
});

test("the entry for a PDF is the one that has it attached, the most recently updated first", () => {
  const library: Pick<ReferenceLibrary, "entries"> = {
    entries: {
      a: entry("a", "a", {}, { attachments: [{ kind: "pdf", path: "N/x.pdf" }], updatedAt: "2026-01-01T00:00:00.000Z" }),
      b: entry("b", "b", {}, { attachments: [{ kind: "pdf", path: "N/x.pdf" }], updatedAt: "2026-02-01T00:00:00.000Z" }),
      c: entry("c", "c", {}, { attachments: [{ kind: "url", url: "https://x.org/N/y.pdf" }] }),
    },
  };
  assert.equal(entryForAttachment(library, "N/x.pdf")?.id, "b");
  assert.equal(entryForAttachment(library, "N/y.pdf"), null);
  assert.equal(entryForAttachment(null, "N/x.pdf"), null);
});

test("a quote goes in as its own block after the paragraph at the caret", () => {
  const value = "First paragraph\nstill first.\n\nSecond.";
  const inside = quoteBlockInsertion(value, 3, "> Q\n>\n> [@k]");
  assert.equal(inside.value, "First paragraph\nstill first.\n> Q\n>\n> [@k]\n\nSecond.".replace("first.\n> Q", "first.\n\n> Q"));
  assert.equal(inside.value.slice(0, inside.from) + inside.text + value.slice(inside.from), inside.value);
  assert.equal(inside.value.slice(inside.caret - 6, inside.caret), "> [@k]");
  const end = quoteBlockInsertion("Text", 4, "> Q");
  assert.equal(end.value, "Text\n\n> Q");
  const empty = quoteBlockInsertion("", 0, "> Q");
  assert.equal(empty.value, "> Q");
});

test("popup insertions cite a page when the match was on one", () => {
  assert.deepEqual(citationInsertion("k", false, false, { pageLocator: "12" }), { text: "[@k, p. 12]", caret: 11 });
  assert.deepEqual(citationInsertion("k", true, false, { pageLocator: "12–13" }), { text: "@k, pp. 12–13", caret: 13 });
  assert.equal(citationRawForTrigger({ insideCitation: false }, "k", { pageLocator: "7" }), "[@k, p. 7]");
  // A narrative choice with a page: `@key [p. 7]`.
  assert.equal(citationRawForTrigger({ insideCitation: false, before: " " }, "k", { narrative: true, pageLocator: "7" }), "@k [p. 7]");
  assert.deepEqual(citationInsertion("k", false, false, { narrative: true, before: " ", pageLocator: "12" }), { text: "@k [p. 12]", caret: 10 });
  assert.equal(citationRawForTrigger({ insideCitation: true, open: "[@a; " }, "k", { pageLocator: "7" }), "[@a; @k, p. 7]");
  assert.equal(citationRawForTrigger({ insideCitation: false }, "k"), "[@k]");
});

// ---------------------------------------------------------------------------
// Copying an entry into another notebook
// ---------------------------------------------------------------------------

async function withData(run: () => Promise<void>) {
  await pendingReferenceReattach();
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-references-pdfcite-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  try {
    await mkdir(path.join(scratch, "data", "users", "admin"), { recursive: true });
    await run();
  } finally {
    await pendingReferenceReattach();
    resetReferenceReattachSchedule();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

function copyRequest(body: unknown, auth = true) {
  return new NextRequest("http://localhost/api/references/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {}) },
    body: JSON.stringify(body),
  });
}

test("POST /api/references/copy copies an entry, keeps a free key, generates one when taken, and reuses the same work", async () => {
  await withData(async () => {
    await createNotebook("Papers");
    await createNotebook("Notes");
    await createNotebook("Other");
    const lee = entry("ref_lee", "lee2019", { title: "Graphs and cuts", author: [{ family: "Lee", given: "Ann" }], issued: { "date-parts": [[2019]] }, DOI: "10.1/lee" }, { identifiers: { doi: "10.1/lee" } });
    const smith = { ...SMITH, attachments: [] };
    await updateReferenceLibrary("Papers", null, [{ op: "put", entry: smith }, { op: "put", entry: lee }]);
    // Notes already has a different work under smith2020, and the same Lee paper under another key.
    await updateReferenceLibrary("Notes", null, [
      { op: "put", entry: entry("ref_other", "smith2020", { title: "Unrelated", author: [{ family: "Smith", given: "Bob" }], issued: { "date-parts": [[2020]] } }) },
      { op: "put", entry: { ...lee, id: "ref_lee_notes", key: "leeGraphs" } },
    ]);

    const unauthorized = await copyRoute(copyRequest({ from: "Papers", to: "Notes", keys: ["smith2020"] }, false));
    assert.equal(unauthorized.status, 401);
    assert.equal((await copyRoute(copyRequest({ from: "Papers", to: "Notes", keys: [] }))).status, 400);
    assert.equal((await copyRoute(copyRequest({ from: "Papers", to: "../x", keys: ["a"] }))).status, 400);
    assert.equal((await copyRoute(copyRequest({ from: "Papers", to: "Notes", keys: ["not a key!"] }))).status, 400);

    const response = await copyRoute(copyRequest({ from: "Papers", to: "Notes", keys: ["smith2020", "lee2019", "ghost2000"] }));
    assert.equal(response.status, 200);
    const body = await response.json() as { keys: Record<string, string>; missing: string[]; copied: { key: string }[]; reused: { key: string; destinationKey: string }[] };
    assert.notEqual(body.keys.smith2020, "smith2020", "a taken key gets a generated one");
    assert.equal(body.keys.lee2019, "leeGraphs", "the same work is reused under its key there");
    assert.deepEqual(body.missing, ["ghost2000"]);
    assert.deepEqual(body.reused, [{ key: "lee2019", destinationKey: "leeGraphs" }]);
    const notes = await readReferenceLibrary("Notes");
    const copied = Object.values(notes.entries).find((value) => value.key === body.keys.smith2020);
    assert.equal(copied?.csl.title, "Sparse attention");
    assert.notEqual(copied?.id, SMITH.id, "a copy gets its own id");

    // A free key is kept; copying again finds the copy by its identifier.
    const first = await copyReferenceEntries("Papers", "Other", ["smith2020", "lee2019"]);
    assert.deepEqual(first.keys, { smith2020: "smith2020", lee2019: "lee2019" });
    assert.equal(first.copied.length, 2);
    const again = await copyReferenceEntries("Papers", "Other", ["lee2019"]);
    assert.deepEqual(again.keys, { lee2019: "lee2019" });
    assert.equal(again.copied.length, 0);
    assert.equal(again.destinationRevision, null);
    assert.equal(Object.keys((await readReferenceLibrary("Other")).entries).length, 2);

    // The same notebook: nothing to copy.
    assert.deepEqual((await copyReferenceEntries("Papers", "Papers", ["lee2019"])).keys, { lee2019: "lee2019" });
    assert.equal((await copyRoute(copyRequest({ from: "Papers", to: "Missing", keys: ["lee2019"] }))).status, 404);
  });
});
