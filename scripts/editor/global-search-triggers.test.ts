import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { POST as indexAction } from "../../src/app/api/search/index/route";
import { GET as indexStatus } from "../../src/app/api/search/status/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { SearchIndexer } from "../../src/lib/search/indexer";
import { runSearch } from "../../src/lib/search/query";
import { getSearchWorker, type EmbedInput } from "../../src/lib/search/worker-client";
import { createMarkdownFile, deleteFile, moveFile, updateMarkdownFile, writeUploadedFile } from "../../src/lib/storage/files";
import { openDirectory } from "../../src/lib/storage/directory-mode";
import { deletePhotos, getGallery, writeGalleryPhoto } from "../../src/lib/storage/gallery";
import { filePathFromParts, getAdminRoot, notebookSystemDirectoryPath } from "../../src/lib/storage/paths";
import { readFileSignature } from "../../src/lib/storage/file-signature";
import { SearchDatabase } from "../../src/lib/search/database";
import { weightsSignature } from "../../src/lib/search/fingerprints";
import { readSearchLibrary } from "../../src/lib/search/library-files";

const INDEXER_KEY = Symbol.for("libera.searchIndexer");
const model = { textDtype: "q4", visionDtype: "q4", vision: true, device: "cpu", fallback: null, loadMs: 0 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

function vector() {
  const result = new Float32Array(128);
  result[0] = 1;
  return result;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function internals(indexer: SearchIndexer) {
  return indexer as unknown as {
    running: Promise<void> | null;
    lastFullScanAt: number;
    chunkLibraryFile: (...args: unknown[]) => Promise<unknown>;
    scan: (...args: unknown[]) => Promise<void>;
  };
}

async function action(action: string) {
  const response = await indexAction(new NextRequest("http://localhost/api/search/index", {
    method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify({ action }),
  }));
  assert.equal(response.status, 200);
  return response.json();
}

async function poll() {
  const response = await indexStatus(new NextRequest("http://localhost/api/search/status?scan=1", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` },
  }));
  assert.equal(response.status, 200);
}

async function writeNote(name: string, text: string) {
  const target = filePathFromParts("Notes", [name]);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
}

async function withIndexer(context: TestContext, run: (indexer: SearchIndexer, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-search-triggers-"));
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
    if (previousIndexer) store[INDEXER_KEY] = previousIndexer;
    else delete store[INDEXER_KEY];
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
}

test("paused indexing rejects every automatic trigger; a manual update embeds once and stays paused", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("a.md", "Old orchard.");
    await writeNote("deleted.md", "To delete.");
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    await action("pause");
    await updateMarkdownFile("Notes/a.md", "New orchard.");
    await deleteFile("Notes/deleted.md");
    internals(indexer).lastFullScanAt = 0;
    assert.equal(indexer.requestScan({ force: true, manual: false }), undefined);
    assert.equal(indexer.requestScan({ force: true }), undefined, "force only bypasses the throttle");
    await action("background");
    await poll();
    // Force the status/configuration hook to run as well.
    process.env.LIBERA_SEARCH_DIMENSIONS = "256";
    indexer.status();
    process.env.LIBERA_SEARCH_DIMENSIONS = "128";
    const result = await runSearch({ parts: [{ type: "text", text: "orchard" }] });
    assert.ok(result.results.length, "existing search remains usable while paused");
    assert.equal(internals(indexer).running, null);
    assert.equal(db.keyword('"Old"', 10).length, 1);
    assert.equal(db.listFiles().length, 2, "automatic work must not delete index entries");
    await action("scan");
    await internals(indexer).running;
    assert.equal(db.keyword('"New"', 10).length, 1);
    assert.equal(db.listFiles().length, 1);
    assert.equal(db.counts().embeddedChunks, db.counts().chunks);
    assert.equal(indexer.status().state, "paused");
    await writeNote("later.md", "Still waiting.");
    await poll();
    assert.equal(db.listFiles().length, 1, "one manual update must not enable automatic work");
  });
});

test("background-off applies to polling, queries, settings and storage hooks while manual actions work", async (context) => {
  await withIndexer(context, async (indexer) => {
    process.env.LIBERA_SEARCH_BACKGROUND_INDEXING = "0";
    await writeNote("a.md", "Before.");
    await action("build");
    await internals(indexer).running;
    const db = indexer.database()!;
    await updateMarkdownFile("Notes/a.md", "After.");
    internals(indexer).lastFullScanAt = 0;
    await poll();
    await action("background");
    await runSearch({ parts: [{ type: "text", text: "Before" }] });
    process.env.LIBERA_SEARCH_DIMENSIONS = "256";
    assert.equal(indexer.status().backgroundIndexing, false);
    process.env.LIBERA_SEARCH_DIMENSIONS = "128";
    assert.equal(internals(indexer).running, null);
    assert.equal(db.keyword('"Before"', 10).length, 1);
    await action("scan");
    await internals(indexer).running;
    assert.equal(db.keyword('"After"', 10).length, 1);
    assert.equal(db.counts().embeddedChunks, 1);
    await action("pause");
    await action("reembed");
    await internals(indexer).running;
    assert.equal(db.counts().embeddedChunks, 1);
    assert.equal(indexer.status().state, "paused");
  });
});

test("a query cannot consume a pending reset or write changed model metadata while paused", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("a.md", "Existing passage.");
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    const signature = db.getMeta("text_signature");
    indexer.reembed();
    indexer.pause();
    await internals(indexer).running;
    const writes = context.mock.method(db, "setMeta");
    await runSearch({ parts: [{ type: "text", text: "Existing" }] });
    assert.equal(db.counts().embeddedChunks, 1, "a cancelled re-embed cannot be performed by a query");
    assert.equal(db.getMeta("text_signature"), signature);
    assert.equal(writes.mock.callCount(), 0, "paused queries only validate stored model metadata");
  });
});

test("resume reconciles every change during the pause, including unreported disk and gallery changes", async (context) => {
  await withIndexer(context, async (indexer, directory) => {
    process.env.LIBERA_SEARCH_INDEX_IMAGES = "1";
    process.env.LIBERA_SEARCH_VISION_WEIGHTS = path.join(directory, "vision_encoder_q4.onnx");
    await writeFile(process.env.LIBERA_SEARCH_VISION_WEIGHTS, "test vision model");
    await writeNote("edited.md", "Before editing.");
    await writeNote("deleted.md", "Deleted later.");
    await writeNote("moved.md", "A moved passage.");
    await writeNote("external.md", "Before sync.");
    await writeNote("stable.md", "Unchanged passage.");
    await writeGalleryPhoto("", "old.png", png, {});
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    const [stableHit] = db.keyword('"Unchanged"', 10);
    const before = db.counts();
    await action("pause");
    await updateMarkdownFile("Notes/edited.md", "After editing.");
    await deleteFile("Notes/deleted.md");
    await moveFile("Notes/moved.md", "Notes", "renamed.md");
    await createMarkdownFile("Notes", "added.md", "Added while paused.");
    await writeNote("external.md", "After sync.");
    await writeNote("external-added.md", "Arrived from sync.");
    await mkdir(filePathFromParts("Notes", ["Folder"]));
    await rename(filePathFromParts("Notes", ["renamed.md"]), filePathFromParts("Notes", ["Folder", "renamed.md"]));
    const oldPhoto = (await getGallery()).photos[0];
    await deletePhotos([oldPhoto.id]);
    await writeGalleryPhoto("", "new.png", png, { prompt: "New gallery scene" });
    await poll();
    assert.deepEqual(db.counts(), before, "all index data stays frozen while paused");
    await action("resume");
    await internals(indexer).running;
    const paths = db.listFiles().map((file) => file.path).sort();
    assert.deepEqual(paths, ["Notes/Folder/renamed.md", "Notes/added.md", "Notes/edited.md", "Notes/external-added.md", "Notes/external.md", "Notes/stable.md", "new.png"].sort());
    assert.equal(db.keyword('"Before"', 10).length, 0);
    assert.equal(db.keyword('"After"', 10).length, 2);
    assert.equal(db.keyword('"scene"', 10).length, 1);
    assert.equal(db.counts().embeddedChunks, db.counts().chunks);
    assert.equal(db.keyword('"Unchanged"', 10)[0].id, stableHit.id, "unchanged passages retain their rows and vectors");
    assert.equal(indexer.status().state, "idle");
  });
});

test("pausing during a scan prevents late file writes and stops visiting further files", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("a.md", "Before.");
    await writeNote("b.md", "Second before.");
    await indexer.requestScan({ force: true, build: true });
    await writeNote("a.md", "After.");
    await writeNote("b.md", "Second after.");
    const entered = deferred();
    const release = deferred();
    const target = internals(indexer);
    const original = target.chunkLibraryFile.bind(indexer);
    const read = context.mock.method(target, "chunkLibraryFile", async (...args: unknown[]) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const pass = indexer.requestScan({ force: true, manual: false });
    await entered.promise;
    indexer.pause();
    release.resolve();
    await pass;
    assert.equal(read.mock.callCount(), 1);
    assert.equal(indexer.database()!.keyword('"After"', 10).length, 0);
    assert.equal(indexer.status().state, "paused");
    await action("resume");
    await target.running;
    assert.equal(indexer.database()!.keyword('"After"', 10).length, 2);
  });
});

for (const stop of ["pause", "background-off"] as const) {
  test(`${stop} during inference discards its late vector and stops further batches`, async (context) => {
    await withIndexer(context, async (indexer) => {
      await writeNote("a.md", "One passage.");
      const entered = deferred();
      const release = deferred();
      context.mock.method(getSearchWorker(), "embed", async (inputs: EmbedInput[]) => {
        entered.resolve();
        await release.promise;
        return inputs.map(vector);
      });
      const pass = indexer.requestScan({ force: true, build: true, manual: false });
      await entered.promise;
      if (stop === "pause") indexer.pause();
      else process.env.LIBERA_SEARCH_BACKGROUND_INDEXING = "0";
      release.resolve();
      await pass;
      assert.equal(indexer.database()!.counts().embeddedChunks, 0);
      assert.equal(indexer.database()!.countPending(false), 1);
      await poll();
      assert.equal(internals(indexer).running, null);
      await action("scan");
      await internals(indexer).running;
      assert.equal(indexer.database()!.counts().embeddedChunks, 1);
    });
  });
}

test("storage hooks debounce changes, update only affected paths, and never build the first index", async (context) => {
  await withIndexer(context, async (indexer, directory) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const project = path.join(directory, "Project");
      await mkdir(path.join(project, "node_modules"), { recursive: true });
      const linked = await openDirectory(project);
      await writeNote("stable.md", "Keep this passage.");
      await createMarkdownFile("Notes", "a.md", "Original passage.");
      context.mock.timers.tick(1_000);
      assert.equal(indexer.status().exists, false);
      await internals(indexer).running;
      await indexer.requestScan({ force: true, build: true });
      const fullScan = context.mock.method(internals(indexer), "scan");
      await updateMarkdownFile("Notes/a.md", "Intermediate passage.");
      await updateMarkdownFile("Notes/a.md", "Final passage.");
      await createMarkdownFile("Notes", "b.md", "New passage.");
      await createMarkdownFile(linked.name, "vendor.txt", "Dependency internals.", `${linked.name}/node_modules`);
      await writeUploadedFile("Notes", new File(["Uploaded passage."], "upload.txt"));
      await moveFile("Notes/b.md", "Notes", "moved.md");
      context.mock.timers.tick(999);
      assert.equal(internals(indexer).running, null);
      context.mock.timers.tick(1);
      await internals(indexer).running;
      const db = indexer.database()!;
      assert.equal(fullScan.mock.callCount(), 0, "file hooks must not walk the entire library");
      assert.equal(db.keyword('"Final"', 10).length, 1);
      assert.equal(db.keyword('"Intermediate"', 10).length, 0);
      assert.equal(db.keyword('"Uploaded"', 10).length, 1);
      assert.deepEqual(db.listFiles().map((file) => file.path).sort(), ["Notes/a.md", "Notes/moved.md", "Notes/stable.md", "Notes/upload.txt"]);
      await deleteFile("Notes/a.md");
      context.mock.timers.tick(1_000);
      await internals(indexer).running;
      assert.equal(db.keyword('"Final"', 10).length, 0);
      assert.equal(fullScan.mock.callCount(), 0);
      assert.equal(db.counts().embeddedChunks, db.counts().chunks);
    } finally { context.mock.timers.reset(); }
  });
});

test("offline linked folders retain their entries and vectors, and reconnecting reconciles every change", async (context) => {
  await withIndexer(context, async (indexer, directory) => {
    const project = path.join(directory, "Project");
    const offline = path.join(directory, "Offline");
    await mkdir(project);
    await writeFile(path.join(project, "a.md"), "Before disconnect.");
    await writeFile(path.join(project, "deleted.md"), "Remove while offline.");
    const linked = await openDirectory(project);
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    const before = db.counts();
    indexer.pause();
    await rename(project, offline);
    await writeFile(path.join(offline, "a.md"), "After reconnect.");
    await rm(path.join(offline, "deleted.md"));
    await action("resume");
    await internals(indexer).running;
    assert.deepEqual(db.counts(), before, "missing drives are not empty folders");
    assert.equal(db.keyword('"Before"', 10).length, 1);
    assert.match(indexer.status().error ?? "", /unavailable/);
    assert.equal(db.listFiles().some((file) => indexer.isStale(file.id)), false);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      indexer.notifyChanges([`${linked.name}/a.md`]);
      context.mock.timers.tick(1_000);
      await internals(indexer).running;
      assert.deepEqual(db.counts(), before, "path-only updates also preserve offline entries");
    } finally { context.mock.timers.reset(); }
    await rename(offline, project);
    await action("resume");
    await internals(indexer).running;
    assert.equal(db.listFiles().length, 1);
    assert.equal(db.keyword('"After"', 10).length, 1);
    assert.equal(db.counts().embeddedChunks, 1);
    assert.equal(indexer.status().error, undefined);
  });
});

test("an unavailable Master directory cannot be recreated and mistaken for an empty library", async (context) => {
  await withIndexer(context, async (indexer, directory) => {
    await writeNote("a.md", "Retain this passage.");
    await indexer.requestScan({ force: true, build: true });
    const db = indexer.database()!;
    const root = getAdminRoot();
    const unavailable = path.join(directory, "unavailable-master");
    indexer.pause();
    await rename(root, unavailable);
    await action("resume");
    await internals(indexer).running;
    assert.equal(existsSync(root), false);
    assert.equal(db.counts().embeddedChunks, 1);
    assert.equal(db.keyword('"Retain"', 10).length, 1);
    assert.ok(indexer.status().error, "an unverified library must not report itself up to date");
    await rename(unavailable, root);
    await action("resume");
    await internals(indexer).running;
    assert.equal(indexer.status().error, undefined);
  });
});

test("Search's full scan neither runs UI cache work nor inherits the 20,000-entry display limit", async (context) => {
  await withIndexer(context, async (indexer, directory) => {
    await writeNote("a.md", "A local passage.");
    const project = path.join(directory, "Project");
    await mkdir(project);
    await writeFile(path.join(project, "zz.md"), "Beyond the UI limit.");
    const linked = await openDirectory(project);
    const fs = (eval("require") as NodeRequire)("node:fs/promises") as {
      readdir: (directory: string, options: { withFileTypes: true }) => Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
    };
    const original = fs.readdir;
    context.mock.method(fs, "readdir", async (target: string, options: { withFileTypes: true }) => {
      const entries = await original(target, options);
      return target === project ? [
        ...Array.from({ length: 20_001 }, () => ({ name: "000-unsupported.bin", isDirectory: () => false, isFile: () => true })),
        ...entries,
      ] : entries;
    });
    await indexer.requestScan({ force: true, build: true });
    assert.equal(indexer.database()!.keyword('"Beyond"', 10).length, 1);
    assert.equal(existsSync(path.join(notebookSystemDirectoryPath("Notes"), "notebook-links.json")), false);
    assert.equal(existsSync(path.join(notebookSystemDirectoryPath(linked.name), "notebook-links.json")), false);
    let checks = 0;
    const cancelled = await readSearchLibrary(() => ++checks < 5);
    assert.equal(cancelled.cancelled, true, "a paused metadata walk stops before traversing the remaining entries");
  });
});

for (const fallback of [false, true]) {
  test(`external text edits during ${fallback ? "fallback" : "batch"} inference discard the stale vector`, async (context) => {
    await withIndexer(context, async (indexer) => {
      await writeNote("a.md", "Before inference.");
      if (fallback) await writeNote("b.md", "Another passage.");
      let calls = 0;
      let changed = false;
      context.mock.method(getSearchWorker(), "embed", async (inputs: EmbedInput[]) => {
        calls += 1;
        if (fallback && calls === 1) throw new Error("Exercise fallback inference.");
        if (!changed) {
          changed = true;
          await writeNote("a.md", "After inference.");
          const old = new Float32Array(128); old[1] = 1;
          return inputs.map(() => old);
        }
        return inputs.map(vector);
      });
      await indexer.requestScan({ force: true, build: true });
      const db = indexer.database()!;
      assert.equal(db.keyword('"Before"', 10).length, 0);
      assert.equal(db.keyword('"After"', 10).length, 1);
      assert.equal(db.counts().embeddedChunks, fallback ? 2 : 1);
      assert.ok(db.nearest(vector(), 1)[0].similarity > 0.99, "only current source vectors are stored");
      assert.equal(calls, fallback ? 3 : 2);
    });
  });
}

test("continuous file rewrites back off instead of keeping inference hot, then catch up when stable", async (context) => {
  await withIndexer(context, async (indexer) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await writeNote("a.md", "Version 0.");
      let calls = 0;
      let changing = true;
      context.mock.method(getSearchWorker(), "embed", async (inputs: EmbedInput[]) => {
        calls += 1;
        if (changing) await writeNote("a.md", `Version ${calls}.`);
        return inputs.map(vector);
      });
      await indexer.requestScan({ force: true, build: true });
      assert.equal(calls, 3, "a pass has a finite inference budget for unstable sources");
      assert.equal(indexer.database()!.counts().embeddedChunks, 0);
      assert.match(indexer.status().error ?? "", /still changing/);
      context.mock.timers.tick(29_999);
      assert.equal(internals(indexer).running, null);
      changing = false;
      context.mock.timers.tick(1);
      await internals(indexer).running;
      const db = indexer.database()!;
      assert.equal(db.counts().embeddedChunks, 1);
      assert.equal(db.chunkRows(db.keyword('"Version"', 10).map((hit) => hit.id))[0].text, "Version 3.");
      assert.equal(indexer.status().error, undefined);
    } finally { context.mock.timers.reset(); }
  });
});

test("an index replaced during inference is detected without polling and cannot receive stale writes", async (context) => {
  await withIndexer(context, async (indexer, directory) => {
    await writeNote("a.md", "First passage.");
    const preserved = await writeNote("preserved.md", "Preserved passage.");
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    context.mock.method(getSearchWorker(), "embed", async (inputs: EmbedInput[]) => {
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return inputs.map(vector);
    });
    const pass = indexer.requestScan({ force: true, build: true });
    await entered.promise;
    const old = indexer.database()!;
    const writes = context.mock.method(old, "storeVectors");
    const replacementPath = path.join(directory, "replacement.sqlite");
    const replacement = new SearchDatabase(replacementPath);
    replacement.prepareVectors(128, await weightsSignature(process.env.LIBERA_SEARCH_TEXT_WEIGHTS!, true), "");
    replacement.replaceFile({
      key: "Notes/preserved.md", source: "library", kind: "markdown", path: "Notes/preserved.md",
      name: "preserved.md", notebook: "Notes", signature: await readFileSignature(preserved), meta: null,
    }, [{ title: "", text: "Preserved passage.", context: "" }], "Notes preserved.md");
    const kept = new Float32Array(128); kept[2] = 1;
    replacement.storeVectors(replacement.pendingChunks(1, false).map((chunk) => ({ ...chunk, vector: kept })));
    replacement.close();
    await rename(replacementPath, old.filePath);
    release.resolve();
    await pass;
    const current = indexer.database()!;
    assert.notEqual(current, old);
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(current.counts().embeddedChunks, 2);
    assert.ok(current.nearest(kept, 1)[0].similarity > 0.99, "the replacement's committed vectors survive reopening");
    assert.equal(indexer.status().error, undefined);
  });
});

test("a slow full metadata scan does not immediately trigger another complete scan", async (context) => {
  await withIndexer(context, async (indexer) => {
    await writeNote("a.md", "A stable passage.");
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const target = internals(indexer);
    const original = target.chunkLibraryFile.bind(indexer);
    context.mock.method(target, "chunkLibraryFile", async (...args: unknown[]) => {
      const chunks = await original(...args);
      now += 60_000;
      return chunks;
    });
    const fullScan = context.mock.method(target, "scan");
    context.mock.method(getSearchWorker(), "embed", async (inputs: EmbedInput[]) => {
      indexer.requestScan();
      return inputs.map(vector);
    });
    await indexer.requestScan({ force: true, build: true });
    assert.equal(fullScan.mock.callCount(), 1);
    assert.equal(indexer.database()!.counts().embeddedChunks, 1);
    assert.equal(indexer.status().error, undefined);
  });
});
