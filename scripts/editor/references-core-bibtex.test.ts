import assert from "node:assert/strict";
import test from "node:test";
import { parseBibtex, serializeBibtex, type BibtexSerializableEntry } from "../../src/lib/references/bibtex";
import type { ReferenceParseResult } from "../../src/lib/references/normalize";

const AT = "2026-01-01T00:00:00.000Z";
const NOCASE = (text: string) => `<span class="nocase">${text}</span>`;

function parse(text: string) {
  return parseBibtex(text, { retrievedAt: AT });
}

function only(text: string) {
  const result = parse(text);
  assert.equal(result.entries.length, 1, JSON.stringify(result.errors));
  return result.entries[0].input;
}

function asEntries(result: ReferenceParseResult): BibtexSerializableEntry[] {
  return result.entries.map(({ input, sourceKey }) => ({ key: input.key ?? sourceKey, csl: input.csl, identifiers: input.identifiers, tags: input.tags }));
}

const TRICKY = String.raw`% A comment line before anything, with an email: someone@example.org
@string{ieee = "IEEE Transactions on "}
@STRING(pami = ieee # {Pattern Analysis})
@preamble{"\newcommand{\noopsort}[1]{}"}
@comment{ @article{commented, title = {Not an entry}} }

Free text between entries is ignored.

@Article{Smith:2020/a-b,
  author    = {Smith, John and van der Waals, J. D. and {World Health Organization} and others},
  title     = {The {DNA} of Caf\'e {\"O}sterreich: {Bayesian} \emph{in vivo} {$\alpha$}-Analysis of 50% A & B},
  journal   = pami # { and Machine Intelligence},
  year      = 2020,
  month     = mar,
  volume    = "42",
  number    = {3},
  pages     = {101--115},
  doi       = {https://doi.org/10.1109/TPAMI.2020.123},
  url       = {https://example.org/paper\_1?x=1&y=2},
  keywords  = {vision; learning, Vision},
  abstract  = {We study {\it things} with \textbf{bold} claims.},
  note      = {Extended version},
  issn      = {0162-8828},
  language  = {English},
}
`;

test("parses a tricky BibTeX file: macros, concatenation, comments, accents, stray characters", () => {
  const result = parse(TRICKY);
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries.length, 1);
  const [{ input, sourceKey, line }] = result.entries;
  assert.equal(sourceKey, "Smith:2020/a-b");
  assert.equal(input.key, "Smith:2020/a-b");
  assert.equal(line, 9);
  assert.deepEqual(input.csl, {
    type: "article-journal",
    title: `The DNA of Café Österreich: ${NOCASE("Bayesian")} <i>in vivo</i> $\\alpha$-Analysis of 50% A & B`,
    "container-title": "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    author: [
      { family: "Smith", given: "John" },
      { family: "Waals", given: "J. D.", "non-dropping-particle": "van der" },
      { literal: "World Health Organization" },
    ],
    issued: { "date-parts": [[2020, 3]] },
    volume: "42",
    issue: "3",
    page: "101–115",
    language: "English",
    abstract: "We study <i>things</i> with <b>bold</b> claims.",
    note: "Extended version",
    DOI: "10.1109/tpami.2020.123",
    URL: "https://example.org/paper_1?x=1&y=2",
    ISSN: "0162-8828",
  });
  assert.deepEqual(input.identifiers, { doi: "10.1109/tpami.2020.123" });
  assert.deepEqual(input.tags, ["vision", "learning"]);
  for (const field of Object.keys(input.csl)) assert.deepEqual(input.provenance?.[field], { source: "import", confidence: 0.8, retrievedAt: AT }, field);
});

test("decodes accents in every macro form inside fields", () => {
  const input = only(String.raw`@book{k, title = {\'a \'{e} {\'i} {\'{o}} \"u \^{a} \`e \~{n} \c{c} \v s \u{g} \H{o} \k{e} \r{u} \=o \.z \d{a} \b{k} \t{ts} {\ss} \o{} \aa\ \ae{} {\oe} \l{} \i}, year = 2000}`);
  assert.equal(input.csl.title, "á é í ó ü â è ñ ç š ğ ő ę ů ō ż ạ ḵ t͡s ß ø å æ œ ł ı");
});

