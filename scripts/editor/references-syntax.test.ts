import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { markdownRemarkPlugins } from "../../src/lib/markdown-rendering";
import { remarkMathMarkers } from "../../src/lib/remark-math-markers";
import { remarkCitations } from "../../src/lib/remark-citations";
import {
  CITATION_SYNTAX_CASES,
  citationAt,
  citationTriggerAt,
  citedKeys,
  narrativeCitationAt,
  parseAnyCitation,
  parseCitationToken,
  parseNarrativeCitation,
  resolvedCitationOccurrences,
  rewriteCitationKeys,
  scanCitations,
  serializeCitation,
} from "../../src/lib/references/citation-syntax";
import type { MathMarkerSettings } from "../../src/lib/math-markers";
import type { Citation } from "../../src/lib/references/types";

type TreeNode = {
  type: string;
  value?: string;
  citation?: Citation;
  data?: { hName?: string; hProperties?: Record<string, string> };
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: TreeNode[];
};

function appProcessor(mathMarkers: MathMarkerSettings = {}) {
  return unified().use(remarkParse).use(markdownRemarkPlugins(mathMarkers)).use(remarkCitations);
}

function citationNodes(tree: TreeNode): TreeNode[] {
  return [...(tree.type === "liberaCitation" ? [tree] : []), ...(tree.children ?? []).flatMap(citationNodes)];
}

function remarkOccurrences(source: string, processor = appProcessor()) {
  const tree = processor.runSync(processor.parse(source)) as unknown as TreeNode;
  return citationNodes(tree).map((node) => ({
    citation: node.citation!, start: node.position!.start.offset!, end: node.position!.end.offset!,
  }));
}

function scanned(source: string, mathMarkers?: MathMarkerSettings) {
  return scanCitations(source, mathMarkers ? { mathMarkers } : undefined);
}

test("the shared case table covers the grammar and the scanner matches it", () => {
  assert.ok(CITATION_SYNTAX_CASES.length >= 60);
  assert.equal(new Set(CITATION_SYNTAX_CASES.map((entry) => entry.name)).size, CITATION_SYNTAX_CASES.length);
  for (const { name, source, expected } of CITATION_SYNTAX_CASES) {
    const occurrences = scanCitations(source);
    assert.deepEqual(occurrences.map(({ citation }) => ({ raw: citation.raw, items: citation.items, ...(citation.narrative ? { narrative: true } : {}) })), expected, name);
    for (const { citation, start, end } of occurrences) assert.equal(source.slice(start, end), citation.raw, name);
  }
});

test("remark-citations in the app pipeline finds the same citations at the same offsets as scanCitations", () => {
  for (const { name, source } of CITATION_SYNTAX_CASES) {
    assert.deepEqual(remarkOccurrences(source), scanned(source), name);
  }
});

test("remark-citations agrees with remark-gfm alone and with custom math markers", () => {
  const plain = unified().use(remarkParse).use(remarkGfm).use(remarkCitations);
  for (const { name, source } of CITATION_SYNTAX_CASES) {
    if (/[$\\]/.test(source)) continue; // math markers are not in this pipeline
    assert.deepEqual(remarkOccurrences(source, plain), scanned(source), name);
  }
  const markers = { inlineMathMarkers: "@@ @@\n$ $", blockMathMarkers: "%% %%" };
  const withMarkers = unified().use(remarkParse).use(remarkGfm).use(remarkMathMarkers, markers).use(remarkCitations);
  for (const source of [
    "@@[@x]@@ [@y]", "%%\n[@x]\n%%\n\n[@y]", "\\([@a]\\) [@b]", "%%\n[@x]\n%% trailing\n[@y]", "$[@x]$ @@ [@y]",
  ]) {
    assert.deepEqual(remarkOccurrences(source, withMarkers), scanned(source, markers), source);
    assert.deepEqual(remarkOccurrences(source, appProcessor(markers)), scanned(source, markers), source);
  }
  assert.deepEqual(scanned("@@[@x]@@ [@y]", markers).map((entry) => entry.citation.raw), ["[@y]"]);
  assert.deepEqual(scanned("\\([@a]\\) [@b]", markers).map((entry) => entry.citation.raw), ["[@a]", "[@b]"]);
});

