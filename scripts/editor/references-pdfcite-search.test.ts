import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { SearchResponse } from "../../src/lib/global-search";
import { SearchIndexer } from "../../src/lib/search/indexer";
import { runSearch } from "../../src/lib/search/query";
import { pdfHighlightChunks, pdfHighlightSignature } from "../../src/lib/search/pdf-highlights";
import { currentReferenceSignature, parseReferenceRecordKey, readReferenceSource, referenceRecord, referenceRecordKey } from "../../src/lib/search/references-source";
import { getSearchWorker, type EmbedInput } from "../../src/lib/search/worker-client";
import type { CslItem, ReferenceEntry } from "../../src/lib/references/types";
import { writePdfAnnotations } from "../../src/lib/storage/annotations";
import { filePathFromParts, notebookPath, pdfAnnotationsPath, referenceLibraryPath } from "../../src/lib/storage/paths";
import { pendingReferenceReattach, resetReferenceReattachSchedule, updateReferenceLibrary } from "../../src/lib/storage/references";
import { libraryAttachmentPaths, semanticCitationRequest, semanticCitationRows, citationQueryWords, wantsSemanticCitationSearch } from "../../src/components/libera/references/citation-semantic";

// References as a Global Search source, PDF highlight passages, and the `@`
// popup's restricted query (docs/references/plan.md §4.3, Phase 5).

const INDEXER_KEY = Symbol.for("libera.searchIndexer");
const model = { textDtype: "q4", visionDtype: "q4", vision: true, device: "cpu", fallback: null, loadMs: 0 };
const NOW = "2026-10-18T00:00:00.000Z";

function vector() {
  const result = new Float32Array(128);
  result[0] = 1;
  return result;
}

function internals(indexer: SearchIndexer) {
  return indexer as unknown as {
    running: Promise<void> | null;
    referenceNotebooks: Set<string>;
    allReferencesChanged: boolean;
    changeTimer: ReturnType<typeof setTimeout> | null;
  };
}

function entry(id: string, key: string, csl: Partial<CslItem>, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id, key, aliases: [], csl: { type: "article-journal", ...csl }, identifiers: {}, provenance: {}, status: "confirmed",
    attachments: [], createdAt: NOW, updatedAt: NOW, fieldUpdatedAt: {}, ...extra,
  };
}

const SPARSE = entry("ref_sparse", "smith2020", {
  title: "Sparse attention for long documents", author: [{ family: "Smith", given: "Jane" }, { family: "Lee", given: "Ann" }],
  issued: { "date-parts": [[2020]] }, "container-title": "Journal of Machine Reading", abstract: "We prune attention heads to read whole books.",
}, { notes: "## Method\nUsed in my thesis chapter on retrieval.", tags: ["transformers"], attachments: [{ kind: "markdown", path: "Notes/papers/smith-notes.md" }] });
const GRAPHS = entry("ref_graphs", "kim2019", { title: "Graph cuts", author: [{ family: "Kim" }], issued: { "date-parts": [[2019]] } });

async function writeNote(relativePath: string, text: string) {
  const [notebook, ...parts] = relativePath.split("/");
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}

