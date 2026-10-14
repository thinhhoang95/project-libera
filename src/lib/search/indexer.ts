import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SearchFileKind, SearchGalleryPhoto, SearchIndexStatus } from "@/lib/global-search";
import {
  chunkLatex,
  chunkMarkdown,
  chunkPdfPages,
  chunkPlainText,
  documentPrompt,
  type SourceChunk,
} from "@/lib/search/chunking";
import { SearchDatabase, type IndexedFile, type NewChunk, type PendingChunk } from "@/lib/search/database";
import { getSearchPreferences, searchIndexFile, type SearchPreferences } from "@/lib/search/settings";
import { getSearchWorker } from "@/lib/search/worker-client";
import { pathExists } from "@/lib/storage/fs-utils";
import { getGallery, getGalleryRoot } from "@/lib/storage/gallery";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { pageTextFromItems, readPdfTextCache } from "@/lib/storage/pdf-text-cache";
import { getTree } from "@/lib/storage/tree";
import type { LiberaFileNode, LiberaTreeNode, PdfTextPage } from "@/lib/types";

// Larger text files (logs, data dumps) are indexed by name only.
const MAX_INDEXED_TEXT_BYTES = 2 * 1024 * 1024;
// The model runs one request at a time, so a search waits for the batch in
// progress. Two passages take about 0.4 s on a laptop CPU, and larger
// batches are no faster per passage.
const TEXT_BATCH_SIZE = 2;
// Indexing waits this long after the last search, so typing stays responsive.
const SEARCH_ACTIVITY_PAUSE_MS = 2_000;
const PDF_PAGE_BATCH = 25;
// A scan reads only file metadata; repeat it at most this often unless asked.
const MIN_SCAN_INTERVAL_MS = 30_000;

type IndexState = SearchIndexStatus["state"];

function yieldToServer() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function collectFiles(nodes: LiberaTreeNode[], files: LiberaFileNode[]) {
  for (const node of nodes) {
    if (node.kind === "file") files.push(node);
    else collectFiles(node.children, files);
  }
}

function fileStem(name: string) {
  const extension = path.extname(name);
  return (extension ? name.slice(0, -extension.length) : name).replace(/[_-]+/g, " ").trim() || name;
}

function textHash(kind: string, title: string, text: string) {
  return createHash("sha1").update(`${kind}\u0000${title}\u0000${text}`).digest("hex");
}

/** Identity of an image's content, so a moved or copied photo keeps its vector. */
async function imageHash(filePath: string, size: number) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    return `image:${createHash("sha1").update(buffer).update(String(size)).digest("hex")}`;
  } finally {
    await handle.close();
  }
}

function libraryAbsolutePath(relativePath: string) {
  const { notebook, pathParts } = splitFilePath(relativePath);
  return filePathFromParts(notebook, pathParts);
}

function weightsSignature(filePath: string) {
  if (!filePath) return Promise.resolve("");
  return stat(filePath)
    .then((stats) => `${path.basename(filePath)}:${stats.size}`)
    .catch(() => "");
}

function toNewChunks(kind: SearchFileKind, chunks: SourceChunk[]): NewChunk[] {
  return chunks.map((chunk) => ({
    hash: textHash(kind, chunk.title, chunk.text),
    title: chunk.title,
    text: chunk.text,
    context: chunk.context,
    page: chunk.page,
    line: chunk.page ? undefined : chunk.line,
    endLine: chunk.page ? undefined : chunk.endLine,
    start: chunk.page ? undefined : chunk.start,
    end: chunk.page ? undefined : chunk.end,
  }));
}

/** A file with nothing to read still gets one passage, so its name can be found. */
function nameOnlyChunk(kind: SearchFileKind, name: string): NewChunk[] {
  return [{ hash: textHash(kind, "", name), title: "", text: name, context: "" }];
}

/**
 * Keeps the Global Search index in step with the library and the gallery.
 *
 * A pass first scans: new and changed files are split into passages and
 * stored with their text, so keyword search covers them at once. It then
 * embeds the passages that have no vector yet, text before images, in small
 * batches on the worker, so searches stay quick while it runs.
 */
class SearchIndexer {
  private db: SearchDatabase | null = null;
  private dbFile = "";
  private running: Promise<void> | null = null;
  private rescanRequested = false;
  private paused = false;
  private lastScanStartedAt = 0;
  private state: IndexState = "idle";
  private done = 0;
  private total = 0;
  private current = "";
  private lastScanAt = "";
  private error = "";
  /** Why the stored vectors cannot be used with the current preferences. */
  private mismatch: string | null = null;
  /** Set when the user asked to embed again with the current preferences. */
  private resetRequested = false;

