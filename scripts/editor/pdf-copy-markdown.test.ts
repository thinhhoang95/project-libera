import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { pdfSelectionFromRange } from "../../src/components/libera/pdf-copy";
import { pdfLayoutPage, readPdfPageStructure } from "../../src/lib/pdf-layout-page";
import {
  pdfSelectionToMarkdown,
  type PdfLayoutPage,
  type PdfLayoutRun,
  type PdfTextSelection,
} from "../../src/lib/pdf-markdown";

const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "Node", "Range"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
after(() => dom.window.close());

type RunInput = Omit<Partial<PdfLayoutRun>, "index" | "text" | "x" | "y"> & { full?: number };

// Body text is 10 units high and 5 units per character; `full` justifies a
// line to the given right edge.
function run(text: string, x: number, y: number, options: RunInput = {}): Omit<PdfLayoutRun, "index"> {
  const { full, ...rest } = options;
  const size = rest.size ?? 10;
  return { text, x, y, size, width: full ? full - x : text.length * size * 0.5, ...rest };
}

function page(pageNumber: number, runs: Omit<PdfLayoutRun, "index">[]): PdfLayoutPage {
  return { pageNumber, width: 600, height: 800, runs: runs.map((item, index) => ({ ...item, index })) };
}

function pageMap(...pages: PdfLayoutPage[]) {
  return new Map(pages.map((item) => [item.pageNumber, item]));
}

function selectAll(...pages: PdfLayoutPage[]): PdfTextSelection[] {
  return pages.flatMap((item) => item.runs.map((entry) => ({
    pageNumber: item.pageNumber, index: entry.index, start: 0, end: entry.text.length,
  })));
}

function copyAll(...pages: PdfLayoutPage[]) {
  return pdfSelectionToMarkdown(pageMap(...pages), selectAll(...pages));
}

test("two columns read in order, with headers, page numbers and broken words repaired", () => {
  const header = (n: number) => [run("Journal of Tests", 50, 40), run(`Vol. 7, page ${n}`, 460, 40)];
  const first = page(1, [
    ...header(1),
    run("A Study of Layout Recovery", 200, 80, { size: 18 }),
    run("The first paragraph begins here and keeps", 50, 120, { full: 270 }),
    run("going until a hyphen-", 50, 132, { full: 270 }),
    run("ated word ends it.", 50, 144),
    run("Second paragraph starts with an indent and", 65, 156, { full: 270 }),
    run("flows to the bottom of the left column", 50, 168, { full: 270 }),
    run("and continues in the right column.", 320, 120),
    run("1", 295, 760),
  ]);
  const second = page(2, [
    ...header(2),
    run("Final words close the article.", 50, 120),
    run("Another body line keeps the page realistic.", 50, 132),
    run("2", 295, 760),
  ]);

  assert.equal(copyAll(first, second), [
    "# A Study of Layout Recovery",
    "The first paragraph begins here and keeps going until a hyphenated word ends it.",
    "Second paragraph starts with an indent and flows to the bottom of the left column and continues in the right column.",
    "Final words close the article.",
    "Another body line keeps the page realistic.",
  ].join("\n\n"));
});

test("a paragraph carries on across a page break mid-sentence", () => {
  const first = page(1, [
    run("Opening line of the body text on this page.", 50, 100, { full: 550 }),
    run("A sentence that is cut off at the bottom of the", 50, 700, { full: 550 }),
    run("1", 300, 760),
  ]);
  const second = page(2, [
    run("page continues here without a break.", 50, 100),
    run("Next paragraph line.", 50, 130),
    run("2", 300, 760),
  ]);
  const markdown = pdfSelectionToMarkdown(pageMap(first, second), [
    { pageNumber: 1, index: 1, start: 0, end: first.runs[1].text.length },
    { pageNumber: 1, index: 2, start: 0, end: 1 },
    { pageNumber: 2, index: 0, start: 0, end: second.runs[0].text.length },
  ]);
  assert.equal(markdown, "A sentence that is cut off at the bottom of the page continues here without a break.");
});