async function withIndexer(context: TestContext, run: (indexer: SearchIndexer, directory: string) => Promise<void>) {
  await pendingReferenceReattach();
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-references-search-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_SEARCH_INDEX_FILE", "LIBERA_SEARCH_TEXT_WEIGHTS", "LIBERA_SEARCH_VISION_WEIGHTS", "LIBERA_SEARCH_DIMENSIONS", "LIBERA_SEARCH_INDEX_IMAGES", "LIBERA_SEARCH_BACKGROUND_INDEXING"];
  const previous = keys.map((key) => process.env[key]);
  const store = globalThis as { [INDEXER_KEY]?: SearchIndexer };
  const previousIndexer = store[INDEXER_KEY];
  keys.forEach((key) => { delete process.env[key]; });
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_SEARCH_INDEX_FILE = path.join(directory, "index.sqlite");
  process.env.LIBERA_SEARCH_DIMENSIONS = "128";
  process.env.LIBERA_SEARCH_INDEX_IMAGES = "0";
  process.env.LIBERA_SEARCH_TEXT_WEIGHTS = path.join(directory, "model_q4.onnx");
  await writeFile(process.env.LIBERA_SEARCH_TEXT_WEIGHTS, "test model");
  const indexer = new SearchIndexer();
  store[INDEXER_KEY] = indexer;
  const worker = getSearchWorker();
  context.mock.method(worker, "ensureModel", async () => model);
  context.mock.method(worker, "embed", async (inputs: EmbedInput[]) => inputs.map(vector));
  try { await run(indexer, directory); }
  finally {
    indexer.pause();
    await internals(indexer).running;
    indexer.database()?.close();
    worker.stop();
    await pendingReferenceReattach();
    resetReferenceReattachSchedule();
    if (previousIndexer) store[INDEXER_KEY] = previousIndexer;
    else delete store[INDEXER_KEY];
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
}

/** Run the debounced incremental pass the storage hooks schedule, now. */
async function flushChanges(indexer: SearchIndexer) {
  const target = internals(indexer);
  if (target.changeTimer) clearTimeout(target.changeTimer);
  target.changeTimer = null;
  await indexer.requestScan({ force: true, manual: false, incremental: true });
  await target.running;
}

const referenceFiles = (indexer: SearchIndexer) => indexer.database()!.listFiles().filter((file) => file.source === "references");

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

test("a reference record holds the title, authors, year, venue, abstract, notes and tags", () => {
  const record = referenceRecord("Notes", SPARSE);
  assert.equal(record.key, "reference:Notes/ref_sparse");
  assert.deepEqual(parseReferenceRecordKey(record.key), { notebook: "Notes", entryId: "ref_sparse" });
  assert.equal(parseReferenceRecordKey("Notes/a.md"), null);
  assert.equal(record.source, "references");
  assert.equal(record.kind, "reference");
  assert.equal(record.path, "Notes");
  assert.equal(record.name, "Sparse attention for long documents");
  assert.match(record.chunks[0].text, /Jane Smith, Ann Lee/);
  assert.match(record.chunks[0].text, /2020 · Journal of Machine Reading/);
  assert.match(record.chunks[0].text, /Tags: transformers/);
  assert.match(record.chunks[0].text, /@smith2020/);
  assert.deepEqual(record.chunks.slice(1).map((chunk) => chunk.title), ["Abstract", "Notes › Method"]);
  assert.deepEqual(JSON.parse(record.meta!), { notebook: "Notes", entryId: "ref_sparse", key: "smith2020", authors: "Smith & Lee", year: "2020" });
  assert.equal(referenceRecord("Notes", { ...SPARSE, updatedAt: "2027-01-01T00:00:00.000Z" }).signature, record.signature, "only indexed text changes the signature");
  assert.notEqual(referenceRecord("Notes", { ...SPARSE, notes: "Other notes." }).signature, record.signature);
});

test("the indexer stores one record per entry and follows library transactions: add, update, delete", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("Notes/a.md", "A note.");
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: SPARSE }]);
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    assert.deepEqual(referenceFiles(indexer).map((file) => file.key), [referenceRecordKey("Notes", "ref_sparse")]);
    assert.equal(db.keyword('"prune"', 10, ["reference"]).length, 1, "the abstract is searchable");
    assert.equal(db.counts().embeddedChunks, db.counts().chunks);
    const [titleHit] = db.keyword('"Sparse"', 10, ["reference"]);

    // Add: a library transaction notifies the indexer for that notebook only.
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: GRAPHS }]);
    assert.deepEqual([...internals(indexer).referenceNotebooks], ["Notes"]);
    assert.ok(internals(indexer).changeTimer, "the change is debounced");
    await flushChanges(indexer);
    assert.equal(referenceFiles(indexer).length, 2);
    assert.equal(db.keyword('"Sparse"', 10, ["reference"])[0].id, titleHit.id, "an unchanged entry keeps its passages and vectors");

    // Update.
    await updateReferenceLibrary("Notes", null, [{ op: "update", id: "ref_graphs", csl: { title: "Minimum graph cuts" } }]);
    await flushChanges(indexer);
    assert.equal(db.keyword('"Minimum"', 10, ["reference"]).length, 1);
    assert.equal(referenceFiles(indexer).find((file) => file.key.endsWith("ref_graphs"))?.name, "Minimum graph cuts");

    // Delete.
    await updateReferenceLibrary("Notes", null, [{ op: "delete", id: "ref_graphs" }]);
    await flushChanges(indexer);
    assert.deepEqual(referenceFiles(indexer).map((file) => file.key), [referenceRecordKey("Notes", "ref_sparse")]);
    assert.equal(db.keyword('"Minimum"', 10).length, 0);
    assert.equal(db.counts().embeddedChunks, db.counts().chunks);
  });
});

