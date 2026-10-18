import assert from "node:assert/strict";
import test from "node:test";
import { parseArxivFeed, fetchArxivRecord } from "../../src/lib/references/resolve/arxiv";
import { fetchCrossrefWork, mapCrossrefWork, searchCrossref } from "../../src/lib/references/resolve/crossref";
import { fetchDataciteRecord } from "../../src/lib/references/resolve/datacite";
import { HttpClient, HttpError, LIBERA_USER_AGENT, isAbortError } from "../../src/lib/references/resolve/http";
import { MATCH_THRESHOLD, scoreMatch, scoreReferenceText, titleAppearsInText, titleScore, titleSimilarityInText } from "../../src/lib/references/resolve/match";
import { abstractFromInvertedIndex, fetchOpenAlexWork, searchOpenAlex } from "../../src/lib/references/resolve/openalex";
import { fetchOpenLibraryRecord } from "../../src/lib/references/resolve/openlibrary";
import { fetchPubmedRecord, mapPubmedRecord, pmidForPmcid } from "../../src/lib/references/resolve/pubmed";
import { recordToInput, type ResolveContext } from "../../src/lib/references/resolve/record";
import { pageMetadataToInput, parseLooseDate, parsePageMetadata } from "../../src/lib/references/resolve/url";
import { FIXED_NOW, fixture, fixtureFetch, testHttpClient, type FetchLog } from "./references-resolve-helpers";

function context(log: FetchLog = [], contactEmail?: string): ResolveContext {
  return {
    http: testHttpClient(fixtureFetch(log)),
    now: () => FIXED_NOW,
    network: (task) => task(),
    llm: (task) => task(),
    ...(contactEmail ? { contactEmail } : {}),
  };
}

test("Crossref works map to CSL with provenance, the journal abbreviation and preprint links", async () => {
  const log: FetchLog = [];
  const record = await fetchCrossrefWork("10.1016/j.neunet.2018.06.008", context(log));
  assert.ok(record);
  assert.equal(log[0].url, "https://api.crossref.org/works/10.1016%2Fj.neunet.2018.06.008");
  assert.equal((log[0].init?.headers as Record<string, string>)["User-Agent"], LIBERA_USER_AGENT);
  assert.equal(record.source, "crossref");
  assert.deepEqual(record.csl.author, [{ family: "Federer", given: "Callie" }, { family: "Zylberberg", given: "Joel" }]);
  assert.equal(record.csl.type, "article-journal");
  assert.equal(record.csl.title, "A self-organizing short-term dynamical memory network");
  assert.equal(record.csl["container-title"], "Neural Networks");
  assert.equal(record.csl["container-title-short"], undefined, "an abbreviation equal to the title adds nothing");
  assert.deepEqual(record.csl.issued, { "date-parts": [[2018, 10]] });
  assert.equal(record.csl.volume, "106");
  assert.equal(record.csl.page, "30-41");
  assert.deepEqual(record.versions, [{ relation: "preprint-of", identifier: "10.1101/144683" }]);
  const input = recordToInput(record);
  assert.equal(input.csl.page, "30–41");
  assert.deepEqual(input.provenance?.title, { source: "crossref", confidence: 0.95, url: "https://api.crossref.org/works/10.1016%2Fj.neunet.2018.06.008", retrievedAt: FIXED_NOW.toISOString() });
  assert.ok(Object.keys(input.csl).every((field) => input.provenance?.[field]), "every field has provenance");

  const notice = mapCrossrefWork({
    DOI: "10.1000/NOTICE", type: "journal-article", title: ["Retraction note"], subtitle: ["On a paper"], "container-title": ["Journal of Things"], "short-container-title": ["J. Things"],
    abstract: "<jats:title>Abstract</jats:title><jats:p>First.</jats:p><jats:p>Second.</jats:p>",
    "update-to": [{ DOI: "10.1000/original", type: "retraction" }], relation: { "is-preprint-of": [{ "id-type": "doi", id: "10.1000/published" }], "has-review": [{ "id-type": "doi", id: "10.1000/review" }] },
  }, FIXED_NOW.toISOString())!;
  assert.equal(notice.csl.title, "Retraction note: On a paper");
  assert.equal(notice.csl["container-title-short"], "J. Things");
  assert.equal(notice.csl.abstract, "First.\n\nSecond.");
  assert.equal(notice.csl.DOI, "10.1000/notice");
  assert.deepEqual(notice.versions, [{ relation: "published-as", identifier: "10.1000/published" }, { relation: "retraction", identifier: "10.1000/original" }]);
});

