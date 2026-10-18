import assert from "node:assert/strict";
import test from "node:test";
import { duplicateScore, findDuplicateGroups, isPreprint, isPreprintPublishedPair, mergeEntryFields, normalizeTitleForMatch, titleSimilarity, type MergeableEntry } from "../../src/lib/references/dedupe";
import {
  applyIdentifiersToCsl, cleanRichText, identifiersFromCsl, looksLikePersonalName, normalizeCslDate, normalizeCslItem, normalizeEntryInput,
  normalizePageRange, parseDateText,
} from "../../src/lib/references/normalize";
import type { CslItem, FieldProvenance, ReferenceEntryInput } from "../../src/lib/references/types";

test("cleans rich text to the citeproc subset", () => {
  const cases: Array<[string, string]> = [
    ["  A   <em>title</em>\n with <strong>bold</strong> ", "A <i>title</i> with <b>bold</b>"],
    ['<span class="nocase">DNA</span> <span class=\'nocase\'>RNA</span>', '<span class="nocase">DNA</span> <span class="nocase">RNA</span>'],
    ['<span style="font-variant: small-caps">sc</span>', '<span style="font-variant:small-caps;">sc</span>'],
    ['<span class="highlight">kept text</span> <a href="x">link</a>', "kept text link"],
    ["<jats:title>JATS</jats:title><jats:p>para</jats:p>", "JATS para"], ["H<sub>2</sub>O and x<sup>2</sup>", "H<sub>2</sub>O and x<sup>2</sup>"],
    ["A &amp; B &lt;3 &#233;&#x00E9;&nbsp;x &bogus;", "A & B <3 éé x &bogus;"], ["a<br/>b", "a b"], ["x < y and y > z", "x < y and y > z"], ["<i> </i>empty", "empty"],
  ];
  for (const [input, expected] of cases) assert.equal(cleanRichText(input), expected, input);
});

