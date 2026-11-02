import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SearchIndexer } from "../../src/lib/search/indexer";
import { embeddingPowerState } from "../../src/lib/search/embedding-policy";
import { latexBuildProductFilter } from "../../src/lib/search/latex-products";
import { getSearchWorker, type EmbedInput } from "../../src/lib/search/worker-client";
import { filePathFromParts } from "../../src/lib/storage/paths";
import { readSearchLibrary } from "../../src/lib/search/library-files";
import { normalizeSearchPreferences, searchPreferencesFromEnvironment } from "../../electron/search-preferences.cjs";
import { scheduleSummary, statusSummary, timeUntil } from "../../src/components/libera/global-search/search-view";

const vector = () => { const value = new Float32Array(128); value[0] = 1; return value; };
const internals = (indexer: SearchIndexer) => indexer as unknown as { running: Promise<void> | null; chunkLibraryFile: (file: { name: string }) => Promise<unknown> };

async function fixture(t: TestContext, run: (context: {
  indexer: SearchIndexer; directory: string; power: (onBattery: boolean | null) => Promise<void>;
  put: (name: string, text: string) => Promise<string>; calls: { loads: number; embeds: number };
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-embedding-policy-"));
  const settings: Record<string, string | undefined> = {
    LIBERA_DATA_DIR: directory, LIBERA_CONFIG_PATH: undefined,
    LIBERA_SEARCH_INDEX_FILE: path.join(directory, "index.sqlite"), LIBERA_SEARCH_DIMENSIONS: "128",
    LIBERA_SEARCH_TEXT_WEIGHTS: path.join(directory, "model_q4.onnx"), LIBERA_SEARCH_VISION_WEIGHTS: "",
    LIBERA_SEARCH_INDEX_IMAGES: "0", LIBERA_SEARCH_BACKGROUND_INDEXING: "1",
    LIBERA_SEARCH_EMBEDDING_INTERVAL_MINUTES: "180", LIBERA_SEARCH_EMBEDDING_ONLY_ON_AC: "0", LIBERA_SEARCH_KEYWORD_INTERVAL_MINUTES: "0",
    LIBERA_POWER_STATE_PATH: path.join(directory, "power.json"),
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await writeFile(settings.LIBERA_SEARCH_TEXT_WEIGHTS!, "model fixture");
  const indexer = new SearchIndexer();
  const calls = { loads: 0, embeds: 0 };
  t.mock.method(getSearchWorker(), "ensureModel", async () => {
    calls.loads++; return { textDtype: "q4", visionDtype: null, vision: false, loadMs: 0 };
  });
  t.mock.method(getSearchWorker(), "embed", async (inputs: EmbedInput[]) => { calls.embeds++; return inputs.map(vector); });
  const power = (onBattery: boolean | null) => writeFile(settings.LIBERA_POWER_STATE_PATH!, JSON.stringify({ onBattery, checkedAt: Date.now() }));
  const put = async (name: string, text: string) => {
    const file = filePathFromParts("Notes", name.split("/"));
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file;
  };
  try { await run({ indexer, directory, power, put, calls }); }
  finally {
    indexer.pause(); await internals(indexer).running; indexer.database()?.close(); getSearchWorker().stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    t.mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  }
}

test("embedding settings validate defaults, bounds, and environment values", () => {
  assert.equal(normalizeSearchPreferences({}).embeddingIntervalMinutes, 180);
  assert.equal(normalizeSearchPreferences({}).embeddingOnlyOnAC, true);
  assert.equal(normalizeSearchPreferences({ embeddingOnlyOnAC: false }).embeddingOnlyOnAC, false);
  for (const minutes of [180, 720, 1440, 10080]) {
    assert.equal(normalizeSearchPreferences({ embeddingIntervalMinutes: String(minutes) }).embeddingIntervalMinutes, minutes);
  }
  for (const minutes of [-20, 0, 15, 60, 120]) {
    assert.equal(normalizeSearchPreferences({ embeddingIntervalMinutes: minutes }).embeddingIntervalMinutes, 180);
  }
  assert.equal(normalizeSearchPreferences({ embeddingIntervalMinutes: 181 }).embeddingIntervalMinutes, 720);
  assert.equal(normalizeSearchPreferences({ embeddingIntervalMinutes: Infinity }).embeddingIntervalMinutes, 180);
  assert.equal(normalizeSearchPreferences({ embeddingIntervalMinutes: 999999 }).embeddingIntervalMinutes, 10080);
  const preferences = searchPreferencesFromEnvironment({ LIBERA_SEARCH_EMBEDDING_INTERVAL_MINUTES: "1440", LIBERA_SEARCH_EMBEDDING_ONLY_ON_AC: "1" } as unknown as NodeJS.ProcessEnv);
  assert.equal(preferences.embeddingIntervalMinutes, 1440);
  assert.equal(preferences.embeddingOnlyOnAC, true);
  // A web deployment has no power bridge: AC-only by default would never embed.
  assert.equal(searchPreferencesFromEnvironment({} as NodeJS.ProcessEnv).embeddingOnlyOnAC, false);
  assert.equal(searchPreferencesFromEnvironment({ LIBERA_POWER_STATE_PATH: "/tmp/power.json" } as unknown as NodeJS.ProcessEnv).embeddingOnlyOnAC, true);
});

test("keyword wait settings default to an hour and round custom values up", () => {
  assert.equal(normalizeSearchPreferences({}).keywordIntervalMinutes, 60);
  for (const minutes of [60, 240, 480, 1440, 4320]) assert.equal(normalizeSearchPreferences({ keywordIntervalMinutes: String(minutes) }).keywordIntervalMinutes, minutes);
  assert.equal(normalizeSearchPreferences({ keywordIntervalMinutes: 0 }).keywordIntervalMinutes, 0);
  assert.equal(normalizeSearchPreferences({ keywordIntervalMinutes: 30 }).keywordIntervalMinutes, 60);
  assert.equal(normalizeSearchPreferences({ keywordIntervalMinutes: 300 }).keywordIntervalMinutes, 480);
  assert.equal(normalizeSearchPreferences({ keywordIntervalMinutes: 99999 }).keywordIntervalMinutes, 4320);
  assert.equal(normalizeSearchPreferences({ keywordIntervalMinutes: -5 }).keywordIntervalMinutes, 60);
  assert.equal(normalizeSearchPreferences({ keywordIntervalMinutes: "soon" }).keywordIntervalMinutes, 60);
});

test("schedules read as relative times", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(timeUntil(at(20_000), now), "in under a minute");
  assert.equal(timeUntil(at(-5_000), now), "in under a minute");
  assert.equal(timeUntil(at(34 * 60_000 + 1), now), "in 35 minutes");
  assert.equal(timeUntil(at(60 * 60_000), now), "in 1 hour");
  assert.equal(timeUntil(at(160 * 60_000), now), "in 3 hours");
  assert.equal(timeUntil(at(36 * 3_600_000), now), "in 2 days");
  assert.equal(timeUntil(at(7 * 86_400_000), now), "in 7 days");
  const status = {
    state: "idle", exists: true, backgroundIndexing: true, files: 12, chunks: 4, embeddedChunks: 2,
    model: { configured: true, vision: false, state: "ready", dimensions: 128 },
    embeddingDeferred: "interval", nextEmbeddingAt: at(3 * 3_600_000), nextKeywordUpdateAt: at(40 * 60_000),
  } as unknown as Parameters<typeof statusSummary>[0];
  assert.equal(statusSummary(status, now).text, "12 files indexed · embeddings in 3 hours");
  assert.equal(scheduleSummary(status, now), "Next keyword update in 40 minutes");
  assert.equal(scheduleSummary({ ...status!, nextKeywordUpdateAt: undefined }, now), "Keyword index up to date");
  assert.equal(scheduleSummary({ ...status!, backgroundIndexing: false }, now), "Updates only when requested");
});

test("saves and polling wait for the keyword interval, then update together; Update index and model changes do not wait", async (t) => {
  await fixture(t, async ({ indexer, put, calls }) => {
    process.env.LIBERA_SEARCH_KEYWORD_INTERVAL_MINUTES = "60";
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await put("a.md", "First keyword.");
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    assert.equal(Number(db.getMeta("last_keyword_pass_at")), now, "a manual pass starts the wait");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await put("a.md", "Second keyword.");
    await put("b.md", "Other keyword.");
    indexer.notifyChanges(["Notes/a.md"]);
    indexer.notifyChanges(["Notes/b.md"]);
    t.mock.timers.tick(1000);
    await indexer.requestScan();
    await indexer.requestScan({ force: true });
    assert.equal(internals(indexer).running, null);
    assert.equal(db.keyword('"Second"', 10).length, 0, "the save waits");
    const status = indexer.status();
    assert.equal(status.nextKeywordUpdateAt, new Date(now + 60 * 60_000).toISOString());
    // Polling must not keep postponing the wake.
    for (let i = 0; i < 5; i++) { now += 20_000; t.mock.timers.tick(20_000); indexer.requestScan(); }
    assert.equal(internals(indexer).running, null);
    now += 60 * 60_000;
    t.mock.timers.tick(30_000);
    await internals(indexer).running;
    assert.equal(db.keyword('"Second"', 10).length, 1);
    assert.equal(db.keyword('"Other"', 10).length, 1);
    assert.equal(calls.embeds, 1, "the embedding interval still applies to the batched pass");
    assert.equal(indexer.status().nextKeywordUpdateAt, undefined);
    assert.equal(indexer.status().embeddingDeferred, "interval");
    // The wait survives a restart.
    const restarted = new SearchIndexer();
    try {
      await put("a.md", "Third keyword.");
      await restarted.requestScan({ force: true });
      assert.equal(restarted.database()!.keyword('"Third"', 10).length, 0);
      await restarted.requestScan({ force: true, immediate: true });
      assert.equal(restarted.database()!.keyword('"Third"', 10).length, 1, "changed model settings rescan at once");
      await put("a.md", "Fourth keyword.");
      await restarted.requestScan({ force: true, manual: true });
      assert.equal(restarted.database()!.keyword('"Fourth"', 10).length, 1, "Update index does not wait");
    } finally { restarted.pause(); restarted.database()?.close(); }
  });
});

test("embeddings due before the keyword wait run with the next keyword update and report its time", async (t) => {
  await fixture(t, async ({ indexer, put, calls, power }) => {
    process.env.LIBERA_SEARCH_KEYWORD_INTERVAL_MINUTES = "1440";
    process.env.LIBERA_SEARCH_EMBEDDING_ONLY_ON_AC = "1";
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // A passage left unembedded on battery, then the adapter is connected.
    await power(true);
    await put("a.md", "First keyword.");
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    assert.equal(db.countPending(false), 1);
    await put("b.md", "New keyword.");
    indexer.notifyChanges(["Notes/b.md"]);
    t.mock.timers.tick(1000);
    now += 4 * 60 * 60_000;
    await power(false);
    const status = indexer.status();
    const keywordDue = new Date(Number(db.getMeta("last_keyword_pass_at")) + 1440 * 60_000).toISOString();
    assert.equal(status.nextKeywordUpdateAt, keywordDue);
    assert.equal(status.embeddingDeferred, "interval");
    assert.equal(status.nextEmbeddingAt, keywordDue, "embeddings report the keyword update they wait for");
    t.mock.timers.tick(30_000);
    assert.equal(internals(indexer).running, null, "a due embedding does not drain the keyword queue early");
    assert.equal(calls.embeds, 0);
    now += 24 * 60 * 60_000;
    await power(false);
    t.mock.timers.tick(30_000);
    await internals(indexer).running;
    assert.equal(db.keyword('"New"', 10).length, 1);
    assert.equal(calls.embeds, 1);
    assert.equal(db.countPending(false), 0);
  });
});

test("a clock set back does not disable the waits", async (t) => {
  await fixture(t, async ({ indexer, put }) => {
    process.env.LIBERA_SEARCH_KEYWORD_INTERVAL_MINUTES = "60";
    await put("a.md", "First keyword.");
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    db.setMeta("last_keyword_pass_at", String(Date.now() + 365 * 86_400_000));
    db.setMeta("last_embedding_attempt_at", String(Date.now() + 365 * 86_400_000));
    await put("a.md", "Second keyword.");
    await indexer.requestScan({ force: true });
    indexer.status();
    assert.equal(db.keyword('"Second"', 10).length, 0);
    assert.ok(Number(db.getMeta("last_keyword_pass_at")) <= Date.now(), "a future timestamp restarts the wait from now");
  });
});

test("keyword updates and polling cannot bypass the persisted embedding interval; timer catches up without Search open", async (t) => {
  await fixture(t, async ({ indexer, put, calls }) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    await put("a.md", "Original keyword.");
    await indexer.requestScan({ force: true, build: true });
    assert.equal(calls.embeds, 1);
    const db = indexer.database()!;
    const completed = Number(db.getMeta("last_embedding_attempt_at"));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await put("a.md", "Changed keyword.");
    await indexer.requestScan({ force: true, incremental: true });
    // A real save notifies the path; include that path through the public hook.
    indexer.notifyChanges(["Notes/a.md"]);
    t.mock.timers.tick(1000);
    await internals(indexer).running;
    assert.equal(db.keyword('"Changed"', 10).length, 1);
    assert.equal(calls.embeds, 1);
    assert.equal(indexer.status().embeddingDeferred, "interval");
    assert.equal(Number(db.getMeta("last_embedding_attempt_at")), completed, "polls never push the deadline forward");
    await indexer.requestScan({ force: true });
    assert.equal(calls.embeds, 1, "force is still an automatic scan");
    now += 3 * 60 * 60_000;
    t.mock.timers.tick(30_000);
    await internals(indexer).running;
    assert.equal(calls.embeds, 2);
    assert.equal(db.countPending(false), 0);
    // The timestamp survives opening a new server/indexer instance.
    const restarted = new SearchIndexer();
    try {
      await put("a.md", "Restarted keyword.");
      await restarted.requestScan({ force: true });
      assert.equal(restarted.database()!.keyword('"Restarted"', 10).length, 1);
      assert.equal(calls.embeds, 2);
      await restarted.requestScan({ force: true, manual: true });
      assert.equal(calls.embeds, 3, "an explicit update bypasses only the interval");
    } finally { restarted.pause(); restarted.database()?.close(); }
  });
});

test("AC-only blocks model loading even for a manual build, keeps keyword updates, and resumes on adapter", async (t) => {
  await fixture(t, async ({ indexer, put, calls, power }) => {
    process.env.LIBERA_SEARCH_EMBEDDING_ONLY_ON_AC = "1";
    await power(true);
    await put("a.md", "Battery keyword.");
    await indexer.requestScan({ force: true, build: true });
    assert.equal(indexer.database()!.keyword('"Battery"', 10).length, 1);
    assert.equal(calls.loads, 0);
    assert.equal(indexer.status().embeddingDeferred, "battery");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await put("b.md", "More keyword.");
    await indexer.requestScan({ force: true, manual: true });
    assert.equal(calls.embeds, 0);
    assert.equal(indexer.database()!.keyword('"More"', 10).length, 1);
    await power(false);
    t.mock.timers.tick(30_000);
    await internals(indexer).running;
    assert.equal(calls.embeds, 1);
    assert.equal(indexer.database()!.countPending(false), 0);
  });
});

test("unplugging during inference stops following batches; stale or missing AC state fails closed", async (t) => {
  await fixture(t, async ({ indexer, put, power, directory }) => {
    process.env.LIBERA_SEARCH_EMBEDDING_ONLY_ON_AC = "1";
    await power(false);
    for (const name of ["a", "b", "c"]) await put(`${name}.md`, `Keyword ${name}.`);
    let calls = 0;
    t.mock.method(getSearchWorker(), "embed", async (inputs: EmbedInput[]) => { calls++; await power(true); return inputs.map(vector); });
    await indexer.requestScan({ force: true, build: true });
    assert.equal(calls, 1);
    assert.equal(indexer.database()!.counts().chunks, 3);
    assert.equal(indexer.database()!.countPending(false), 3);
    assert.equal(indexer.status().embeddingDeferred, "battery");
    await writeFile(path.join(directory, "power.json"), JSON.stringify({ onBattery: false, checkedAt: Date.now() - 90_001 }));
    assert.equal(embeddingPowerState(), "unknown");
    await rm(path.join(directory, "power.json"));
    await indexer.requestScan({ force: true, manual: true });
    assert.equal(calls, 1);
    assert.equal(indexer.status().embeddingDeferred, "power-unknown");
  });
});

test("LaTeX sources and ordinary PDFs stay searchable while matching, renamed, and out-directory products are never parsed", async (t) => {
  await fixture(t, async ({ indexer, put }) => {
    const root = path.dirname(await put("main.tex", "\\documentclass{article}\nSource keyword."));
    await put("main.pdf", "not a PDF: must never parse");
    await put("main.log", "Generated log keyword.");
    await put("main.bbl", "Generated bibliography keyword.");
    await put("build/main.pdf", "generated in build directory");
    await put("figures/renamed.svg", "generated diagram");
    await put("main.fls", `PWD ${root}\nOUTPUT figures/renamed.svg\n`);
    await put("article.pdf", "ordinary paper");
    const original = internals(indexer).chunkLibraryFile.bind(indexer);
    t.mock.method(internals(indexer), "chunkLibraryFile", async (file: { name: string }) => {
      if (file.name === "article.pdf") return [{ title: "", text: "Ordinary paper keyword.", context: "" }];
      assert.ok(!/\.(pdf|log|bbl|svg)$/.test(file.name), `generated product reached the parser: ${file.name}`);
      return original(file);
    });
    await indexer.requestScan({ force: true, build: true });
    assert.deepEqual(indexer.database()!.listFiles().map((file) => file.name).sort(), ["article.pdf", "main.tex"]);
    assert.equal(indexer.database()!.keyword('"Source"', 10).length, 1);
    assert.equal(indexer.database()!.keyword('"Ordinary"', 10).length, 1);
    const filter = latexBuildProductFilter();
    await put("custom.aux", "build evidence"); await put("custom.pdf", "renamed job output");
    assert.equal(await filter(path.join(root, "custom.pdf"), root), true);
    const { files } = await readSearchLibrary(() => true);
    assert.ok(!files.some((file) => file.name === "custom.pdf"));
  });
});

test("adding a TeX source removes a previously indexed PDF on an incremental update", async (t) => {
  await fixture(t, async ({ indexer, put }) => {
    await put("draft.pdf", "ordinary until its source appears");
    t.mock.method(internals(indexer), "chunkLibraryFile", async (file: { name: string }) => [{ title: "", text: file.name, context: "" }]);
    await indexer.requestScan({ force: true, build: true });
    assert.equal(indexer.database()!.listFiles().length, 1);
    await put("draft.tex", "Source.");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    indexer.notifyChanges(["Notes/draft.tex"]);
    t.mock.timers.tick(1000);
    await internals(indexer).running;
    assert.deepEqual(indexer.database()!.listFiles().map((file) => file.name), ["draft.tex"]);
  });
});