test("Crossref and OpenAlex receive the contact email only when one is configured", async () => {
  const anonymous: FetchLog = [];
  await searchCrossref("deep learning overview", context(anonymous));
  await searchOpenAlex("deep learning overview", context(anonymous));
  await fetchArxivRecord("1404.7828", context(anonymous));
  assert.ok(anonymous.every((request) => !request.url.includes("mailto")));
  const polite: FetchLog = [];
  await searchCrossref("deep learning overview", context(polite, "me@example.org"));
  await searchOpenAlex("deep learning overview", context(polite, "me@example.org"));
  await fetchArxivRecord("1404.7828", context(polite, "me@example.org"));
  await fetchPubmedRecord("23193287", context(polite, "me@example.org"));
  assert.equal(new URL(polite[0].url).searchParams.get("mailto"), "me@example.org");
  assert.equal(new URL(polite[1].url).searchParams.get("mailto"), "me@example.org");
  assert.ok(polite.slice(2).every((request) => !request.url.includes("mailto")), "arXiv and PubMed never get it");
});

test("Crossref search results map and carry their relevance order", async () => {
  const results = await searchCrossref("Deep learning in neural networks: An overview Schmidhuber 2015", context());
  assert.equal(results.length, 5);
  assert.equal(results[0].identifiers.doi, "10.1016/j.neunet.2014.09.003");
  assert.equal(results[2].csl.type, "paper-conference");
  assert.equal(results[3].csl.type, "chapter");
});

test("DataCite datasets map to CSL", async () => {
  const record = await fetchDataciteRecord("10.5061/dryad.8515", context());
  assert.ok(record);
  assert.equal(record.source, "datacite");
  assert.equal(record.csl.type, "dataset");
  assert.equal(record.csl.title, "Data from: A new malaria agent in African hominids.");
  assert.equal(record.csl.publisher, "Dryad");
  assert.deepEqual(record.csl.issued, { "date-parts": [[2011, 2, 1]] });
  assert.equal(record.csl.author?.length, 8);
  assert.deepEqual(record.csl.author?.[3], { family: "Douzery", given: "Emmanuel J. P." });
  assert.match(String(record.csl.abstract), /^Plasmodium falciparum/);
  assert.equal(record.csl.DOI, "10.5061/dryad.8515");
  assert.equal(await fetchDataciteRecord("10.5061/unknown", context()), null);
});

test("arXiv preprints map to CSL and report the journal DOI of the published version", () => {
  const [record] = parseArxivFeed(fixture("arxiv-1404.7828.xml"), FIXED_NOW.toISOString());
  assert.equal(record.source, "arxiv");
  assert.equal(record.csl.type, "article");
  assert.equal(record.csl.title, "Deep Learning in Neural Networks: An Overview");
  assert.deepEqual(record.csl.author, [{ family: "Schmidhuber", given: "Juergen" }]);
  assert.deepEqual(record.csl.issued, { "date-parts": [[2014, 4, 30]] });
  assert.equal(record.csl.publisher, "arXiv");
  assert.equal(record.csl.number, "arXiv:1404.7828");
  assert.equal(record.csl.DOI, "10.48550/arxiv.1404.7828");
  assert.match(String(record.csl.abstract), /^In recent years, deep artificial neural networks/);
  assert.deepEqual(record.identifiers, { arxiv: "1404.7828", doi: "10.48550/arxiv.1404.7828" });
  assert.equal(record.publishedDoi, "10.1016/j.neunet.2014.09.003");
  assert.equal(record.journalRef, "Neural Networks, Vol 61, pp 85-117, Jan 2015");
  assert.deepEqual(record.versions, [{ relation: "published-as", identifier: "10.1016/j.neunet.2014.09.003" }]);
  assert.deepEqual(parseArxivFeed("<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format</id><title>Error</title></entry></feed>", ""), []);
});

