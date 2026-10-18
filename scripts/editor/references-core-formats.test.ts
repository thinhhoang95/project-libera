import assert from "node:assert/strict";
import test from "node:test";
import { parseCslJson, serializeCslJson } from "../../src/lib/references/csl-json";
import type { ReferenceParseResult } from "../../src/lib/references/normalize";
import { parseRis, serializeRis } from "../../src/lib/references/ris";

const AT = "2026-01-01T00:00:00.000Z";

function asEntries(result: ReferenceParseResult) {
  return result.entries.map(({ input, sourceKey }) => ({ key: input.key ?? sourceKey, csl: input.csl, identifiers: input.identifiers, tags: input.tags }));
}

const RIS = [
  "﻿TY  - JOUR",
  "ID  - smith2020",
  "AU  - Smith, John",
  "AU  - van der Waals, J. D.",
  "A1  - King, Martin Luther, Jr.",
  "TI  - A study of things",
  "  that continues on the next line",
  "T2  - Journal of Things",
  "J2  - J. Things",
  "PY  - 2020///",
  "DA  - 2020/05/12/",
  "VL  - 12",
  "IS  - 3",
  "SP  - 100",
  "EP  - 110",
  "DO  - https://doi.org/10.1000/ABC",
  "UR  - https://example.org/paper",
  "SN  - 0378-5955",
  "PB  - Elsevier",
  "CY  - Amsterdam",
  "AB  - An abstract.",
  "KW  - alpha",
  "KW  - beta; gamma",
  "N1  - A note",
  "LA  - en",
  "ER  - ",
  "",
  "TY - BOOK",
  "AU - World Health Organization",
  "ED - Editor, Ed",
  "T1 - Handbook",
  "Y1 - 1999/01/02/",
  "SN - 0-262-03384-4; 1234-5679",
  "ET - 2",
  "ER -",
  "",
  "TY  - CHAP",
  "AU  - Ng, Andrew",
  "TI  - A Chapter",
  "T2  - The Book",
  "A2  - Editor, Ed",
  "PY  - 2005",
  "SP  - e1234",
  "UR  - https://arxiv.org/abs/2101.00001v2",
  "ER  - ",
].join("\r\n");

test("parses RIS: tags, continuation lines, lenient spacing, names and identifiers", () => {
  const result = parseRis(RIS, { retrievedAt: AT });
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries.length, 3);
  const [journal, book, chapter] = result.entries;
  assert.equal(journal.sourceKey, "smith2020");
  assert.equal(journal.input.key, "smith2020");
  assert.equal(journal.line, 1);
  assert.deepEqual(journal.input.csl, {
    type: "article-journal",
    author: [
      { family: "Smith", given: "John" },
      { family: "Waals", given: "J. D.", "non-dropping-particle": "van der" },
      { family: "King", given: "Martin Luther", suffix: "Jr." },
    ],
    title: "A study of things that continues on the next line",
    "container-title": "Journal of Things",
    "container-title-short": "J. Things",
    issued: { "date-parts": [[2020, 5, 12]] },
    volume: "12",
    issue: "3",
    page: "100–110",
    publisher: "Elsevier",
    "publisher-place": "Amsterdam",
    abstract: "An abstract.",
    note: "A note",
    language: "en",
    DOI: "10.1000/abc",
    URL: "https://example.org/paper",
    ISSN: "0378-5955",
  });
  assert.deepEqual(journal.input.tags, ["alpha", "beta", "gamma"]);
  assert.deepEqual(journal.input.provenance?.title, { source: "import", confidence: 0.8, retrievedAt: AT });
  assert.equal(book.line, 28);
  assert.deepEqual(book.input.csl.author, [{ literal: "World Health Organization" }]);
  assert.deepEqual(book.input.csl.editor, [{ family: "Editor", given: "Ed" }]);
  assert.deepEqual(book.input.csl.issued, { "date-parts": [[1999, 1, 2]] });
  assert.equal(book.input.csl.ISBN, "9780262033848");
  assert.equal(book.input.csl.ISSN, "1234-5679");
  assert.equal(book.input.csl.edition, "2");
  assert.deepEqual(book.input.identifiers, { isbn: ["9780262033848"] });
  assert.equal(book.input.key, undefined);
  assert.equal(book.sourceKey, "");
  assert.equal(chapter.input.csl.type, "chapter");
  assert.equal(chapter.input.csl["container-title"], "The Book");
  assert.equal(chapter.input.csl.page, "e1234");
  assert.deepEqual(chapter.input.identifiers, { arxiv: "2101.00001" });
});

