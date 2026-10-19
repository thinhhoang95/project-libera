import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHUNK_MAX_CHARS,
  chunkLatex,
  chunkMarkdown,
  chunkPdfPages,
  chunkPlainText,
  documentPrompt,
  embeddingText,
} from "../../src/lib/search/chunking";
import { SearchDatabase, truncateVector } from "../../src/lib/search/database";
import { fuseRankings, keywordMatchExpression, relevantSemanticHits } from "../../src/lib/search/query";
import { planIndexRepair } from "../../src/lib/search/repair";
import type { LiberaFileNode } from "../../src/lib/types";
import {
  findTermRanges,
  searchLocationLabel,
  searchQueryPlainText,
  searchQueryTerms,
  searchQueryText,
  snippetWindow,
} from "../../src/lib/global-search";
import { markdownPassageWords } from "../../src/lib/markdown-outline-navigation";
import { pdfFindPhrase, searchRevealViewState } from "../../src/components/libera/global-search/reveal";
import { normalizeSearchPreferences, searchPreferencesFromEnvironment } from "../../electron/search-preferences.cjs";
import { searchIndexFile } from "../../src/lib/search/settings";

const NOTES = `# Quantum notes

Intro paragraph about the course.

## Wave functions

The wave function describes the state of a particle and evolves by the Schrödinger equation.

\`\`\`python
# not a heading
print("hello")
\`\`\`

## Tunneling

A particle can pass through a barrier that is higher than its energy. This explains alpha decay.

### Applications

- Scanning tunneling microscope
`;

test("Markdown passages follow headings, ignore code fences and point back into the source", () => {
  const chunks = chunkMarkdown(NOTES);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.equal(NOTES.slice(chunk.start, chunk.end), chunk.text);
    assert.equal(NOTES.split("\n")[chunk.line - 1].trim().length > 0, true);
  }
  const tunneling = chunks.find((chunk) => chunk.text.includes("alpha decay"));
  assert.ok(tunneling);
  assert.equal(tunneling.title, "Quantum notes › Tunneling");
  assert.ok(!chunks.some((chunk) => chunk.title.includes("not a heading")));
  // A near-empty section joins the next one under the more specific heading.
  const applications = chunks.find((chunk) => chunk.text.includes("Scanning tunneling microscope"));
  assert.ok(applications);
  assert.ok(applications.title.endsWith("Tunneling") || applications.title.endsWith("Applications"));
});

test("long passages are split near the target size at sentence boundaries", () => {
  const sentence = "Gradient descent moves the weights against the gradient of the loss. ";
  const source = `# Training\n\n${sentence.repeat(120)}`;
  const chunks = chunkMarkdown(source);
  assert.ok(chunks.length > 3);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= CHUNK_MAX_CHARS, `chunk of ${chunk.text.length} chars`);
    assert.equal(source.slice(chunk.start, chunk.end), chunk.text);
  }
  // Every passage after the first carries the end of the previous one as context.
  assert.equal(chunks[0].context, "");
  assert.ok(chunks[1].context.length > 0);
  assert.ok(chunks.slice(1).every((chunk) => /loss\.?$/.test(chunk.text.trim()) || chunk.text.trim().endsWith(".")));
});

test("LaTeX passages follow sectioning commands and skip commented-out ones", () => {
  const source = String.raw`\documentclass{article}
\begin{document}
\section{Entropy}
Heat flows from hot to cold, which is why a refrigerator needs work. ${"More words here. ".repeat(10)}
% \section{Commented}
\subsection{Carnot \emph{engines}}
No engine is more efficient than a Carnot engine. ${"Even more words. ".repeat(10)}
\end{document}
`;
  const chunks = chunkLatex(source, "notes.tex");
  const titles = chunks.map((chunk) => chunk.title);
  assert.ok(titles.includes("Entropy"));
  assert.ok(titles.includes("Entropy › Carnot engines"));
  assert.ok(!titles.some((title) => title.includes("Commented")));
  const carnot = chunks.find((chunk) => chunk.title.endsWith("Carnot engines"))!;
  assert.equal(source.split("\n")[carnot.line - 1], String.raw`\subsection{Carnot \emph{engines}}`);
});

test("BibTeX entries become one passage each, titled by their title field", () => {
  const source = `@article{smith2020,\n  title = {Deep learning for proteins},\n  author = {Smith}\n}\n\n@book{doe,\n  title = "A history of aqueducts",\n}\n`;
  const chunks = chunkLatex(source, "refs.bib");
  assert.deepEqual(chunks.map((chunk) => chunk.title), ["Deep learning for proteins", "A history of aqueducts"]);
});