test("headings come from font size and bold short lines; hyphens in compounds survive", () => {
  const markdown = copyAll(page(1, [
    run("1 Introduction", 50, 100, { size: 14 }),
    run("Body text fills the first line of the column", 50, 120, { full: 550 }),
    run("and the second line of the column as well", 50, 132, { full: 550 }),
    run("before it ends here.", 50, 144),
    run("Related Work", 50, 170, { bold: true }),
    run("Prior systems such as state-of-", 50, 186, { full: 550 }),
    run("the-art tools and COVID-", 50, 198, { full: 550 }),
    run("19 dashboards link to https://example.com/very/", 50, 210, { full: 550 }),
    run("long/path for details.", 50, 222),
  ]));

  assert.equal(markdown, [
    "## 1 Introduction",
    "Body text fills the first line of the column and the second line of the column as well before it ends here.",
    "#### Related Work",
    "Prior systems such as state-of-the-art tools and COVID-19 dashboards link to https://example.com/very/long/path for details.",
  ].join("\n\n"));
});

test("bullets, numbered items and hanging-indent references", () => {
  const markdown = copyAll(page(1, [
    run("Lead paragraph text that introduces the list below.", 50, 88),
    run("• First item that wraps onto", 50, 100, { full: 550 }),
    run("a second line here.", 62, 112),
    run("• Second item.", 50, 124),
    run("1. Ordered one", 50, 136),
    run("2. Ordered two", 50, 148),
    run("[1] A. Author. A long reference title that", 50, 160, { full: 550 }),
    run("continues with a hanging indent.", 70, 172),
    run("[2] B. Author. Another.", 50, 184),
  ]));

  assert.equal(markdown, [
    "Lead paragraph text that introduces the list below.",
    "- First item that wraps onto a second line here.\n- Second item.",
    "1. Ordered one\n2. Ordered two",
    "[1] A. Author. A long reference title that continues with a hanging indent.",
    "[2] B. Author. Another.",
  ].join("\n\n"));
});

test("emphasis, escaping and partial selections", () => {
  const styled = page(1, [
    run("This is ", 50, 100),
    run("bold", 90, 100, { bold: true }),
    run(" and ", 110, 100),
    run("italic", 135, 100, { italic: true }),
    run(" text.", 165, 100),
    run("# not a heading *really* costs $5 <b> [x](y)", 50, 130),
    run("Large Title Words", 50, 160, { size: 20 }),
  ]);
  const map = pageMap(styled);
  const select = (index: number, start = 0, end = styled.runs[index].text.length) => ({ pageNumber: 1, index, start, end });

  assert.equal(
    pdfSelectionToMarkdown(map, [0, 1, 2, 3, 4].map((index) => select(index))),
    "This is **bold** and *italic* text.",
  );
  assert.equal(
    pdfSelectionToMarkdown(map, [select(5)]),
    "\\# not a heading \\*really\\* costs \\$5 \\<b> \\[x](y)",
  );
  // Part of one line pastes as inline text, never as a heading.
  assert.equal(pdfSelectionToMarkdown(map, [select(6, 6, 11)]), "Title");
});

test("a selected running header is still copied", () => {
  const header = (n: number) => page(n, [
    run("Proceedings of Tests 2026", 50, 40),
    run(`Body text on page ${n} sits well below the header.`, 50, 120),
    run("More body text keeps the page realistic.", 50, 132),
    run("Closing body line.", 50, 144),
  ]);
  const first = header(1);
  const second = header(2);
  const map = pageMap(first, second);

  assert.doesNotMatch(pdfSelectionToMarkdown(map, selectAll(first)), /Proceedings/);
  assert.equal(
    pdfSelectionToMarkdown(map, [{ pageNumber: 1, index: 0, start: 0, end: first.runs[0].text.length }]),
    "Proceedings of Tests 2026",
  );
});

test("monospace lines become a fenced code block with indentation", () => {
  const markdown = copyAll(page(1, [
    run("Example code follows in the listing below, set in a typewriter font.", 50, 80),
    run("def join(lines):", 50, 110, { monospace: true, width: 96 }),
    run("return lines", 74, 122, { monospace: true, width: 72 }),
  ]));
  assert.equal(markdown, [
    "Example code follows in the listing below, set in a typewriter font.",
    "```\ndef join(lines):\n    return lines\n```",
  ].join("\n\n"));
});

test("tagged structure decides paragraphs, headings and artifacts", () => {
  const markdown = copyAll(page(1, [
    run("Overview", 50, 100, { block: 0, role: "H2" }),
    run("First tagged paragraph that fills a line", 50, 116, { full: 550, block: 1, role: "P" }),
    run("Second tagged paragraph without any gap.", 50, 128, { full: 550, block: 2, role: "P" }),
    run("Running footer", 50, 130, { artifact: true }),
  ]));
  assert.equal(markdown, [
    "## Overview",
    "First tagged paragraph that fills a line",
    "Second tagged paragraph without any gap.",
  ].join("\n\n"));
});