test("every notebook library is covered; a deleted library or notebook drops its records on the next scan", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("Notes/a.md", "A note.");
    await writeNote("Papers/b.md", "Another.");
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: SPARSE }]);
    await updateReferenceLibrary("Papers", null, [{ op: "put", entry: GRAPHS }]);
    await indexer.requestScan({ force: true, build: true });
    assert.deepEqual(referenceFiles(indexer).map((file) => file.notebook).sort(), ["Notes", "Papers"]);

    await rm(referenceLibraryPath("Papers"));
    indexer.notifyReferenceChanges(["Papers"]);
    await flushChanges(indexer);
    assert.deepEqual(referenceFiles(indexer).map((file) => file.notebook), ["Notes"]);

    // A damaged library keeps its records until it can be read again.
    await writeFile(referenceLibraryPath("Notes"), "{ not json");
    await indexer.requestScan({ force: true, manual: true });
    await internals(indexer).running;
    assert.deepEqual(referenceFiles(indexer).map((file) => file.notebook), ["Notes"]);
    assert.equal(await currentReferenceSignature("Notes", "ref_sparse"), "");
    assert.equal((await readReferenceSource("Notes")).status, "unreadable");

    await rm(notebookPath("Notes"), { recursive: true, force: true });
    await indexer.requestScan({ force: true, manual: true });
    await internals(indexer).running;
    assert.deepEqual(referenceFiles(indexer), [], "a deleted notebook's records go");
  });
});

test("pause: library changes are not recorded, and resume reconciles them", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("Notes/a.md", "A note.");
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: SPARSE }]);
    await indexer.requestScan({ force: true, build: true });
    indexer.pause();
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: GRAPHS }]);
    assert.equal(internals(indexer).referenceNotebooks.size, 0, "paused: the notification is dropped");
    assert.equal(internals(indexer).changeTimer, null);
    assert.equal(referenceFiles(indexer).length, 1);
    indexer.resume();
    await internals(indexer).running;
    assert.equal(referenceFiles(indexer).length, 2);
    assert.equal(indexer.database()!.counts().embeddedChunks, indexer.database()!.counts().chunks);
  });
});

test("background indexing off: notifications are ignored until a manual update", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("Notes/a.md", "A note.");
    await indexer.requestScan({ force: true, build: true });
    process.env.LIBERA_SEARCH_BACKGROUND_INDEXING = "0";
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: SPARSE }]);
    assert.equal(internals(indexer).referenceNotebooks.size, 0);
    assert.equal(referenceFiles(indexer).length, 0);
    await indexer.requestScan({ force: true, manual: true });
    await internals(indexer).running;
    assert.equal(referenceFiles(indexer).length, 1);
  });
});

test("an entry changed during embedding is not embedded with its old text", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("Notes/a.md", "A note.");
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: SPARSE }]);
    const signature = referenceRecord("Notes", SPARSE).signature;
    assert.equal(await currentReferenceSignature("Notes", "ref_sparse"), signature);
    let changed = false;
    context.mock.method(getSearchWorker(), "embed", async (inputs: EmbedInput[]) => {
      if (!changed) {
        changed = true;
        await updateReferenceLibrary("Notes", null, [{ op: "update", id: "ref_sparse", notes: "Rewritten while embedding." }]);
      }
      return inputs.map(vector);
    });
    await indexer.requestScan({ force: true, build: true });
    await internals(indexer).running;
    const db = indexer.database()!;
    assert.notEqual(await currentReferenceSignature("Notes", "ref_sparse"), signature);
    assert.equal(db.keyword('"Rewritten"', 10).length, 1, "the new text is indexed");
    assert.equal(db.keyword('"thesis"', 10).length, 0);
    assert.equal(db.counts().embeddedChunks, db.counts().chunks);
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