test("normalizes page ranges to en dashes and keeps single pages", () => {
  const cases: Array<[string, string]> = [
    ["12-14", "12–14"], ["12--14", "12–14"], ["12 — 14", "12–14"], ["pp. 12-14", "12–14"], ["p. 7", "7"], ["e1234", "e1234"], ["S12", "S12"],
    ["S12-S14", "S12–S14"], ["e1234-e1240", "e1234–e1240"], ["12-14, 18-20", "12–14, 18–20"], ["iv-x", "iv–x"], ["123-4567-89", "123-4567-89"],
    ["A-B", "A-B"], ["12–14", "12–14"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizePageRange(input), expected, input);
});

test("parses date text and validates date-parts", () => {
  const texts: Array<[string, unknown]> = [
    ["2020", { "date-parts": [[2020]] }], ["2020-05-12", { "date-parts": [[2020, 5, 12]] }], ["2020-05-12T10:00:00Z", { "date-parts": [[2020, 5, 12]] }],
    ["2019–2020", { "date-parts": [[2019], [2020]] }], ["May 2020", { "date-parts": [[2020, 5]] }], ["12 May 2020", { "date-parts": [[2020, 5, 12]] }],
    ["May 12, 2020", { "date-parts": [[2020, 5, 12]] }], ["Sept. 2001", { "date-parts": [[2001, 9]] }], ["2020?", { "date-parts": [[2020]], circa: true }],
    ["someday", undefined], ["", undefined],
  ];
  for (const [input, expected] of texts) assert.deepEqual(parseDateText(input), expected, input);
  const dates: Array<[unknown, unknown]> = [
    [{ "date-parts": [[2020, 13, 5]] }, { "date-parts": [[2020]] }], [{ "date-parts": [[2021, 2, 29]] }, { "date-parts": [[2021, 2]] }],
    [{ "date-parts": [[2020, 2, 29]] }, { "date-parts": [[2020, 2, 29]] }], [{ "date-parts": [["2020", "05", "01"]] }, { "date-parts": [[2020, 5, 1]] }],
    [{ "date-parts": [[2020, 0]] }, { "date-parts": [[2020]] }], [{ "date-parts": [["x"]] }, undefined], [{ "date-parts": [["x"]], literal: "n.d." }, { literal: "n.d." }],
    [{ "date-parts": [[2020], [2020]] }, { "date-parts": [[2020]] }], [{ "date-parts": [[2019], [2020, 99]] }, { "date-parts": [[2019], [2020]] }],
    [{ raw: "2001-02-03" }, { "date-parts": [[2001, 2, 3]] }], [{ raw: "circa never" }, { raw: "circa never" }], ["2020-04", { "date-parts": [[2020, 4]] }],
    [{ "date-parts": [[2020]], season: 2, circa: true }, { "date-parts": [[2020]], season: 2, circa: true }], [{}, undefined], [null, undefined],
  ];
  for (const [input, expected] of dates) assert.deepEqual(normalizeCslDate(input), expected, JSON.stringify(input));
});

test("recognizes literal names that are really people", () => {
  for (const name of ["Smith, J.", "Smith, J. A.", "J. Smith", "J.-P. Sartre", "Smith, Jane", "van der Berg, J.", "Müller, J."]) assert.equal(looksLikePersonalName(name), true, name);
  for (const name of ["World Health Organization", "NASA", "The Beatles", "Smith and Sons, Ltd."]) assert.equal(looksLikePersonalName(name), false, name);
});

test("normalizes a CSL item: whitespace, titles, pages, identifiers, dates, names, numbers and empties", () => {
  const csl = normalizeCslItem({
    type: "article-journal",
    title: "  A  <em>Study</em>\n of <span class='x'>Things</span> ",
    "container-title": "Journal &amp; Review",
    author: [{ literal: "Smith, J." }, { literal: "J. Doe" }, { literal: "World Health Organization" }, { family: "  Lee ", given: "" }, {}, "Roe, Rich" as never],
    issued: { "date-parts": [[2020, 2, 31]] },
    page: "100-110",
    volume: 12 as unknown as string,
    issue: "  ",
    DOI: "https://doi.org/10.1000/ABC.",
    ISBN: "0-262-03384-4, 978-3-16-148410-0",
    ISSN: "03785955",
    PMID: "PMID: 0123",
    PMCID: "pmc99",
    note: "",
    abstract: "<jats:p>Abstract</jats:p>",
    "custom-field": "kept",
    editor: [],
  });
  assert.deepEqual(csl, {
    type: "article-journal",
    title: "A <i>Study</i> of Things",
    "container-title": "Journal & Review",
    author: [{ family: "Smith", given: "J." }, { family: "Doe", given: "J." }, { literal: "World Health Organization" }, { family: "Lee" }, { family: "Roe", given: "Rich" }],
    issued: { "date-parts": [[2020, 2]] },
    page: "100–110",
    volume: "12",
    DOI: "10.1000/abc",
    ISBN: "9780262033848 9783161484100",
    ISSN: "0378-5955",
    PMID: "123",
    PMCID: "PMC99",
    abstract: "Abstract",
    "custom-field": "kept",
  });
  assert.equal(normalizeCslItem({ type: "bogus" as never }).type, "document");
  assert.equal(normalizeCslItem({ type: "book", DOI: "not a doi" }).DOI, "not a doi", "invalid identifiers are kept as typed");
});

test("syncs identifiers with CSL in both directions without overwriting", () => {
  assert.deepEqual(identifiersFromCsl({ type: "article", DOI: "10.48550/arXiv.2101.00001", ISBN: "0262033844", PMID: "5", PMCID: "PMC6" }), {
    doi: "10.48550/arxiv.2101.00001", isbn: ["9780262033848"], pmid: "5", pmcid: "PMC6", arxiv: "2101.00001",
  });
  assert.deepEqual(identifiersFromCsl({ type: "article", URL: "https://arxiv.org/abs/hep-th/9901001" }), { arxiv: "hep-th/9901001" });
  assert.deepEqual(identifiersFromCsl({ type: "article", number: "arXiv:2101.00001" }), { arxiv: "2101.00001" });
  assert.deepEqual(applyIdentifiersToCsl({ type: "book", DOI: "10.1/keep" }, { doi: "10.1/other", isbn: ["9780262033848", "9783161484100"], pmid: "1", pmcid: "PMC2" }), {
    type: "book", DOI: "10.1/keep", ISBN: "9780262033848 9783161484100", PMID: "1", PMCID: "PMC2",
  });
  const input = normalizeEntryInput({
    key: "",
    csl: { type: "book", title: " T ", ISBN: "0262033844" },
    identifiers: { doi: "doi:10.1000/X", isbn: ["978-3-16-148410-0", "bad"], arxiv: "arXiv:2101.00001v3", openalex: "https://openalex.org/w123" },
    tags: [" Alpha ", "alpha", "", "Beta"],
    notes: "   ",
    attachments: [],
  });
  assert.deepEqual(input, {
    csl: { type: "book", title: "T", ISBN: "9780262033848", DOI: "10.1000/x" },
    identifiers: { doi: "10.1000/x", arxiv: "2101.00001", isbn: ["9783161484100", "9780262033848"], openalex: "W123" },
    tags: ["Alpha", "Beta"],
  });
});

const article = (title: string, extra: Partial<CslItem> = {}, identifiers: ReferenceEntryInput["identifiers"] = {}) => ({
  csl: { type: "article-journal" as const, title, author: [{ family: "Smith", given: "J." }], issued: { "date-parts": [[2020]] as Array<[number]> }, ...extra },
  identifiers,
});

test("normalizes titles for matching and scores title similarity", () => {
  assert.equal(normalizeTitleForMatch("<i>Über</i> die Straße: A Study—of Œuvres!"), "uber die strasse a study of oeuvres");
  assert.equal(normalizeTitleForMatch(null), "");
  assert.equal(titleSimilarity("Deep Learning", "deep learning."), 1);
  assert.equal(titleSimilarity("", "x"), 0);
  assert.ok(titleSimilarity("Attention is all you need", "Attention is all you nead") > 0.85);
  assert.ok(titleSimilarity("Learning to rank with neural networks", "Neural networks with learning to rank") > 0.8);
  assert.ok(titleSimilarity("Attention is all you need", "A survey of protein folding") < 0.3);
  assert.ok(titleSimilarity("BERT: Pre-training of deep bidirectional transformers", "BERT pretraining of deep bidirectional transformers") > 0.8);
});

test("scores duplicates by shared identifiers first", () => {
  const cases: Array<[string, Parameters<typeof duplicateScore>[0], Parameters<typeof duplicateScore>[1], { score: number; reason: string | null }]> = [
    ["same DOI in different forms", article("A", { DOI: "https://doi.org/10.1000/ABC" }), article("Completely different", { DOI: "10.1000/abc" }), { score: 1, reason: "doi" }],
    ["DOI in identifiers only", article("A", {}, { doi: "10.1000/abc" }), article("B", { DOI: "10.1000/ABC" }), { score: 1, reason: "doi" }],
    ["arXiv from a DOI and an eprint", article("A", { DOI: "10.48550/arXiv.2101.00001" }), article("B", {}, { arxiv: "2101.00001v2" }), { score: 1, reason: "arxiv" }],
    ["shared PMID", article("A", { PMID: "123" }), article("B", {}, { pmid: "123" }), { score: 1, reason: "pmid" }],
    ["shared PMCID", article("A", { PMCID: "PMC1" }), article("B", {}, { pmcid: "PMC1" }), { score: 1, reason: "pmid" }],
    ["shared ISBN between books", { csl: { type: "book", title: "A", ISBN: "0262033844" } }, { csl: { type: "book", title: "B" }, identifiers: { isbn: ["9780262033848"] } }, { score: 1, reason: "isbn" }],
    ["different DOIs, same title", article("Same Title Here", { DOI: "10.1000/a" }), article("Same Title Here", { DOI: "10.1000/b" }), { score: 0, reason: null }],
    ["different arXiv IDs", article("Same Title Here", {}, { arxiv: "2101.00001" }), article("Same Title Here", {}, { arxiv: "2101.00002" }), { score: 0, reason: null }],
  ];
  for (const [name, a, b, expected] of cases) assert.deepEqual(duplicateScore(a, b), expected, name);
  // Chapters share their book's ISBN, so the ISBN alone does not make them one work.
  const chapters = duplicateScore(
    { csl: { type: "chapter", title: "First chapter about cats", ISBN: "9780262033848" } },
    { csl: { type: "chapter", title: "Second chapter about dogs", ISBN: "9780262033848" } },
  );
  assert.equal(chapters.reason, "fuzzy");
  assert.ok(chapters.score < 0.9);
});

test("scores fuzzy duplicates on title, first author and year", () => {
  const base = article("Sparse attention for long documents");
  const score = (other: ReturnType<typeof article>) => duplicateScore(base, other).score;
  assert.equal(score(article("Sparse Attention for Long Documents.")), 0.99);
  assert.ok(score(article("Sparse attention for long documents", { issued: { "date-parts": [[2021]] } })) >= 0.9, "a year off by one still matches");
  assert.ok(score(article("Sparse attention for long documents", { issued: { "date-parts": [[2023]] } })) < 0.7, "years far apart");
  assert.ok(score(article("Sparse attention for long documents", { author: [{ family: "Jones" }] })) < 0.75, "another first author");
  assert.ok(score(article("Sparse attention for long documents", { author: [{ family: "Šmith" }] })) >= 0.99, "accents fold");
  assert.ok(score(article("Dense retrieval for question answering")) < 0.4);
  assert.ok(score(article("Sparse attention for long documents", { author: undefined, issued: undefined })) < 0.95);
  assert.ok(duplicateScore(article("Introduction"), article("Introduction")).score < 0.95, "short titles count less");
  // An arXiv DOI and a journal DOI may still be one work.
  const preprint = article("Sparse attention for long documents", { DOI: "10.48550/arXiv.2101.00001", type: "article" });
  const published = article("Sparse attention for long documents", { DOI: "10.1000/journal.1" });
  assert.deepEqual(duplicateScore(preprint, published), { score: 0.99, reason: "fuzzy" });
  assert.deepEqual(duplicateScore(article("Untitled", { title: undefined }), article("Other", { title: undefined })), { score: 0, reason: null });
});

test("groups duplicates transitively with union-find", () => {
  const entries = [
    { id: "a", ...article("Graph neural networks: a review", { DOI: "10.1000/gnn" }) },
    { id: "b", ...article("Something else entirely", { DOI: "10.1000/GNN" }) },
    { id: "c", ...article("Something else entirely!") },
    { id: "d", ...article("Unrelated work on proteins") },
    { id: "e", ...article("Unrelated work on proteins", { author: [{ family: "Other" }] }) },
    { id: "f", ...article("Graph neural networks: a review", { DOI: "10.1000/different" }) },
  ];
  assert.deepEqual(findDuplicateGroups(entries).map((group) => group.map((entry) => entry.id)), [["a", "b", "c"]]);
  assert.deepEqual(findDuplicateGroups(entries, 0.6).map((group) => group.map((entry) => entry.id)), [["a", "b", "c"], ["d", "e"]]);
  assert.deepEqual(findDuplicateGroups([]), []);
});

test("recognizes preprint and published versions of one work", () => {
  const arxivPreprint = { csl: { type: "article" as const, title: "Sparse attention for long documents", author: [{ family: "Smith" }], issued: { "date-parts": [[2020]] as Array<[number]> } }, identifiers: { arxiv: "2101.00001" } };
  const journal = article("Sparse Attention for Long Documents", { DOI: "10.1000/journal.1", "container-title": "Journal of ML", issued: { "date-parts": [[2021]] } });
  const biorxiv = article("Sparse attention for long documents", { DOI: "10.1101/2020.01.01.123456", publisher: "Cold Spring Harbor Laboratory" });
  const medrxiv = article("Sparse attention for long documents", { "container-title": "medRxiv" });
  const ssrn = article("Sparse attention for long documents", { publisher: "SSRN" });
  const genomeResearch = article("Genome paper", { DOI: "10.1101/gr.123", "container-title": "Genome Research" });
  const publishedWithArxiv = article("Sparse attention for long documents", { DOI: "10.1000/journal.1", "container-title": "Journal of ML" }, { arxiv: "2101.00001" });
  assert.deepEqual([arxivPreprint, journal, biorxiv, medrxiv, ssrn, genomeResearch, publishedWithArxiv].map(isPreprint), [true, false, true, true, true, false, false]);
  assert.equal(isPreprintPublishedPair(arxivPreprint, journal), true);
  assert.equal(isPreprintPublishedPair(journal, biorxiv), true, "different DOIs are fine for versions");
  assert.equal(isPreprintPublishedPair(arxivPreprint, publishedWithArxiv), true, "a shared arXiv ID links the versions");
  assert.equal(isPreprintPublishedPair(journal, publishedWithArxiv), false, "two published versions");
  assert.equal(isPreprintPublishedPair(arxivPreprint, medrxiv), false, "two preprints");
  assert.equal(isPreprintPublishedPair(arxivPreprint, article("A different paper about proteins", { "container-title": "Journal" })), false);
  assert.equal(duplicateScore(journal, biorxiv).score, 0, "duplicateScore keeps the different-DOI rule");
});

test("previews a merge without overwriting or mutating", () => {
  const provenance = (source: FieldProvenance["source"]): FieldProvenance => ({ source, confidence: 0.9, retrievedAt: "2026-01-01T00:00:00.000Z" });
  const keep: MergeableEntry & { id: string; key: string } = {
    id: "ref_1", key: "smith2020",
    csl: { type: "article-journal", title: "Kept title", volume: "", page: "1–2" },
    identifiers: { doi: "10.1/keep", isbn: ["9780262033848"] },
    provenance: { title: provenance("user"), page: provenance("user") },
    attachments: [{ kind: "pdf", path: "a.pdf" }],
    tags: ["Alpha"],
  };
  const other: MergeableEntry = {
    csl: { type: "book", title: "Other title", volume: "12", issue: "3", DOI: "10.1/other", abstract: "Text" },
    identifiers: { doi: "10.1/other", arxiv: "2101.00001", isbn: ["9783161484100", "9780262033848"] },
    provenance: { title: provenance("crossref"), volume: provenance("crossref"), issue: provenance("crossref") },
    attachments: [{ kind: "pdf", path: "a.pdf" }, { kind: "url", url: "https://example.org" }],
    tags: ["alpha", "Beta"],
    notes: "From other",
  };
  const before = JSON.stringify([keep, other]);
  const merged = mergeEntryFields(keep, other);
  assert.equal(JSON.stringify([keep, other]), before, "inputs are not mutated");
  assert.deepEqual(merged, {
    id: "ref_1", key: "smith2020",
    csl: { type: "article-journal", title: "Kept title", volume: "12", page: "1–2", issue: "3", DOI: "10.1/other", abstract: "Text" },
    identifiers: { doi: "10.1/keep", arxiv: "2101.00001", isbn: ["9780262033848", "9783161484100"] },
    provenance: { title: provenance("user"), page: provenance("user"), volume: provenance("crossref"), issue: provenance("crossref") },
    attachments: [{ kind: "pdf", path: "a.pdf" }, { kind: "url", url: "https://example.org" }],
    tags: ["Alpha", "Beta"],
    notes: "From other",
  });
  assert.equal(mergeEntryFields({ ...keep, notes: "Mine" }, other).notes, "Mine");
  assert.deepEqual(mergeEntryFields({ csl: { type: "book" } }, { csl: { type: "book", title: "T" } }), { csl: { type: "book", title: "T" }, identifiers: {} });
});