test("handles nested braces, quoted values with braces, numbers and CRLF + BOM", () => {
  const text = "﻿@misc{nested,\r\n  title = \"A {Very {Deeply {Nested}}} \\\"{O}tto\",\r\n  year = 1999,\r\n  howpublished = {Printed {flyer}}\r\n}\r\n@misc{second,\r\n  title = {Second}\r\n}\r\n";
  const result = parse(text);
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries[0].input.csl.title, `A ${NOCASE("Very Deeply Nested")} Ötto`);
  assert.equal(result.entries[0].input.csl.medium, "Printed flyer");
  assert.deepEqual(result.entries[0].input.csl.issued, { "date-parts": [[1999]] });
  assert.deepEqual(result.entries.map((entry) => entry.line), [1, 6]);
});

test("keeps a stray & or % in values and accepts trailing commas and paren-delimited entries", () => {
  const result = parse(String.raw`@techreport(rep1, title = {R&D at 100% capacity}, institution = {AT&T Labs}, number = {TR-1}, year = {2001},)`);
  assert.deepEqual(result.errors, []);
  const { csl } = result.entries[0].input;
  assert.equal(csl.title, "R&D at 100% capacity");
  assert.equal(csl.publisher, "AT&T Labs");
  assert.equal(csl.type, "report");
  assert.equal(csl.number, "TR-1");
});

test("resolves crossref: the child takes missing fields and the parent title as booktitle", () => {
  const result = parse(String.raw`
@inproceedings{child,
  author = {Doe, Jane},
  title = {A Paper},
  crossref = {proc},
  pages = {1--10},
}
@proceedings{proc,
  title = {Proceedings of the {ACM} Conference},
  editor = {Editor, Ed},
  publisher = {ACM},
  address = {New York},
  year = 2019,
  doi = {10.1145/parent},
}
@incollection{orphan, title = {Orphan}, crossref = {missing}}
`);
  assert.equal(result.entries.length, 3);
  const child = result.entries[0].input.csl;
  assert.equal(child.type, "paper-conference");
  assert.equal(child.title, "A Paper");
  assert.equal(child["container-title"], "Proceedings of the ACM Conference");
  assert.deepEqual(child.editor, [{ family: "Editor", given: "Ed" }]);
  assert.equal(child.publisher, "ACM");
  assert.equal(child["publisher-place"], "New York");
  assert.deepEqual(child.issued, { "date-parts": [[2019]] });
  assert.equal(child.page, "1–10");
  assert.equal(child.DOI, undefined, "a DOI is never inherited");
  assert.equal(result.entries[1].input.csl.type, "book");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Crossref "missing"/);
});

test("reports malformed entries and continues with the next entry", () => {
  const text = [
    "@article{unclosed, title = {Never closed, year = 2000",
    "@book{good1, title = {Good One}, year = 2001}",
    "@article{nocomma, title = {X} author = {Y}}",
    "@book{good2, title = {Good Two}}",
    "@article{noequals, title {X}}",
    "@misc{good3, title = {Good Three}}",
    "@article{noclose, title = {X},",
    "",
    "@misc{good4, title = {Good Four}, note = {mail me@home}}",
    "@misc{undefined, month = notamacro, title = {Macro}}",
    "@article{dup, title = {First}, title = {Second}}",
    "@article{dup, title = {Again}}",
  ].join("\n");
  const result = parse(text);
  assert.deepEqual(result.entries.map((entry) => entry.sourceKey), ["good1", "good2", "good3", "good4", "undefined", "dup", "dup"]);
  assert.equal(result.entries[5].input.csl.title, "First");
  const messages = result.errors.map((error) => `${error.line}: ${error.message}`);
  assert.equal(messages.length, 7, messages.join("\n"));
  assert.match(messages[0], /^1: Unbalanced braces/);
  assert.match(messages[1], /^3: Expected "," or "}" after field "title" in entry "nocomma"/);
  assert.match(messages[2], /^5: Expected "=" after field "title"/);
  assert.match(messages[3], /^9: Entry "noclose" is not closed/);
  assert.match(messages[4], /^10: Undefined macro "notamacro"/);
  assert.match(messages[5], /^11: Duplicate field "title"/);
  assert.match(messages[6], /^12: Duplicate key "dup"/);
});

