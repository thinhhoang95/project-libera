import assert from "node:assert/strict";
import test from "node:test";
import { ALL_TOOLS, toolsForPermission } from "../../src/lib/agent/tools";
import { AGENT_PERMISSIONS } from "../../src/lib/agent/types";
import { referencesTool } from "../../src/lib/agent/references-tool";
import { listCitations, listCitationsTool, locatorPages } from "../../src/lib/agent/fact-check/list-citations";
import { LONG_PDF_PAGES, planBatches, recordingWebSearch } from "../../src/lib/agent/fact-check/check-citations";
import { scopedReadTools } from "../../src/lib/agent/fact-check/read-scope";
import { findQuote, normalizeForMatch, normalizeUrl, QUOTE_MATCH_THRESHOLD, sourceTextLoader, verifyEvidence, verifyWebSources } from "../../src/lib/agent/fact-check/evidence";
import { checkExistence } from "../../src/lib/agent/fact-check/existence";
import { settleVerdict, submitVerdictsTool, VERDICTS_SCHEMA } from "../../src/lib/agent/fact-check/verdicts";
import { validateJsonSchema } from "../../src/lib/agent/subagents";
import { formatWebSearchResult } from "../../src/lib/agent/web-search";
import { readReferenceLibrary } from "../../src/lib/storage/references";
import { fixtureFetch, testHttpClient, testSettings, type FetchLog } from "./references-resolve-helpers";
import { addWorks, entryId, makeContext, withLibrary, work, writePdf, writeText } from "./references-factcheck-helpers";

// ---------------------------------------------------------------------------
// References tool
// ---------------------------------------------------------------------------

test("References is offered in every permission and looks entries up by key, alias and query", async () => {
  for (const permission of AGENT_PERMISSIONS) assert.ok(toolsForPermission(permission).some((tool) => tool.name === "References"), permission);
  assert.equal(ALL_TOOLS.find((tool) => tool.name === "References")!.kind, "read");
  await withLibrary(async ({ root }) => {
    const { context } = makeContext("read-only");
    assert.match((await referencesTool.run({ query: "anything" }, context)).text, /is empty/);
    await writePdf(root, "Research/papers/smith.pdf", ["Sparse attention."]);
    await addWorks([
      work("smith2020sparse", "Sparse attention for long documents", "Smith", 2020, {
        identifiers: { doi: "10.1000/sparse" }, attachments: [{ kind: "pdf", path: "Research/papers/smith.pdf" }], tags: ["attention"],
        csl: { "container-title": "Journal of Tests", abstract: `We study sparse attention. ${"Long abstract. ".repeat(80)}` },
      }),
      work("lee2021dense", "Dense retrieval at scale", "Lee", 2021, { status: "unresolved" }),
      work("smith2018old", "Older work on attention", "Smith", 2018),
    ], (library) => [{ op: "rename-key", id: entryId(library, "lee2021dense"), key: "lee2021" }]);

    const byKey = await referencesTool.run({ keys: ["smith2020sparse", "@lee2021dense", "missing2000"] }, context);
    assert.match(byKey.text, /@smith2020sparse · confirmed/);
    assert.match(byKey.text, /Reference: Smith, A\. \(2020\)\. Sparse attention for long documents\. Journal of Tests\./);
    assert.match(byKey.text, /Identifiers: DOI 10\.1000\/sparse/);
    assert.match(byKey.text, /Attachments: Research\/papers\/smith\.pdf/);
    assert.match(byKey.text, /Abstract: We study sparse attention\. .*…/);
    assert.ok(byKey.text.split("Abstract: ")[1].split("\n")[0].length <= 600);
    assert.match(byKey.text, /@lee2021 \(aliases: @lee2021dense\) · unresolved/, "an alias resolves to the renamed entry");
    assert.match(byKey.text, /No entry has the key or alias @missing2000\./);

    const caseless = await referencesTool.run({ keys: ["SMITH2018OLD"] }, context);
    assert.match(caseless.text, /@smith2018old/);

    const query = await referencesTool.run({ query: "smith attention" }, context);
    assert.deepEqual([...query.text.matchAll(/^@(\S+)/gm)].map((match) => match[1]), ["smith2020sparse", "smith2018old"], "newer first among equal matches");
    assert.match((await referencesTool.run({ query: "2021" }, context)).text, /@lee2021 /);
    assert.match((await referencesTool.run({ query: "attention", limit: 1 }, context)).text, /Showing 1 of 2 matches/);
    assert.match((await referencesTool.run({ query: "nonexistent words" }, context)).text, /No entries .* match/);
    assert.equal(referencesTool.describe({ keys: ["a", "b"] }), "Looking up @a, @b in References");

    await assert.rejects(referencesTool.run({}, makeContext("read-only", { notebook: null }).context), /No notebook is selected/);
  });
});