test("PDF passages keep their page and carry context across pages", () => {
  const chunks = chunkPdfPages([
    { pageNumber: 1, text: "Roman aqueducts carried water by gravity." },
    { pageNumber: 2, text: "" },
    { pageNumber: 3, text: "Photosynthesis turns light into chemical energy." },
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.page), [1, 3]);
  assert.match(chunks[1].context, /gravity/);
});

test("plain text and code are windowed without losing text", () => {
  const source = Array.from({ length: 400 }, (_, index) => `line ${index}: value = compute(${index})`).join("\n");
  const chunks = chunkPlainText(source);
  assert.ok(chunks.length > 5);
  assert.equal(chunks[0].line, 1);
  assert.ok(chunks.every((chunk, index) => index === 0 || chunk.line > chunks[index - 1].line));
});

test("document prompts use EmbeddingGemma's title and text format without markup noise", () => {
  const prompt = documentPrompt("markdown", "Quantum notes", {
    title: "Tunneling",
    context: "",
    text: "## Tunneling\n\nSee ![diagram](data:image/png;base64,AAAA) and [the paper](https://example.com). y>>>Important<<<",
  });
  assert.equal(prompt, "title: Quantum notes — Tunneling | text: Tunneling\n\nSee diagram and the paper. Important");
  assert.equal(documentPrompt("text", "", { title: "", context: "", text: "x = 1" }), "title: none | text: x = 1");
  assert.equal(embeddingText("latex", "Energy % a comment\n\\label{eq:1}is conserved"), "Energy\n is conserved");
});

test("query words skip function words, keep quoted phrases, and highlight without accents", () => {
  assert.deepEqual(searchQueryTerms("why does a fridge need energy"), ["fridge", "energy"]);
  assert.deepEqual(searchQueryTerms('"wave function" and Schrödinger'), ["wave function", "Schrödinger"]);
  const text = "The Schrödinger equation and SCHRODINGER's cat";
  assert.deepEqual(findTermRanges(text, ["schrodinger"]).map(([start, end]) => text.slice(start, end)), ["Schrödinger", "SCHRODINGER"]);
  // Words are matched from their start, like keyword search.
  assert.deepEqual(findTermRanges("hyperion pions", ["ion"]), []);
  const snippet = snippetWindow(`${"filler ".repeat(100)}the barrier height ${"tail ".repeat(100)}`, ["barrier"], 120);
  assert.ok(snippet.clippedStart && snippet.clippedEnd && snippet.text.includes("barrier"));
});

test("query parts read in order with image placeholders", () => {
  const parts = [
    { type: "text" as const, text: "photos like " },
    { type: "image" as const, image: { kind: "file" as const, path: "Photos/corgi.jpg", name: "corgi.jpg" } },
    { type: "text" as const, text: " at the beach" },
  ];
  assert.equal(searchQueryText(parts), "photos like <|image|> at the beach");
  assert.equal(searchQueryPlainText(parts), "photos like at the beach");
});

test("keyword expressions quote terms and use prefixes", () => {
  assert.equal(keywordMatchExpression(["tunnel", "wave function", "ab"], "AND"), '"tunnel"* AND "wave function" AND "ab"');
  assert.equal(keywordMatchExpression(['say "hi"']), '"say ""hi"""');
});

test("rank fusion rewards passages found both ways", () => {
  const fused = fuseRankings([{ id: 1, similarity: 0.8 }, { id: 2, similarity: 0.7 }], [{ id: 2 }, { id: 3 }], 1);
  assert.deepEqual(fused.map((candidate) => candidate.id), [2, 1, 3]);
  assert.equal(fused[0].semantic && fused[0].keyword, true);
});

test("semantic hits are cut per modality, relative to the best match", () => {
  const kept = relevantSemanticHits([
    { id: 1, similarity: 0.72, image: false },
    { id: 2, similarity: 0.6, image: false },
    { id: 3, similarity: 0.5, image: false },
    { id: 4, similarity: 0.71, image: true },
    { id: 5, similarity: 0.58, image: true },
  ], false);
  assert.deepEqual(kept.map((hit) => hit.id), [1, 2, 4]);
  // Unrelated photos (all near 0.6 for a text query) are dropped entirely.
  assert.deepEqual(relevantSemanticHits([{ id: 1, similarity: 0.6, image: true }], false), []);
});