// A deterministic stand-in for the randomized differential testing used while
// building the scanner: random concatenations of tricky fragments.
test("random Markdown fragments parse identically in the scanner and in micromark", () => {
  const fragments = [
    "[@a]", "[see @b, p. 3]", "[-@c]", "[@d; @e]", "[", "]", "(", ")", "(url)", "![", "\\", "\\[", "\\]", "`", "``", "$", "$$", "\\(", "\\)",
    "<", "<b>", "<!--", "-->", "<http://x.y>", " ", "\n", "\n\n", "\t", "> ", "y> ", "- ", "1. ", "2. ", "    ", "```", "~~~", "# ", "---",
    "|", "\n| a | b |\n| - | - |\n", "me@x.com", "www.a.b", "https://x.com/", "[ref]: /u", "[@a]: /u", "[^1]: ", "[x](", "[[@g]]",
    "[a [@h] b]", "[@j]\n(", "<div>", "\\[\n", "\n\\]", "[see\n@a]", "[@a\nb]", "*", "{", "p.", "12", "word",
    // Narrative citations
    "@a", " @b", "@c [p. 3]", "@d[ch. 2]", " [p. 4]", "@", "@e.", "x@y", "(@f)", "@g [x]", "@h [p. 5](u)", "\t", "@i [p.\t6]", "\\@j",
    "@k ", "[p. 7]", "@黄", "@l\\[", "_@m_", "@n<b>", "@o$p$",
  ];
  let seed = 20261018;
  const random = (size: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % size;
  };
  for (let run = 0; run < 400; run += 1) {
    let source = "";
    for (let count = 1 + random(16); count > 0; count -= 1) source += fragments[random(fragments.length)];
    assert.deepEqual(remarkOccurrences(source), scanned(source), JSON.stringify(source));
  }
});

test("citation nodes carry the citation, hast data and exact source positions", () => {
  const source = "> Shown [see\n> @a, p. 12; -@b].\n\nAnd [@c].";
  const processor = appProcessor();
  const tree = processor.runSync(processor.parse(source)) as unknown as TreeNode;
  const [first, second] = citationNodes(tree);
  assert.equal(first.citation!.raw, "[see\n> @a, p. 12; -@b]");
  assert.deepEqual(first.citation!.items, [{ key: "a", prefix: "see", label: "page", locator: "12" }, { key: "b", suppressAuthor: true }]);
  assert.equal(source.slice(first.position!.start.offset, first.position!.end.offset), first.citation!.raw);
  assert.equal(first.data!.hName, "libera-cite");
  assert.deepEqual(JSON.parse(first.data!.hProperties!["data-citation"]), first.citation);
  assert.equal(first.value, first.citation!.raw);
  assert.equal(second.citation!.raw, "[@c]");
  assert.equal(second.position!.start.offset, source.indexOf("[@c]"));
  // A demoted citation in link text becomes plain text, merged with its neighbours.
  const linked = processor.runSync(processor.parse("[see [@x] here](https://example.com)")) as unknown as TreeNode;
  const link = linked.children![0].children![0];
  assert.equal(link.type, "link");
  assert.deepEqual(link.children!.map((child) => [child.type, child.value]), [["text", "see [@x] here"]]);
});

test("links, images, references and footnotes parse exactly as before when nothing is a citation", () => {
  const sources = [
    "[link](https://example.com) and ![image](a.png \"title\")",
    "[ref] and [full][ref] and [collapsed][] and [ref][]\n\n[ref]: https://example.com\n[collapsed]: /c",
    "[x][@ref] and [@ref][]\n\n[@ref]: https://example.com", // reference labels and definitions are not citations
    "Text[^note] and [^other].\n\n[^note]: A footnote.\n[^other]: Another.",
    "[a [nested] label](u) ![a [b] c](i.png) [x](<a b> 'c')",
    "[@x](https://example.com) ![@y](y.png) [@z][ref]\n\n[ref]: /r",
    "<https://example.com> www.example.com https://example.com/a_(b) me@example.com",
    "- [ ] task\n- [x] done [link](u)",
  ];
  const without = unified().use(remarkParse).use(markdownRemarkPlugins({}));
  for (const source of sources) {
    const expected = without.runSync(without.parse(source));
    const actual = appProcessor().runSync(appProcessor().parse(source));
    assert.deepEqual(actual, expected, source);
  }
});