  /**
   * The index for the current preferences, reopened when its file changes.
   * Without `create`, a missing index stays missing: the first index is built
   * only when the user asks, so an existing one can be chosen instead.
   */
  database({ create = false }: { create?: boolean } = {}) {
    const file = searchIndexFile();
    if (this.db && this.dbFile === file) return this.db;

    this.db?.close();
    this.db = null;
    this.dbFile = "";
    this.mismatch = null;
    if (!create && !existsSync(file)) return null;

    const db = new SearchDatabase(file);
    this.db = db;
    this.dbFile = file;
    this.mismatch = db.prepareVectors(getSearchPreferences().dimensions, "", "");
    return db;
  }

  /** The vectors can be searched: they were made with the current model and size. */
  get vectorsUsable() {
    return !this.mismatch;
  }

  private async prepare(preferences: SearchPreferences) {
    const worker = getSearchWorker();
    worker.configure(preferences);
    const db = this.database({ create: true })!;
    const [textSignature, visionSignature] = await Promise.all([
      weightsSignature(preferences.textWeights),
      weightsSignature(preferences.visionWeights),
    ]);
    // Images are embedded by both encoders; the text model is part of their signature.
    this.mismatch = db.prepareVectors(
      preferences.dimensions,
      textSignature,
      visionSignature && `${textSignature}|${visionSignature}`,
      this.resetRequested,
    );
    this.resetRequested = false;
    return db;
  }

  /**
   * Start a pass, or note that another one is needed after the current pass.
   * Only `build` creates an index that does not exist yet.
   */
  requestScan({ force = false, build = false }: { force?: boolean; build?: boolean } = {}) {
    if (!build && !existsSync(searchIndexFile())) return;
    if (this.running) {
      if (force) this.rescanRequested = true;
      return;
    }
    if (!force && Date.now() - this.lastScanStartedAt < MIN_SCAN_INTERVAL_MS) return;

    // Report the pass at once; the scan itself starts after the first await.
    this.state = "scanning";
    this.done = 0;
    this.total = 0;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    this.running.catch(() => undefined);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.requestScan({ force: true });
  }

  async rebuild() {
    this.database({ create: true })!.clear();
    this.resetRequested = true;
    this.requestScan({ force: true, build: true });
  }

  /** Drop vectors made with other settings and embed again with the current ones. */
  reembed() {
    this.resetRequested = true;
    this.requestScan({ force: true, build: true });
  }

  private async run() {
    this.error = "";
    try {
      do {
        this.rescanRequested = false;
        const preferences = getSearchPreferences();
        const db = await this.prepare(preferences);
        await this.scan(db, preferences);
        if (!this.mismatch) await this.embedPending(db, preferences);
      } while (this.rescanRequested);
      this.state = this.paused ? "paused" : "idle";
    } catch (error) {
      this.state = "error";
      this.error = error instanceof Error ? error.message : "Indexing failed.";
    } finally {
      this.current = "";
      this.db?.checkpoint();
    }
  }

  private async scan(db: SearchDatabase, preferences: SearchPreferences) {
    this.lastScanStartedAt = Date.now();
    this.state = "scanning";

    const tree = await getTree({ includeArchive: true });
    const files: LiberaFileNode[] = [];
    for (const notebook of tree.notebooks) collectFiles(notebook.children, files);

    // Reading the gallery reconciles its index; leave a gallery that does not exist alone.
    const photos = preferences.indexImages && (await pathExists(getGalleryRoot()))
      ? (await getGallery().catch(() => null))?.photos ?? []
      : [];
    const known = new Map(db.listFiles().map((file) => [file.key, file]));
    const seen = new Set<string>();

    this.done = 0;
    this.total = files.length + photos.length;

    for (const file of files) {
      this.done += 1;
      if (file.fileType === "image" && !preferences.indexImages) continue;
      seen.add(file.path);
      const signature = `${file.size}:${file.updatedAt}`;
      if (known.get(file.path)?.signature === signature) continue;

      this.current = file.path;
      await this.indexLibraryFile(db, file, signature);
      await yieldToServer();
    }

    for (const photo of photos) {
      this.done += 1;
      const key = `gallery:${photo.id}`;
      seen.add(key);
      const signature = `${photo.size}:${photo.updatedAt}:${photo.prompt ?? ""}`;
      const record = known.get(key);
      const meta: SearchGalleryPhoto = {
        id: photo.id,
        path: photo.path,
        name: photo.name,
        updatedAt: photo.updatedAt,
        size: photo.size,
        prompt: photo.prompt,
      };
      if (record?.signature === signature && record.path === photo.path) continue;

      this.current = `Gallery/${photo.path}`;
      await this.indexGalleryPhoto(db, meta, signature);
      await yieldToServer();
    }

    // Remove what is gone after adding what is new, so moved files can borrow vectors.
    for (const [key, file] of known) {
      if (!seen.has(key)) db.deleteFile(file.id);
    }

    this.lastScanAt = new Date().toISOString();
  }