test("OpenAlex links the published work to its arXiv preprint and rebuilds abstracts", async () => {
  const record = await fetchOpenAlexWork({ doi: "10.1016/j.neunet.2014.09.003" }, context());
  assert.ok(record);
  assert.equal(record.source, "openalex");
  assert.equal(record.confidence, 0.85);
  assert.deepEqual(record.identifiers, { openalex: "W2076063813", doi: "10.1016/j.neunet.2014.09.003", pmid: "25462637", arxiv: "1404.7828" });
  assert.deepEqual(record.versions, [{ relation: "preprint-of", identifier: "arXiv:1404.7828" }]);
  assert.equal(record.csl["container-title"], "Neural Networks");
  assert.equal(record.csl.page, "85-117");
  assert.deepEqual(record.csl.author, [{ family: "Schmidhuber", given: "Jürgen" }]);
  const results = await searchOpenAlex("Deep learning in neural networks: An overview", context());
  assert.equal(results.length, 5);
  const withAbstract = results.find((item) => item.csl.abstract);
  assert.ok(withAbstract, "a search result with an inverted-index abstract is rebuilt");
  assert.ok(String(withAbstract.csl.abstract).split(" ").length > 100);
  assert.equal(abstractFromInvertedIndex({ Hello: [0], world: [1, 3], again: [2] }), "Hello world again world");
  assert.equal(abstractFromInvertedIndex(null), undefined);
});