test("parseCitationToken parses one complete token", () => {
  assert.deepEqual(parseCitationToken("[see @a, p. 12]"), { items: [{ key: "a", prefix: "see", label: "page", locator: "12" }], raw: "[see @a, p. 12]" });
  assert.deepEqual(parseCitationToken("[@a; -@b, ch. 3, emphasis added]")?.items, [
    { key: "a" }, { key: "b", suppressAuthor: true, label: "chapter", locator: "3", suffix: "emphasis added" },
  ]);
  for (const raw of ["@a", "[@a", "[@a] ", " [@a]", "[@a][@b]", "[see]", "[@a and @b]", "[\\@a]", "[@a\n\n]", "[a\nb\nc @d]", `[@a, ${"x".repeat(2000)}]`, "[@a]]"]) {
    assert.equal(parseCitationToken(raw), null, raw);
  }
});

test("serializeCitation writes the canonical form and round-trips every case", () => {
  assert.equal(serializeCitation(parseCitationToken("[see   @a,p.12]")!), "[see @a, p. 12]");
  assert.equal(serializeCitation(parseCitationToken("[@a, 12-14]")!), "[@a, pp. 12-14]");
  assert.equal(serializeCitation(parseCitationToken("[@a, pages 3, 5]")!), "[@a, pp. 3, 5]");
  assert.equal(serializeCitation(parseCitationToken("[@a, Chapter 3, my emphasis]")!), "[@a, ch. 3 my emphasis]");
  assert.equal(serializeCitation(parseCitationToken("[@a, emphasis added]")!), "[@a, emphasis added]");
  assert.equal(serializeCitation(parseCitationToken("[-@a;see @b]")!), "[-@a; see @b]");
  assert.equal(serializeCitation({ items: [{ key: "a", label: "canon", locator: "5" }] }), "[@a, canon 5]");
  assert.equal(serializeCitation({ items: [{ key: "a", label: "timestamp", locator: "1:02:03" }] }), "[@a, timestamp 1:02:03]");
  assert.equal(serializeCitation({ items: [{ key: "a", locator: "A.3" }] }), "[@a, p. {A.3}]");
  assert.equal(serializeCitation({ items: [{ key: "a", label: "sub-verbo", locator: "sparse" }] }), "[@a, s.v. {sparse}]");
  const labels = ["act", "appendix", "article-locator", "book", "canon", "chapter", "column", "elocation", "equation", "figure", "folio", "issue",
    "line", "note", "opus", "page", "paragraph", "part", "rule", "scene", "section", "sub-verbo", "supplement", "table", "timestamp", "title-locator",
    "verse", "volume"] as const;
  for (const label of labels) {
    const citation = { items: [{ key: "k", prefix: "see", label, locator: "4-5", suffix: "and passim" }] };
    assert.deepEqual(parseCitationToken(serializeCitation(citation))?.items, citation.items, label);
  }
  for (const { name, source } of CITATION_SYNTAX_CASES) {
    for (const { citation } of scanCitations(source)) {
      const text = serializeCitation(citation);
      assert.deepEqual(parseAnyCitation(text)?.items, citation.items, `${name}: ${text}`);
      assert.equal(Boolean(parseAnyCitation(text)?.narrative), Boolean(citation.narrative), `${name}: ${text}`);
    }
  }
});

test("narrative tokens: parse, serialize, and fall back to brackets when the form cannot hold an item", () => {
  assert.deepEqual(parseNarrativeCitation("@smith2020"), { items: [{ key: "smith2020" }], raw: "@smith2020", narrative: true });
  assert.deepEqual(parseNarrativeCitation("@a [p. 33, emphasis added]")?.items, [{ key: "a", label: "page", locator: "33", suffix: "emphasis added" }]);
  for (const raw of ["@a.", "@a [the user]", " @a", "x@a", "@a [p. 3](u)", "@a  [p. 3]", "[@a]", "@a [p. 3", "@"]) {
    assert.equal(parseNarrativeCitation(raw), null, raw);
  }
  assert.equal(parseAnyCitation("[@a]")?.narrative, undefined);
  assert.equal(parseAnyCitation("@a")?.narrative, true);
  assert.equal(serializeCitation({ items: [{ key: "a" }], narrative: true }), "@a");
  assert.equal(serializeCitation({ items: [{ key: "a", label: "chapter", locator: "3", suffix: "and passim" }], narrative: true }), "@a [ch. 3 and passim]");
  // Not representable as narrative: written bracketed, nothing lost.
  assert.equal(serializeCitation({ items: [{ key: "a", prefix: "see" }], narrative: true }), "[see @a]");
  assert.equal(serializeCitation({ items: [{ key: "a", suppressAuthor: true }], narrative: true }), "[-@a]");
  assert.equal(serializeCitation({ items: [{ key: "a", suffix: "emphasis added" }], narrative: true }), "[@a, emphasis added]");
  assert.equal(serializeCitation({ items: [{ key: "a" }, { key: "b" }], narrative: true }), "[@a; @b]");
  assert.equal(serializeCitation({ items: [{ key: "a", locator: "3", suffix: "see [x]" }], narrative: true }), "[@a, p. 3 see [x]]");
  assert.equal(serializeCitation({ items: [{ key: "a", locator: "3", suffix: "per @b" }], narrative: true }), "[@a, p. 3 per @b]");
  assert.deepEqual(narrativeCitationAt("x @a", 2), { end: 4, key: [3, 4], item: { key: "a" } });
  assert.equal(narrativeCitationAt("x@a", 1), null);
  assert.deepEqual(narrativeCitationAt("@a", 0, "("), { end: 2, key: [1, 2], item: { key: "a" } });
  assert.equal(narrativeCitationAt("@a", 0, "*"), null);
});