test("Global Search shows references with a References kind filter, scoped to visible notebooks", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("Notes/a.md", "Sparse attention in my own words.");
    await writeNote("Papers/b.md", "Elsewhere.");
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: SPARSE }]);
    await updateReferenceLibrary("Papers", null, [{ op: "put", entry: { ...SPARSE, id: "ref_other" } }]);
    await indexer.requestScan({ force: true, build: true });
    const all = await runSearch({ parts: [{ type: "text", text: "sparse attention" }] });
    assert.ok(all.results.some((result) => result.source === "library"));
    const references = await runSearch({ parts: [{ type: "text", text: "sparse attention" }], kinds: ["reference"] });
    assert.deepEqual(references.results.map((result) => [result.kind, result.reference?.notebook]).sort(), [["reference", "Notes"], ["reference", "Papers"]]);
    const result = references.results.find((item) => item.reference?.notebook === "Notes")!;
    assert.deepEqual(result.reference, { notebook: "Notes", entryId: "ref_sparse", key: "smith2020", authors: "Smith & Lee", year: "2020" });
    assert.equal(result.name, "Sparse attention for long documents");
    const scoped = await runSearch({ parts: [{ type: "text", text: "sparse attention" }], kinds: ["reference"], scope: ["Notes/a.md"] });
    assert.deepEqual(scoped.results.map((item) => item.reference?.notebook), ["Notes"], "a hidden notebook's references stay hidden");
  });
});

test("a restricted query covers one notebook's references and the given files only, semantic or keyword", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("Notes/papers/smith-notes.md", "# Reading notes\n\nHeads are pruned so whole books fit.");
    await writeNote("Notes/other.md", "Heads are pruned here too, but this file is not attached.");
    await writeNote("Papers/b.md", "Unrelated.");
    await updateReferenceLibrary("Notes", null, [{ op: "put", entry: SPARSE }]);
    await updateReferenceLibrary("Papers", null, [{ op: "put", entry: { ...SPARSE, id: "ref_elsewhere" } }]);
    await indexer.requestScan({ force: true, build: true });

    const library = { entries: { ref_sparse: SPARSE } };
    const request = semanticCitationRequest("pruned-heads-books", "Notes", library);
    assert.deepEqual(request.within, { notebooks: ["Notes"], paths: ["Notes/papers/smith-notes.md"] });
    assert.deepEqual(request.parts, [{ type: "text", text: "pruned heads books" }]);
    const response = await runSearch(request);
    assert.equal(response.mode, "hybrid");
    const keys = response.results.map((result) => result.key).sort();
    assert.deepEqual(keys, ["Notes/papers/smith-notes.md", "reference:Notes/ref_sparse"]);

    // Without a usable model the same query falls back to keyword (BM25) matches.
    delete process.env.LIBERA_SEARCH_TEXT_WEIGHTS;
    const keyword = await runSearch(request);
    assert.equal(keyword.mode, "keyword");
    assert.deepEqual(keyword.results.map((result) => result.key).sort(), keys);
    const rows = semanticCitationRows(keyword, library);
    assert.deepEqual(rows.map((row) => row.entry.key), ["smith2020"], "both hits map back to one entry");

    assert.deepEqual((await runSearch({ ...request, within: { notebooks: ["Nowhere"] } })).results, []);
  });
});

// ---------------------------------------------------------------------------
// PDF highlights
// ---------------------------------------------------------------------------