test("maps RIS types and classifies SN values by checksum and length", () => {
  const types: Array<[string, string]> = [
    ["JOUR", "article-journal"], ["BOOK", "book"], ["CHAP", "chapter"], ["CONF", "paper-conference"], ["CPAPER", "paper-conference"],
    ["THES", "thesis"], ["RPRT", "report"], ["ELEC", "webpage"], ["UNPB", "manuscript"], ["GEN", "document"], ["PAT", "patent"],
    ["DATA", "dataset"], ["COMP", "software"], ["MGZN", "article-magazine"], ["NEWS", "article-newspaper"], ["XYZ", "document"],
  ];
  for (const [risType, cslType] of types) {
    const result = parseRis(`TY  - ${risType}\nTI  - T\nER  - `);
    assert.equal(result.entries[0].input.csl.type, cslType, risType);
  }
  const sn = (value: string) => parseRis(`TY  - BOOK\nSN  - ${value}\nER  - `).entries[0].input.csl;
  assert.deepEqual([sn("9780262033848").ISBN, sn("9780262033848").ISSN], ["9780262033848", undefined]);
  assert.deepEqual([sn("0262033844").ISBN, sn("0262033844").ISSN], ["9780262033848", undefined]);
  assert.deepEqual([sn("2049-3630").ISBN, sn("2049-3630").ISSN], [undefined, "2049-3630"]);
  assert.deepEqual([sn("ISSN 0317-8471").ISSN], ["0317-8471"]);
  assert.deepEqual([sn("9780262033849").ISBN], ["9780262033849"], "an invalid ISBN is kept as typed");
  assert.equal(parseRis("TY  - INPR\nTI  - T\nER  - ").entries[0].input.csl.status, "in press");
});

test("reports stray tags and missing ER lines but keeps the records", () => {
  const result = parseRis("AU  - Orphan, A\nTY  - JOUR\nTI  - First\nTY  - BOOK\nTI  - Second\n");
  assert.deepEqual(result.entries.map((entry) => entry.input.csl.title), ["First", "Second"]);
  assert.deepEqual(result.errors.map((error) => error.line), [1, 2, 4]);
  assert.match(result.errors[0].message, /outside a record/);
  assert.match(result.errors[1].message, /no ER/);
});

test("RIS → entries → RIS → entries is stable", () => {
  const first = parseRis(RIS, { retrievedAt: AT });
  const written = serializeRis(asEntries(first));
  assert.match(written, /^TY {2}- JOUR\r\nAU {2}- Smith, John\r\n/);
  assert.match(written, /\r\nAU {2}- King, Martin Luther, Jr\.\r\n/);
  assert.match(written, /\r\nSP {2}- 100\r\nEP {2}- 110\r\n/);
  const second = parseRis(written, { retrievedAt: AT });
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.entries.map((entry) => entry.input), first.entries.map((entry) => entry.input));
  assert.equal(serializeRis(asEntries(second)), written);
  assert.equal(serializeRis([]), "");
});

test("serializes rich text as plain text and arXiv IDs as abs URLs", () => {
  const written = serializeRis([{ key: "k", csl: { type: "article", title: 'The <i>E. coli</i> <span class="nocase">DNA</span>' }, identifiers: { arxiv: "2101.00001" } }]);
  assert.equal(written, "TY  - JOUR\r\nTI  - The E. coli DNA\r\nUR  - https://arxiv.org/abs/2101.00001\r\nID  - k\r\nER  - \r\n");
});