test("keeps odd source keys, and sets the entry key only when it is a valid citation key", () => {
  const result = parse([
    "@misc{odd:key.with/chars-1, title={A}}", "@misc{has%percent, title={B}}", "@misc{-leading, title={C}}",
    "@misc{trailing., title={D}}", "@misc{, title={E}}",
  ].join("\n"));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.entries.map((entry) => [entry.sourceKey, entry.input.key]), [
    ["odd:key.with/chars-1", "odd:key.with/chars-1"], ["has%percent", "has%percent"], ["-leading", undefined], ["trailing.", undefined], ["", undefined],
  ]);
  assert.equal(result.entries[4].input.csl.title, "E");
});

test("maps BibTeX and BibLaTeX entry types to CSL", () => {
  const cases: Array<[string, string, string?]> = [
    ["article", "article-journal"], ["inproceedings", "paper-conference"], ["conference", "paper-conference"],
    ["incollection", "chapter"], ["inbook", "chapter"], ["book", "book"], ["mvbook", "book"], ["phdthesis", "thesis", "PhD thesis"],
    ["mastersthesis", "thesis", "Master's thesis"], ["thesis", "thesis"], ["techreport", "report"], ["report", "report"],
    ["online", "webpage"], ["electronic", "webpage"], ["www", "webpage"], ["misc", "document"], ["unpublished", "manuscript"],
    ["manual", "report"], ["proceedings", "book"], ["patent", "patent"], ["dataset", "dataset"], ["software", "software"],
    ["booklet", "pamphlet"], ["inreference", "entry-encyclopedia"],
  ];
  for (const [bibType, cslType, genre] of cases) {
    const input = only(`@${bibType}{k, title = {T}, year = 2000}`);
    assert.equal(input.csl.type, cslType, bibType);
    assert.equal(input.csl.genre, genre, bibType);
  }
  assert.equal(only("@misc{k, title = {Site}, url = {https://example.org}}").csl.type, "webpage");
  assert.equal(only("@misc{k, title = {Site}, url = {https://example.org}, publisher = {P}}").csl.type, "document");
  assert.equal(only("@misc{k, title = {Site}, howpublished = {\\url{https://example.org}}}").csl.URL, "https://example.org");
  const unknown = parse("@video{k, title = {Clip}, note = {Watch it}}");
  assert.deepEqual(unknown.errors, []);
  assert.equal(unknown.entries[0].input.csl.type, "document");
  assert.equal(unknown.entries[0].input.csl.note, "Watch it. BibTeX entry type: @video");
  assert.equal(only("@thesis{k, title = {T}, type = {phdthesis}}").csl.genre, "PhD thesis");
  assert.equal(only("@phdthesis{k, title = {T}, type = {Habilitation}}").csl.genre, "Habilitation");
  assert.equal(only("@article{k, title = {T}, entrysubtype = {newspaper}}").csl.type, "article-newspaper");
});