test("DOM selections map to text items, including partial and highlighted spans", () => {
  document.body.innerHTML = `
    <div data-pdf-page-content="3"><div class="pdf-text-layer">
      <span data-pdf-item="0">Hello world</span><br>
      <span data-pdf-item="2">Second <mark>line</mark> here</span>
      <span data-pdf-item="3">Unselected</span>
    </div></div>`;
  const spans = document.querySelectorAll("span");
  const range = document.createRange();
  range.setStart(spans[0].firstChild!, 6);
  range.setEnd(spans[1].querySelector("mark")!.firstChild!, 2);

  assert.deepEqual(pdfSelectionFromRange(range, document.body), [
    { pageNumber: 3, index: 0, start: 6, end: 11 },
    { pageNumber: 3, index: 2, start: 0, end: 9 },
  ]);
});

test("pdf.js text items become runs with fonts, skipping rotated text", () => {
  const fonts: Record<string, { name: string }> = {
    f1: { name: "ABCDEF+Times-Bold" },
    f2: { name: "ABCDEF+CMMI10" },
    f3: { name: "ABCDEF+CMTT10" },
  };
  const layout = pdfLayoutPage(
    {
      pageNumber: 4,
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }) as never,
      commonObjs: { has: (name: string) => name in fonts, get: (name: string) => fonts[name] },
    },
    {
      items: [
        { str: "Bold", dir: "ltr", transform: [10, 0, 0, 10, 50, 700], width: 20, height: 10, fontName: "f1", hasEOL: false },
        { str: "arXiv:1234", dir: "ltr", transform: [0, 10, -10, 0, 20, 400], width: 50, height: 10, fontName: "f1", hasEOL: false },
        { str: "", dir: "ltr", transform: [10, 0, 0, 10, 0, 0], width: 0, height: 0, fontName: "f1", hasEOL: true },
        { str: "x", dir: "ltr", transform: [10, 0, 0, 10, 80, 700], width: 5, height: 10, fontName: "f2", hasEOL: false },
        { str: "code", dir: "ltr", transform: [10, 0, 0, 10, 90, 700], width: 20, height: 10, fontName: "f3", hasEOL: false },
      ],
      styles: {
        f1: { fontFamily: "serif", ascent: 0.8, descent: -0.2, vertical: false },
        f2: { fontFamily: "serif", ascent: 0.8, descent: -0.2, vertical: false },
        f3: { fontFamily: "monospace", ascent: 0.8, descent: -0.2, vertical: false },
      },
      lang: null,
    },
  );

  assert.deepEqual(layout.runs.map(({ index, text, y, bold, italic, monospace }) => ({ index, text, y, bold, italic, monospace })), [
    { index: 0, text: "Bold", y: 100, bold: true, italic: false, monospace: false },
    { index: 3, text: "x", y: 100, bold: false, italic: false, monospace: false },
    { index: 4, text: "code", y: 100, bold: false, italic: false, monospace: true },
  ]);
});

test("structure tree content maps to text items, with artifacts flagged", async () => {
  const content = (id: string) => ({ type: "content", id });
  const structure = await readPdfPageStructure({
    getStructTree: async () => ({
      role: "Root",
      children: [{
        role: "Document",
        children: [
          { role: "H1", children: [content("p1R_mc0")] },
          { role: "L", children: [{ role: "LI", children: [
            { role: "Lbl", children: [content("p1R_mc1")] },
            { role: "LBody", children: [{ role: "P", children: [content("p1R_mc2")] }] },
          ] }] },
        ],
      }],
    }),
    getTextContent: async () => ({
      items: [
        { type: "beginMarkedContentProps", id: "p1R_mc0", tag: "H1" }, { str: "Title" }, { type: "endMarkedContent" },
        { type: "beginMarkedContent", tag: "Artifact" }, { str: "3" }, { type: "endMarkedContent" },
        { type: "beginMarkedContentProps", id: "p1R_mc1", tag: "Lbl" }, { str: "•" }, { type: "endMarkedContent" },
        { type: "beginMarkedContentProps", id: "p1R_mc2", tag: "P" }, { str: "Item" }, { type: "endMarkedContent" },
      ],
      styles: {},
      lang: null,
    }) as never,
  });

  assert.deepEqual(structure, {
    itemCount: 4,
    blocks: [0, undefined, 1, 1],
    roles: ["H1", undefined, "LI", "LI"],
    artifacts: [false, true, false, false],
  });
});