test("PubMed records combine esummary and efetch; PMCIDs resolve through esearch", async () => {
  const ctx = context();
  assert.equal(await pmidForPmcid("PMC3531190", ctx), "23193287");
  const record = await fetchPubmedRecord("23193287", ctx);
  assert.ok(record);
  assert.equal(record.source, "pubmed");
  assert.equal(record.csl.title, "GenBank");
  assert.deepEqual(record.csl.author?.[0], { family: "Benson", given: "Dennis A" });
  assert.equal(record.csl.author?.length, 7);
  assert.equal(record.csl["container-title"], "Nucleic acids research");
  assert.equal(record.csl["container-title-short"], "Nucleic Acids Res");
  assert.deepEqual(record.csl.issued, { "date-parts": [[2013, 1]] });
  assert.equal(record.csl.language, "en");
  assert.match(String(record.csl.abstract), /^GenBank® \(http/);
  assert.deepEqual(record.identifiers, { pmid: "23193287", doi: "10.1093/nar/gks1195", pmcid: "PMC3531190" });
  const summary = JSON.parse(fixture("pubmed-esummary-23193287.json")).result["23193287"];
  const summaryOnly = mapPubmedRecord(summary, "", FIXED_NOW.toISOString())!;
  assert.deepEqual(summaryOnly.csl.author?.[0], { family: "Benson", given: "D. A." }, "without efetch the abbreviated names are used");
  assert.equal(summaryOnly.identifiers.pmcid, "PMC3531190");
});

test("Open Library ISBN records map to books with their authors", async () => {
  const log: FetchLog = [];
  const record = await fetchOpenLibraryRecord("9780131103627", context(log));
  assert.ok(record);
  assert.deepEqual(log.map((request) => new URL(request.url).pathname), ["/isbn/9780131103627.json", "/authors/OL946967A.json"]);
  assert.equal(record.source, "isbn");
  assert.equal(record.csl.type, "book");
  assert.equal(record.csl.title, "The C Programming Language");
  assert.deepEqual(record.csl.author, [{ family: "Kernighan", given: "Brian W." }]);
  assert.equal(record.csl.publisher, "Prentice Hall");
  assert.deepEqual(record.csl.issued, { "date-parts": [[1988]] });
  assert.equal(record.csl.edition, "2nd");
  assert.ok(record.identifiers.isbn?.includes("9780131103627"));
  assert.equal(await fetchOpenLibraryRecord("9780000000002", context()), null);
});

test("URL meta tags give identifiers, or a web page candidate", () => {
  const page = parsePageMetadata(fixture("arxiv-abs-1404.7828.html"), "https://arxiv.org/abs/1404.7828");
  assert.equal(page.doi, "10.1016/j.neunet.2014.09.003");
  assert.equal(page.arxiv, "1404.7828");
  assert.equal(page.title, "Deep Learning in Neural Networks: An Overview");
  assert.deepEqual(page.authors, ["Schmidhuber, Juergen"]);
  assert.deepEqual(parseLooseDate(page.date), { "date-parts": [[2014, 4, 30]] });

  const html = `<!doctype html><html lang="fr"><head><title>Ignored &amp; title</title>
    <meta property="og:title" content="Rapport annuel 2023">
    <meta property="og:site_name" content="Agence &amp; Co">
    <meta name="DC.creator" content="Martin, Claire">
    <meta property="article:published_time" content="2024-03-05T09:00:00Z">
    <meta name="DC.identifier" content="urn:isbn:none"></head><body></body></html>`;
  const report = parsePageMetadata(html, "https://agence.example/rapport");
  assert.equal(report.doi, undefined);
  assert.equal(report.title, "Rapport annuel 2023");
  const input = pageMetadataToInput(report, FIXED_NOW.toISOString())!;
  assert.equal(input.csl.type, "webpage");
  assert.equal(input.csl["container-title"], "Agence & Co");
  assert.deepEqual(input.csl.author, [{ family: "Martin", given: "Claire" }]);
  assert.deepEqual(input.csl.issued, { "date-parts": [[2024, 3, 5]] });
  assert.deepEqual(input.csl.accessed, { "date-parts": [[2026, 10, 18]] });
  assert.equal(input.csl.language, "fr");
  assert.equal(input.status, "needs-review");
  assert.deepEqual(input.attachments, [{ kind: "url", url: "https://agence.example/rapport" }]);
  assert.deepEqual(input.provenance?.title, { source: "import", confidence: 0.6, url: "https://agence.example/rapport", retrievedAt: FIXED_NOW.toISOString() });
  assert.equal(pageMetadataToInput(parsePageMetadata("<html><head></head></html>", "https://x.example"), FIXED_NOW.toISOString()), null);
});

test("match scoring weighs title, authors and year; titles are found in noisy page text", () => {
  const work = { type: "article-journal" as const, title: "Deep learning in neural networks: An overview", author: [{ family: "Schmidhuber", given: "Jürgen" }], issued: { "date-parts": [[2015]] as [[number]] } };
  const exact = scoreMatch({ title: "Deep Learning in Neural Networks: An Overview", authors: ["Juergen Schmidhuber"], year: 2015 }, work);
  assert.ok(exact >= 0.99, String(exact));
  const yearOff = scoreMatch({ title: "Deep Learning in Neural Networks: An Overview", authors: ["J. Schmidhuber"], year: 2014 }, work);
  assert.ok(yearOff >= MATCH_THRESHOLD && yearOff < exact, String(yearOff));
  const wrongAuthorAndYear = scoreMatch({ title: "Deep Learning in Neural Networks: An Overview", authors: ["Someone Else"], year: 2001 }, work);
  assert.ok(wrongAuthorAndYear < MATCH_THRESHOLD, String(wrongAuthorAndYear));
  const otherTitle = scoreMatch({ title: "An overview of multi-task learning in deep neural networks", authors: ["Schmidhuber"], year: 2015 }, work);
  assert.ok(otherTitle < MATCH_THRESHOLD, String(otherTitle));
  assert.equal(scoreMatch({}, work), 0);
  const noisy = scoreMatch({ title: "Deep Leaming in Neural Networks: An 0verview", authors: ["Schmidhuber"], year: 2015 }, work);
  assert.ok(noisy >= MATCH_THRESHOLD, `OCR noise is tolerated: ${noisy}`);
  assert.ok(titleScore("Deep learning in neural networks", work.title) >= 0.9, "a dropped subtitle still matches");
  assert.ok(scoreMatch({ title: work.title }, work) < MATCH_THRESHOLD, "a title alone is not enough");
  assert.ok(scoreMatch({ title: work.title, authors: ["Other Person"], year: 2015 }, work) < MATCH_THRESHOLD, "the same title by someone else is not enough");

  const page = "Neural Networks 61 (2015) 85–117\nContents lists available at ScienceDirect\nReview\nDeep learning in neural net-\nworks: An overview\nJürgen Schmidhuber\nThe Swiss AI Lab IDSIA";
  assert.ok(titleSimilarityInText(work.title, page) > 0.9);
  assert.ok(titleAppearsInText(work.title, page));
  assert.equal(titleAppearsInText("A self-organizing short-term dynamical memory network", page), false);
  const reference = "Schmidhuber, J. (2015). Deep learning in neural networks: An overview. Neural Networks, 61, 85-117.";
  assert.ok(scoreReferenceText(reference, work) >= MATCH_THRESHOLD);
  assert.ok(scoreReferenceText("Smith, A. (1999). Cats and dogs.", work) < MATCH_THRESHOLD);
});

function clockedClient(responses: (Response | Error)[], options: { intervalMs?: number; retries?: number } = {}) {
  let now = 0;
  const starts: { url: string; at: number }[] = [];
  const sleeps: number[] = [];
  const client = new HttpClient({
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      sleeps.push(ms);
      now += Math.max(0, ms);
    },
    retries: options.retries,
    hostLimits: { "a.example": { intervalMs: options.intervalMs ?? 1_000, concurrency: 1 }, "b.example": { intervalMs: options.intervalMs ?? 1_000, concurrency: 1 } },
    fetch: async (url, init) => {
      if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      starts.push({ url, at: now });
      const next = responses.shift() ?? new Response("{}", { status: 200 });
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { client, starts, sleeps };
}

test("the HTTP client spaces requests per host, backs off on 429 and 5xx, and caches", async () => {
  const spaced = clockedClient([]);
  await Promise.all([1, 2, 3].map((n) => spaced.client.getJson(`https://a.example/${n}`)));
  await spaced.client.getJson("https://b.example/1");
  assert.deepEqual(spaced.starts.map((item) => item.at), [0, 1_000, 2_000, 2_000], "a.example is spaced; b.example has its own limiter");

  const limited = clockedClient([
    new Response("", { status: 429, headers: { "retry-after": "2" } }),
    new Response("", { status: 503 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ], { intervalMs: 0 });
  assert.deepEqual(await limited.client.getJson("https://a.example/x"), { ok: true });
  assert.equal(limited.starts.length, 3);
  assert.ok(limited.starts[1].at - limited.starts[0].at >= 2_000, "Retry-After is honoured");
  assert.equal(limited.starts[2].at - limited.starts[1].at, 1_000, "then exponential backoff");

  const failing = clockedClient([new Response("", { status: 500 }), new Response("", { status: 500 }), new Response("", { status: 500 })], { intervalMs: 0, retries: 2 });
  await assert.rejects(failing.client.getJson("https://a.example/y"), (error: unknown) => error instanceof HttpError && error.status === 500);
  assert.equal(failing.starts.length, 3);

  const badRequest = clockedClient([new Response("", { status: 400 })], { intervalMs: 0 });
  await assert.rejects(badRequest.client.getJson("https://a.example/z"), (error: unknown) => error instanceof HttpError && error.status === 400);
  assert.equal(badRequest.starts.length, 1, "4xx other than 429 is not retried");

  const flaky = clockedClient([new TypeError("fetch failed"), new Response(JSON.stringify([1]), { status: 200 })], { intervalMs: 0 });
  assert.deepEqual(await flaky.client.getJson("https://a.example/net"), [1]);

  const cached = clockedClient([new Response("", { status: 404 }), new Response(JSON.stringify({ a: 1 }))], { intervalMs: 0 });
  assert.equal(await cached.client.getJson("https://a.example/missing"), null);
  assert.equal(await cached.client.getJson("https://a.example/missing"), null);
  assert.deepEqual(await cached.client.getJson("https://a.example/present"), { a: 1 });
  assert.deepEqual(await cached.client.getJson("https://a.example/present"), { a: 1 });
  assert.equal(cached.starts.length, 2, "404s and successes are cached");

  const large = clockedClient([new Response("x".repeat(2_000))], { intervalMs: 0 });
  await assert.rejects(large.client.getText("https://a.example/big", { maxBytes: 1_000 }), (error: unknown) => error instanceof HttpError && error.status === 413);
});

test("cancelling aborts waiting and in-flight requests", async () => {
  const waiting = clockedClient([]);
  const controller = new AbortController();
  await waiting.client.getJson("https://a.example/first");
  controller.abort();
  await assert.rejects(waiting.client.getJson("https://a.example/second", { signal: controller.signal }), (error: unknown) => isAbortError(error));
  assert.equal(waiting.starts.length, 1);

  let received: AbortSignal | undefined;
  const client = new HttpClient({
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      received = init?.signal ?? undefined;
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  const inflight = new AbortController();
  const pending = client.getJson("https://c.example/slow", { signal: inflight.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  inflight.abort();
  await assert.rejects(pending, (error: unknown) => isAbortError(error));
  assert.equal(received?.aborted, true, "the upstream request was aborted");
});

test("reference preferences come from the config file, else the environment; the model defaults to AI Formatting's", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { getReferenceResolveSettings, DEFAULT_REFERENCE_SETTINGS } = await import("../../src/lib/references/resolve/settings");
  const { getAiFunctionOptions } = await import("../../src/lib/ai-preferences");
  const keys = ["LIBERA_CONFIG_PATH", "LIBERA_REFERENCES_LOOKUP_ONLINE", "LIBERA_REFERENCES_USE_AI", "LIBERA_REFERENCES_WEB_SEARCH", "LIBERA_REFERENCES_CONTACT_EMAIL", "LIBERA_REFERENCES_AUTO_CREATE_PDFS", "LIBERA_AI_FORMATTING_MODEL", "LIBERA_AI_REFERENCES_MODEL", "LIBERA_AI_REFERENCES_REASONING_EFFORT"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-reference-settings-"));
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(getReferenceResolveSettings(), DEFAULT_REFERENCE_SETTINGS);
    assert.deepEqual(DEFAULT_REFERENCE_SETTINGS, { lookupOnline: true, useAi: true, webSearchDefault: false, contactEmail: "", autoCreateForPdfs: false });
    process.env.LIBERA_REFERENCES_LOOKUP_ONLINE = "false";
    process.env.LIBERA_REFERENCES_WEB_SEARCH = "true";
    process.env.LIBERA_REFERENCES_CONTACT_EMAIL = "not-an-email";
    assert.deepEqual(getReferenceResolveSettings(), { ...DEFAULT_REFERENCE_SETTINGS, lookupOnline: false, webSearchDefault: true });
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ aiFunctions: { references: { useAi: false, contactEmail: "me@example.org", autoCreateForPdfs: true } } }));
    process.env.LIBERA_CONFIG_PATH = configPath;
    assert.deepEqual(getReferenceResolveSettings(), { lookupOnline: true, useAi: false, webSearchDefault: false, contactEmail: "me@example.org", autoCreateForPdfs: true });

    process.env.LIBERA_AI_FORMATTING_MODEL = "provider/formatting";
    process.env.LIBERA_AI_REFERENCES_MODEL = "";
    assert.deepEqual(getAiFunctionOptions("references"), { model: "provider/formatting", reasoning: { effort: "low" }, promptCaching: false });
    process.env.LIBERA_AI_REFERENCES_MODEL = "provider/references";
    process.env.LIBERA_AI_REFERENCES_REASONING_EFFORT = "high";
    assert.deepEqual(getAiFunctionOptions("references"), { model: "provider/references", reasoning: { effort: "high" }, promptCaching: false });
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