test("maps BibTeX and BibLaTeX fields to CSL", () => {
  const book = only(String.raw`@book{k,
    editor = {Ed, Itor}, translator = {Trans, Lator}, title = {Main}, subtitle = {And More}, shorttitle = {Main},
    series = {Lecture Notes}, number = {12}, edition = {2nd}, volume = {3}, pagetotal = {300}, publisher = {Springer},
    location = {Berlin}, isbn = {0-262-03384-4}, langid = {ngerman}, date = {2020-05-01}, urldate = {2021-02-03},
    eprint = {2101.00001v2}, eprinttype = {arXiv}, pmid = {12345}, version = {1.2}, pubstate = {forthcoming}}`);
  assert.deepEqual(book.csl, {
    type: "book", title: "Main: And More", "title-short": "Main", "collection-title": "Lecture Notes",
    editor: [{ family: "Ed", given: "Itor" }], translator: [{ family: "Trans", given: "Lator" }],
    issued: { "date-parts": [[2020, 5, 1]] }, status: "forthcoming", accessed: { "date-parts": [[2021, 2, 3]] },
    volume: "3", "collection-number": "12", "number-of-pages": "300", edition: "2", version: "1.2", publisher: "Springer",
    "publisher-place": "Berlin", language: "de", ISBN: "9780262033848", PMID: "12345",
  });
  assert.deepEqual(book.identifiers, { isbn: ["9780262033848"], pmid: "12345", arxiv: "2101.00001" });

  const thesis = only("@phdthesis{k, title = {T}, school = {MIT}, address = {Cambridge, MA}, year = {2010}}");
  assert.equal(thesis.csl.publisher, "MIT");
  assert.equal(thesis.csl["publisher-place"], "Cambridge, MA");
  const report = only("@techreport{k, title = {T}, institution = {NASA}, type = {Memo}, number = {7}}");
  assert.deepEqual([report.csl.publisher, report.csl.genre, report.csl.number], ["NASA", "Memo", "7"]);
  const article = only("@article{k, title = {T}, journaltitle = {J}, shortjournal = {J. Abbr.}, issue = {4}, eid = {e1234}, archiveprefix = {arXiv}, eprint = {hep-th/9901001}}");
  assert.deepEqual([article.csl["container-title"], article.csl["container-title-short"], article.csl.issue, article.csl.number], ["J", "J. Abbr.", "4", "e1234"]);
  assert.equal(article.identifiers?.arxiv, "hep-th/9901001");
  const chapter = only("@inbook{k, title = {The Book}, chapter = {The Chapter}, pages = {5-9}}");
  assert.deepEqual([chapter.csl.title, chapter.csl["container-title"], chapter.csl.page], ["The Chapter", "The Book", "5–9"]);
  const numbered = only("@incollection{k, title = {Part}, booktitle = {Whole}, chapter = {3}}");
  assert.deepEqual([numbered.csl.title, numbered.csl["container-title"], numbered.csl["chapter-number"]], ["Part", "Whole", "3"]);
  assert.equal(only("@article{k, title = {T}, year = {in press}}").csl.status, "in press");
  assert.deepEqual(only("@article{k, title = {T}, year = {2020a}}").csl.issued, { "date-parts": [[2020]] });
  assert.deepEqual(only("@article{k, title = {T}, year = {2019--2020}}").csl.issued, { "date-parts": [[2019], [2020]] });
  assert.deepEqual(only("@article{k, title = {T}, year = 2020, month = {September}, day = {9}}").csl.issued, { "date-parts": [[2020, 9, 9]] });
  assert.deepEqual(only("@article{k, title = {T}, year = 2020, month = 13}").csl.issued, { "date-parts": [[2020]] });
  assert.deepEqual(only("@article{k, title = {T}, doi = {10.1000/x}, pmcid = {PMC12345}}").identifiers, { doi: "10.1000/x", pmcid: "PMC12345" });
});

test("parses BibLaTeX dates: ISO, ranges, open ranges and approximate dates", () => {
  const cases: Array<[string, unknown]> = [
    ["2020", { "date-parts": [[2020]] }], ["2020-01", { "date-parts": [[2020, 1]] }], ["2020-01-15", { "date-parts": [[2020, 1, 15]] }],
    ["2020-01/2020-03", { "date-parts": [[2020, 1], [2020, 3]] }], ["2019/2021", { "date-parts": [[2019], [2021]] }],
    ["2020-05-01/..", { "date-parts": [[2020, 5, 1]] }], ["2020~", { "date-parts": [[2020]], circa: true }],
    ["1850?", { "date-parts": [[1850]], circa: true }], ["2020-02-30", { "date-parts": [[2020, 2]] }], ["Spring 2020", { literal: "Spring 2020" }],
  ];
  for (const [date, expected] of cases) assert.deepEqual(only(`@online{k, title = {T}, date = {${date}}}`).csl.issued, expected, date);
});