// ---------------------------------------------------------------------------
// ListCitations
// ---------------------------------------------------------------------------

const DRAFT = `# Results

Sparse attention cuts memory use by 40% [@smith2020, p. 2]. It also helps recall.

Dense retrieval scales well. [@lee2021, p. 45]

Printed pages work [@park2019, p. 345], as do ghosts [@ghost2022] and \`[@code2020]\` is code.

- A list item cites a retracted study [@retracted2017].
`;

async function seedListing(root: string) {
  await writePdf(root, "Research/papers/smith.pdf", ["Intro page.", "Memory use fell by 40% with sparse attention.", "Conclusions."]);
  await writePdf(root, "Research/papers/lee.pdf", ["Dense retrieval.", "Scaling."]);
  await writePdf(root, "Research/papers/park.pdf", Array.from({ length: 12 }, (_, index) => `Park page ${index + 1}.`));
  await writeText(root, "Research/draft.md", DRAFT);
  return addWorks([
    work("smith2020", "Sparse attention", "Smith", 2020, { attachments: [{ kind: "pdf", path: "Research/papers/smith.pdf" }] }),
    work("lee2021", "Dense retrieval", "Lee", 2021, { attachments: [{ kind: "pdf", path: "Research/papers/lee.pdf" }], status: "unresolved" }),
    work("park2019", "Printed pages", "Park", 2019, { attachments: [{ kind: "pdf", path: "Research/papers/park.pdf" }], csl: { page: "340-351" } }),
    work("retracted2017", "A retracted study", "Ret", 2017),
  ], (library) => [{ op: "update", id: entryId(library, "retracted2017"), retraction: { state: "retracted", checkedAt: "2026-10-01T00:00:00.000Z" } }]);
}

