import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SearchDatabase, type IndexedFile } from "../../src/lib/search/database";
import { weightsSignature } from "../../src/lib/search/fingerprints";
import { SearchIndexer } from "../../src/lib/search/indexer";
import { runSearch } from "../../src/lib/search/query";
import { getSearchWorker, type EmbedInput } from "../../src/lib/search/worker-client";
import { readFileSignature } from "../../src/lib/storage/file-signature";
import { filePathFromParts } from "../../src/lib/storage/paths";

const INDEXER_KEY = Symbol.for("libera.searchIndexer");
const note = { key: "Notes/a.md", source: "library", kind: "markdown", path: "Notes/a.md", name: "a.md", notebook: "Notes", signature: "old", meta: null } satisfies Omit<IndexedFile, "id" | "status">;
const modelInfo = { textDtype: "q4", visionDtype: null, vision: false, loadMs: 0 };

function unit(position = 0) {
  const vector = new Float32Array(128);
  vector[position] = 1;
  return vector;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withIndexer(run: (indexer: SearchIndexer, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-repair-regression-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_SEARCH_INDEX_FILE", "LIBERA_SEARCH_TEXT_WEIGHTS", "LIBERA_SEARCH_VISION_WEIGHTS", "LIBERA_SEARCH_DIMENSIONS", "LIBERA_SEARCH_INDEX_IMAGES"];
  const previous = keys.map((key) => process.env[key]);
  const store = globalThis as { [INDEXER_KEY]?: SearchIndexer };
  const previousIndexer = store[INDEXER_KEY];
  keys.forEach((key) => { delete process.env[key]; });
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_SEARCH_INDEX_FILE = path.join(directory, "index.sqlite");
  process.env.LIBERA_SEARCH_DIMENSIONS = "128";
  process.env.LIBERA_SEARCH_INDEX_IMAGES = "0";
  const indexer = new SearchIndexer();
  store[INDEXER_KEY] = indexer;
  try { await run(indexer, directory); }
  finally {
    indexer.database()?.close();
    getSearchWorker().stop();
    if (previousIndexer) store[INDEXER_KEY] = previousIndexer;
    else delete store[INDEXER_KEY];
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeNote(name: string, text: string | Uint8Array) {
  const target = filePathFromParts("Notes", [name]);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
}

async function configureModel(directory: string, vision = false) {
  process.env.LIBERA_SEARCH_TEXT_WEIGHTS = path.join(directory, "model_q4.onnx");
  await writeFile(process.env.LIBERA_SEARCH_TEXT_WEIGHTS, "original model");
  if (vision) {
    process.env.LIBERA_SEARCH_INDEX_IMAGES = "1";
    process.env.LIBERA_SEARCH_VISION_WEIGHTS = path.join(directory, "vision_encoder_q4.onnx");
    await writeFile(process.env.LIBERA_SEARCH_VISION_WEIGHTS, "vision model");
  }
}

// Seed the actual persisted hash format from before the cache repair implementation.
function makeLegacy(file: string, chunkId: number, hash: string, version?: string) {
  const { DatabaseSync } = (eval("require") as NodeRequire)("node:sqlite") as {
    DatabaseSync: new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...values: Array<string | number>): void }; close(): void };
  };
  const db = new DatabaseSync(file);
  try {
    db.prepare("UPDATE chunks SET hash = ? WHERE id = ?").run(hash, chunkId);
    db.exec("DELETE FROM meta WHERE key = 'content_version'");
    if (version) db.prepare("INSERT INTO meta(key, value) VALUES ('content_version', ?)").run(version);
  } finally { db.close(); }
}

for (const version of [undefined, "2"]) {
  test(`a legacy text vector survives a full repair scan (${version ? "previously opened" : "original index"})`, async () => {
    await withIndexer(async (indexer, directory) => {
      const source = "Wave functions collapse.";
      const target = await writeNote("a.md", source);
      await configureModel(directory);
      const file = process.env.LIBERA_SEARCH_INDEX_FILE!;
      const legacy = new SearchDatabase(file);
      const signature = `model_q4.onnx:${(await stat(process.env.LIBERA_SEARCH_TEXT_WEIGHTS!)).size}`;
      legacy.prepareVectors(128, signature, "");
      legacy.replaceFile({ ...note, signature: `${source.length}:${(await stat(target)).mtime.toISOString()}` },
        [{ hash: "ignored", title: "", text: source, context: "" }], "Notes a.md");
      const [chunk] = legacy.pendingChunks(1, false);
      legacy.storeVectors([{ ...chunk, vector: unit() }]);
      legacy.close();
      makeLegacy(file, chunk.id, createHash("sha1").update(`markdown\u0000\u0000${source}`).digest("hex"), version);

      const db = (await indexer.databaseForSearch())!;
      assert.match(indexer.status().mismatch ?? "", /text model/);
      await indexer.requestScan({ force: true });
      assert.equal(db.counts().embeddedChunks, 1, "unchanged text retains its cached vector after scanning");
      assert.equal(db.countPending(false), 0);
      assert.equal(db.nearest(unit(), 1)[0].id, chunk.id, "the original chunk survives migration");
      await indexer.databaseForSearch();
      assert.equal(db.getMeta("text_signature"), signature);
      assert.match(indexer.status().mismatch ?? "", /text model/, "a scan cannot silently approve another model");
    });
  });
}

test("legacy image vectors survive repair but require an explicit reset before use", async (context) => {
  await withIndexer(async (indexer, directory) => {
    const bytes = Buffer.alloc(300 * 1024, 1);
    const target = await writeNote("a.png", bytes);
    await configureModel(directory, true);
    const text = await weightsSignature(process.env.LIBERA_SEARCH_TEXT_WEIGHTS!, true);
    const vision = await weightsSignature(process.env.LIBERA_SEARCH_VISION_WEIGHTS!);
    const file = process.env.LIBERA_SEARCH_INDEX_FILE!;
    const legacy = new SearchDatabase(file);
    legacy.prepareVectors(128, text, `${text}|${vision}|tokens:140`);
    legacy.replaceFile({ ...note, key: "Notes/a.png", path: "Notes/a.png", name: "a.png", kind: "image" },
      [{ hash: "image:fixture", title: "", text: "a.png", context: "" }], "Notes a.png");
    const [chunk] = legacy.pendingChunks(1, true);
    legacy.storeVectors([{ ...chunk, vector: unit() }]);
    legacy.close();
    const oldHash = `image:${createHash("sha1").update(bytes.subarray(0, 256 * 1024)).update(String(bytes.length)).digest("hex")}`;
    makeLegacy(file, chunk.id, oldHash);
    bytes[bytes.length - 1] = 2;
    await writeFile(target, bytes);

    await indexer.requestScan({ force: true });
    const db = indexer.database()!;
    assert.equal(db.counts().embeddedChunks, 1, "repair retains the old cache until reset");
    assert.equal(indexer.vectorsUsable, false);
    assert.match(indexer.status().mismatch ?? "", /partial image fingerprints/);
    assert.equal(db.keyword('"a.png"', 10).length, 1, "keyword search remains available");
    await indexer.databaseForSearch();
    assert.equal(indexer.vectorsUsable, false, "full hashing alone cannot approve a legacy vector");

    const worker = getSearchWorker();
    context.mock.method(worker, "ensureModel", async () => ({ ...modelInfo, vision: true, visionDtype: "q4" }));
    context.mock.method(worker, "embed", async () => [unit(1)]);
    indexer.reembed();
    await indexer.requestScan();
    assert.equal(indexer.vectorsUsable, true);
    assert.equal(db.countPending(true), 0);
    assert.ok(db.nearest(unit(1), 1)[0].similarity > 0.99);
  });
});

test("removing legacy images releases their compatibility hold without resetting text vectors", async () => {
  await withIndexer(async (indexer, directory) => {
    const source = "Kept text vector.";
    const target = await writeNote("a.md", source);
    await configureModel(directory);
    const db = indexer.database({ create: true })!;
    await indexer.databaseForSearch();
    db.replaceFile({ ...note, signature: await readFileSignature(target) },
      [{ title: "", text: source, context: "" }], "Notes a.md");
    db.replaceFile({ ...note, key: "Notes/a.png", path: "Notes/a.png", name: "a.png", kind: "image" },
      [{ hash: "image:verified-file-with-legacy-vector", title: "", text: "a.png", context: "" }], "Notes a.png");
    db.storeVectors(db.pendingChunks(10, true).map((chunk) => ({ ...chunk, vector: unit() })));
    db.setMeta("legacy_image_vectors", "1");
    await indexer.databaseForSearch();
    assert.equal(indexer.vectorsUsable, false);
    await indexer.requestScan({ force: true });
    await indexer.databaseForSearch();
    assert.equal(indexer.vectorsUsable, true);
    assert.equal(db.counts().embeddedChunks, 1, "removing images preserves the compatible text vector");
    assert.equal(db.getMeta("legacy_image_vectors"), "");
  });
});

for (const fallback of [false, true]) {
  test(`replacing model weights stops an active ${fallback ? "fallback" : "batch"} embedding pass`, async (context) => {
    await withIndexer(async (indexer, directory) => {
      const source = "Kept passage.";
      const target = await writeNote("a.md", source);
      await writeNote("b.md", "Pending passage one.");
      await writeNote("c.md", "Pending passage two.");
      await configureModel(directory);
      const db = indexer.database({ create: true })!;
      await indexer.databaseForSearch();
      const signature = db.getMeta("text_signature");
      db.replaceFile({ ...note, signature: await readFileSignature(target) },
        [{ hash: "ignored", title: "", text: source, context: "" }], "Notes a.md");
      db.storeVectors(db.pendingChunks(1, false).map((chunk) => ({ ...chunk, vector: unit() })));
      const worker = getSearchWorker();
      context.mock.method(worker, "ensureModel", async () => modelInfo);
      const entered = deferred();
      const release = deferred();
      let calls = 0;
      const internals = worker as unknown as { request: (message: { inputs: unknown[] }) => Promise<Float32Array[]> };
      context.mock.method(internals, "request", async ({ inputs }: { inputs: unknown[] }) => {
        calls += 1;
        if (fallback && calls === 1) throw new Error("Exercise the per-passage fallback");
        if (calls === (fallback ? 2 : 1)) { entered.resolve(); await release.promise; }
        const current = await readFile(process.env.LIBERA_SEARCH_TEXT_WEIGHTS!, "utf8");
        return inputs.map(() => unit(current === "original model" ? 0 : 1));
      });
      const scan = indexer.requestScan({ force: true });
      try {
        await entered.promise;
        await writeFile(process.env.LIBERA_SEARCH_TEXT_WEIGHTS!, "replaced model");
        await indexer.databaseForSearch();
        assert.match(indexer.status().mismatch ?? "", /text model/);
      } finally { release.resolve(); }
      await scan;
      assert.equal(calls, fallback ? 2 : 1, "the retired pass never starts more inference");
      assert.equal(db.counts().embeddedChunks, 1);
      assert.equal(db.countPending(false), 2);
      assert.equal(db.getMeta("text_signature"), signature);
      assert.equal(db.nearest(unit(1), 1)[0].similarity, 0, "no new-model vector entered the old index");

      await writeFile(process.env.LIBERA_SEARCH_TEXT_WEIGHTS!, "original model");
      await indexer.requestScan({ force: true });
      assert.equal(indexer.vectorsUsable, true);
      assert.equal(db.counts().embeddedChunks, 3, "restoring compatible weights resumes the queue");
    });
  });
}

test("a status poll during slow inference commits the valid batch before rescanning", async (context) => {
  await withIndexer(async (indexer, directory) => {
    await writeNote("a.png", "image fixture");
    await configureModel(directory, true);
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const worker = getSearchWorker();
    context.mock.method(worker, "ensureModel", async () => ({ ...modelInfo, vision: true, visionDtype: "q4" }));
    let calls = 0;
    context.mock.method(worker, "embed", async () => {
      assert.equal(++calls, 1, "polling must not repeatedly embed the same image");
      now += 31_000;
      indexer.requestScan();
      return [unit()];
    });
    await indexer.requestScan({ force: true, build: true });
    assert.equal(calls, 1);
    assert.equal(indexer.database()!.countPending(true), 0);
    assert.equal(indexer.database()!.counts().embeddedChunks, 1);
  });
});

test("the query that starts a routine scan still uses the validated semantic index", async (context) => {
  await withIndexer(async (indexer, directory) => {
    const source = "Water travels.";
    const target = await writeNote("a.md", source);
    await configureModel(directory);
    const db = indexer.database({ create: true })!;
    await indexer.databaseForSearch();
    db.replaceFile({ ...note, signature: await readFileSignature(target) },
      [{ hash: "ignored", title: "", text: source, context: "" }], "Notes a.md");
    db.storeVectors(db.pendingChunks(1, false).map((chunk) => ({ ...chunk, vector: unit() })));
    let queries = 0;
    context.mock.method(getSearchWorker(), "embed", async (_inputs: EmbedInput[], priority: "query" | "index") => {
      assert.equal(priority, "query");
      queries += 1;
      return [unit()];
    });
    const result = await runSearch({ parts: [{ type: "text", text: "aqueduct" }] });
    await indexer.requestScan();
    assert.equal(queries, 1);
    assert.equal(result.mode, "semantic");
    assert.equal(result.warning, undefined);
    assert.equal(result.results[0].path, "Notes/a.md");
  });
});
