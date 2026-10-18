import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  citationEntriesForDocument,
  citationHtmlToText,
  formatCitationDocument,
  formatCitations,
  libraryEntriesByKey,
  loadCitationFormatter,
  loadCslStyle,
  sanitizeCitationHtml,
  sanitizeCitationHtmlString,
} from "../../src/lib/references/format";
import { parseCitationToken } from "../../src/lib/references/citation-syntax";
import { BUNDLED_CSL_STYLES, type Citation, type CslItem, type ReferenceEntry, type ReferenceLibrary } from "../../src/lib/references/types";
import { BUNDLED_CSL_STYLE_XML } from "../../src/lib/references/csl/styles.generated";

const NOW = "2026-10-18T00:00:00.000Z";

function entry(id: string, key: string, csl: Partial<CslItem>, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl } as CslItem, identifiers: {}, provenance: {},
    status: "confirmed", attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra,
  };
}

function library(...entries: ReferenceEntry[]): ReferenceLibrary {
  return { version: 1, revision: 1, style: "apa", entries: Object.fromEntries(entries.map((value) => [value.id, value])) };
}

function cites(...raws: string[]): Citation[] {
  return raws.map((raw) => {
    const citation = parseCitationToken(raw);
    assert.ok(citation, raw);
    return citation;
  });
}