test("narrative occurrences: offsets, citedKeys and the resolved filter", () => {
  const source = "@a [p. 3] and [@b] and @alice, then @a again. me@x.com";
  const found = scanCitations(source);
  assert.deepEqual(found.map(({ citation, start, end }) => [citation.raw, citation.narrative ?? false, source.slice(start, end)]), [
    ["@a [p. 3]", true, "@a [p. 3]"], ["[@b]", false, "[@b]"], ["@alice", true, "@alice"], ["@a", true, "@a"],
  ]);
  const library = new Set(["a", "b"]);
  const resolves = (key: string) => library.has(key);
  assert.deepEqual(citedKeys(source), ["b"]);
  assert.deepEqual(citedKeys(source, { resolves }), ["a", "b"]);
  assert.deepEqual(citedKeys(source, { allNarrative: true }), ["a", "b", "alice"]);
  assert.deepEqual(resolvedCitationOccurrences(found, resolves).map(({ citation }) => citation.raw), ["@a [p. 3]", "[@b]", "@a"]);
  assert.deepEqual(resolvedCitationOccurrences(found).map(({ citation }) => citation.raw), ["[@b]"]);
  assert.equal(citationAt(source, 1)?.citation.narrative, true);
  assert.equal(citationAt(source, source.indexOf("@alice") + 3)?.citation.raw, "@alice");
  // The trigger: a narrative candidate is not "inside a citation".
  assert.deepEqual(citationTriggerAt("See @smi", 8), { from: 4, query: "smi", insideCitation: false });
});

test("citationTriggerAt fires for @ at a word start outside code, math and links", () => {
  // The last "|" marks the caret.
  const at = (text: string) => {
    const caret = text.lastIndexOf("|");
    return citationTriggerAt(text.slice(0, caret) + text.slice(caret + 1), caret);
  };
  assert.deepEqual(at("See @|"), { from: 4, query: "", insideCitation: false });
  assert.deepEqual(at("@smi|"), { from: 0, query: "smi", insideCitation: false });
  assert.deepEqual(at("line\n@doe:20|"), { from: 5, query: "doe:20", insideCitation: false });
  assert.deepEqual(at("(@a|"), { from: 1, query: "a", insideCitation: false });
  assert.deepEqual(at("[@sm|"), { from: 1, query: "sm", insideCitation: true });
  assert.deepEqual(at("[see @|"), { from: 5, query: "", insideCitation: true });
  assert.deepEqual(at("[see @a; @|"), { from: 9, query: "", insideCitation: true });
  assert.deepEqual(at("[see @a;@b|"), { from: 8, query: "b", insideCitation: true });
  assert.deepEqual(at("[-@x|"), { from: 2, query: "x", insideCitation: true });
  assert.deepEqual(at("text -@x|"), { from: 6, query: "x", insideCitation: false });
  assert.deepEqual(at("[@a, p. 3; @|] more"), { from: 11, query: "", insideCitation: true });
  assert.deepEqual(at("Done [@a]. Then @b|"), { from: 16, query: "b", insideCitation: false });
  assert.deepEqual(at("[@a and @|"), { from: 8, query: "", insideCitation: false });
  assert.deepEqual(at("[link](u) @|"), { from: 10, query: "", insideCitation: false });
  assert.deepEqual(at("> [see\n> @|"), { from: 9, query: "", insideCitation: true });
  assert.deepEqual(at("| [@a|"), { from: 3, query: "a", insideCitation: true });
  assert.deepEqual(at("- @m\u00fc|"), { from: 2, query: "m\u00fc", insideCitation: false });
  for (const text of [
    "me@exa|", "x@|", "a1@|", "`@a|`", "```\n@a|\n```", "$x @a|$", "[x](<a @b|>)", "[x](u \"see @a|\")", "---\ntitle: @a|\n---\n", "\\@a|", "<!-- @a| -->",
    "    @a|", "a-@b|", "[x](<@a|>)",
  ]) {
    assert.equal(at(text), null, text);
  }
});

