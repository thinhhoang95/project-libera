import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SearchDatabase, type IndexedFile } from "../../src/lib/search/database";
import { contentHash, weightsSignature } from "../../src/lib/search/fingerprints";
import { SearchIndexer } from "../../src/lib/search/indexer";
import { getSearchWorker } from "../../src/lib/search/worker-client";
import { normalizeSearchPreferences } from "../../electron/search-preferences.cjs";
import { readFileSignature } from "../../src/lib/storage/file-signature";
import { filePathFromParts, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { readPdfTextCache } from "../../src/lib/storage/pdf-text-cache";

const file = { key: "Notes/a.md", source: "library", kind: "markdown", path: "Notes/a.md", name: "a.md", notebook: "Notes", signature: "1", meta: null } satisfies Omit<IndexedFile, "id" | "status">;
const chunk = { hash: "content", title: "Section", text: "Current passage", context: "" };
const vector = new Float32Array([1, 0, 0, 0]);

function embedAll(db: SearchDatabase) {
  db.storeVectors(db.pendingChunks(100, true).map((entry) => ({ ...entry, vector })));
}

async function withDatabase(run: (db: SearchDatabase, directory: string) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-cache-"));
  const db = new SearchDatabase(path.join(directory, "index.sqlite"));
  try {
    db.prepareVectors(4, "text:1", "vision:1");
    await run(db, directory);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("retained image vectors refresh all keyword fields and raw passage text", async () => {
  await withDatabase((db) => {
    const image = { ...file, key: "gallery:1", source: "gallery" as const, kind: "image" as const, path: "Old/cat.png", name: "cat.png" };
    db.replaceFile(image, [{ ...chunk, text: "cat sunset", title: "" }], "Gallery Old cat.png");
    embedAll(db);
    db.replaceFile({ ...image, path: "New/dog.png", name: "dog.png", signature: "2" }, [{ ...chunk, text: "dog sunrise", title: "" }], "Gallery New dog.png");
    assert.equal(db.counts().embeddedChunks, 1, "the pixels did not change");
    assert.equal(db.keyword('"sunset" OR "cat" OR "Old"', 10).length, 0);
    const hits = db.keyword('"sunrise" AND "dog" AND "New"', 10);
    assert.equal(hits.length, 1);
    assert.equal(db.chunkRows([hits[0].id])[0].text, "dog sunrise");
  });
});

test("vector reuse includes context and file title, while normalized markup can reuse vectors", async () => {
  await withDatabase((db) => {
    db.replaceFile(file, [chunk], "Notes a.md");
    embedAll(db);
    db.replaceFile({ ...file, signature: "2" }, [{ ...chunk, context: "Changed preceding paragraph" }], "Notes a.md");
    assert.equal(db.countPending(true), 1, "context is part of the embedding input");
    embedAll(db);
    db.replaceFile({ ...file, name: "renamed.md", signature: "3" }, [{ ...chunk, context: "Changed preceding paragraph" }], "Notes renamed.md");
    assert.equal(db.countPending(true), 1, "the document title is part of the embedding input");
    embedAll(db);
    db.replaceFile({ ...file, name: "renamed.md", signature: "4" }, [{ ...chunk, context: "Changed preceding paragraph", text: "[Current passage](obsolete)" }], "Notes renamed.md");
    assert.equal(db.countPending(true), 0, "markup removed from the prompt can retain its vector");
    assert.equal(db.keyword('"obsolete"', 10).length, 1, "FTS still stores current raw text");
  });
});

test("late embedding results and failures cannot attach to reused ids or reset vectors", async () => {
  await withDatabase((db) => {
    db.replaceFile(file, [chunk], "Notes a.md");
    const [old] = db.pendingChunks(1, true);
    db.clear();
    db.replaceFile(file, [{ ...chunk, text: "Replacement passage" }], "Notes a.md");
    const [replacement] = db.pendingChunks(1, true);
    assert.equal(old.id, replacement.id, "exercise SQLite row id reuse");
    db.storeVectors([{ ...old, vector }]);
    db.markEmbeddingFailed([old]);
    assert.equal(db.countPending(true), 1);
    embedAll(db);
    assert.equal(db.counts().embeddedChunks, 1);
    db.prepareVectors(4, "text:1", "vision:1", true);
    db.storeVectors([{ ...replacement, vector }]);
    assert.equal(db.countPending(true), 1, "explicit re-embed invalidates earlier work with the same settings");
    const current = db.pendingChunks(1, true);
    db.markEmbeddingFailed(current);
    assert.equal(db.countPending(true), 0);
    db.retryFailedEmbeddings();
    assert.equal(db.countPending(true), 1);
  });
});

test("relocation forces a content check and persisted older indexes get a repair scan", async () => {
  await withDatabase((db, directory) => {
    const id = db.replaceFile(file, [chunk], "Notes a.md");
    embedAll(db);
    db.relocateFile(id, { ...file, key: "Other/a.md", path: "Other/a.md", notebook: "Other" }, "Other a.md");
    assert.equal(db.listFiles()[0].signature, "");
    db.setMeta("content_version", "1");
    const reopened = new SearchDatabase(path.join(directory, "index.sqlite"));
    try {
      assert.equal(reopened.getMeta("content_version"), "2");
      assert.equal(reopened.listFiles()[0].signature, "");
      assert.equal(reopened.counts().embeddedChunks, 1, "repair waits for the source before replacing vectors");
    } finally { reopened.close(); }
  });
});

test("a failed vector reset rolls back its table, pending flags and model metadata together", async () => {
  await withDatabase((db) => {
    db.replaceFile(file, [chunk], "Notes a.md");
    embedAll(db);
    assert.throws(() => db.prepareVectors(-1, "text:2", "vision:2", true));
    assert.equal(db.getMeta("dimensions"), "4");
    assert.equal(db.getMeta("text_signature"), "text:1");
    assert.equal(db.counts().embeddedChunks, 1);
    assert.equal(db.nearest(vector, 1).length, 1);
  });
});

test("invalid inference outputs roll back the whole vector batch without marking passages embedded", async () => {
  await withDatabase((db) => {
    db.replaceFile(file, [chunk, { ...chunk, text: "Another passage" }], "Notes a.md");
    for (const invalid of [new Float32Array(4), new Float32Array([NaN, 0, 0, 0]), new Float32Array([Infinity, 0, 0, 0]), new Float32Array([1, 0])]) {
      const pending = db.pendingChunks(2, false);
      assert.throws(() => db.storeVectors([
        { ...pending[0], vector }, { ...pending[1], vector: invalid },
      ]), /embedding/);
      assert.equal(db.counts().embeddedChunks, 0);
      assert.equal(db.countPending(false), 2);
    }
    embedAll(db);
    assert.equal(db.counts().embeddedChunks, 2);
  });
});

test("unsupported and incomplete SQLite schemas are rejected without dropping their data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-schema-"));
  const { DatabaseSync } = (eval("require") as NodeRequire)("node:sqlite") as {
    DatabaseSync: new (file: string) => { exec(sql: string): void; prepare(sql: string): { get(): { value?: string; id?: number } }; close(): void };
  };
  try {
    for (const version of ["99", "1"]) {
      const target = path.join(directory, `${version}.sqlite`);
      const original = new DatabaseSync(target);
      original.exec(`CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('schema', '${version}'); CREATE TABLE files (id INTEGER); INSERT INTO files VALUES (42);`);
      original.close();
      assert.throws(() => new SearchDatabase(target), /not changed/);
      const reopened = new DatabaseSync(target);
      try {
        assert.equal(reopened.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, version);
        assert.equal(reopened.prepare("SELECT id FROM files").get().id, 42);
      } finally { reopened.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed index initialization closes its SQLite connection", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-open-"));
  const { DatabaseSync } = (eval("require") as NodeRequire)("node:sqlite") as {
    DatabaseSync: { prototype: { loadExtension(file: string): void; close(): void } };
  };
  const closed = context.mock.method(DatabaseSync.prototype, "close");
  context.mock.method(DatabaseSync.prototype, "loadExtension", () => { throw new Error("Extension unavailable"); });
  try {
    assert.throws(() => new SearchDatabase(path.join(directory, "index.sqlite")), /Extension unavailable/);
    assert.equal(closed.mock.callCount(), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cached status counts stay correct across local writes, caller mutation, and another SQLite connection", async () => {
  await withDatabase((db, directory) => {
    assert.equal(db.counts().files, 0);
    db.replaceFile(file, [chunk], "Notes a.md");
    const counts = db.counts();
    assert.equal(counts.files, 1);
    counts.files = 999;
    assert.equal(db.counts().files, 1);
    embedAll(db);
    assert.equal(db.counts().embeddedChunks, 1);
    const { DatabaseSync } = (eval("require") as NodeRequire)("node:sqlite") as {
      DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
    };
    const external = new DatabaseSync(path.join(directory, "index.sqlite"));
    try { external.exec("UPDATE files SET status = 'error'"); }
    finally { external.close(); }
    assert.equal(db.counts().files, 0);
    assert.equal(db.counts().failedFiles, 1);
  });
});

test("a failed close checkpoint still releases the SQLite connection", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-close-"));
  const db = new SearchDatabase(path.join(directory, "index.sqlite"));
  const { DatabaseSync } = (eval("require") as NodeRequire)("node:sqlite") as {
    DatabaseSync: { prototype: { exec(sql: string): void; close(): void } };
  };
  const original = DatabaseSync.prototype.exec;
  const closed = context.mock.method(DatabaseSync.prototype, "close");
  context.mock.method(DatabaseSync.prototype, "exec", function (this: unknown, sql: string) {
    if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") throw new Error("Checkpoint unavailable");
    return original.call(this, sql);
  });
  try {
    assert.throws(() => db.close(), /Checkpoint unavailable/);
    assert.equal(closed.mock.callCount(), 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprints catch preserved-mtime edits, image-tail edits and changed model dependencies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-fingerprint-"));
  try {
    const target = path.join(directory, "large.png");
    const bytes = Buffer.alloc(300 * 1024, 1);
    await writeFile(target, bytes);
    const before = await stat(target);
    const signature = await readFileSignature(target);
    const hash = await contentHash(target);
    bytes[bytes.length - 1] = 2;
    await writeFile(target, bytes);
    await utimes(target, before.atime, before.mtime);
    assert.notEqual(await readFileSignature(target), signature);
    assert.notEqual(await contentHash(target), hash);

    const weights = path.join(directory, "model_q4.onnx");
    await writeFile(weights, "AAAA");
    await writeFile(`${weights}_data`, "BBBB");
    await writeFile(path.join(directory, "config.json"), "{}");
    await writeFile(path.join(directory, "tokenizer.json"), "{}");
    const first = await weightsSignature(weights, true);
    await writeFile(`${weights}_data`, "CCCC");
    const second = await weightsSignature(weights, true);
    assert.notEqual(second, first);
    await writeFile(path.join(directory, "tokenizer.json"), '{"changed":true}');
    assert.notEqual(await weightsSignature(weights, true), second);
    const copied = path.join(directory, "copied");
    await mkdir(copied);
    for (const name of ["model_q4.onnx", "model_q4.onnx_data", "config.json", "tokenizer.json"]) {
      await writeFile(path.join(copied, name), await readFile(path.join(directory, name)));
    }
    assert.equal(await weightsSignature(path.join(copied, "model_q4.onnx"), true), await weightsSignature(weights, true), "model identity survives copying to another computer");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function withIndexer(run: (indexer: SearchIndexer, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-scan-"));
  const keys = ["LIBERA_DATA_DIR", "LIBERA_CONFIG_PATH", "LIBERA_SEARCH_INDEX_FILE", "LIBERA_SEARCH_TEXT_WEIGHTS", "LIBERA_SEARCH_VISION_WEIGHTS", "LIBERA_SEARCH_DIMENSIONS", "LIBERA_SEARCH_INDEX_IMAGES"];
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key) => { delete process.env[key]; });
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_SEARCH_DIMENSIONS = "128";
  const indexer = new SearchIndexer();
  try { await run(indexer, directory); }
  finally {
    indexer.database()?.close();
    getSearchWorker().stop();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeNote(name: string, text: string) {
  const target = filePathFromParts("Notes", [name]);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
}

test("scans update equal-size preserved-mtime edits, remove deletions, and verify relocated contents", async () => {
  await withIndexer(async (indexer) => {
    const target = await writeNote("a.md", "alpha");
    const before = await stat(target);
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    assert.equal(db.keyword('"alpha"', 10).length, 1);
    await writeFile(target, "bravo");
    await utimes(target, before.atime, before.mtime);
    await indexer.requestScan({ force: true });
    assert.equal(db.keyword('"alpha"', 10).length, 0);
    assert.equal(db.keyword('"bravo"', 10).length, 1);
    const other = filePathFromParts("Other", ["a.md"]);
    await mkdir(path.dirname(other), { recursive: true });
    await rename(target, other);
    await writeFile(other, "delta");
    await indexer.requestScan({ force: true });
    assert.equal(db.keyword('"bravo"', 10).length, 0);
    assert.equal(db.keyword('"delta"', 10).length, 1);
    await rm(other);
    await indexer.requestScan({ force: true });
    assert.equal(db.listFiles().length, 0);
    assert.equal(db.keyword('"delta"', 10).length, 0);
  });
});

test("failed file reads retry without a metadata change", async (context) => {
  await withIndexer(async (indexer) => {
    await writeNote("paper.pdf", "not a PDF");
    let fails = true;
    context.mock.method(getSearchWorker(), "pdfText", async () => {
      if (fails) throw new Error("Temporary worker failure");
      return { numPages: 1, pages: [{ pageNumber: 1, items: [{ str: "Recovered passage", hasEOL: false }] }] };
    });
    await indexer.requestScan({ force: true, build: true });
    assert.equal(indexer.database()!.counts().failedFiles, 1);
    fails = false;
    await indexer.requestScan({ force: true });
    assert.equal(indexer.database()!.counts().failedFiles, 0);
    assert.equal(indexer.database()!.keyword('"Recovered"', 10).length, 1);
  });
});

test("a gallery scan failure does not prevent stale library entries from being removed", async () => {
  await withIndexer(async (indexer, directory) => {
    const target = await writeNote("a.md", "alpha");
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    db.replaceFile({ ...file, key: "gallery:1", source: "gallery", kind: "image", path: "photo.png", name: "photo.png", notebook: "" }, [{ ...chunk, text: "photo" }], "Gallery photo.png");
    await rm(path.join(directory, "gallery"), { recursive: true, force: true });
    await writeFile(path.join(directory, "gallery"), "temporarily unavailable");
    await rm(target);
    await indexer.requestScan({ force: true });
    assert.deepEqual(db.listFiles().map((entry) => entry.key), ["gallery:1"], "unreadable sources stay cached for a later retry");
    assert.equal(db.keyword('"alpha"', 10).length, 0);
    assert.ok(indexer.status().error);
  });
});

test("PDF content changes are detected beneath a newer annotation timestamp", async (context) => {
  await withIndexer(async (indexer) => {
    const target = await writeNote("paper.pdf", "alpha");
    const annotation = pdfAnnotationsPath("Notes", "paper.pdf");
    await mkdir(path.dirname(annotation), { recursive: true });
    await writeFile(annotation, "{}");
    const future = new Date("2040-01-01T00:00:00Z");
    await utimes(annotation, future, future);
    context.mock.method(getSearchWorker(), "pdfText", async () => ({
      numPages: 1, pages: [{ pageNumber: 1, items: [{ str: await readFile(target, "utf8"), hasEOL: false }] }],
    }));
    await indexer.requestScan({ force: true, build: true });
    const before = await stat(target);
    await writeFile(target, "bravo");
    await utimes(target, before.atime, before.mtime);
    await indexer.requestScan({ force: true });
    const db = indexer.database()!;
    assert.equal(db.keyword('"alpha"', 10).length, 0);
    assert.equal(db.keyword('"bravo"', 10).length, 1);
  });
});

test("a PDF modified during extraction cannot persist stale text under its new identity", async () => {
  await withIndexer(async () => {
    const target = await writeNote("paper.pdf", "alpha");
    await assert.rejects(readPdfTextCache("Notes/paper.pdf", { extractPages: async () => {
      await writeFile(target, "bravo");
      return [{ pageNumber: 1, text: "alpha" }];
    } }), /changed while being read/);
    const cache = await readPdfTextCache("Notes/paper.pdf", { extractPages: async () => [{ pageNumber: 1, text: "bravo" }] });
    assert.equal(cache.pages[0].text, "bravo");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("switching index files during extraction discards late writes and scans the chosen index", async (context) => {
  await withIndexer(async (indexer, directory) => {
    await writeNote("paper.pdf", "alpha");
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    context.mock.method(getSearchWorker(), "pdfText", async () => {
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return { numPages: 1, pages: [{ pageNumber: 1, items: [{ str: "Current passage", hasEOL: false }] }] };
    });
    const originalPath = path.join(directory, "original.sqlite");
    process.env.LIBERA_SEARCH_INDEX_FILE = originalPath;
    const scan = indexer.requestScan({ force: true, build: true });
    await entered.promise;
    const chosenPath = path.join(directory, "chosen.sqlite");
    const chosen = new SearchDatabase(chosenPath);
    chosen.prepareVectors(128, "", "");
    chosen.close();
    process.env.LIBERA_SEARCH_INDEX_FILE = chosenPath;
    indexer.status();
    release.resolve();
    await scan;
    assert.equal(indexer.status().error, undefined);
    assert.equal(indexer.database()!.keyword('"Current"', 10).length, 1);
    const original = new SearchDatabase(originalPath);
    try { assert.equal(original.counts().chunks, 0, "the superseded pass never commits"); }
    finally { original.close(); }
  });
});

test("a rebuild requested during a scan cannot repopulate the index with the old pass", async (context) => {
  await withIndexer(async (indexer) => {
    const target = await writeNote("paper.pdf", "alpha");
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    context.mock.method(getSearchWorker(), "pdfText", async () => {
      const text = await readFile(target, "utf8");
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return { numPages: 1, pages: [{ pageNumber: 1, items: [{ str: text, hasEOL: false }] }] };
    });
    const scan = indexer.requestScan({ force: true, build: true });
    await entered.promise;
    await writeFile(target, "bravo");
    await indexer.rebuild();
    release.resolve();
    await scan;
    const db = indexer.database()!;
    assert.equal(indexer.status().error, undefined);
    assert.equal(db.keyword('"alpha"', 10).length, 0);
    assert.equal(db.keyword('"bravo"', 10).length, 1);
  });
});

test("persisted model mismatches are checked before the first semantic query", async () => {
  await withIndexer(async (indexer, directory) => {
    process.env.LIBERA_SEARCH_TEXT_WEIGHTS = path.join(directory, "model_q4.onnx");
    await writeFile(process.env.LIBERA_SEARCH_TEXT_WEIGHTS, "new model");
    const db = indexer.database({ create: true })!;
    db.prepareVectors(128, "model_q4.onnx:old", "");
    db.replaceFile(file, [chunk], "Notes a.md");
    db.storeVectors(db.pendingChunks(1, true).map((entry) => ({ ...entry, vector: new Float32Array(128).fill(1) })));
    assert.equal(await indexer.databaseForSearch(), db);
    assert.equal(indexer.vectorsUsable, false);
    assert.match(indexer.status().mismatch ?? "", /text model/);
  });
});

test("selecting another existing index bypasses the previous index's scan throttle", async () => {
  await withIndexer(async (indexer, directory) => {
    await writeNote("a.md", "alpha");
    await indexer.requestScan({ force: true, build: true });
    const chosenPath = path.join(directory, "chosen.sqlite");
    const chosen = new SearchDatabase(chosenPath);
    chosen.prepareVectors(128, "", "");
    chosen.close();
    process.env.LIBERA_SEARCH_INDEX_FILE = chosenPath;
    await indexer.requestScan();
    assert.equal(indexer.database()!.keyword('"alpha"', 10).length, 1);
  });
});

test("image-detail settings are part of the persisted vision fingerprint", async () => {
  await withDatabase((db) => {
    db.prepareVectors(4, "text:1", "vision:1|tokens:140");
    db.replaceFile({ ...file, kind: "image" }, [chunk], "Notes a.png");
    embedAll(db);
    assert.match(db.prepareVectors(4, "text:1", "vision:1|tokens:280") ?? "", /vision encoder/);
    assert.equal(db.counts().embeddedChunks, 1, "a mismatch waits for explicit re-embedding");
  });
});

test("an index atomically replaced at the same path gets a fresh database handle", async () => {
  await withIndexer(async (indexer, directory) => {
    await writeNote("a.md", "alpha");
    await indexer.requestScan({ force: true, build: true });
    const old = indexer.database()!;
    old.checkpoint();
    const replacementPath = path.join(directory, "replacement.sqlite");
    const replacement = new SearchDatabase(replacementPath);
    replacement.prepareVectors(128, "", "");
    replacement.close();
    await rename(replacementPath, old.filePath);
    const reopened = indexer.database()!;
    assert.notEqual(reopened, old);
    assert.equal(reopened.counts().chunks, 0);
    await indexer.requestScan();
    assert.equal(reopened.keyword('"alpha"', 10).length, 1);
  });
});

test("an image changed during embedding discards its old vector and is embedded again", async (context) => {
  await withIndexer(async (indexer, directory) => {
    const target = await writeNote("a.png", "alpha");
    const weights = path.join(directory, "model_q4.onnx");
    const vision = path.join(directory, "vision_encoder_q4.onnx");
    await writeFile(weights, "text");
    await writeFile(vision, "vision");
    process.env.LIBERA_SEARCH_TEXT_WEIGHTS = weights;
    process.env.LIBERA_SEARCH_VISION_WEIGHTS = vision;
    const worker = getSearchWorker();
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    context.mock.method(worker, "ensureModel", async () => ({ textDtype: "q4", visionDtype: "q4", vision: true, loadMs: 0 }));
    context.mock.method(worker, "embed", async () => {
      const position = calls++;
      if (position === 0) { entered.resolve(); await release.promise; }
      const embedded = new Float32Array(128);
      embedded[position] = 1;
      return [embedded];
    });
    const scan = indexer.requestScan({ force: true, build: true });
    await entered.promise;
    await writeFile(target, "bravo");
    release.resolve();
    await scan;
    assert.equal(calls, 2);
    const current = new Float32Array(128);
    current[1] = 1;
    assert.ok(indexer.database()!.nearest(current, 1)[0].similarity > 0.99);
  });
});

test("a build requested while the old index scans creates only the explicitly chosen file", async (context) => {
  await withIndexer(async (indexer, directory) => {
    await writeNote("paper.pdf", "alpha");
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    context.mock.method(getSearchWorker(), "pdfText", async () => {
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return { numPages: 1, pages: [{ pageNumber: 1, items: [{ str: "Current passage", hasEOL: false }] }] };
    });
    const scan = indexer.requestScan({ force: true, build: true });
    await entered.promise;
    process.env.LIBERA_SEARCH_INDEX_FILE = path.join(directory, "new-index.sqlite");
    indexer.requestScan({ force: true, build: true });
    release.resolve();
    await scan;
    assert.equal(indexer.database()!.filePath, process.env.LIBERA_SEARCH_INDEX_FILE);
    assert.equal(indexer.database()!.keyword('"Current"', 10).length, 1);
  });
});

test("a retired model load cannot overwrite a new load after settings switch away and back", async (context) => {
  const worker = getSearchWorker();
  worker.stop();
  const preferences = normalizeSearchPreferences({ textWeights: "/fake/model_q4.onnx" });
  worker.configure(preferences, "first");
  const old = deferred<void>();
  const current = deferred<{ textDtype: string; visionDtype: null; vision: boolean; loadMs: number }>();
  let calls = 0;
  const internals = worker as unknown as { request: () => Promise<unknown> };
  context.mock.method(internals, "request", () => ++calls === 1 ? old.promise : current.promise);
  try {
    const oldLoad = worker.ensureModel();
    worker.configure(preferences, "second");
    worker.configure(preferences, "first");
    const newLoad = worker.ensureModel();
    // Resolve the old request after the new one starts, exercising the ABA case.
    old.resolve();
    await assert.rejects(oldLoad, /restarted/);
    assert.equal(worker.modelState, "loading");
    assert.equal(worker.modelError, "");
    current.resolve({ textDtype: "q4", visionDtype: null, vision: false, loadMs: 1 });
    await newLoad;
    assert.equal(worker.modelState, "ready");
  } finally { worker.stop(); }
});

test("a recording is indexed through its transcript, never its audio, and reindexed when the transcript changes", async () => {
  await withIndexer(async (indexer) => {
    const target = filePathFromParts("Notes", ["interview.m4a"]);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "ftypM4A binary audio words");
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    assert.equal(db.listFiles()[0].kind, "audio");
    assert.equal(db.keyword('"interview"', 10).length, 1, "without a transcript it is found by name");
    assert.equal(db.keyword('"binary"', 10).length, 0, "the audio bytes are never read as text");

    const { writeTranscript, renameTranscriptSpeakers } = await import("../../src/lib/storage/transcripts");
    await writeTranscript("Notes/interview.m4a", {
      version: 1,
      createdAt: "2026-10-19T10:00:00.000Z",
      audio: { size: 26, modifiedAt: "", duration: 70 },
      engine: { kind: "local", model: "Parakeet TDT 0.6B v3" },
      language: "en",
      diarization: null,
      speakers: [{ name: "Speaker 1", talkSeconds: 60, share: 1, segments: 1 }],
      segments: [{ start: 62.5, end: 68, speaker: 0, text: "Sparse attention scales to long documents." }],
      stats: { words: 6, chunks: 1, elapsedMs: 10 },
    });
    await indexer.requestScan({ force: true });
    const hits = db.keyword('"sparse" AND "attention"', 10);
    assert.equal(hits.length, 1);
    const [row] = db.chunkRows([hits[0].id]);
    assert.equal(row.start, 62500, "the passage starts where it is said, in milliseconds");
    assert.equal(db.keyword('"interview"', 10).length, 1, "the file name stays searchable");

    await renameTranscriptSpeakers("Notes/interview.m4a", { 0: "Vy" });
    await indexer.requestScan({ force: true });
    assert.equal(db.keyword('"Vy"', 10).length, 1, "a renamed speaker is found by name");
  });
});