const smithA = entry("ref_1", "smith2020sparse", { title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] }, "container-title": "Journal of Tests", volume: "3", page: "1-10" }, { aliases: ["smith2020old"] });
const smithB = entry("ref_2", "smith2020dense", { title: "Dense attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] }, "container-title": "Journal of Tests" });
const lee = entry("ref_3", "lee2019graphs", { title: "Graphs", author: [{ family: "Lee", given: "Ann" }], issued: { "date-parts": [[2019]] }, "container-title": "Graph Letters" });
const uncited = entry("ref_4", "doe2001", { title: "Never cited", author: [{ family: "Doe", given: "John" }], issued: { "date-parts": [[2001]] } });
const LIBRARY = library(smithA, smithB, lee, uncited);

let apa = "";
let ieee = "";

before(async () => {
  await loadCitationFormatter();
  apa = await loadCslStyle("apa");
  ieee = await loadCslStyle("ieee");
});

function format(style: string, raws: string[], format?: "html" | "text") {
  const citations = cites(...raws);
  return formatCitations({ citations, entries: citationEntriesForDocument(LIBRARY, citations.flatMap((citation) => citation.items.map((item) => item.key))), style, format });
}

test("loadCslStyle returns bundled styles, custom XML as is, and the default for anything else", async () => {
  for (const { id } of BUNDLED_CSL_STYLES) {
    const xml = await loadCslStyle(id);
    assert.equal(xml, BUNDLED_CSL_STYLE_XML[id]);
    assert.match(xml, /<citation[\s>]/, id);
    assert.doesNotMatch(xml, /rel="independent-parent"/, `${id} must be an independent style`);
    assert.match(xml, /creativecommons\.org\/licenses\/by-sa\/3\.0/, id);
  }
  assert.match(await loadCslStyle("vancouver"), /<id>http:\/\/www\.zotero\.org\/styles\/nlm-citation-sequence<\/id>/);
  const custom = "<?xml version=\"1.0\"?><style xmlns=\"http://purl.org/net/xbiblio/csl\"></style>";
  assert.equal(await loadCslStyle(custom), custom);
  assert.equal(await loadCslStyle("no-such-style"), BUNDLED_CSL_STYLE_XML.apa);
  assert.equal(await loadCslStyle(""), BUNDLED_CSL_STYLE_XML.apa);
  assert.equal(await loadCslStyle("Notebook/styles/custom.csl"), BUNDLED_CSL_STYLE_XML.apa);
});

test("author-date: locators and labels, prefixes, suffixes and suppressed authors", () => {
  const result = format(apa, [
    "[@lee2019graphs, p. 12]",
    "[see @lee2019graphs, ch. 3]",
    "[@lee2019graphs, pp. 33-35, emphasis added]",
    "[-@lee2019graphs]",
    "[@lee2019graphs, fig. 2]",
  ]);
  assert.deepEqual(result.citations, [
    "(Lee, 2019, p. 12)",
    "(see Lee, 2019, Chapter 3)",
    "(Lee, 2019, pp. 33–35, emphasis added)",
    "(2019)",
    "(Lee, 2019, Figure 2)",
  ]);
  assert.deepEqual(result.unresolvedKeys, []);
});

test("author-date styles disambiguate the same author and year as 2020a and 2020b", () => {
  const result = format(apa, ["[@smith2020sparse]", "[@smith2020dense]", "[@smith2020sparse; @lee2019graphs]"]);
  assert.deepEqual(result.citations, ["(Smith, 2020b)", "(Smith, 2020a)", "(Lee, 2019; Smith, 2020b)"]);
  assert.match(result.bibliography, /Smith, J\. \(2020a\)\. Dense attention/);
  assert.match(result.bibliography, /Smith, J\. \(2020b\)\. Sparse attention/);
  const chicago = BUNDLED_CSL_STYLE_XML["chicago-author-date"];
  assert.deepEqual(format(chicago, ["[@smith2020sparse, 4]", "[@smith2020dense]"]).citations, ["(Smith 2020b, 4)", "(Smith 2020a)"]);
});

test("numeric styles number works by first appearance, and the bibliography follows", () => {
  const result = formatCitationDocument({
    citations: cites("[@lee2019graphs]", "[@smith2020sparse, p. 4]", "[@lee2019graphs; @smith2020dense]"),
    entries: citationEntriesForDocument(LIBRARY, ["lee2019graphs", "smith2020sparse", "smith2020dense"]),
    style: ieee,
  });
  assert.deepEqual(result.citations, ["[1]", "[2, p. 4]", "[1], [3]"]);
  const order = [...result.bibliography.matchAll(/csl-left-margin">\[(\d)\]<\/div><div class="csl-right-inline">([^,]+)/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(order, [["1", "A. Lee"], ["2", "J. Smith"], ["3", "J. Smith"]]);
  assert.match(result.bibliographyEntries[lee.id], /Graphs/);
  assert.equal(Object.keys(result.bibliographyEntries).length, 3);

  const nature = format(BUNDLED_CSL_STYLE_XML.nature, ["[@smith2020dense]", "[@lee2019graphs]"]);
  assert.deepEqual(nature.citations, ["<sup>1</sup>", "<sup>2</sup>"]);
  const vancouver = format(BUNDLED_CSL_STYLE_XML.vancouver, ["[@smith2020dense]", "[@lee2019graphs; @smith2020dense]"]);
  assert.deepEqual(vancouver.citations, ["(1)", "(1,2)"]);
  const harvard = format(BUNDLED_CSL_STYLE_XML["harvard-cite-them-right"], ["[@lee2019graphs, p. 3]"]);
  assert.deepEqual(harvard.citations, ["(Lee, 2019, p. 3)"]);
});

test("unresolved keys never reach citeproc: @key? inside a citation, the raw token alone, and listed", () => {
  const result = format(apa, ["[@lee2019graphs; @nope]", "[@missing, p. 3]", "[@a&b]", "[@lee2019graphs]"]);
  assert.deepEqual(result.citations, [
    '(Lee, 2019; <span class="csl-unresolved">@nope?</span>)',
    "[@missing, p. 3]",
    "[@a&amp;b]",
    "(Lee, 2019)",
  ]);
  assert.deepEqual(result.unresolvedKeys, ["nope", "missing", "a&b"]);
  // The bibliography lists cited, resolved entries only.
  assert.match(result.bibliography, /Graphs/);
  assert.doesNotMatch(result.bibliography, /Never cited|Sparse|nope|missing/);
  assert.equal((result.bibliography.match(/csl-entry/g) ?? []).length, 1);

  const numeric = format(ieee, ["[@lee2019graphs; @nope]"]);
  assert.deepEqual(numeric.citations, ['[1], <span class="csl-unresolved">@nope?</span>']);
  const text = format(apa, ["[@lee2019graphs; @nope]", "[@missing]"], "text");
  assert.deepEqual(text.citations, ["(Lee, 2019; @nope?)", "[@missing]"]);
  assert.doesNotMatch(text.bibliography, /</);

  const nothing = format(apa, ["[@missing]"]);
  assert.deepEqual(nothing, { citations: ["[@missing]"], bibliography: "", unresolvedKeys: ["missing"] });
});

test("aliases resolve to their entry, which is one work wherever it is cited", () => {
  const byKey = libraryEntriesByKey(LIBRARY);
  assert.equal(byKey.smith2020old, smithA);
  assert.equal(byKey.smith2020sparse, smithA);
  assert.equal(byKey.constructor, undefined);
  const cited = citationEntriesForDocument(LIBRARY, ["smith2020old", "nope"]);
  assert.deepEqual(Object.keys(cited).sort(), ["smith2020old", "smith2020sparse"]);
  const result = format(ieee, ["[@smith2020old]", "[@smith2020sparse]", "[@smith2020old; @smith2020sparse]"]);
  assert.deepEqual(result.citations, ["[1]", "[1]", "[1]"]);
  assert.deepEqual(result.unresolvedKeys, []);
  // A key wins over another entry's alias.
  const shadow = entry("ref_9", "shadow", { title: "Shadow" }, { aliases: ["lee2019graphs"] });
  assert.equal(libraryEntriesByKey(library(lee, shadow)).lee2019graphs, lee);
  // Keys that are Object.prototype names do not resolve by accident.
  assert.deepEqual(formatCitations({ citations: cites("[@constructor]", "[@__proto__]"), entries: {}, style: apa }).unresolvedKeys, ["constructor", "__proto__"]);
});

test("citeproc output is sanitized: script, event handlers and javascript: URLs come out inert", () => {
  const hostile = entry("ref_x", "evil2024", {
    title: "<script>alert(1)</script><img src=x onerror=alert(2)> <i onmouseover=\"alert(3)\">Italic</i>",
    author: [{ family: "Evil<b onclick=alert(4)>", given: "Eve" }],
    issued: { "date-parts": [[2024]] },
    URL: "javascript:alert(5)",
    "container-title": "<a href=\"javascript:alert(6)\">Journal</a>",
  });
  for (const style of [apa, ieee]) {
    const result = formatCitationDocument({ citations: cites("[@evil2024]"), entries: { evil2024: hostile }, style });
    for (const html of [...result.citations, result.bibliography, ...Object.values(result.bibliographyEntries)]) {
      // Hostile markup survives only as escaped text, never as tags or attributes.
      for (const [tag] of html.matchAll(/<[^>]+>/g)) assert.doesNotMatch(tag, /^<\/?(?:script|img|a)|\son\w+=|javascript:/i, tag);
      // What remains of the markup is only the allowlist.
      for (const [, tag] of html.matchAll(/<\/?([a-z0-9]+)/gi)) assert.ok(["i", "b", "em", "strong", "sup", "sub", "span", "div"].includes(tag), tag);
    }
  }

  assert.equal(sanitizeCitationHtmlString('<script>alert(1)</script>ok'), "ok");
  assert.equal(sanitizeCitationHtmlString('<img src=x onerror="alert(1)">x'), "x");
  assert.equal(sanitizeCitationHtmlString('<a href="javascript:alert(1)">link</a>'), "link");
  assert.equal(sanitizeCitationHtmlString('<a href=" JavaScript:alert(1)" onclick="x">link</a>'), "link");
  assert.equal(sanitizeCitationHtmlString('<a href="https://doi.org/10.1/x" onclick="x">doi</a>'), '<a href="https://doi.org/10.1/x" rel="noopener noreferrer" target="_blank">doi</a>');
  assert.equal(sanitizeCitationHtmlString('<i onclick="x">a</i><b style="color:red">b</b><sup>c</sup><sub>d</sub><em>e</em><strong>f</strong>'), "<i>a</i><b>b</b><sup>c</sup><sub>d</sub><em>e</em><strong>f</strong>");
  assert.equal(sanitizeCitationHtmlString('<span class="nocase evil">A</span><span style="font-variant:small-caps;">B</span><span style="background:url(x)">C</span>'), '<span class="nocase">A</span><span style="font-variant:small-caps">B</span>C');
  assert.equal(sanitizeCitationHtmlString('<div class="csl-entry other" id="x"><div class="csl-left-margin">[1]</div></div><div class="x">y</div>'), '<div class="csl-entry"><div class="csl-left-margin">[1]</div></div>y');
  assert.equal(sanitizeCitationHtmlString('<p>para</p><iframe src="x">frame</iframe><style>body{}</style>&lt;b&gt; &#38; &amp;'), "para&lt;b&gt; &amp; &amp;");
  assert.equal(sanitizeCitationHtmlString("a < b <notatag and <!-- c --> d"), "a &lt; b &lt;notatag and  d");
  assert.equal(citationHtmlToText('<i>Title</i> &#38; <span class="csl-unresolved">@x?</span>'), "Title & @x?");
  const tree = sanitizeCitationHtml('<svg onload="alert(1)"><script>1</script></svg><span onclick="x">t</span>');
  assert.deepEqual(tree.children, [{ type: "text", value: "t" }]);
});

test("formatting is cached by citations, cited entries and style, and follows entry changes", () => {
  const citations = cites("[@smith2020sparse]", "[@lee2019graphs, p. 2]");
  const entries = citationEntriesForDocument(LIBRARY, ["smith2020sparse", "lee2019graphs"]);
  const first = formatCitationDocument({ citations, entries, style: apa });
  // A re-render passes equal but new arrays: no citeproc work, the same result.
  const again = formatCitationDocument({ citations: cites("[@smith2020sparse]", "[@lee2019graphs, p. 2]"), entries: { ...entries }, style: apa });
  assert.equal(again, first);
  assert.notEqual(formatCitationDocument({ citations, entries, style: ieee }), first);
  assert.notEqual(formatCitationDocument({ citations: citations.slice(0, 1), entries, style: apa }), first);

  // After an entry changes, its engine is rebuilt: no stale disambiguation.
  const twoSmiths = citationEntriesForDocument(LIBRARY, ["smith2020sparse", "smith2020dense"]);
  assert.deepEqual(formatCitations({ citations: cites("[@smith2020sparse]", "[@smith2020dense]"), entries: twoSmiths, style: apa }).citations, ["(Smith, 2020b)", "(Smith, 2020a)"]);
  const moved = { ...smithA, csl: { ...smithA.csl, issued: { "date-parts": [[2021]] as Array<[number]> } } };
  const changed = formatCitations({ citations: cites("[@smith2020sparse]", "[@smith2020dense]"), entries: { smith2020sparse: moved, smith2020dense: smithB }, style: apa });
  assert.deepEqual(changed.citations, ["(Smith, 2021)", "(Smith, 2020)"]);
});

test("a 300-citation document: timings are logged, and re-renders with the same citations are free", () => {
  const families = ["Smith", "Lee", "Garcia", "Nguyen", "Kim", "Brown", "Müller", "Rossi", "Tanaka", "Ivanov", "Chen", "Wang", "Patel", "Cohen", "Dubois"];
  const entries: Record<string, ReferenceEntry> = {};
  for (let index = 0; index < 80; index += 1) {
    const key = `work${index}`;
    entries[key] = entry(`ref_w${index}`, key, {
      title: `A study of topic ${index}`,
      author: [{ family: `${families[index % 15]}${index >= 15 ? String.fromCharCode(65 + Math.floor(index / 15)) : ""}`, given: "J." }],
      issued: { "date-parts": [[1990 + (index % 30)]] },
      "container-title": "Journal", volume: "3", page: "1-10",
    });
  }
  const citations = Array.from({ length: 300 }, (_, index) => parseCitationToken(index % 3 ? `[@work${(index * 7) % 80}, p. ${index}]` : `[@work${(index * 7) % 80}; @work${(index * 11) % 80}]`)!);
  const timings: Record<string, number> = {};
  for (const [name, style] of [["apa", apa], ["ieee", ieee]] as const) {
    let start = performance.now();
    const result = formatCitationDocument({ citations, entries, style });
    timings[`${name} first`] = Math.round(performance.now() - start);
    assert.equal(result.citations.length, 300);
    start = performance.now();
    const cached = formatCitationDocument({ citations: [...citations], entries: { ...entries }, style });
    timings[`${name} cached`] = Math.round(performance.now() - start);
    assert.equal(cached, result);
    assert.ok(timings[`${name} cached`] < 50, `${name} cached formatting took ${timings[`${name} cached`]} ms`);
    // An edit to one citation reformats with the warm engine.
    const edited = citations.map((citation, index) => index === 150 ? parseCitationToken("[@work1, p. 999]")! : citation);
    start = performance.now();
    formatCitationDocument({ citations: edited, entries, style });
    timings[`${name} edit`] = Math.round(performance.now() - start);
  }
  console.log(`300-citation document (ms): ${JSON.stringify(timings)}`);
});