test("rewriteCitationKeys changes keys only inside citation tokens and keeps every other byte", () => {
  const source = "See [see  @old,  p. 3; -@other] and [@old].\n\n`[@old]` @old me@old.com [@old](u) [@older]\n\n> [x\n> @old]\n";
  const { text, count } = rewriteCitationKeys(source, new Map([["old", "new2024"], ["other", "other"]]));
  // A narrative `@old` is rewritten too; one inside link text, code or a word is not.
  assert.equal(count, 4);
  assert.equal(text, "See [see  @new2024,  p. 3; -@other] and [@new2024].\n\n`[@old]` @new2024 me@old.com [@old](u) [@older]\n\n> [x\n> @new2024]\n");
  assert.deepEqual(rewriteCitationKeys("@old [p. 3] and (@old).", new Map([["old", "n"]])), { text: "@n [p. 3] and (@n).", count: 2 });
  assert.deepEqual(rewriteCitationKeys(source, new Map()), { text: source, count: 0 });
});

test("citedKeys and citationAt", () => {
  const source = "[@b; @a] text [@b, p. 2] `[@c]` [@d]";
  assert.deepEqual(citedKeys(source), ["b", "a", "d"]);
  assert.equal(citationAt(source, 0)?.citation.raw, "[@b; @a]");
  assert.equal(citationAt(source, 7)?.citation.raw, "[@b; @a]");
  assert.equal(citationAt(source, 8), null);
  assert.equal(citationAt(source, source.indexOf("[@b, p. 2]") + 3)?.start, source.indexOf("[@b, p. 2]"));
  assert.equal(citationAt(source, source.indexOf("[@c]") + 1), null);
  assert.equal(citationAt(source, source.length - 1)?.citation.raw, "[@d]");
});

test("scanning a 1 MB document is fast", () => {
  const block = [
    "## Section with [@heading2020]", "",
    "Paragraph text citing [see @smith2020sparse, pp. 12–14; -@lee2021] and `code [@x]` with $x^2$ math, a [link](https://example.com/a) and me@example.com.",
    "> Quoted [@quote2019, ch. 3] with \\[escaped] brackets and **bold** text.", "",
    "- item [@item1]", "  - nested [@item2, fig. 3]", "",
    "| A | B |", "| --- | --- |", "| [@cell] | text |", "",
    "```js", "const a = '[@notacitation]';", "```", "",
    "Unclosed [bracket and (paren and `tick and $dollar.", "",
  ].join("\n");
  let source = "";
  let blocks = 0;
  for (; source.length < 1_000_000; blocks += 1) source += `${block}\n`;
  // Best of three, each on a fresh string (results are cached per source), so
  // JIT warm-up and other processes on the machine do not decide the result.
  const timed = (text: string) => {
    let best = Infinity;
    let result: ReturnType<typeof scanCitations> = [];
    for (let run = 0; run < 3; run += 1) {
      const variant = `${text}${" ".repeat(run + 1)}`;
      const started = performance.now();
      result = scanCitations(variant);
      best = Math.min(best, performance.now() - started);
    }
    return { best, result };
  };
  const { best, result } = timed(source);
  assert.equal(result.length, blocks * 6);
  // About 90 ms on an idle laptop. The cap is loose so a loaded machine (the
  // full suite runs files in parallel) does not fail it; quadratic behaviour
  // would take many seconds.
  assert.ok(best < 2000, `took ${best.toFixed(1)} ms`);
  // Pathological input stays linear: 4x the input may not cost much more than 4x the time.
  for (const unit of ["[", "`", "$", "\\(", "<!--", "[@a, ", "[a](", "*_[", "\\[\n", "> - ", "www."]) {
    const small = timed(unit.repeat(Math.ceil(25_000 / unit.length))).best;
    const large = timed(unit.repeat(Math.ceil(100_000 / unit.length))).best;
    assert.ok(large < 2000, `${unit}: ${large.toFixed(1)} ms`);
    assert.ok(large < Math.max(small, 2) * 12, `${unit}: ${small.toFixed(1)} ms → ${large.toFixed(1)} ms`);
  }
});
