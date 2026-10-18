import assert from "node:assert/strict";
import test from "node:test";
import { emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import { isAbortError } from "../../src/lib/references/resolve/http";
import { resolveInput, resolveMarkdown, resolvePdf, type ResolveOptions } from "../../src/lib/references/resolve/pipeline";
import type { PdfDocumentMetadata } from "../../src/lib/references/resolve/pdf";
import type { ReferenceEntry, ReferenceLibrary } from "../../src/lib/references/types";
import { FIXED_NOW, mockModel, testOptions, testSettings, type FetchLog, type ModelCall, type Route } from "./references-resolve-helpers";

function libraryWith(...entries: Partial<ReferenceEntry>[]): ReferenceLibrary {
  const library = emptyReferenceLibrary();
  entries.forEach((entry, index) => {
    const id = entry.id ?? `ref_${index}`;
    library.entries[id] = {
      id, key: entry.key ?? `key${index}`, aliases: [], csl: entry.csl ?? { type: "document" }, identifiers: entry.identifiers ?? {}, provenance: {},
      status: entry.status ?? "confirmed", attachments: entry.attachments ?? [], createdAt: FIXED_NOW.toISOString(), updatedAt: FIXED_NOW.toISOString(), fieldUpdatedAt: {},
    };
  });
  return library;
}

const emptySearch: Route[] = [
  { match: (url) => url.host === "api.crossref.org" && url.pathname === "/works", respond: () => Response.json({ message: { items: [] } }) },
  { match: (url) => url.host === "api.openalex.org" && url.pathname === "/works", respond: () => Response.json({ results: [] }) },
];

test("a DOI resolves through Crossref, enriched by OpenAlex, with disagreements as conflicts", async () => {
  const log: FetchLog = [];
  const { candidates, duplicates, updates, warnings } = await resolveInput("https://doi.org/10.1016/J.NEUNET.2014.09.003", testOptions({ log }));
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.status, "needs-review");
  assert.equal(candidate.csl.title, "Deep learning in neural networks: An overview");
  assert.deepEqual(candidate.csl.issued, { "date-parts": [[2015, 1]] });
  assert.equal(candidate.provenance?.title?.source, "crossref");
  assert.equal(candidate.identifiers?.openalex, "W2076063813", "OpenAlex fills identifiers Crossref lacks");
  assert.equal(candidate.identifiers?.arxiv, "1404.7828");
  assert.deepEqual(candidate.versions, [{ relation: "preprint-of", identifier: "arXiv:1404.7828" }]);
  assert.deepEqual(candidate.conflicts?.issued, [{ value: { "date-parts": [[2014, 10, 13]] }, provenance: { source: "openalex", confidence: 0.85, url: "https://openalex.org/W2076063813", retrievedAt: FIXED_NOW.toISOString() } }]);
  assert.deepEqual(duplicates, []);
  assert.deepEqual(updates, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(log.map((request) => new URL(request.url).host), ["api.crossref.org", "api.openalex.org"]);
});

test("an arXiv preprint with a journal DOI is offered as one work: published metadata, preprint linked", async () => {
  const { candidates } = await resolveInput("arXiv:1404.7828v4", testOptions());
  const [candidate] = candidates;
  assert.equal(candidate.csl.type, "article-journal");
  assert.equal(candidate.csl.DOI, "10.1016/j.neunet.2014.09.003");
  assert.equal(candidate.csl["container-title"], "Neural Networks");
  assert.equal(candidate.identifiers?.arxiv, "1404.7828");
  assert.equal(candidate.identifiers?.doi, "10.1016/j.neunet.2014.09.003");
  assert.deepEqual(candidate.versions, [{ relation: "preprint-of", identifier: "arXiv:1404.7828" }]);
  assert.match(String(candidate.csl.abstract), /^In recent years/);
  assert.equal(candidate.provenance?.abstract?.source, "arxiv", "the preprint fills the abstract the journal record lacks");
  assert.equal(candidate.conflicts?.title, undefined, "versions of one work are not disagreements");
});

test("a DOI Crossref does not know falls back to DataCite; PMIDs, PMCIDs and ISBNs resolve", async () => {
  const dataset = (await resolveInput("doi:10.5061/dryad.8515", testOptions())).candidates[0];
  assert.equal(dataset.csl.type, "dataset");
  assert.equal(dataset.provenance?.title?.source, "datacite");
  const pmcid = (await resolveInput("PMC3531190", testOptions())).candidates[0];
  assert.equal(pmcid.csl.title, "GenBank");
  assert.equal(pmcid.identifiers?.pmid, "23193287");
  const pmid = (await resolveInput("PMID: 23193287", testOptions())).candidates[0];
  assert.equal(pmid.provenance?.author?.source, "pubmed");
  const book = await resolveInput("ISBN 0-13-110362-8", testOptions());
  assert.equal(book.candidates[0].csl.title, "The C Programming Language");
  assert.equal(book.candidates[0].provenance?.publisher?.source, "isbn");
  const unknown = await resolveInput("978-0-00-000000-2", testOptions());
  assert.equal(unknown.candidates[0].status, "unresolved");
  assert.deepEqual(unknown.candidates[0].identifiers, { isbn: ["9780000000002"] });
  assert.ok(unknown.warnings.some((warning) => /Google Books/.test(warning)));
});

test("URLs are read once for meta tags: identifiers resolve, other pages become web page candidates", async () => {
  const pages: Route[] = [
    { match: (url) => url.href === "https://journal.example/article/1", respond: () => new Response(`<html><head><meta name="citation_doi" content="10.1016/j.neunet.2018.06.008"></head></html>`, { headers: { "content-type": "text/html" } }) },
    { match: (url) => url.href === "https://agency.example/report", respond: () => new Response(`<html><head><meta property="og:title" content="Annual report 2023"><meta property="og:site_name" content="The Agency"></head></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }) },
    { match: (url) => url.href === "https://files.example/data.zip", respond: () => new Response("PK", { headers: { "content-type": "application/zip" } }) },
  ];
  const log: FetchLog = [];
  const article = await resolveInput("https://journal.example/article/1", testOptions({ routes: pages, log }));
  assert.equal(article.candidates[0].csl.title, "A self-organizing short-term dynamical memory network");
  assert.equal(log.filter((request) => request.url === "https://journal.example/article/1").length, 1);
  const report = await resolveInput("https://agency.example/report", testOptions({ routes: pages }));
  assert.equal(report.candidates[0].csl.type, "webpage");
  assert.equal(report.candidates[0].csl.title, "Annual report 2023");
  assert.equal(report.candidates[0].status, "needs-review");
  const binary = await resolveInput("https://files.example/data.zip", testOptions({ routes: pages }));
  assert.equal(binary.candidates[0].status, "unresolved");
  assert.ok(binary.warnings.some((warning) => /not an HTML page/.test(warning)));
  const privateLog: FetchLog = [];
  const local = await resolveInput("http://localhost:3000/secret", testOptions({ log: privateLog }));
  assert.equal(privateLog.length, 0, "private addresses are never fetched");
  assert.equal(local.candidates[0].csl.type, "webpage");
});

test("a pasted bibliography resolves each item, at most four at a time, in order", async () => {
  let active = 0;
  let peak = 0;
  const calls: ModelCall[] = [];
  const complete: ResolveOptions["complete"] = async (messages) => {
    calls.push({ messages });
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const text = String(messages[1].content);
    const title = text.match(/Item number (\d+)/)?.[0] ?? "Unknown";
    return { content: JSON.stringify({ found: true, type: "article-journal", title, authors: ["Ada Lovelace"], year: 2001 }) };
  };
  const bibliography = Array.from({ length: 7 }, (_, index) => `[${index + 1}] Lovelace, A. Item number ${index + 1}. Journal of Tests, 2001.`).join("\n");
  const { candidates } = await resolveInput(bibliography, testOptions({ complete, settings: testSettings({ lookupOnline: false }) }));
  assert.equal(candidates.length, 7);
  assert.deepEqual(candidates.map((candidate) => candidate.csl.title), Array.from({ length: 7 }, (_, index) => `Item number ${index + 1}`));
  assert.ok(peak <= 4 && peak > 1, `peak concurrency ${peak}`);
  for (const candidate of candidates) {
    assert.equal(candidate.status, "unresolved");
    assert.equal(candidate.provenance?.title?.source, "llm");
    assert.ok((candidate.provenance?.title?.confidence ?? 1) <= 0.5);
  }
});

test("BibTeX is parsed without lookups, and enriched from Crossref only when asked", async () => {
  const bibtex = `@article{schmidhuber2015,
  author = {Schmidhuber, J{\\"u}rgen},
  title = {Deep learning in neural networks: an overview},
  journal = {Neural Netw.},
  year = {2015},
  doi = {10.1016/j.neunet.2014.09.003}
}
@book{plain, title = {No identifiers here}}`;
  const log: FetchLog = [];
  const parsed = await resolveInput(bibtex, testOptions({ log }));
  assert.equal(log.length, 0);
  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.candidates[0].status, "confirmed");
  assert.equal(parsed.candidates[1].status, "needs-review");
  assert.equal(parsed.candidates[0].provenance?.title?.source, "import");
  const enriched = await resolveInput(bibtex, testOptions({ enrich: true, log }));
  assert.ok(log.some((request) => request.url.startsWith("https://api.crossref.org/works/10.1016")));
  const [entry] = enriched.candidates;
  assert.equal(entry.csl["container-title"], "Neural Netw.", "the user's value stays");
  assert.equal(entry.conflicts?.["container-title"]?.[0].value, "Neural Networks");
  assert.equal(entry.csl.volume, "61", "gaps are filled");
  assert.equal(entry.provenance?.volume?.source, "crossref");
});

test("duplicates are reported against the library, with preprint/published pairs flagged", async () => {
  const library = libraryWith(
    { id: "ref_same_doi", csl: { type: "article-journal", title: "Deep learning in neural networks: An overview" }, identifiers: { doi: "10.1016/j.neunet.2014.09.003" } },
    { id: "ref_preprint", csl: { type: "article", title: "Deep Learning in Neural Networks: An Overview", author: [{ family: "Schmidhuber", given: "Juergen" }], issued: { "date-parts": [[2014]] } }, identifiers: { arxiv: "1404.7828" } },
    { id: "ref_unrelated", csl: { type: "book", title: "Cooking for engineers" } },
  );
  const { duplicates } = await resolveInput("10.1016/j.neunet.2014.09.003", testOptions({ library }));
  assert.deepEqual(duplicates.map(({ entryId, reason, score, preprintPair }) => ({ entryId, reason, score, preprintPair })), [
    { entryId: "ref_same_doi", reason: "doi", score: 1, preprintPair: undefined },
    { entryId: "ref_preprint", reason: "arxiv", score: 1, preprintPair: true },
  ]);
  const fuzzyLibrary = libraryWith({ id: "ref_fuzzy", csl: { type: "article-journal", title: "A self-organizing short-term dynamical memory network", author: [{ family: "Federer" }], issued: { "date-parts": [[2018]] } } });
  const fuzzy = await resolveInput("10.1016/j.neunet.2018.06.008", testOptions({ library: fuzzyLibrary }));
  assert.equal(fuzzy.duplicates[0].reason, "fuzzy");
  assert.ok(fuzzy.duplicates[0].score >= 0.9 && fuzzy.duplicates[0].score < 1);
});

test("LLM + web: fields cite consulted pages; unconsulted citations are downgraded or dropped", async () => {
  const calls: ModelCall[] = [];
  const reply = {
    content: JSON.stringify({
      found: true, type: "report",
      fields: {
        title: { value: "State of the Rivers 2023", url: "https://rivers.example/report-2023" },
        author: { value: ["River Agency"], url: "https://rivers.example/report-2023" },
        issued: { value: "2023-06", url: "https://rivers.example/report-2023/" },
        publisher: { value: "River Agency", url: "https://hallucinated.example/about" },
        DOI: { value: "10.9999/made.up", url: "https://hallucinated.example/doi" },
      },
    }),
    webCitations: [{ url: "https://www.rivers.example/report-2023#summary" }],
  };
  const complete = mockModel(["not json at all", reply], calls);
  const result = await resolveInput("River Agency. State of the rivers report, 2023.", testOptions({ complete, webSearch: true, routes: emptySearch }));
  const [candidate] = result.candidates;
  assert.equal(calls.length, 2, "invalid JSON is repaired once");
  assert.deepEqual(calls[0].options?.webSearch, { maxResults: 5 });
  assert.match(String(calls[1].messages.at(-1)?.content), /failed validation/);
  assert.equal(candidate.status, "needs-review");
  assert.equal(candidate.csl.type, "report");
  assert.deepEqual(candidate.provenance?.title, { source: "llm-web", confidence: 0.7, url: "https://rivers.example/report-2023", retrievedAt: FIXED_NOW.toISOString() });
  assert.equal(candidate.provenance?.issued?.source, "llm-web", "a trailing slash is the same page");
  assert.deepEqual(candidate.provenance?.publisher, { source: "llm", confidence: 0.3, retrievedAt: FIXED_NOW.toISOString() }, "a page the model did not consult is downgraded");
  assert.equal(candidate.csl.DOI, undefined, "an identifier citing an unconsulted page is dropped");
  assert.equal(candidate.identifiers?.doi, undefined);
  assert.ok(result.warnings.some((warning) => /Unverified web fields.*publisher/.test(warning)));
  assert.ok(result.warnings.some((warning) => /Dropped web fields.*DOI/.test(warning)));

  const noWeb = await resolveInput("River Agency. State of the rivers report, 2023.", testOptions({ complete: mockModel([JSON.stringify({ found: true, type: "report", title: "State of the rivers report", authors: ["River Agency"], year: 2023 })]), routes: emptySearch }));
  assert.equal(noWeb.candidates[0].status, "unresolved", "without web search the model only parses the string");
  assert.equal(noWeb.candidates[0].provenance?.title?.source, "llm");
});

test("preferences gate lookups and AI: parse-only when both are off", async () => {
  const log: FetchLog = [];
  const offline = await resolveInput("10.1016/j.neunet.2018.06.008", testOptions({ log, settings: testSettings({ lookupOnline: false, useAi: false }) }));
  assert.equal(log.length, 0);
  assert.equal(offline.candidates[0].status, "unresolved");
  assert.equal(offline.candidates[0].csl.DOI, "10.1016/j.neunet.2018.06.008");
  assert.ok(offline.warnings.some((warning) => /turned off/.test(warning)));

  const calls: ModelCall[] = [];
  const text = "Smith, J. (2020). “A study of something important”. Journal of Studies 3.";
  const parseOnly = await resolveInput(text, testOptions({ log, complete: mockModel(["{}"], calls), settings: testSettings({ lookupOnline: false, useAi: false }) }));
  assert.equal(calls.length, 0, "AI off: no model call even with a key");
  assert.equal(log.length, 0);
  assert.equal(parseOnly.candidates[0].csl.title, "A study of something important");
  assert.deepEqual(parseOnly.candidates[0].csl.issued, { "date-parts": [[2020]] });
  assert.equal(parseOnly.candidates[0].status, "unresolved");

  const aiOnly = await resolveInput(text, testOptions({ log, complete: mockModel([JSON.stringify({ found: true, title: "A study of something important", authors: ["J. Smith"], year: 2020, venue: "Journal of Studies" })]), settings: testSettings({ lookupOnline: false, useAi: true }) }));
  assert.equal(log.length, 0, "online off: the model is used, nothing is looked up");
  assert.equal(aiOnly.candidates[0].csl["container-title"], "Journal of Studies");
});

test("cancelling a resolve aborts its upstream requests", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const slow: Route[] = [{
    match: (url) => url.host === "api.crossref.org",
    respond: () => new Promise<Response>((_resolve, reject) => {
      queueMicrotask(() => controller.abort());
      const check = setInterval(() => {
        if (seen?.aborted) {
          clearInterval(check);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }
      }, 1);
    }),
  }];
  const options = testOptions({ routes: slow, signal: controller.signal });
  const http = options.http!;
  const original = http.getText.bind(http);
  http.getText = (url, requestOptions) => {
    seen = requestOptions?.signal;
    return original(url, requestOptions);
  };
  await assert.rejects(resolveInput("10.1016/j.neunet.2018.06.008", options), (error: unknown) => isAbortError(error));
  assert.equal(seen?.aborted, true);
});

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

function pdfDeps(pages: string[], metadata: Partial<PdfDocumentMetadata> = {}): ResolveOptions["pdf"] {
  return {
    readText: async () => ({ pages: pages.map((text, index) => ({ pageNumber: index + 1, text })) }),
    readMetadata: async () => ({ dois: [], ...metadata }),
  };
}

test("a PDF's DOI that belongs to a cited work is skipped for the next identifier on page 1", async () => {
  const page1 = [
    "Neural Networks 106 (2018) 30–41",
    "Building on the survey of deep learning (doi:10.1016/j.neunet.2014.09.003), we ask how memory emerges.",
    "A self-organizing short-term",
    "dynamical memory network",
    "Callie Federer, Joel Zylberberg",
    "https://doi.org/10.1016/j.neunet.2018.06.008",
  ].join("\n");
  const result = await resolvePdf("Notes/papers/federer.pdf", testOptions({ pdf: pdfDeps([page1, "Introduction ..."], { title: "Microsoft Word - draft.docx" }) }));
  const [candidate] = result.candidates;
  assert.equal(candidate.csl.DOI, "10.1016/j.neunet.2018.06.008");
  assert.equal(candidate.status, "needs-review");
  assert.deepEqual(candidate.attachments, [{ kind: "pdf", path: "Notes/papers/federer.pdf" }]);
  assert.ok(result.warnings.some((warning) => /10\.1016\/j\.neunet\.2014\.09\.003 names another work/.test(warning)));
  assert.equal(candidate.conflicts?.title, undefined, "a placeholder metadata title is not evidence");
});

test("a PDF without identifiers: the model reads page 1, Crossref/OpenAlex are searched and scored", async () => {
  const calls: ModelCall[] = [];
  const complete = mockModel([JSON.stringify({ found: true, type: "article-journal", title: "Deep learning in neural networks: an overview", authors: ["Jürgen Schmidhuber"], year: 2014, venue: "Neural Netw" })], calls);
  const page1 = "Review\nDeep learning in neural networks: An overview\nJürgen Schmidhuber\nThe Swiss AI Lab IDSIA\nAbstract In recent years, deep artificial neural networks have won numerous contests.";
  const result = await resolvePdf("Notes/survey.pdf", testOptions({ complete, pdf: pdfDeps([page1], { title: "Deep learning in neural networks", author: "J. Schmidhuber" }) }));
  const [candidate] = result.candidates;
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].messages[1].content), /<<<FIRST PAGE\nReview\nDeep learning/);
  assert.equal(candidate.status, "needs-review");
  assert.equal(candidate.csl.DOI, "10.1016/j.neunet.2014.09.003");
  assert.equal(candidate.provenance?.title?.source, "crossref");
  assert.deepEqual(candidate.conflicts?.issued?.map((alternative) => alternative.value), [{ "date-parts": [[2014, 10, 13]] }], "the year the model (and OpenAlex) read is offered once");
  assert.ok(candidate.conflicts?.["container-title"]?.some((alternative) => alternative.value === "Neural Netw"));
  assert.ok(candidate.conflicts?.title?.some((alternative) => alternative.provenance.source === "pdf-metadata"), "the PDF's own title is evidence too");
  assert.deepEqual(candidate.attachments, [{ kind: "pdf", path: "Notes/survey.pdf" }]);

  const unmatched = await resolvePdf("Notes/survey.pdf", testOptions({ complete: mockModel([JSON.stringify({ found: true, title: "A field guide to invented things", authors: ["Nobody Known"], year: 2030 })]), routes: emptySearch, pdf: pdfDeps([page1]) }));
  const [low] = unmatched.candidates;
  assert.equal(low.status, "unresolved");
  assert.equal(low.csl.title, "A field guide to invented things");
  assert.equal(low.provenance?.title?.source, "llm");
  assert.ok((low.provenance?.title?.confidence ?? 1) <= 0.5);
});

test("a scanned PDF without a text layer stays unresolved, titled from its file name", async () => {
  const result = await resolvePdf("Notes/scans/Smith_2019_field_notes.pdf", testOptions({ pdf: pdfDeps(["", "  "]) }));
  const [candidate] = result.candidates;
  assert.equal(candidate.status, "unresolved");
  assert.equal(candidate.csl.title, "Smith 2019 field notes");
  assert.equal(candidate.provenance?.title?.source, "pdf-metadata");
  assert.ok(result.warnings.some((warning) => /No text layer/.test(warning)));
});

test("with AI off a PDF's first line is the title hint, and a title alone is not enough to match", async () => {
  const log: FetchLog = [];
  const page1 = "Deep learning in neural networks: An overview\nSome Author\nAbstract: text text text text text text";
  const result = await resolvePdf("Notes/x.pdf", testOptions({ log, pdf: pdfDeps([page1]) }));
  assert.ok(log.some((request) => request.url.includes("query.bibliographic=Deep+learning+in+neural+networks")));
  assert.equal(result.candidates[0].status, "unresolved");
  assert.equal(result.candidates[0].provenance?.title?.source, "pdf-text");
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

test("a converted <pdf name>.md is attached to the PDF's entry instead of becoming a candidate", async () => {
  const library = libraryWith({ id: "ref_pdf", attachments: [{ kind: "pdf", path: "Notes/papers/smith.pdf" }] });
  for (const markdown of ["Notes/papers/smith.md", "Notes/papers/smith (2).md", "Notes/papers/smith.pdf.md"]) {
    const result = await resolveMarkdown(markdown, testOptions({ library, markdown: { readText: async () => { throw new Error("not read"); } } }));
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.updates, [{ op: "attach", id: "ref_pdf", attachment: { kind: "markdown", path: markdown } }]);
  }
});

test("other notes get a proposed entry from front matter, heading and first section", async () => {
  const note = "---\ntitle: \"Field notes on rivers\"\nauthor:\n  - Claire Martin\ndate: 2024-05-02\n---\n# Rivers\n\nNotes from the spring survey.\n\n## Later\nMore.";
  const calls: ModelCall[] = [];
  const complete = mockModel([JSON.stringify({ found: true, type: "manuscript", title: "Rivers", authors: ["C. Martin"], year: 2024 })], calls);
  const result = await resolveMarkdown("Notes/rivers.md", testOptions({ complete, markdown: { readText: async () => note } }));
  const [candidate] = result.candidates;
  assert.match(String(calls[0].messages[1].content), /First heading: Rivers/);
  assert.match(String(calls[0].messages[1].content), /Notes from the spring survey/);
  assert.equal(candidate.status, "needs-review");
  assert.equal(candidate.csl.type, "manuscript");
  assert.equal(candidate.csl.title, "Field notes on rivers", "the front matter wins over the model");
  assert.deepEqual(candidate.csl.author, [{ family: "Martin", given: "Claire" }]);
  assert.deepEqual(candidate.csl.issued, { "date-parts": [[2024, 5, 2]] });
  assert.deepEqual(candidate.attachments, [{ kind: "markdown", path: "Notes/rivers.md" }]);

  const plain = await resolveMarkdown("Notes/ideas.md", testOptions({ markdown: { readText: async () => "Just some text without a heading." } }));
  assert.equal(plain.candidates[0].csl.title, "ideas");
  assert.equal(plain.candidates[0].csl.type, "manuscript");
  assert.equal(plain.candidates[0].status, "needs-review");
});