  private async indexLibraryFile(db: SearchDatabase, file: LiberaFileNode, signature: string) {
    const record: Omit<IndexedFile, "id" | "status"> = {
      key: file.path,
      source: "library",
      kind: file.fileType,
      path: file.path,
      name: file.name,
      notebook: file.notebook,
      signature,
      meta: null,
    };
    const ftsName = file.path.replaceAll("/", " ");

    try {
      db.replaceFile(record, await this.chunkLibraryFile(file), ftsName);
    } catch (error) {
      db.markFailed(record, error instanceof Error ? error.message : "Could not read the file.", ftsName);
    }
  }

  private async chunkLibraryFile(file: LiberaFileNode): Promise<NewChunk[]> {
    const absolutePath = libraryAbsolutePath(file.path);

    if (file.fileType === "image") {
      return [{ hash: await imageHash(absolutePath, file.size), title: "", text: file.name, context: "" }];
    }

    if (file.fileType === "pdf") {
      // Without the worker (it could not start), parse here as Deep Search does.
      const { pages } = await readPdfTextCache(file.path, { extractPages: (target) => this.extractPdfPages(target) })
        .catch(() => readPdfTextCache(file.path));
      const chunks = toNewChunks("pdf", chunkPdfPages(pages));
      return chunks.length ? chunks : nameOnlyChunk("pdf", file.name);
    }

    if (file.size > MAX_INDEXED_TEXT_BYTES) return nameOnlyChunk(file.fileType, file.name);

    const source = await readFile(absolutePath, "utf8");
    if (source.includes("\u0000")) return nameOnlyChunk(file.fileType, file.name);

    const chunks = file.fileType === "markdown"
      ? chunkMarkdown(source)
      : file.fileType === "latex"
        ? chunkLatex(source, file.name)
        : chunkPlainText(source);
    return chunks.length ? toNewChunks(file.fileType, chunks) : nameOnlyChunk(file.fileType, file.name);
  }

  /** Parse the PDF in the worker, a few pages at a time, so searches can run in between. */
  private async extractPdfPages(absolutePath: string): Promise<PdfTextPage[]> {
    const worker = getSearchWorker();
    const pages: PdfTextPage[] = [];
    let numPages = Number.POSITIVE_INFINITY;

    try {
      for (let from = 1; from <= numPages; from += PDF_PAGE_BATCH) {
        const result = await worker.pdfText(absolutePath, from, from + PDF_PAGE_BATCH - 1);
        numPages = result.numPages;
        for (const page of result.pages) pages.push({ pageNumber: page.pageNumber, text: pageTextFromItems(page.items) });
      }
    } catch (error) {
      await worker.closePdf(absolutePath);
      throw error;
    }

    return pages;
  }

  private async indexGalleryPhoto(db: SearchDatabase, photo: SearchGalleryPhoto, signature: string) {
    const record: Omit<IndexedFile, "id" | "status"> = {
      key: `gallery:${photo.id}`,
      source: "gallery",
      kind: "image",
      path: photo.path,
      name: photo.name,
      notebook: "",
      signature,
      meta: JSON.stringify(photo),
    };
    const ftsName = `Gallery ${photo.path.replaceAll("/", " ")}`;

    try {
      const hash = await imageHash(path.join(getGalleryRoot(), ...photo.path.split("/")), photo.size);
      db.replaceFile(record, [{ hash, title: "", text: [photo.name, photo.prompt].filter(Boolean).join("\n"), context: "" }], ftsName);
    } catch (error) {
      db.markFailed(record, error instanceof Error ? error.message : "Could not read the photo.", ftsName);
    }
  }