const ROUND_TRIP = String.raw`@string{jml = {Journal of Machine Learning}}
@article{smith2020sparse,
  author = {Smith, Jane and van der Waals, J. D. and King, Jr., Martin Luther and {OpenAI Team}},
  title = {Sparse {Bayesian} Attention for {DNA} and the iPhone: 50% of R&D in \textit{E. coli} with $O(n^2)$ cost},
  journal = jml,
  shortjournal = {J. Mach. Learn.},
  year = 2020, month = may, volume = {21}, number = {4}, pages = {1--42}, eid = {e123},
  doi = {10.1234/JML.2020.001}, url = {https://example.org/a_b~c},
  keywords = {attention, sparsity},
  abstract = {We \emph{study} it.}, note = {See also {Part II}},
}
@book{muller1999,
  author = {M{\"u}ller, J{\"u}rgen and Dvo{\v{r}}{\'a}k, Anton{\'i}n},
  title = {{\"U}ber die Stra{\ss}e: L{\o}sungen},
  publisher = {Springer}, address = {Berlin}, year = {1999}, edition = {3}, series = {Lecture Notes}, number = {7},
  isbn = {978-3-16-148410-0},
}
@phdthesis{doe2010,
  author = {Doe, John}, title = {A Thesis}, school = {MIT}, year = {2010}, month = {jun},
}
@mastersthesis{roe2011, author = {Roe, Rich}, title = {Another}, school = {ETH}, year = {2011}}
@techreport{tr2001, author = {{NASA}}, title = {Report}, institution = {NASA}, number = {TR-9}, type = {Technical Note}, year = {2001}}
@inproceedings{conf2019,
  author = {Lee, Ann}, title = {A Paper}, booktitle = {Proceedings of {NeurIPS}}, editor = {Ed, Itor}, pages = {5--9},
  publisher = {Curran}, year = {2019}, eprint = {1901.00001}, archiveprefix = {arXiv},
}
@incollection{chap, author = {Ng, Andrew}, title = {Chapter}, booktitle = {The Book}, chapter = {3}, pages = {10--20}, year = {2005}}
@online{web, author = {Web, Master}, title = {A Page}, url = {https://example.org/page}, urldate = {2021-02-03}, year = {2021}}
@misc{mis, title = {Thing}, howpublished = {Poster}, year = {2018}, language = {French}}
@unpublished{draft, author = {Draft, Writer}, title = {Draft}, note = {Manuscript in preparation}, year = {2022}}
@patent{pat, author = {Inventor, Ivy}, title = {Gadget}, number = {US123}, year = {2015}}
@software{sw, author = {Dev, Dana}, title = {Tool}, version = {2.0}, url = {https://example.org/tool}, year = {2023}}
@article{press, author = {Pressed, Penny}, title = {Forthcoming Work}, journal = {Nature}, year = {in press}}
@book{ranged, title = {Collected Works}, year = {1990--1995}, publisher = {P}}
`;

for (const dialect of ["bibtex", "biblatex"] as const) {
  test(`BibTeX → entries → ${dialect} → entries is stable`, () => {
    const first = parse(ROUND_TRIP);
    assert.deepEqual(first.errors, []);
    const written = serializeBibtex(asEntries(first), { dialect });
    const second = parse(written);
    assert.deepEqual(second.errors, [], written);
    assert.deepEqual(second.entries.map((entry) => entry.input), first.entries.map((entry) => entry.input), written);
    // And the text itself is a fixed point.
    assert.equal(serializeBibtex(asEntries(second), { dialect }), written);
  });
}