test("ListCitations gives each occurrence its claim, works, page counts and static problems", async () => {
  await withLibrary(async ({ root }) => {
    await seedListing(root);
    const { context } = makeContext("read-only");
    const listing = await listCitations(context, "Research/draft.md");
    assert.deepEqual(listing.occurrences.map((occurrence) => [occurrence.id, occurrence.raw, occurrence.line]), [
      ["c1", "[@smith2020, p. 2]", 3],
      ["c2", "[@lee2021, p. 45]", 5],
      ["c3", "[@park2019, p. 345]", 7],
      ["c4", "[@ghost2022]", 7],
      ["c5", "[@retracted2017]", 9],
    ], "code spans are skipped");
    const [c1, c2, c3, c4, c5] = listing.occurrences;
    assert.equal(c1.claim, "Sparse attention cuts memory use by 40% [@smith2020, p. 2].");
    assert.equal(c1.paragraph, "Sparse attention cuts memory use by 40% [@smith2020, p. 2]. It also helps recall.");
    assert.equal(c2.claim, "Dense retrieval scales well. [@lee2021, p. 45]", "a citation after the full stop belongs to the sentence before");
    assert.equal(c5.claim, "A list item cites a retracted study [@retracted2017].");
    assert.equal(listing.text.slice(c5.blockRange.start, c5.blockRange.end), "A list item cites a retracted study [@retracted2017].", "the innermost block, not the whole list");
    assert.deepEqual(c1.problems, []);
    assert.deepEqual(c2.problems.map((problem) => problem.kind), ["locator-out-of-range", "entry-unresolved"]);
    assert.match(c2.problems[0].message, /p\. 45 is beyond the attached PDF's last page \(2\)/);
    assert.deepEqual(c3.problems, [], "p. 345 is a printed page inside 340–351");
    assert.deepEqual(c4.problems.map((problem) => problem.kind), ["unknown-key"]);
    assert.deepEqual(c5.problems.map((problem) => problem.kind), ["entry-without-attachment", "entry-retracted"]);

    const text = (await listCitationsTool.run({ path: "Research/draft.md" }, context)).text;
    assert.match(text, /^Citations in Research\/draft\.md: 5 occurrences citing 5 works; 5 static problems\./);
    assert.match(text, /c1 · line 3 · \[@smith2020, p\. 2\]\n  Claim: “Sparse attention cuts memory use by 40% \[@smith2020, p\. 2\]\.”\n  - @smith2020 \(p\. 2\) → Smith, A\. \(2020\)\. Sparse attention\. · confirmed · Research\/papers\/smith\.pdf \(3 pages\)/);
    assert.match(text, /Research\/papers\/park\.pdf \(12 pages; printed pages 340–351 are PDF pages 1–12\)/);
    assert.match(text, /! unknown-key: @ghost2022 is not in the notebook's References library\./);

    // The unsaved draft is what gets checked.
    context.drafts.set("Research/draft.md", "Only one claim [@smith2020].\n");
    assert.deepEqual((await listCitations(context, "Research/draft.md")).occurrences.map((occurrence) => occurrence.raw), ["[@smith2020]"]);
    await assert.rejects(listCitations(context, "Research/papers/smith.pdf"), /not a Markdown file/);
  });
});

test("locators name pages, ranges and printed pages; non-page locators are not checked", () => {
  assert.deepEqual(locatorPages({ locator: "12" }), [12]);
  assert.deepEqual(locatorPages({ locator: "12-14" }), [12, 13, 14]);
  assert.deepEqual(locatorPages({ locator: "345–52" }), [345, 346, 347, 348, 349, 350, 351, 352]);
  assert.deepEqual(locatorPages({ locator: "3, 7" }), [3, 7]);
  assert.deepEqual(locatorPages({ locator: "12f" }), [12]);
  assert.deepEqual(locatorPages({ locator: "xii" }), []);
  assert.deepEqual(locatorPages({ locator: "4", label: "chapter" }), []);
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

test("batches hold at most three sources, two with a long PDF, and an occurrence joins each of its sources' batches", async () => {
  await withLibrary(async ({ root }) => {
    const keys = ["a2020", "b2020", "c2020", "d2020", "e2020"];
    for (const key of keys) await writePdf(root, `Research/papers/${key}.pdf`, ["Page one.", "Page two."]);
    await writePdf(root, "Research/papers/long.pdf", Array.from({ length: LONG_PDF_PAGES + 10 }, (_, index) => `Long page ${index + 1}.`));
    await addWorks([
      ...keys.map((key) => work(key, `Work ${key}`, key.toUpperCase(), 2020, { attachments: [{ kind: "pdf" as const, path: `Research/papers/${key}.pdf` }] })),
      work("long2020", "A long book", "Long", 2020, { attachments: [{ kind: "pdf", path: "Research/papers/long.pdf" }] }),
      work("nofile2020", "No file", "Nofile", 2020),
    ]);
    await writeText(root, "Research/draft.md", [
      "One [@a2020]. Two [@b2020]. Three [@c2020]. Four [@d2020; @a2020].",
      "Five [@e2020]. Long [@long2020, p. 3]. Missing [@nofile2020]. Unknown [@zzz1999].",
    ].join("\n\n"));
    const { context } = makeContext("read-only");
    const listing = await listCitations(context, "Research/draft.md");
    const all = new Set(listing.occurrences.map((occurrence) => occurrence.id));
    const { batches, statics } = planBatches(listing, all);
    assert.deepEqual(batches.map((batch) => batch.sources.map((source) => source.key)), [["a2020", "b2020", "c2020"], ["d2020", "e2020"], ["long2020"]]);
    assert.deepEqual(batches.map((batch) => batch.long), [false, false, true]);
    const shared = listing.occurrences.find((occurrence) => occurrence.raw === "[@d2020; @a2020]")!;
    assert.ok(batches[0].occurrences.includes(shared) && batches[1].occurrences.includes(shared), "a shared occurrence is checked in both batches");
    assert.deepEqual(batches[0].assignments.filter((assignment) => assignment.occurrence === shared.id).map((assignment) => assignment.key), ["a2020"]);
    assert.deepEqual(batches[1].assignments.filter((assignment) => assignment.occurrence === shared.id).map((assignment) => assignment.key), ["d2020"]);
    assert.deepEqual(batches[2].assignments[0].files, ["Research/papers/long.pdf"]);
    assert.deepEqual(statics.map((result) => [result.key, result.verdict]), [["nofile2020", "source-missing"], ["zzz1999", "source-missing"]]);

    // A long PDF caps its batch at two sources.
    const longFirst = { ...listing, occurrences: [listing.occurrences.find((occurrence) => occurrence.raw.includes("long2020"))!, ...listing.occurrences.filter((occurrence) => !occurrence.raw.includes("long2020"))] };
    assert.deepEqual(planBatches(longFirst, all).batches.map((batch) => batch.sources.map((source) => source.key)), [["long2020", "a2020"], ["b2020", "c2020", "d2020"], ["e2020"]]);
    // With web search, works without a file are checked on the web.
    const web = planBatches(listing, all, { webSearch: true });
    assert.ok(web.batches.some((batch) => batch.sources.some((source) => source.key === "nofile2020")));
    assert.deepEqual(web.statics.map((result) => result.key), ["zzz1999"]);
  });
});

// ---------------------------------------------------------------------------
// Read scope
// ---------------------------------------------------------------------------

test("the read scope refuses every path outside the batch's files and the document", async () => {
  await withLibrary(async ({ root }) => {
    await writePdf(root, "Research/papers/smith.pdf", ["Sparse attention cut memory by 40%."]);
    await writeText(root, "Research/draft.md", "Memory fell [@smith2020].\n");
    await writeText(root, "Research/secret.md", "Memory secrets.\n");
    await writeText(root, "Research/papers/other.md", "Memory elsewhere.\n");
    const { context } = makeContext("read-only");
    const [read, grep, glob] = scopedReadTools(["Research/papers/smith.pdf", "Research/draft.md"]);
    assert.match((await read.run({ file_path: "Research/papers/smith.pdf" }, context)).text, /--- Page 1 ---\nSparse attention/);
    assert.match((await read.run({ file_path: "draft.md" }, context)).text, /Memory fell/, "paths relative to the notebook resolve first");
    await assert.rejects(read.run({ file_path: "Research/secret.md" }, context), /Research\/secret\.md is outside this check\. You may read only these files: Research\/papers\/smith\.pdf, Research\/draft\.md\./);
    await assert.rejects(read.run({ file_path: "../../etc/passwd" }, context));
    await assert.rejects(grep.run({ pattern: "Memory", path: "Research" }, context), /outside this check/);
    const everywhere = await grep.run({ pattern: "Memory|memory", output_mode: "content" }, context);
    assert.match(everywhere.text, /Research\/papers\/smith\.pdf:page 1:/);
    assert.match(everywhere.text, /Research\/draft\.md:1:Memory fell/);
    assert.doesNotMatch(everywhere.text, /secret|other\.md/);
    assert.equal((await glob.run({ pattern: "*.md" }, context)).text, "Research/draft.md");
    assert.equal((await glob.run({ pattern: "**/*" }, context)).text, "Research/papers/smith.pdf\nResearch/draft.md");
    assert.match(read.description, /In this check you may read only: Research\/papers\/smith\.pdf, Research\/draft\.md\./);
  });
});

// ---------------------------------------------------------------------------
// Evidence verification
// ---------------------------------------------------------------------------

test("quotes match through case, whitespace, quotes, ligatures, hyphenation and small OCR errors", () => {
  assert.equal(normalizeForMatch("The “eﬃcient”  re-\nsult — here").text, "the \"efficient\" result - here");
  const page = "Our results show that sparse atten-\ntion reduced memory consumption by 40 percent across all benchmarks.";
  assert.equal(findQuote("sparse attention reduced memory consumption", page)!.ratio, 1, "hyphenation across a line break");
  assert.ok(findQuote("sparse attentlon reduced memorv consumption by 40 percent", page)!.ratio >= QUOTE_MATCH_THRESHOLD, "OCR slips");
  assert.equal(findQuote("sparse attention doubled memory consumption by 90 percent everywhere", page), null, "a different statement");
  assert.ok(findQuote("Our results show … by 40 percent", page), "an ellipsis splits the quote");
  assert.equal(findQuote("by 50 percent", page), null, "short quotes must match exactly");
  const match = findQuote("reduced memory", page)!;
  assert.equal(page.slice(match.start, match.end), "reduced memory");
});

test("evidence verification drops fabricated quotes, corrects adjacent pages, and needs returned URLs for web quotes", async () => {
  await withLibrary(async ({ root }) => {
    await writePdf(root, "Research/papers/smith.pdf", [
      "Title page of the study.",
      "Methods. We trained on the corpus for two weeks and measured memory use at the end of every",
      "epoch. Memory use fell by 40% with sparse attention in all runs.",
      "Discussion of limitations.",
      "Appendix: Memory use fell by 40% with sparse attention, restated.",
    ]);
    await writeText(root, "Research/papers/notes.md", "# Notes\n\nLine two.\nThe effect was small but consistent.\n");
    const { context } = makeContext("read-only");
    const loader = sourceTextLoader(context);
    const files = ["Research/papers/smith.pdf", "Research/papers/notes.md"];
    const { kept, dropped } = await verifyEvidence([
      { path: "Research/papers/smith.pdf", page: 3, quote: "Memory use fell by 40% with sparse attention in all runs." },
      { path: "Research/papers/smith.pdf", page: 2, quote: "Memory use fell by 40% with sparse attention in all runs." },
      { path: "Research/papers/smith.pdf", page: 2, quote: "measured memory use at the end of every epoch" },
      { path: "Research/papers/smith.pdf", page: 5, quote: "Discussion of limitations." },
      { path: "Research/papers/smith.pdf", quote: "Discussion of limitations." },
      { path: "Research/papers/smith.pdf", page: 3, quote: "Sparse attention tripled throughput on every benchmark we ran." },
      { path: "Research/papers/notes.md", quote: "The effect was small but consistent." },
      { path: "Research/papers/other.pdf", page: 1, quote: "Anything." },
    ], files, loader);
    assert.deepEqual(kept.map((item) => [item.page, item.line, item.pageCorrected]), [
      [3, undefined, undefined],
      [3, undefined, { from: 2, to: 3 }],
      [2, undefined, undefined],
      [4, undefined, { from: 5, to: 4 }],
      [4, undefined, undefined],
      [undefined, 4, undefined],
    ]);
    assert.deepEqual(dropped.map((item) => item.reason), [
      "evidence not found in source",
      "Research/papers/other.pdf is not an attached file of the cited work",
    ]);
    const far = await verifyEvidence([{ path: "Research/papers/smith.pdf", page: 1, quote: "Appendix: Memory use fell by 40% with sparse attention, restated." }], files, loader);
    assert.deepEqual(far.dropped.map((item) => item.reason), ["the quote is on page 5, not page 1"], "a page two or more away is not corrected");

    // A verdict that loses all its evidence cannot be verified.
    const submitted = { occurrence: "c1", key: "smith2020", verdict: "supported" as const, evidence: [{ path: "Research/papers/smith.pdf", page: 3, quote: "Sparse attention tripled throughput on every benchmark we ran." }], webSources: [], confidence: 0.9, note: "Matches.", suggestedText: "x" };
    const settled = settleVerdict(submitted, "ref_1", await verifyEvidence(submitted.evidence, files, loader), { kept: [], dropped: [] });
    assert.deepEqual([settled.verdict, settled.checkerVerdict, settled.note, settled.confidence, settled.suggestedText], ["cannot-verify", "supported", "evidence not found in source", 0, undefined]);

    // Web quotes count only with a URL WebSearch returned.
    const returned = new Set([normalizeUrl("https://example.org/study#results")]);
    const web = verifyWebSources([
      { url: "https://example.org/study/", quote: "40% less memory" },
      { url: "https://invented.example/paper", quote: "40% less memory" },
    ], returned);
    assert.deepEqual(web.kept.map((item) => item.url), ["https://example.org/study/"]);
    assert.match(web.dropped[0].reason, /not among the pages WebSearch returned/);
    const webOnly = settleVerdict({ ...submitted, evidence: [], webSources: [{ url: "https://invented.example/paper", quote: "q" }] }, undefined, { kept: [], dropped: [] }, verifyWebSources([{ url: "https://invented.example/paper", quote: "q" }], returned));
    assert.equal(webOnly.verdict, "cannot-verify");
  });
});

test("the recording WebSearch remembers the cited pages it returned", async () => {
  const returned = new Set<string>();
  const tool = recordingWebSearch(returned);
  const text = formatWebSearchResult("q", { model: "m", answer: "See https://answer.example/not-cited for more.", citations: [{ url: "https://example.org/a", title: "A — B", content: "snippet" }, { url: "https://example.org/b/" }] });
  const { context } = makeContext("read-only", { allowWebSearch: true });
  const original = (await import("../../src/lib/agent/web-search")).webSearchTool;
  const run = original.run;
  original.run = async () => ({ text, isError: false, result: "2 sources" });
  try { await tool.run({ query: "q" }, context); }
  finally { original.run = run; }
  assert.deepEqual([...returned], ["https://example.org/a", "https://example.org/b"]);
});

test("SubmitVerdicts is strict: the schema, every pair once, and evidence only from the work's files", async () => {
  const tool = submitVerdictsTool([{ occurrence: "c1", key: "smith2020", files: ["Research/papers/smith.pdf"] }, { occurrence: "c2", key: "smith2020", files: ["Research/papers/smith.pdf"] }]);
  const good = { occurrence: "c1", key: "smith2020", verdict: "supported", evidence: [{ path: "Research/papers/smith.pdf", page: 2, quote: "q" }], webSources: [], confidence: 0.8, note: "ok" };
  assert.deepEqual(validateJsonSchema(VERDICTS_SCHEMA, { verdicts: [good] }), []);
  assert.ok(validateJsonSchema(VERDICTS_SCHEMA, { verdicts: [{ ...good, verdict: "probably" }] }).length);
  assert.ok(validateJsonSchema(VERDICTS_SCHEMA, { verdicts: [{ ...good, extra: 1 }] }).length);
  const { context } = makeContext("read-only");
  await assert.rejects(tool.run({ verdicts: [good] }, context), /Missing verdicts for: c2 \/ @smith2020/);
  await assert.rejects(tool.run({ verdicts: [good, { ...good, occurrence: "c2", evidence: [{ path: "Research/other.pdf", quote: "q" }] }] }, context), /cites Research\/other\.pdf, which is not a file of @smith2020/);
  await assert.rejects(tool.run({ verdicts: [good, { ...good, occurrence: "c2", evidence: [] }] }, context), /is supported but has no evidence/);
  await assert.rejects(tool.run({ verdicts: [good, { ...good, occurrence: "c9" }] }, context), /c9 \/ @smith2020 was not part of this check/);
  assert.match((await tool.run({ verdicts: [good, { ...good, occurrence: "c2", verdict: "not-supported", evidence: [] }] }, context)).text, /Received 2 verdicts/);
});

// ---------------------------------------------------------------------------
// Existence
// ---------------------------------------------------------------------------

test("existence: resolved by DOI or search, possibly hallucinated, attachment mismatch, unreachable, and lookups off", async () => {
  await withLibrary(async ({ root }) => {
    await writePdf(root, "Research/papers/federer.pdf", ["A self-organizing short-term dynamical memory network\nFederer and Zylberberg"]);
    await writePdf(root, "Research/papers/wrong.pdf", ["Cooking with cast iron: a practical guide\nChapter one"]);
    const library = await addWorks([
      work("federer2018", "A self-organizing short-term dynamical memory network", "Federer", 2018, { identifiers: { doi: "10.1016/j.neunet.2018.06.008" }, attachments: [{ kind: "pdf", path: "Research/papers/federer.pdf" }] }),
      work("schmidhuber2015", "Deep learning in neural networks: An overview", "Schmidhuber", 2015),
      work("ghost2021", "Quantum gravitational effects on sparse transformer attention heads", "Ghost", 2021),
      work("wrongfile2019", "Deep learning in neural networks: An overview", "Schmidhuber", 2015, { attachments: [{ kind: "pdf", path: "Research/papers/wrong.pdf" }] }),
      work("baddoi2018", "Completely unrelated title about gardening", "Gardener", 2018, { identifiers: { doi: "10.1016/j.neunet.2018.06.008" } }),
    ]);
    const { context } = makeContext("read-only");
    const entries = Object.values((await readReferenceLibrary("Research")).entries);
    const listing = { sources: new Map() } as { sources: Map<string, import("../../src/lib/agent/fact-check/list-citations").SourceSummary> };
    const { summarizeSources } = await import("../../src/lib/agent/fact-check/list-citations");
    listing.sources = await summarizeSources(context, library, entries);
    const log: FetchLog = [];
    const report = await checkExistence(entries, listing.sources, sourceTextLoader(context), { settings: testSettings(), http: testHttpClient(fixtureFetch(log)) });
    const byKey = Object.fromEntries(report.results.map((result) => [result.key, result]));
    assert.equal(report.online, true);
    assert.deepEqual([byKey.federer2018.status, byKey.federer2018.source, byKey.federer2018.possiblyHallucinated, byKey.federer2018.mismatch], ["resolved", "crossref", false, undefined]);
    assert.equal(byKey.schmidhuber2015.status, "resolved");
    assert.ok(byKey.schmidhuber2015.score! >= 0.85);
    assert.deepEqual([byKey.ghost2021.status, byKey.ghost2021.possiblyHallucinated], ["not-found", true]);
    assert.match(byKey.ghost2021.message, /Possibly hallucinated reference: no matching work at Crossref or OpenAlex, and no file is attached\./);
    assert.equal(byKey.wrongfile2019.status, "resolved");
    assert.match(byKey.wrongfile2019.mismatch!.message, /The first page of Research\/papers\/wrong\.pdf does not show the title/);
    assert.match(byKey.baddoi2018.mismatch!.message, /DOI 10\.1016\/j\.neunet\.2018\.06\.008 belongs to “A self-organizing short-term dynamical memory network”/);
    assert.ok(log.every((entry) => !entry.url.includes("openrouter")), "no model is involved");

    const failing = await checkExistence(entries.filter((entry) => entry.key === "ghost2021"), listing.sources, sourceTextLoader(context), { settings: testSettings(), http: testHttpClient(async () => new Response("down", { status: 503 })) });
    assert.deepEqual([failing.results[0].status, failing.results[0].possiblyHallucinated], ["unreachable", false], "an unreachable source never makes a work hallucinated");

    const offline = await checkExistence(entries, listing.sources, sourceTextLoader(context), { settings: testSettings({ lookupOnline: false }), http: testHttpClient(async () => { throw new Error("no network"); }) });
    assert.equal(offline.note, "existence not checked (online lookups off)");
    assert.ok(offline.results.every((result) => result.status === "not-checked" && !result.possiblyHallucinated));
    assert.ok(offline.results.find((result) => result.key === "wrongfile2019")!.mismatch, "the attachment check needs no network");
  });
});