test("PDF highlight quotes become passages on their pages, and saving annotations notifies the index", async (context) => {
  await withIndexer(context, async () => {
    await writeNote("Notes/paper.pdf", "%PDF-1.4 stub");
    assert.equal(await pdfHighlightSignature("Notes/paper.pdf"), "");
    assert.deepEqual(await pdfHighlightChunks("Notes/paper.pdf"), []);
    const notified: string[] = [];
    const store = globalThis as { [INDEXER_KEY]?: unknown };
    const indexer = store[INDEXER_KEY];
    store[INDEXER_KEY] = { notifyChanges: (paths?: string[]) => notified.push(...paths ?? []) };
    try {
      await writePdfAnnotations("Notes/paper.pdf", [
        { id: "h2", type: "highlight", pageNumber: 5, color: "#ff0", rects: [{ x: 0, y: 0, width: 0.1, height: 0.1 }], quote: "  Sparse   heads matter. ", createdAt: NOW, updatedAt: NOW },
        { id: "h1", type: "highlight", pageNumber: 2, color: "#ff0", rects: [{ x: 0, y: 0, width: 0.1, height: 0.1 }], quote: "Long documents.", createdAt: NOW, updatedAt: NOW },
        { id: "n", type: "text", pageNumber: 1, text: "A note", fontSize: 12, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, createdAt: NOW, updatedAt: NOW },
      ]);
    } finally {
      store[INDEXER_KEY] = indexer;
    }
    assert.deepEqual(notified, ["Notes/paper.pdf"]);
    assert.match(await pdfHighlightSignature("Notes/paper.pdf"), /^highlights:/);
    assert.ok(pdfAnnotationsPath("Notes", ["paper.pdf"]));
    assert.deepEqual(await pdfHighlightChunks("Notes/paper.pdf"), [
      { title: "Highlight", text: "Long documents.", context: "", page: 2 },
      { title: "Highlight", text: "Sparse heads matter.", context: "", page: 5 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The popup's mapping
// ---------------------------------------------------------------------------

test("the popup asks Global Search for three words, or two without library matches", () => {
  assert.deepEqual(citationQueryWords("sparse-attention_highlighted+paper"), ["sparse", "attention", "highlighted", "paper"]);
  assert.equal(wantsSemanticCitationSearch("smith2020", 0), false);
  assert.equal(wantsSemanticCitationSearch("sparse-attention", 3), false);
  assert.equal(wantsSemanticCitationSearch("sparse-attention", 0), true);
  assert.equal(wantsSemanticCitationSearch("that-paper-I-highlighted", 2), true);
  assert.deepEqual(libraryAttachmentPaths({ entries: { a: SPARSE, b: entry("b", "b", {}, { attachments: [{ kind: "url", url: "https://x" }, { kind: "pdf", path: "Notes/b.pdf" }] }) } }),
    ["Notes/b.pdf", "Notes/papers/smith-notes.md"]);
});

test("file hits map to entries by attachment path; PDF pages and highlights cite their page", () => {
  const pdfEntry = entry("ref_pdf", "lee2021", { title: "Dense", page: "100-120" }, { attachments: [{ kind: "pdf", path: "Notes/lee.pdf" }] });
  const library = { entries: { ref_sparse: SPARSE, ref_pdf: pdfEntry } };
  const hit = (text: string, location: Record<string, unknown> = {}) => ({ chunkId: 1, score: 1, semantic: true, keyword: false, text, location });
  const response: Pick<SearchResponse, "results" | "terms"> = {
    terms: ["heads"],
    results: [
      { key: "Notes/lee.pdf", source: "library", kind: "pdf", name: "lee.pdf", path: "Notes/lee.pdf", score: 3, hits: [hit("Heads we highlighted.", { page: 3, section: "Highlight" })] },
      { key: "Notes/stray.pdf", source: "library", kind: "pdf", name: "stray.pdf", path: "Notes/stray.pdf", score: 2.5, hits: [hit("Not attached.", { page: 1 })] },
      { key: "reference:Notes/ref_sparse", source: "references", kind: "reference", name: "Sparse", path: "Notes", reference: { notebook: "Notes", entryId: "ref_sparse", key: "smith2020" }, score: 2, hits: [hit("We prune attention heads.", { section: "Abstract" })] },
      { key: "Notes/papers/smith-notes.md", source: "library", kind: "markdown", name: "smith-notes.md", path: "Notes/papers/smith-notes.md", score: 1, hits: [hit("Heads again.")] },
      { key: "reference:Notes/ref_gone", source: "references", kind: "reference", name: "Gone", path: "Notes", reference: { notebook: "Notes", entryId: "ref_gone", key: "gone" }, score: 0.5, hits: [hit("Gone.")] },
    ],
  };
  const rows = semanticCitationRows(response, library, { pageLabels: () => undefined });
  assert.deepEqual(rows.map((row) => [row.entry.key, row.reason.kind, row.pageLocator]), [
    ["lee2021", "highlight", "102"],
    ["smith2020", "reference", undefined],
  ]);
  assert.equal(rows[1].reason.kind === "reference" && rows[1].reason.section, "Abstract");
  // The PDF's own page labels win over the CSL range.
  const labelled = semanticCitationRows(response, library, { pageLabels: (pdf) => (pdf === "Notes/lee.pdf" ? ["i", "ii", "iii"] : undefined) });
  assert.equal(labelled[0].pageLocator, "iii");
  // A page passage (not a highlight) also cites its page; Markdown passages cite none.
  const page = semanticCitationRows({ terms: [], results: [{ ...response.results[0], hits: [hit("Body text.", { page: 4 })] }, response.results[3]] }, { entries: { ref_pdf: pdfEntry, ref_sparse: SPARSE } }, { pageLabels: () => undefined });
  assert.deepEqual(page.map((row) => [row.reason.kind, row.pageLocator]), [["page", "103"], ["passage", undefined]]);
  assert.equal(semanticCitationRows(response, library, { limit: 1, pageLabels: () => undefined }).length, 1);
});