test("Matryoshka truncation keeps unit length", () => {
  const vector = truncateVector(new Float32Array([3, 4, 12, 0]), 2);
  assert.deepEqual(Array.from(vector), [0.6, 0.8].map((value) => Math.fround(value)));
});

function unit(values: number[]) {
  const vector = new Float32Array(4);
  values.forEach((value, index) => { vector[index] = value; });
  return truncateVector(vector, 4);
}

test("the index stores passages, finds them both ways, and reuses vectors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-"));
  const db = new SearchDatabase(path.join(directory, "libera-search.sqlite"));
  try {
    db.prepareVectors(4, "model_q4.onnx:1", "");
    const file = { key: "Physics/notes.md", source: "library" as const, kind: "markdown" as const, path: "Physics/notes.md", name: "notes.md", notebook: "Physics", signature: "1", meta: null };
    const chunks = [
      { hash: "a", title: "Tunneling", text: "A particle passes through a barrier.", context: "", line: 1, endLine: 1, start: 0, end: 36 },
      { hash: "b", title: "Entropy", text: "Heat flows from hot to cold.", context: "", line: 3, endLine: 3, start: 38, end: 66 },
    ];
    db.replaceFile(file, chunks, "Physics notes.md");
    assert.equal(db.countPending(true), 2);

    const pending = db.pendingChunks(10, true);
    db.storeVectors(pending.map((chunk) => ({ id: chunk.id, generation: chunk.generation, kind: chunk.kind, vector: chunk.title === "Tunneling" ? unit([1, 0, 0, 0]) : unit([0, 1, 0, 0]) })));
    assert.equal(db.countPending(true), 0);

    const nearest = db.nearest(unit([0.9, 0.1, 0, 0]), 2);
    assert.equal(db.chunkRows([nearest[0].id])[0].title, "Tunneling");
    assert.ok(nearest[0].similarity > 0.95);
    assert.equal(db.nearest(unit([1, 0, 0, 0]), 2, ["pdf"]).length, 0);

    const keyword = db.keyword(keywordMatchExpression(["barr"]), 10);
    assert.equal(db.chunkRows([keyword[0].id])[0].title, "Tunneling");
    assert.equal(db.keyword(keywordMatchExpression(["physics"]), 10).length, 2, "the path is searchable");

    // Editing one passage keeps the other's vector.
    db.replaceFile({ ...file, signature: "2" }, [chunks[0], { ...chunks[1], hash: "c", text: "Heat never flows from cold to hot on its own." }], "Physics notes.md");
    assert.equal(db.countPending(true), 1);

    // A copy of the file borrows the vectors of identical passages.
    db.replaceFile({ ...file, key: "Other/notes.md", path: "Other/notes.md", notebook: "Other" }, [chunks[0]], "Other notes.md");
    assert.equal(db.countPending(true), 1);

    const copy = db.listFiles().find((entry) => entry.key === "Other/notes.md")!;
    db.deleteFile(copy.id);
    assert.equal(db.keyword(keywordMatchExpression(["other"]), 10).length, 0);
    assert.deepEqual(db.counts(), { files: 1, failedFiles: 0, images: 0, chunks: 2, embeddedChunks: 1 });

    // Another embedding size or model keeps the vectors (re-embedding is costly) until a reset is allowed.
    assert.match(db.prepareVectors(2, "model_q4.onnx:1", "") ?? "", /4 dimensions instead of 2/);
    assert.match(db.prepareVectors(4, "model_quantized.onnx:2", "") ?? "", /the text model model_q4\.onnx/);
    assert.equal(db.countPending(true), 1);
    assert.equal(db.prepareVectors(4, "model_q4.onnx:1", ""), null, "the original settings use them again");
    assert.equal(db.prepareVectors(2, "model_q4.onnx:1", "", true), null);
    assert.equal(db.countPending(true), 2);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an existing index is reused, and other SQLite files are never taken over", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-"));
  try {
    const file = path.join(directory, "copied-index.sqlite");
    const first = new SearchDatabase(file);
    first.prepareVectors(4, "model_q4.onnx:1", "");
    first.replaceFile({ key: "A/a.md", source: "library", kind: "markdown", path: "A/a.md", name: "a.md", notebook: "A", signature: "1", meta: null },
      [{ hash: "h", title: "", text: "Kept across reopening", context: "" }], "A a.md");
    first.close();

    const reopened = new SearchDatabase(file);
    assert.equal(reopened.counts().chunks, 1);
    reopened.close();

    const other = path.join(directory, "other.sqlite");
    const { DatabaseSync } = (eval("require") as NodeRequire)("node:sqlite") as { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } };
    const foreign = new DatabaseSync(other);
    foreign.exec("CREATE TABLE files (id INTEGER PRIMARY KEY); INSERT INTO files VALUES (1);");
    foreign.close();
    assert.throws(() => new SearchDatabase(other), /not a Libera search index/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function libraryFile(filePath: string, size = 10, fileType: LiberaFileNode["fileType"] = "markdown"): LiberaFileNode {
  return { kind: "file", name: filePath.split("/").at(-1)!, path: filePath, notebook: filePath.split("/")[0], fileType, createdAt: "", size, updatedAt: "" };
}

test("an index from another computer is repaired: drifted paths move, missing files are stale", () => {
  const entry = (id: number, key: string, extra: Partial<{ source: "library" | "gallery"; kind: LiberaFileNode["fileType"]; path: string; size: number }> = {}) => ({
    id,
    key,
    source: extra.source ?? "library" as const,
    kind: extra.kind ?? "markdown" as const,
    path: extra.path ?? key,
    name: key.split("/").at(-1)!,
    notebook: key.split("/")[0],
    signature: `${extra.size ?? 10}:2026-01-01T00:00:00.000Z`,
    meta: null,
    status: "ok",
  });
  const indexed = [
    entry(1, "Physics/notes.md"),
    entry(2, "Physics/Cafe\u0301.md"),
    entry(3, "Thesis (laptop)/chapters/intro.tex", { kind: "latex" }),
    entry(4, "Physics/gone.md"),
    entry(5, "gallery:old-id", { source: "gallery", kind: "image", path: "Trips/beach.png", size: 500 }),
    entry(6, "Old/readme.md", { size: 10 }),
    entry(7, "Old/a.md"),
  ];
  const files = [
    libraryFile("Physics/notes.md"),
    libraryFile("physics/Caf\u00e9.md"),
    libraryFile("Thesis/chapters/intro.tex", 10, "latex"),
    libraryFile("One/readme.md", 10),
    libraryFile("Two/readme.md", 99),
    libraryFile("One/a.md"),
    libraryFile("Two/a.md"),
  ];
  const photos = [{ id: "new-id", path: "Trips/beach.png", name: "beach.png", updatedAt: "", size: 500 }];
  const { relocations, stale } = planIndexRepair(indexed, files, photos);
  const moved = new Map(relocations.map((relocation) => [relocation.id, relocation.key]));

  assert.equal(moved.has(1), false, "entries that still match are left alone");
  assert.equal(moved.get(2), "physics/Caf\u00e9.md", "Unicode form and letter case do not matter");
  assert.equal(moved.get(3), "Thesis/chapters/intro.tex", "a linked folder with another name keeps its entries");
  assert.equal(moved.get(5), "gallery:new-id", "gallery photos are found by path when their ids changed");
  assert.equal(moved.get(6), "One/readme.md", "the size decides between files at the same inner path");
  assert.deepEqual(stale.sort(), [4, 7], "a missing or ambiguous file is stale, never guessed");
});

test("a relocated entry keeps its vectors and is found under its new name", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-"));
  const db = new SearchDatabase(path.join(directory, "libera-search.sqlite"));
  try {
    db.prepareVectors(4, "model_q4.onnx:1", "");
    const id = db.replaceFile({ key: "Laptop/notes.md", source: "library", kind: "markdown", path: "Laptop/notes.md", name: "notes.md", notebook: "Laptop", signature: "1", meta: null },
      [{ hash: "a", title: "", text: "Wave functions collapse.", context: "" }], "Laptop notes.md");
    db.storeVectors(db.pendingChunks(10, true).map((chunk) => ({ id: chunk.id, generation: chunk.generation, kind: chunk.kind, vector: unit([1, 0, 0, 0]) })));

    db.relocateFile(id, { key: "Desktop/notes.md", path: "Desktop/notes.md", name: "notes.md", notebook: "Desktop", meta: null }, "Desktop notes.md");
    assert.deepEqual(db.listFiles().map((file) => file.key), ["Desktop/notes.md"]);
    assert.equal(db.countPending(true), 0, "no passage has to be embedded again");
    assert.equal(db.keyword(keywordMatchExpression(["desktop"]), 10).length, 1);
    assert.equal(db.keyword(keywordMatchExpression(["laptop"]), 10).length, 0);
    assert.equal(db.keyword(keywordMatchExpression(["wave"]), 10).length, 1);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("search hits open at their passage in each kind of file", () => {
  const hit = { chunkId: 1, score: 1, semantic: true, keyword: false, text: "Plants convert light energy into chemical energy.", location: { page: 2 } };
  assert.deepEqual(searchRevealViewState("pdf", hit)?.pdf?.reveal?.page, 2);
  assert.equal(pdfFindPhrase("  Plants   convert light energy into chemical energy. "), "Plants convert light energy into chemical");
  const markdown = searchRevealViewState("markdown", { ...hit, location: { start: 10, end: 40, line: 3 } })?.markdown;
  assert.deepEqual([markdown?.reveal?.start, markdown?.reveal?.end, markdown?.selectionStart], [10, 40, 10]);
  assert.equal(searchRevealViewState("latex", { ...hit, location: { line: 12 } })?.latex?.revealLine?.line, 12);
  assert.equal(searchRevealViewState("text", { ...hit, location: { line: 5, endLine: 9 } })?.text?.reveal?.endLine, 9);
  assert.equal(searchRevealViewState("image", hit), undefined);
  assert.equal(searchLocationLabel("pdf", { page: 4, section: "Results" }), "Page 4 · Results");
  assert.equal(searchLocationLabel("text", { line: 5, endLine: 9 }), "Lines 5–9");
});

test("rendered Markdown words drop syntax so the visual editor can find a passage", () => {
  assert.equal(
    markdownPassageWords("## Tunneling\n\n- **Bold** item with [a link](x.md) and `code` and $x^2$\ny> boxed _emphasis_ in snake_case"),
    "tunneling bold item with a link and code and boxed emphasis in snake_case",
  );
});

test("search preferences are normalized from the config file or the environment", () => {
  const preferences = normalizeSearchPreferences({ textWeights: " /models/model_q4.onnx ", dimensions: "256", visionTokens: 999, indexImages: false });
  assert.equal(preferences.textWeights, path.resolve("/models/model_q4.onnx"));
  assert.equal(preferences.dimensions, 256);
  assert.equal(preferences.visionTokens, 140);
  assert.equal(preferences.indexImages, false);
  assert.equal(preferences.backgroundIndexing, true);
  const fromEnvironment = searchPreferencesFromEnvironment({ LIBERA_SEARCH_DIMENSIONS: "512", LIBERA_SEARCH_BACKGROUND_INDEXING: "0" } as unknown as NodeJS.ProcessEnv);
  assert.equal(fromEnvironment.dimensions, 512);
  assert.equal(fromEnvironment.backgroundIndexing, false);
});

test("the index stays on this computer, outside the Master directory, one per library", () => {
  const saved = { data: process.env.LIBERA_DATA_DIR, config: process.env.LIBERA_CONFIG_PATH, local: process.env.LOCALAPPDATA };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const defaults = normalizeSearchPreferences({});
  try {
    delete process.env.LOCALAPPDATA;
    process.env.LIBERA_CONFIG_PATH = path.join("/Users/me/Library/Application Support/Libera", "libera-electron-config.json");
    process.env.LIBERA_DATA_DIR = "/Users/me/OneDrive/Libera";
    const first = searchIndexFile(defaults);
    assert.ok(first.startsWith(path.join("/Users/me/Library/Application Support/Libera", "search-index")));
    assert.ok(first.endsWith("libera-search.sqlite"));

    process.env.LIBERA_DATA_DIR = "/Users/me/Other notes";
    assert.notEqual(searchIndexFile(defaults), first, "each Master directory has its own index");

    // A file chosen in Preferences wins; a folder from earlier versions still works.
    assert.equal(searchIndexFile({ ...defaults, indexFile: "/fast/disk/mine.sqlite" }), "/fast/disk/mine.sqlite");
    assert.equal(normalizeSearchPreferences({ indexDirectory: "/old/place" }).indexFile, path.join("/old/place", "libera-search.sqlite"));

    // Without the desktop config (a web deployment), the index stays with the server's data.
    delete process.env.LIBERA_CONFIG_PATH;
    assert.equal(searchIndexFile(defaults), path.join("/Users/me/Other notes", "users", "admin", ".libera", "search", "libera-search.sqlite"));
  } finally {
    restore("LIBERA_DATA_DIR", saved.data);
    restore("LIBERA_CONFIG_PATH", saved.config);
    restore("LOCALAPPDATA", saved.local);
  }
});
