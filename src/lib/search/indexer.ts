import { existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SearchGalleryPhoto, SearchIndexStatus } from "@/lib/global-search";
import {
  chunkLatex,
  chunkMarkdown,
  chunkPdfPages,
  chunkPlainText,
  documentPrompt,
  searchDocumentTitle,
  type SourceChunk,
} from "@/lib/search/chunking";
import { SearchDatabase, type IndexedFile, type NewChunk, type PendingChunk } from "@/lib/search/database";
import { contentHash, weightsSignature } from "@/lib/search/fingerprints";
import { galleryMeta, planIndexRepair } from "@/lib/search/repair";
import { readSearchFile, readSearchLibrary } from "@/lib/search/library-files";
import { pdfHighlightChunks, pdfHighlightSignature } from "@/lib/search/pdf-highlights";
import { currentReferenceSignature, parseReferenceRecordKey, readReferenceSource, type ReferenceRecord } from "@/lib/search/references-source";
import { getSearchPreferences, searchIndexFile, type SearchPreferences } from "@/lib/search/settings";
import { getSearchWorker } from "@/lib/search/worker-client";
import { readFileSignature } from "@/lib/storage/file-signature";
import { getGallery, getGalleryRoot } from "@/lib/storage/gallery";
import { filePathFromParts, getAdminRoot, getLinkedFolder, getLinkedFolders, referenceLibraryPath, splitFilePath } from "@/lib/storage/paths";
import { referenceLibraryNotebooks } from "@/lib/storage/references";
import { pageTextFromItems, readPdfTextCache } from "@/lib/storage/pdf-text-cache";
import { isVisibleTreeFile } from "@/lib/storage/tree";
import type { LiberaFileNode, PdfTextPage } from "@/lib/types";

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
const CHANGE_DEBOUNCE_MS = 1_000;
const MAX_IMMEDIATE_PASSES = 3;
const UNSTABLE_RETRY_MS = 30_000;

type IndexState = SearchIndexStatus["state"];

function yieldToServer() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function indexIdentity(file: string) {
  try {
    const stats = statSync(file);
    return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
  } catch { return ""; }
}

/** Identity of an image's content, so a moved or copied photo keeps its vector. */
async function imageHash(filePath: string) {
  return `image:${await contentHash(filePath)}`;
}

function ftsNameOf(source: IndexedFile["source"], relativePath: string) {
  const words = relativePath.replaceAll("/", " ");
  return source === "gallery" ? `Gallery ${words}` : words;
}

/** What the status line shows for a record being indexed. */
function displayPath(record: Pick<IndexedFile, "source" | "path" | "name">) {
  return record.source === "gallery" ? `Gallery/${record.path}` : record.source === "references" ? `References/${record.path}/${record.name}` : record.path;
}

function libraryAbsolutePath(relativePath: string) {
  const { notebook, pathParts } = splitFilePath(relativePath);
  return filePathFromParts(notebook, pathParts);
}