test("serializes with escaping, protection, page ranges and month macros (bibtex)", () => {
  const written = serializeBibtex([{
    key: "smith2020",
    csl: {
      type: "article-journal", title: `Café and DNA in ${NOCASE("Bayesian")} <i>E. coli</i>: 50% & more`,
      author: [{ family: "Müller", given: "Jürgen" }, { literal: "World Health Organization" }],
      "container-title": "Journal of Things", "container-title-short": "J. Things", issued: { "date-parts": [[2020, 3, 9]] },
      volume: "1", issue: "2", page: "12–14", DOI: "10.1000/x_y", URL: "https://example.org/{a}",
    },
    identifiers: { arxiv: "2101.00001" },
    aliases: ["old2020"],
    tags: ["a", "b"],
  }], { dialect: "bibtex" });
  assert.equal(written, String.raw`@article{smith2020,
  author        = {M{\"u}ller, J{\"u}rgen and {World Health Organization}},
  title         = {Caf{\'e} and {DNA} in {Bayesian} \textit{E. coli}: 50\% \& more},
  journal       = {Journal of Things},
  shortjournal  = {J. Things},
  volume        = {1},
  number        = {2},
  pages         = {12--14},
  year          = {2020},
  month         = mar,
  day           = {9},
  doi           = {10.1000/x_y},
  eprint        = {2101.00001},
  archiveprefix = {arXiv},
  url           = {https://example.org/%7Ba%7D},
  keywords      = {a, b}
}
`);
});

test("serializes BibLaTeX dates, journaltitle, abbreviations, aliases and one entry per key", () => {
  const entries: BibtexSerializableEntry[] = [
    {
      key: "a", aliases: ["old-a", "older-a"],
      csl: { type: "article-journal", title: "Title", "container-title": "Journal of Things", "container-title-short": "J. Things", issued: { "date-parts": [[2020, 1], [2020, 3]] }, accessed: { "date-parts": [[2021, 2, 3]] }, status: "in press" },
    },
    { key: "A", csl: { type: "book", title: "Duplicate key, case-insensitive" } },
    { key: "t", csl: { type: "thesis", title: "T", genre: "Master's thesis", publisher: "ETH", issued: { "date-parts": [[2011]], circa: true } } },
  ];
  const written = serializeBibtex(entries, { dialect: "biblatex", abbreviateJournals: true, includeAliases: true });
  assert.equal(written, `@comment{alias: old-a -> a}
@comment{alias: older-a -> a}
@article{a,
  title        = {Title},
  journaltitle = {J. Things},
  shortjournal = {J. Things},
  date         = {2020-01/2020-03},
  urldate      = {2021-02-03},
  pubstate     = {inpress}
}

@thesis{t,
  title       = {T},
  institution = {ETH},
  date        = {2011~},
  type        = {mathesis}
}
`);
  const reparsed = parse(written);
  assert.deepEqual(reparsed.errors, []);
  assert.deepEqual(reparsed.entries.map((entry) => entry.sourceKey), ["a", "t"]);
  assert.equal(reparsed.entries[1].input.csl.genre, "Master's thesis");
  assert.equal(serializeBibtex(entries, { dialect: "biblatex" }).includes("@comment"), false);
  assert.match(serializeBibtex(entries, { dialect: "biblatex" }), /journaltitle = \{Journal of Things\}/);
  assert.match(serializeBibtex(entries, { dialect: "bibtex" }), /journal +?= \{Journal of Things\}/);
  assert.equal(serializeBibtex([], { dialect: "bibtex" }), "");
});

test("keeps fields in a stable order regardless of CSL key order", () => {
  const a = serializeBibtex([{ key: "k", csl: { type: "book", title: "T", publisher: "P", author: [{ family: "A" }], issued: { "date-parts": [[2000]] } } }], { dialect: "bibtex" });
  const b = serializeBibtex([{ key: "k", csl: { issued: { "date-parts": [[2000]] }, author: [{ family: "A" }], publisher: "P", title: "T", type: "book" } }], { dialect: "bibtex" });
  assert.equal(a, b);
  assert.deepEqual(a.split("\n").slice(1, -2).map((line) => line.trim().split(" ")[0]), ["author", "title", "publisher", "year"]);
});