  private imagePath(chunk: PendingChunk) {
    return chunk.source === "gallery"
      ? path.join(getGalleryRoot(), ...chunk.path.split("/"))
      : libraryAbsolutePath(chunk.path);
  }

  private async embedPending(db: SearchDatabase, preferences: SearchPreferences) {
    const worker = getSearchWorker();
    if (!worker.configured || this.paused) return;

    const includeImages = preferences.indexImages && worker.visionConfigured;
    this.total = db.countPending(includeImages);
    this.done = 0;
    if (!this.total) return;

    this.state = "embedding";
    try {
      await worker.ensureModel();
    } catch {
      // The status shows the model error; keyword search keeps working.
      return;
    }

    while (!this.paused && !this.rescanRequested) {
      while (!this.paused && Date.now() - worker.lastQueryAt < SEARCH_ACTIVITY_PAUSE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const batch = db.pendingChunks(TEXT_BATCH_SIZE, includeImages);
      if (!batch.length) break;

      // Images go one at a time: each takes a while, and a search may be waiting.
      const work = batch[0].kind === "image" ? batch.slice(0, 1) : batch.filter((chunk) => chunk.kind !== "image");
      this.current = work[0].source === "gallery" ? `Gallery/${work[0].path}` : work[0].path;

      try {
        const vectors = await worker.embed(work.map((chunk) => this.embedInput(chunk)), "index");
        db.storeVectors(work.map((chunk, index) => ({ id: chunk.id, kind: chunk.kind, vector: vectors[index] })));
      } catch (error) {
        if (worker.modelState === "error") return;
        // One unreadable passage or photo must not stall the queue: skip it.
        if (work.length === 1) db.markEmbeddingFailed([work[0].id]);
        else await this.embedOneByOne(db, work);
        console.warn(`Global Search could not embed ${this.current}: ${error instanceof Error ? error.message : error}`);
      }

      this.done += work.length;
      await yieldToServer();
    }
  }

  private async embedOneByOne(db: SearchDatabase, chunks: PendingChunk[]) {
    const worker = getSearchWorker();
    for (const chunk of chunks) {
      try {
        const [vector] = await worker.embed([this.embedInput(chunk)], "index");
        db.storeVectors([{ id: chunk.id, kind: chunk.kind, vector }]);
      } catch {
        db.markEmbeddingFailed([chunk.id]);
      }
    }
  }

  private embedInput(chunk: PendingChunk) {
    if (chunk.kind === "image") return { images: [{ path: this.imagePath(chunk) }] };
    return { text: documentPrompt(chunk.kind, fileStem(chunk.name), chunk) };
  }

  status(): SearchIndexStatus {
    const preferences = getSearchPreferences();
    const worker = getSearchWorker();
    // New weights or settings: check the stored vectors against them again.
    if (worker.configure(preferences)) this.requestScan({ force: true });
    let counts = { files: 0, failedFiles: 0, images: 0, chunks: 0, embeddedChunks: 0 };
    let error = this.error;
    let exists = false;

    try {
      const db = this.database();
      exists = Boolean(db);
      if (db) counts = db.counts();
    } catch (databaseError) {
      exists = existsSync(searchIndexFile(preferences));
      error ||= databaseError instanceof Error ? databaseError.message : "The search index could not be opened.";
    }

    return {
      state: this.paused && !this.running ? "paused" : this.running ? this.state : error ? "error" : "idle",
      exists,
      mismatch: this.mismatch ?? undefined,
      model: {
        configured: worker.configured,
        vision: worker.visionConfigured,
        state: !worker.configured ? "unconfigured" : worker.modelState,
        error: worker.modelError || undefined,
        textWeights: preferences.textWeights || undefined,
        visionWeights: preferences.visionWeights || undefined,
        textDtype: worker.modelInfo?.textDtype,
        visionDtype: worker.modelInfo?.visionDtype,
        dimensions: preferences.dimensions,
      },
      ...counts,
      done: this.done,
      total: this.total,
      current: this.running ? this.current || undefined : undefined,
      lastScanAt: this.lastScanAt || undefined,
      indexPath: searchIndexFile(preferences),
      customIndex: Boolean(preferences.indexFile),
      error: error || undefined,
    };
  }
}

const INDEXER_KEY = Symbol.for("libera.searchIndexer");

export function getSearchIndexer() {
  const store = globalThis as { [INDEXER_KEY]?: SearchIndexer };
  store[INDEXER_KEY] ??= new SearchIndexer();
  return store[INDEXER_KEY];
}