const CSL_JSON = `[
  {
    "id": "smith2020",
    "type": "article-journal",
    "title": "A <em>Study</em>",
    "author": [{ "family": "Smith", "given": "John" }, { "literal": "Doe, J." }],
    "issued": { "date-parts": [["2020", "5", "40"]] },
    "page": "1-10",
    "volume": 12,
    "DOI": "https://doi.org/10.1000/ABC.",
    "keyword": "one, two"
  },
  {
    "id": 42,
    "type": "not-a-type",
    "title": "Unknown type"
  },
  "not an object",
  {
    "id": "bad key?",
    "type": "book",
    "title": "Book",
    "ISBN": "0-262-03384-4",
    "issued": { "raw": "2001-02-03" }
  }
]`;

test("parses CSL-JSON arrays, validates types and normalizes", () => {
  const result = parseCslJson(CSL_JSON, { retrievedAt: AT });
  assert.deepEqual(result.errors.map((error) => [error.line, error.message]), [
    [13, 'Unknown CSL type "not-a-type" in item 2, imported as a document'],
    [18, "Item 3 is not an object"],
  ]);
  assert.equal(result.entries.length, 3);
  const [article, unknown, book] = result.entries;
  assert.deepEqual([article.sourceKey, article.input.key, article.line], ["smith2020", "smith2020", 2]);
  assert.deepEqual(article.input.csl, {
    type: "article-journal",
    title: "A <i>Study</i>",
    author: [{ family: "Smith", given: "John" }, { family: "Doe", given: "J." }],
    issued: { "date-parts": [[2020, 5]] },
    page: "1–10",
    volume: "12",
    DOI: "10.1000/abc",
  });
  assert.deepEqual(article.input.tags, ["one", "two"]);
  assert.deepEqual(article.input.identifiers, { doi: "10.1000/abc" });
  assert.deepEqual(article.input.provenance?.page, { source: "import", confidence: 0.8, retrievedAt: AT });
  assert.deepEqual([unknown.sourceKey, unknown.input.key, unknown.input.csl.type], ["42", "42", "document"]);
  assert.deepEqual([book.sourceKey, book.input.key, book.line], ["bad key?", undefined, 19]);
  assert.deepEqual(book.input.csl.issued, { "date-parts": [[2001, 2, 3]] });
  assert.deepEqual(book.input.identifiers, { isbn: ["9780262033848"] });
});

test("parses a single CSL-JSON object and reports invalid JSON", () => {
  const single = parseCslJson('{"id": "x", "type": "book", "title": "One"}');
  assert.deepEqual([single.entries.length, single.entries[0].input.key, single.errors.length], [1, "x", 0]);
  const missing = parseCslJson('{"title": "No type"}');
  assert.equal(missing.entries[0].input.csl.type, "document");
  assert.match(missing.errors[0].message, /has no type/);
  const broken = parseCslJson("[\n  {\"id\": 1,,}\n]");
  assert.equal(broken.entries.length, 0);
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0].message, /^Invalid JSON/);
});

test("serializes CSL-JSON with id = key and identifiers filled in, and round-trips", () => {
  const written = serializeCslJson([{
    key: "k",
    csl: { type: "book", title: "T" },
    identifiers: { doi: "10.1/x", isbn: ["9780262033848"], pmid: "1", pmcid: "PMC2" },
    attachments: [{ kind: "pdf", path: "a.pdf" }, { kind: "url", url: "https://example.org" }],
    tags: ["a", "b"],
  }]);
  assert.deepEqual(JSON.parse(written), [{
    id: "k", type: "book", title: "T", DOI: "10.1/x", ISBN: "9780262033848", PMID: "1", PMCID: "PMC2", URL: "https://example.org", keyword: "a, b",
  }]);
  const first = parseCslJson(CSL_JSON, { retrievedAt: AT });
  const again = serializeCslJson(asEntries(first));
  const second = parseCslJson(again, { retrievedAt: AT });
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.entries.map((entry) => entry.input), first.entries.map((entry) => entry.input));
  assert.equal(serializeCslJson(asEntries(second)), again);
});