function toNewChunks(chunks: SourceChunk[]): NewChunk[] {
  return chunks.map((chunk) => ({
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
function nameOnlyChunk(name: string): NewChunk[] {
  return [{ title: "", text: name, context: "" }];
}

/**
 * Keeps the Global Search index in step with the library, the gallery and
 * the notebooks' References libraries (one record per entry).
 *
 * A pass first scans: new and changed files are split into passages and
 * stored with their text, so keyword search covers them at once. It then
 * embeds the passages that have no vector yet, text before images, in small
 * batches on the worker, so searches stay quick while it runs.
 */
export class SearchIndexer {
  private db: SearchDatabase | null = null;
  private dbFile = "";
  private dbRoot = "";
  private dbIdentity = "";
  private running: Promise<void> | null = null;
  private rescanRequested = false;
  private paused = false;
  private manualPass = false;
  private manualRequested = false;
  private fullScanRequested = false;
  private changedPaths = new Set<string>();
  private galleryChanged = false;
  /** Notebooks whose References library changed; `allReferencesChanged` stands for every one. */
  private referenceNotebooks = new Set<string>();
  private allReferencesChanged = false;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFullScanAt = 0;
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
  private rebuildRequested = false;
  private buildFile = "";
  private resetFile = "";
  private rebuildFile = "";
  private preparedKey = "";
  private embeddingEpoch = 0;
  /** Entries that match no file; hidden from searches until the scan removes them. */
  private staleFileIds = new Set<number>();
  private unavailablePaths = new Set<string>();

  /**
   * The index for the current preferences, reopened when its file changes.
   * Without `create`, a missing index stays missing: the first index is built
   * only when the user asks, so an existing one can be chosen instead.
   */
  database({ create = false }: { create?: boolean } = {}) {
    const file = searchIndexFile();
    const root = this.libraryKey();
    const identity = indexIdentity(file);
    if (this.db && this.dbFile === file && this.dbRoot === root && this.dbIdentity === identity && identity) return this.db;

    const previous = this.db;
    this.db = null;
    this.dbFile = "";
    this.dbRoot = "";
    this.dbIdentity = "";
    this.preparedKey = "";
    this.fullScanRequested = true;
    this.lastFullScanAt = 0;
    this.lastScanAt = "";
    this.mismatch = null;
    this.staleFileIds.clear();
    this.unavailablePaths.clear();
    previous?.close();
    if (!create && !existsSync(file)) return null;

    const db = new SearchDatabase(file);
    this.db = db;
    this.dbFile = file;
    this.dbRoot = root;
    this.dbIdentity = indexIdentity(file);
    this.mismatch = db.prepareVectors(getSearchPreferences().dimensions, "", "", false, !create && !this.indexingAllowed());
    return db;
  }

  /** The entry matches no file any more and is about to be removed. */
  isStale(fileId: number) {
    return this.staleFileIds.has(fileId);
  }

  /** The vectors can be searched: they were made with the current model and size. */
  get vectorsUsable() {
    return !this.mismatch && this.preparedKey === this.configurationKey(getSearchPreferences());
  }

  private configurationKey(preferences: SearchPreferences) {
    return JSON.stringify([this.libraryKey(), preferences]);
  }

  private libraryKey() {
    return JSON.stringify([getAdminRoot(), getLinkedFolders().map(({ name, path, unresolved }) => [name, path, Boolean(unresolved)])]);
  }

  private isCurrent(db: SearchDatabase, preferences: SearchPreferences) {
    if (this.db === db && this.dbIdentity === indexIdentity(db.filePath) && this.dbRoot === this.libraryKey() && !this.rebuildRequested &&
        this.configurationKey(preferences) === this.configurationKey(getSearchPreferences()) && db.filePath === searchIndexFile()) return true;
    this.rescanRequested = true;
    this.fullScanRequested = true;
    return false;
  }

  private automaticUpdatesAllowed() {
    return !this.paused && getSearchPreferences().backgroundIndexing;
  }

  private indexingAllowed() {
    return this.manualPass || this.automaticUpdatesAllowed();
  }

  /** Checked after awaits too: pausing or disabling background work stops writes. */
  private canIndex(db: SearchDatabase, preferences: SearchPreferences) {
    return this.indexingAllowed() && this.isCurrent(db, preferences);
  }

  /** Verify persisted vector settings before a query can use them. */
  async databaseForSearch() {
    if (!this.database()) return null;
    return this.prepare(getSearchPreferences());
  }

  private async prepare(preferences: SearchPreferences, indexing = false) {
    const worker = getSearchWorker();
    if (worker.configure(preferences)) this.invalidateEmbeddings();
    const db = this.database();
    if (!db) return null;
    const key = this.configurationKey(preferences);
    // A routine verification of the same settings must not disable a query
    // that has just validated them and requested a background scan.
    if (this.preparedKey !== key) this.preparedKey = "";
    let textSignature: string;
    let visionSignature: string;
    try {
      [textSignature, visionSignature] = await Promise.all([
        weightsSignature(preferences.textWeights, true),
        weightsSignature(preferences.visionWeights),
      ]);
    } catch (error) {
      if (!this.isCurrent(db, preferences)) return null;
      this.mismatch = error instanceof Error ? error.message : "Could not read the model files.";
      return db;
    }
    if (!this.isCurrent(db, preferences)) return null;
    if (indexing && !this.canIndex(db, preferences)) return null;
    if (worker.configure(preferences, `${textSignature}|${visionSignature}`)) this.invalidateEmbeddings();
    const reset = indexing && this.resetRequested && this.resetFile === db.filePath;
    if (reset) this.invalidateEmbeddings();
    // Images are embedded by both encoders; the text model is part of their signature.
    this.mismatch = db.prepareVectors(
      preferences.dimensions,
      textSignature,
      visionSignature && `${textSignature}|${visionSignature}|tokens:${preferences.visionTokens}`,
      reset,
      !indexing && !this.automaticUpdatesAllowed(),
    );
    if (indexing) {
      this.resetRequested = false;
      this.resetFile = "";
    }
    this.preparedKey = key;
    return db;
  }

  private invalidateEmbeddings() {
    this.embeddingEpoch += 1;
    if (this.running && this.state === "embedding") this.rescanRequested = true;
  }

  private canEmbed(db: SearchDatabase, preferences: SearchPreferences, epoch: number) {
    return this.canIndex(db, preferences) && this.embeddingEpoch === epoch && !this.mismatch;
  }

  /** Storage mutations coalesce; ordinary saves read only the affected files. */
  notifyChanges(paths?: string[], gallery = false) {
    if (!this.automaticUpdatesAllowed() || !existsSync(searchIndexFile())) return;
    if (gallery) this.galleryChanged = true;
    else if (paths) paths.forEach((filePath) => this.changedPaths.add(filePath));
    else this.fullScanRequested = true;
    this.scheduleChanges();
  }

  /** A References library changed (every one without `notebooks`). Only those libraries are read again. */
  notifyReferenceChanges(notebooks?: string[]) {
    if (!this.automaticUpdatesAllowed() || !existsSync(searchIndexFile())) return;
    if (notebooks) notebooks.forEach((notebook) => this.referenceNotebooks.add(notebook));
    else this.allReferencesChanged = true;
    this.scheduleChanges();
  }

  private scheduleChanges(delay = CHANGE_DEBOUNCE_MS) {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.requestScan({ force: true, manual: false, incremental: true });
    }, delay);
    this.changeTimer.unref();
  }

  /**
   * Start a pass, or note that another one is needed after the current pass.
   * `force` bypasses throttling, never Pause or Preferences. Only an explicit
   * `manual` action (or `build`) may do that. Only `build` creates an index.
   */
  requestScan({ force = false, build = false, manual = build, incremental = false }: {
    force?: boolean; build?: boolean; manual?: boolean; incremental?: boolean;
  } = {}) {
    if (!manual && !this.automaticUpdatesAllowed()) return;
    if (!build && !existsSync(searchIndexFile())) return;
    if (build) this.buildFile = searchIndexFile();
    if (this.running) {
      if (force || (this.state === "embedding" && Date.now() - this.lastFullScanAt >= MIN_SCAN_INTERVAL_MS)) {
        this.rescanRequested = true;
        this.fullScanRequested ||= !incremental;
        this.manualRequested ||= manual;
      }
      return this.running;
    }
    if (!this.database({ create: build })) return;
    if (!force && Date.now() - this.lastFullScanAt < MIN_SCAN_INTERVAL_MS) return;
    this.fullScanRequested ||= !incremental;
    this.manualRequested ||= manual;

    // Report the pass at once; the scan itself starts after the first await.
    this.state = "scanning";
    this.done = 0;
    this.total = 0;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    this.running.catch(() => undefined);
    return this.running;
  }

  pause() {
    this.paused = true;
    this.manualPass = false;
    this.manualRequested = false;
    this.rescanRequested = false;
    this.resetRequested = false;
    this.rebuildRequested = false;
    this.resetFile = "";
    this.rebuildFile = "";
    this.buildFile = "";
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
  }

  resume() {
    this.paused = false;
    // Notifications are intentionally skipped while paused. Reconcile all
    // sources on resume, including changes made outside Libera during the pause.
    this.requestScan({ force: true, manual: true });
  }

  async rebuild() {
    this.rebuildRequested = true;
    this.rebuildFile = searchIndexFile();
    this.resetRequested = true;
    this.resetFile = this.rebuildFile;
    this.requestScan({ force: true, build: true });
  }

  /** Drop vectors made with other settings and embed again with the current ones. */
  reembed() {
    this.resetRequested = true;
    this.resetFile = searchIndexFile();
    this.requestScan({ force: true, build: true });
  }

  private async run() {
    this.error = "";
    let passes = 0;
    try {
      do {
        if (++passes > MAX_IMMEDIATE_PASSES) {
          // A sync client continuously rewriting a file must not create a hot loop.
          this.manualRequested = false;
          this.rescanRequested = false;
          this.error = "Some files are still changing. They will be retried on the next update.";
          if (this.automaticUpdatesAllowed()) this.scheduleChanges(UNSTABLE_RETRY_MS);
          break;
        }
        this.rescanRequested = false;
        this.manualPass = this.manualRequested;
        this.manualRequested = false;
        if (!this.manualPass && !this.automaticUpdatesAllowed()) break;
        try {
          const preferences = getSearchPreferences();
          const target = this.database({ create: this.buildFile === searchIndexFile(preferences) });
          this.buildFile = "";
          if (!target) break;
          if (this.rebuildRequested) {
            if (this.rebuildFile === target.filePath) target.clear();
            this.rebuildRequested = false;
            this.rebuildFile = "";
          }
          const db = await this.prepare(preferences, true);
          if (!db || !this.canIndex(db, preferences)) {
            if (this.rescanRequested && this.manualPass) this.manualRequested = true;
            continue;
          }
          const fullScan = this.fullScanRequested;
          const paths = [...this.changedPaths];
          const gallery = this.galleryChanged;
          const references = this.allReferencesChanged ? null : [...this.referenceNotebooks];
          this.fullScanRequested = false;
          this.changedPaths.clear();
          this.galleryChanged = false;
          this.referenceNotebooks.clear();
          this.allReferencesChanged = false;
          if (fullScan) await this.scan(db, preferences);
          else await this.scanChanges(db, preferences, paths, gallery, references);
          if (this.canIndex(db, preferences) && !this.mismatch) await this.embedPending(db, preferences);
        } catch (error) {
          if (this.rescanRequested) {
            if (this.manualPass) this.manualRequested = true;
            continue;
          }
          this.error = error instanceof Error ? error.message : "Indexing failed.";
        }
        // A superseded manual pass may need to retry while automatic work is paused.
        if (this.rescanRequested && this.manualPass) this.manualRequested = true;
      } while (this.rescanRequested);
      if (this.unavailablePaths.size && !this.error) {
        this.error = "Some folders or files are unavailable. Their index entries were kept; reconnect or restore access and update the index.";
      }
      this.state = this.error ? "error" : this.paused ? "paused" : "idle";
    } finally {
      this.manualPass = false;
      this.current = "";
      if (this.db && this.dbIdentity === indexIdentity(this.db.filePath)) this.db.checkpoint();
    }
  }

  private async scan(db: SearchDatabase, preferences: SearchPreferences) {
    this.lastFullScanAt = Date.now();
    this.state = "scanning";

    const { files, unavailable, cancelled } = await readSearchLibrary(() => this.canIndex(db, preferences));
    if (cancelled || !this.canIndex(db, preferences)) return;
    this.unavailablePaths = unavailable;

    // A failed gallery must not block library updates or be treated as empty.
    let galleryReadable = true;
    const photos = preferences.indexImages ? (await getGallery().catch((error) => {
      galleryReadable = false;
      this.error = error instanceof Error ? error.message : "Could not scan the gallery.";
      return null;
    }))?.photos ?? [] : [];
    if (!this.canIndex(db, preferences)) return;
    const indexedFiles = files.filter((file) => file.fileType !== "image" || preferences.indexImages);
    this.repair(db, indexedFiles, photos.map(galleryMeta), galleryReadable);
    const known = new Map(db.listFiles().map((file) => [file.key, file]));
    const seen = new Set<string>([...known.values()]
      .filter((file) => ((file.source === "gallery" && !galleryReadable) || this.isUnavailable(file)) &&
        (preferences.indexImages || file.kind !== "image"))
      .map((file) => file.key));

    this.done = 0;
    this.total = files.length + photos.length;

    for (const file of files) {
      if (!this.canIndex(db, preferences)) return;
      this.done += 1;
      if (file.fileType === "image" && !preferences.indexImages) continue;
      seen.add(file.path);
      this.current = file.path;
      await this.indexLibraryFile(db, file, known.get(file.path), preferences);
      if (!this.canIndex(db, preferences)) return;
      await yieldToServer();
    }

    for (const photo of photos) {
      if (!this.canIndex(db, preferences)) return;
      this.done += 1;
      const key = `gallery:${photo.id}`;
      seen.add(key);
      const record = known.get(key);
      const meta = galleryMeta(photo);
      this.current = `Gallery/${photo.path}`;
      await this.indexGalleryPhoto(db, meta, record, preferences);
      if (!this.canIndex(db, preferences)) return;
      await yieldToServer();
    }

    if (!await this.indexReferences(db, preferences, null, known, seen)) return;

    // Remove what is gone after adding what is new, so moved files can borrow vectors.
    if (!this.canIndex(db, preferences)) return;
    for (const [key, file] of known) {
      if (!seen.has(key)) db.deleteFile(file.id);
    }
    this.staleFileIds.clear();
    db.retryFailedEmbeddings();

    // Reserve the next routine scan from completion too. Otherwise a slow
    // metadata walk is immediately repeated as soon as embedding begins.
    this.lastFullScanAt = Date.now();
    this.lastScanAt = new Date().toISOString();
  }

  /** A file, or a References record (its path is its notebook), under a folder that cannot be read now. */
  private isUnavailable(file: Pick<IndexedFile, "source" | "path">) {
    return (file.source === "library" || file.source === "references") &&
      [...this.unavailablePaths].some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`));
  }

  /**
   * Index the References libraries of `notebooks` (every library with null).
   * Entries are added to `seen`, and a full scan removes the unseen records
   * after it; without `seen`, the records of each library read here that no
   * longer match an entry are removed now. Returns false when indexing stopped.
   */
  private async indexReferences(
    db: SearchDatabase,
    preferences: SearchPreferences,
    notebooks: string[] | null,
    known: Map<string, IndexedFile>,
    seen?: Set<string>,
  ) {
    const recordsByNotebook = new Map<string, IndexedFile[]>();
    for (const file of known.values()) {
      if (file.source !== "references") continue;
      recordsByNotebook.set(file.notebook, [...(recordsByNotebook.get(file.notebook) ?? []), file]);
    }
    const libraries = notebooks ? [] : await referenceLibraryNotebooks().catch(() => null);
    if (!this.canIndex(db, preferences)) return false;
    // A notebook list that cannot be read is not proof that every library is gone.
    if (!libraries) {
      for (const file of known.values()) if (file.source === "references") seen?.add(file.key);
      return true;
    }
    const names = notebooks ?? [...new Set([...libraries, ...recordsByNotebook.keys()])];
    const removed: IndexedFile[] = [];

    for (const notebook of names) {
      if (!this.canIndex(db, preferences)) return false;
      const existing = recordsByNotebook.get(notebook) ?? [];
      const read = await readReferenceSource(notebook);
      if (!this.canIndex(db, preferences)) return false;
      if (read.status === "unreadable" || this.isUnavailable({ source: "references", path: notebook })) {
        // Keep what is indexed until the library can be read again.
        existing.forEach((file) => seen?.add(file.key));
        continue;
      }
      const records = read.status === "ok" ? read.records : [];
      const current = new Set(records.map((record) => record.key));
      this.total += records.length;
      for (const record of records) {
        if (!this.canIndex(db, preferences)) return false;
        seen?.add(record.key);
        this.current = displayPath(record);
        this.indexReferenceRecord(db, record, known.get(record.key));
        this.done += 1;
        await yieldToServer();
      }
      if (!seen) removed.push(...existing.filter((file) => !current.has(file.key)));
    }

    if (!this.canIndex(db, preferences)) return false;
    for (const file of removed) db.deleteFile(file.id);
    return true;
  }

  private indexReferenceRecord(db: SearchDatabase, record: ReferenceRecord, known: IndexedFile | undefined) {
    if (known?.status === "ok" && known.signature === record.signature && known.meta === record.meta && known.name === record.name) return;
    const { chunks, ftsName, ...file } = record;
    db.replaceFile(file, chunks, ftsName);
  }

  /** A save/upload/move does not need a walk of the whole library. */
  private async scanChanges(db: SearchDatabase, preferences: SearchPreferences, paths: string[], gallery: boolean, references: string[] | null = []) {
    this.state = "scanning";
    this.done = 0;
    this.total = paths.length;
    const known = new Map(db.listFiles().map((file) => [file.key, file]));
    const removed = new Set<string>();

    for (const filePath of paths) {
      if (!this.canIndex(db, preferences)) return;
      this.current = filePath;
      try {
        const { notebook, pathParts } = splitFilePath(filePath);
        if (!isVisibleTreeFile(notebook, pathParts)) {
          removed.add(filePath);
          continue;
        }
        const file = await readSearchFile(notebook, pathParts);
        if (!this.canIndex(db, preferences)) return;
        if (this.isUnavailable({ source: "library", path: filePath })) {
          this.fullScanRequested = true;
          this.rescanRequested = true;
        }
        if (file.fileType === "image" && !preferences.indexImages) removed.add(filePath);
        else await this.indexLibraryFile(db, file, known.get(filePath), preferences);
      } catch (error) {
        // Permission/read failures do not mean the file was deleted.
        const notebook = filePath.split("/")[0];
        const linked = getLinkedFolder(notebook);
        const offline = linked && (linked.unresolved || !(await stat(linked.path).catch(() => null))?.isDirectory());
        if (offline) this.unavailablePaths.add(notebook);
        else if ((error as NodeJS.ErrnoException).code === "ENOENT") removed.add(filePath);
        else this.error = error instanceof Error ? error.message : "Could not scan the file.";
      }
      this.done += 1;
      await yieldToServer();
    }

    if (gallery) {
      const photos = preferences.indexImages ? (await getGallery()).photos.map(galleryMeta) : [];
      if (!this.canIndex(db, preferences)) return;
      const seen = new Set(photos.map((photo) => `gallery:${photo.id}`));
      this.total += photos.length;
      for (const photo of photos) {
        if (!this.canIndex(db, preferences)) return;
        this.current = `Gallery/${photo.path}`;
        await this.indexGalleryPhoto(db, photo, known.get(`gallery:${photo.id}`), preferences);
        this.done += 1;
        await yieldToServer();
      }
      for (const file of known.values()) {
        if (file.source === "gallery" && !seen.has(file.key)) removed.add(file.key);
      }
    }

    if (references === null || references.length) {
      if (!await this.indexReferences(db, preferences, references, known)) return;
    }

    if (!this.canIndex(db, preferences)) return;
    // Add destinations before removing sources, retaining reusable passage vectors.
    for (const key of removed) {
      const file = known.get(key);
      if (file) db.deleteFile(file.id);
    }
    this.lastScanAt = new Date().toISOString();
  }

  /**
   * Move entries whose paths drifted (an index from another computer, a
   * renamed notebook) to the files they stand for, and hide the ones that
   * match no file. Those stay until the end of the scan, so a file that was
   * really moved can still borrow their vectors.
   */
  private repair(db: SearchDatabase, files: LiberaFileNode[], photos: SearchGalleryPhoto[], galleryReadable: boolean) {
    // References records are keyed by notebook and entry, not by a file's path.
    const indexed = db.listFiles().filter((file) => file.source !== "references" && (galleryReadable || file.source !== "gallery") && !this.isUnavailable(file));
    const { relocations, stale } = planIndexRepair(indexed, files, photos);
    const sources = new Map(indexed.map((file) => [file.id, file.source]));
    for (const relocation of relocations) {
      db.relocateFile(relocation.id, relocation, ftsNameOf(sources.get(relocation.id) ?? "library", relocation.path));
    }
    this.staleFileIds = new Set([...stale, ...relocations.map((entry) => entry.id)]);
    if (relocations.length || stale.length) {
      console.info(`Global Search repaired its index: ${relocations.length} entries moved to their files, ${stale.length} stale.`);
    }
  }

  private async indexLibraryFile(db: SearchDatabase, file: LiberaFileNode, known: IndexedFile | undefined, preferences: SearchPreferences) {
    const record: Omit<IndexedFile, "id" | "status"> = {
      key: file.path,
      source: "library",
      kind: file.fileType,
      path: file.path,
      name: file.name,
      notebook: file.notebook,
      signature: "",
      meta: null,
    };
    const ftsName = ftsNameOf("library", file.path);

    try {
      record.signature = await this.librarySignature(file.path, file.fileType);
      if (!this.canIndex(db, preferences)) return;
      if (known?.status === "ok" && known.signature === record.signature && known.kind === file.fileType) return;
      const chunks = await this.chunkLibraryFile({ ...file, size: Number(record.signature.split(":")[0]) });
      const after = await this.librarySignature(file.path, file.fileType);
      if (!this.canIndex(db, preferences)) return;
      if (record.signature !== after) {
        this.changedPaths.add(file.path);
        this.rescanRequested = true;
        return;
      }
      db.replaceFile(record, chunks, ftsName);
    } catch (error) {
      if (!this.canIndex(db, preferences)) return;
      db.markFailed(record, error instanceof Error ? error.message : "Could not read the file.", ftsName);
    }
  }

  /**
   * A library file's identity. A PDF's includes its highlights' sidecar, so
   * adding a highlight indexes its quote; a PDF without one keeps the plain
   * file signature.
   */
  private async librarySignature(relativePath: string, fileType: LiberaFileNode["fileType"]) {
    const signature = await readFileSignature(libraryAbsolutePath(relativePath));
    if (fileType !== "pdf") return signature;
    const highlights = await pdfHighlightSignature(relativePath);
    return highlights ? `${signature}|${highlights}` : signature;
  }

  private async chunkLibraryFile(file: LiberaFileNode): Promise<NewChunk[]> {
    const absolutePath = libraryAbsolutePath(file.path);

    if (file.fileType === "image") {
      return [{ hash: await imageHash(absolutePath), title: "", text: file.name, context: "" }];
    }

    if (file.fileType === "pdf") {
      // Without the worker (it could not start), parse here as Deep Search does.
      const { pages } = await readPdfTextCache(file.path, { extractPages: (target) => this.extractPdfPages(target) })
        .catch((error) => {
          if (!this.indexingAllowed()) throw error;
          return readPdfTextCache(file.path);
        });
      // Highlight quotes are passages of their own, so a search can find what was marked.
      const chunks = [...toNewChunks(chunkPdfPages(pages)), ...await pdfHighlightChunks(file.path)];
      return chunks.length ? chunks : nameOnlyChunk(file.name);
    }

    if (file.size > MAX_INDEXED_TEXT_BYTES) return nameOnlyChunk(file.name);

    const source = await readFile(absolutePath, "utf8");
    if (source.includes("\u0000")) return nameOnlyChunk(file.name);

    const chunks = file.fileType === "markdown"
      ? chunkMarkdown(source)
      : file.fileType === "latex"
        ? chunkLatex(source, file.name)
        : chunkPlainText(source);
    return chunks.length ? toNewChunks(chunks) : nameOnlyChunk(file.name);
  }

  /** Parse the PDF in the worker, a few pages at a time, so searches can run in between. */
  private async extractPdfPages(absolutePath: string): Promise<PdfTextPage[]> {
    const worker = getSearchWorker();
    const pages: PdfTextPage[] = [];
    let numPages = Number.POSITIVE_INFINITY;

    try {
      for (let from = 1; from <= numPages; from += PDF_PAGE_BATCH) {
        if (!this.indexingAllowed()) throw new Error("Indexing is paused.");
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

  private async indexGalleryPhoto(db: SearchDatabase, photo: SearchGalleryPhoto, known: IndexedFile | undefined, preferences: SearchPreferences) {
    const record: Omit<IndexedFile, "id" | "status"> = {
      key: `gallery:${photo.id}`,
      source: "gallery",
      kind: "image",
      path: photo.path,
      name: photo.name,
      notebook: "",
      signature: "",
      meta: JSON.stringify(photo),
    };
    const ftsName = ftsNameOf("gallery", photo.path);

    try {
      const absolutePath = path.join(getGalleryRoot(), ...photo.path.split("/"));
      record.signature = await readFileSignature(absolutePath);
      if (!this.canIndex(db, preferences)) return;
      if (known?.status === "ok" && known.signature === record.signature && known.meta === record.meta) return;
      const hash = await imageHash(absolutePath);
      const after = await readFileSignature(absolutePath);
      if (!this.canIndex(db, preferences)) return;
      if (record.signature !== after) {
        this.galleryChanged = true;
        this.rescanRequested = true;
        return;
      }
      db.replaceFile(record, [{ hash, title: "", text: [photo.name, photo.prompt].filter(Boolean).join("\n"), context: "" }], ftsName);
    } catch (error) {
      if (!this.canIndex(db, preferences)) return;
      db.markFailed(record, error instanceof Error ? error.message : "Could not read the photo.", ftsName);
    }
  }

  private sourcePath(chunk: PendingChunk) {
    return chunk.source === "gallery"
      ? path.join(getGalleryRoot(), ...chunk.path.split("/"))
      : chunk.source === "references"
        ? referenceLibraryPath(chunk.notebook)
        : libraryAbsolutePath(chunk.path);
  }

  /** The signature a record has now, to compare with the one its passages were stored under. */
  private async currentSignature(chunk: PendingChunk) {
    if (chunk.source === "references") {
      const parsed = parseReferenceRecordKey(chunk.key);
      return parsed ? currentReferenceSignature(parsed.notebook, parsed.entryId) : "";
    }
    if (chunk.source === "library") return this.librarySignature(chunk.path, chunk.kind as LiberaFileNode["fileType"]);
    return readFileSignature(this.sourcePath(chunk));
  }

  /** Text can change during inference too; never attach a vector to stale source text. */
  private async sourcesCurrent(db: SearchDatabase, chunks: PendingChunk[], preferences: SearchPreferences) {
    const seen = new Set<string>();
    for (const chunk of chunks) {
      if (seen.has(chunk.key)) continue;
      seen.add(chunk.key);
      const signature = await this.currentSignature(chunk).catch(() => "");
      if (!this.canIndex(db, preferences)) return false;
      if (signature !== chunk.signature) {
        if (chunk.source === "gallery") this.galleryChanged = true;
        else if (chunk.source === "references") this.referenceNotebooks.add(chunk.notebook);
        else this.changedPaths.add(chunk.path);
        this.rescanRequested = true;
        return false;
      }
    }
    return true;
  }

  private async embedPending(db: SearchDatabase, preferences: SearchPreferences) {
    const worker = getSearchWorker();
    if (!worker.configured || !this.canIndex(db, preferences)) return;
    const epoch = this.embeddingEpoch;

    const includeImages = preferences.indexImages && worker.visionConfigured;
    const excludedFileIds = db.listFiles().filter((file) => this.isUnavailable(file)).map((file) => file.id);
    this.total = db.countPending(includeImages, excludedFileIds);
    this.done = 0;
    if (!this.total) return;

    this.state = "embedding";
    try {
      await worker.ensureModel();
    } catch {
      // The status shows the model error; keyword search keeps working.
      return;
    }

    while (!this.rescanRequested && this.canEmbed(db, preferences, epoch)) {
      while (!this.rescanRequested && this.canEmbed(db, preferences, epoch) && Date.now() - worker.lastQueryAt < SEARCH_ACTIVITY_PAUSE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (this.rescanRequested || !this.canEmbed(db, preferences, epoch)) return;
      const batch = db.pendingChunks(TEXT_BATCH_SIZE, includeImages, excludedFileIds);
      if (!batch.length) break;

      // Images go one at a time: each takes a while, and a search may be waiting.
      const work = batch[0].kind === "image" ? batch.slice(0, 1) : batch.filter((chunk) => chunk.kind !== "image");
      this.current = displayPath(work[0]);

      try {
        if (!await this.sourcesCurrent(db, work, preferences) || !this.canEmbed(db, preferences, epoch)) return;
        const vectors = await worker.embed(work.map((chunk) => this.embedInput(chunk)), "index");
        // A routine rescan can wait until this valid batch is stored. Otherwise
        // polling repeatedly discards slow inference and the queue never advances.
        if (!this.canEmbed(db, preferences, epoch)) return;
        if (!await this.sourcesCurrent(db, work, preferences)) return;
        if (!this.canEmbed(db, preferences, epoch)) return;
        db.storeVectors(work.map((chunk, index) => ({ id: chunk.id, generation: chunk.generation, kind: chunk.kind, vector: vectors[index] })));
      } catch (error) {
        if (!this.canEmbed(db, preferences, epoch) || this.rescanRequested) return;
        if (!await this.sourcesCurrent(db, work, preferences)) return;
        if (worker.modelState === "error") return;
        // One unreadable passage or photo must not stall the queue: skip it.
        if (work.length === 1) db.markEmbeddingFailed(work);
        else await this.embedOneByOne(db, work, preferences, epoch);
        console.warn(`Global Search could not embed ${this.current}: ${error instanceof Error ? error.message : error}`);
      }

      this.done += work.length;
      await yieldToServer();
    }
  }

  private async embedOneByOne(db: SearchDatabase, chunks: PendingChunk[], preferences: SearchPreferences, epoch: number) {
    const worker = getSearchWorker();
    for (const chunk of chunks) {
      if (!this.canEmbed(db, preferences, epoch) || this.rescanRequested) return;
      try {
        if (!await this.sourcesCurrent(db, [chunk], preferences)) return;
        const [vector] = await worker.embed([this.embedInput(chunk)], "index");
        if (!await this.sourcesCurrent(db, [chunk], preferences)) return;
        if (!this.canEmbed(db, preferences, epoch)) return;
        db.storeVectors([{ id: chunk.id, generation: chunk.generation, kind: chunk.kind, vector }]);
      } catch {
        if (!this.canEmbed(db, preferences, epoch) || this.rescanRequested) return;
        if (!await this.sourcesCurrent(db, [chunk], preferences)) return;
        db.markEmbeddingFailed([chunk]);
      }
    }
  }

  private embedInput(chunk: PendingChunk) {
    if (chunk.kind === "image") return { images: [{ path: this.sourcePath(chunk) }] };
    return { text: documentPrompt(chunk.kind, searchDocumentTitle(chunk.kind, chunk.name), chunk) };
  }

  status(): SearchIndexStatus {
    const preferences = getSearchPreferences();
    const worker = getSearchWorker();
    // New weights or settings: check the stored vectors against them again.
    if (worker.configure(preferences)) this.requestScan({ force: true, manual: false });
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
      backgroundIndexing: preferences.backgroundIndexing,
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
