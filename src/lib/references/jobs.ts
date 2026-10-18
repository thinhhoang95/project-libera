import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ARCHIVE_DIR, MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { writeJsonAtomically } from "@/lib/storage/fs-utils";
import { getAdminRoot, getLinkedFolders, notebookPath, notebookSystemDirectoryPath } from "@/lib/storage/paths";
import { readReferenceLibrary, updateReferenceLibrary } from "@/lib/storage/references";
import { LibraryOpError } from "./library-ops";
import { isActiveReferenceJob, type ReferenceJobKind, type ReferenceJobStatus } from "./jobs-types";
import { isAbortError } from "./resolve/http";
import { createLimiter, mapWithConcurrency, type Limiter } from "./resolve/limit";
import { findCandidateDuplicates, resolveMarkdown, resolvePdf, type ResolveOptions, type ResolveResult } from "./resolve/pipeline";
import { getReferenceResolveSettings, type ReferenceResolveSettings } from "./resolve/settings";
import type { ReferenceEntryInput, ReferenceLibrary, ReferenceLibraryOp } from "./types";

// Background reference jobs (docs/references/plan.md §4.4 "Background
// jobs"): resolve every PDF without an entry, or given paths, on the server.
// The runner is a globalThis singleton like the search indexer. Each
// notebook's queue persists in `<system dir>/references/jobs.json`; after a
// restart, running jobs go back to the queue and resume when the runner is
// first used. One job per notebook runs at a time, in order. Across all jobs
// at most two network lookups and two model calls run at once. Every file
// commits its own library transaction, so a cancelled job keeps what it
// finished. Entries are created `needs-review` or `unresolved`, never
// `confirmed`.

/** Finished jobs kept per notebook. */
export const FINISHED_JOBS_KEPT = 20;
/** PDFs added within this window become one automatic job. */
export const AUTO_CREATE_DEBOUNCE_MS = 2_000;
const NETWORK_CONCURRENCY = 2;
const LLM_CONCURRENCY = 2;
/** Files of one job in flight at once; the network and model limits do the real throttling. */
const FILE_CONCURRENCY = 2;
const MAX_JOB_PATHS = 10_000;
const MAX_ERRORS_KEPT = 200;
const JOBS_FILE_VERSION = 1;

type StoredJob = ReferenceJobStatus & {
  /** Paths still to process. */
  pending: string[];
  /** A `resolve-pdfs` job lists its PDFs when it first starts. */
  prepared: boolean;
};

type JobsFile = { version: number; jobs: StoredJob[] };

export type ReferenceJobRunnerDeps = {
  resolvePdf: (relativePath: string, options: ResolveOptions) => Promise<ResolveResult>;
  resolveMarkdown: (relativePath: string, options: ResolveOptions) => Promise<ResolveResult>;
  readLibrary: (notebook: string) => Promise<ReferenceLibrary>;
  updateLibrary: (notebook: string, ops: ReferenceLibraryOp[]) => Promise<ReferenceLibrary>;
  /** Library-relative paths of the notebook's PDFs, archive excluded. */
  listPdfs: (notebook: string) => Promise<string[]>;
  /** Notebooks that may have a jobs file, for resuming after a restart. */
  listNotebooks: () => Promise<string[]>;
  jobsFile: (notebook: string) => string;
  settings: () => ReferenceResolveSettings;
  now: () => Date;
  /** Extra resolve options (tests inject fetch and model doubles here). */
  resolveOptions?: Partial<ResolveOptions>;
  autoCreateDebounceMs?: number;
};

const HIDDEN_ENTRIES = new Set(["__MACOSX", MARKDOWN_ASSETS_DIR, "node_modules", "__pycache__", "bower_components"]);

/** Every PDF in the notebook, outside the archive and hidden folders. */
export async function listNotebookPdfs(notebook: string): Promise<string[]> {
  const root = notebookPath(notebook);
  const found: string[] = [];
  const walk = async (directory: string, parts: string[]) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_JOB_PATHS) return;
      if (entry.name.startsWith(".") || HIDDEN_ENTRIES.has(entry.name)) continue;
      if (!parts.length && entry.name === ARCHIVE_DIR) continue;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), [...parts, entry.name]);
      else if (entry.isFile() && /\.pdf$/i.test(entry.name)) found.push([notebook, ...parts, entry.name].join("/"));
    }
  };
  await walk(root, []);
  return found.sort((a, b) => a.localeCompare(b));
}

async function listLibraryNotebooks() {
  const linked = getLinkedFolders();
  const linkedNames = new Set(linked.map((folder) => folder.name));
  let names: string[] = [];
  try {
    names = (await readdir(getAdminRoot(), { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !linkedNames.has(entry.name)).map((entry) => entry.name);
  } catch {
    // No library yet.
  }
  return [...names, ...linked.filter((folder) => !folder.unresolved).map((folder) => folder.name)];
}

export function referenceJobsFilePath(notebook: string) {
  return path.join(notebookSystemDirectoryPath(notebook), "references", "jobs.json");
}

function defaultDeps(): ReferenceJobRunnerDeps {
  return {
    resolvePdf,
    resolveMarkdown,
    readLibrary: readReferenceLibrary,
    updateLibrary: (notebook, ops) => updateReferenceLibrary(notebook, null, ops),
    listPdfs: listNotebookPdfs,
    listNotebooks: listLibraryNotebooks,
    jobsFile: referenceJobsFilePath,
    settings: getReferenceResolveSettings,
    now: () => new Date(),
  };
}

function publicStatus(job: StoredJob): ReferenceJobStatus {
  const status: Partial<StoredJob> = structuredClone(job);
  delete status.pending;
  delete status.prepared;
  return status as ReferenceJobStatus;
}

function isFileAttached(library: ReferenceLibrary, kind: "pdf" | "markdown", relativePath: string) {
  return Object.values(library.entries).some((entry) => entry.attachments.some((attachment) => attachment.kind === kind && attachment.path === relativePath));
}

function exactDuplicate(candidate: ReferenceEntryInput, library: ReferenceLibrary) {
  return findCandidateDuplicates([candidate], library).find((duplicate) => duplicate.score === 1 && duplicate.reason !== "fuzzy" && duplicate.reason !== "preprint-published");
}

/** A job's notebook-owned path: inside the notebook, a PDF or Markdown file. */
function fileKind(relativePath: string): "pdf" | "markdown" | null {
  if (/\.pdf$/i.test(relativePath)) return "pdf";
  if (/\.(md|markdown)$/i.test(relativePath)) return "markdown";
  return null;
}

export class ReferenceJobRunner {
  private jobs = new Map<string, StoredJob[]>();
  private loading = new Map<string, Promise<void>>();
  private running = new Set<string>();
  private controllers = new Map<string, AbortController>();
  private persistChains = new Map<string, Promise<void>>();
  private commitChains = new Map<string, Promise<unknown>>();
  private pumps = new Map<string, Promise<void>>();
  private runs = new Map<string, Promise<void>>();
  private autoPaths = new Map<string, Set<string>>();
  private autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private network: Limiter = createLimiter(NETWORK_CONCURRENCY);
  private llm: Limiter = createLimiter(LLM_CONCURRENCY);
  private deps: ReferenceJobRunnerDeps;

  constructor(deps: Partial<ReferenceJobRunnerDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(notebook: string) {
    let loading = this.loading.get(notebook);
    if (!loading) {
      loading = (async () => {
        let stored: StoredJob[] = [];
        try {
          const file = JSON.parse(await readFile(this.deps.jobsFile(notebook), "utf8")) as JobsFile;
          if (file?.version === JOBS_FILE_VERSION && Array.isArray(file.jobs)) stored = file.jobs.filter((job) => job && typeof job.id === "string" && Array.isArray(job.pending));
        } catch {
          // Missing or unreadable: start with no jobs.
        }
        let resumed = false;
        for (const job of stored) {
          job.notebook = notebook;
          if (job.state === "running") {
            // Interrupted by a restart: back to the queue, keeping what finished.
            job.state = "queued";
            delete job.current;
            resumed = true;
          }
        }
        this.jobs.set(notebook, [...stored, ...(this.jobs.get(notebook) ?? [])]);
        if (resumed) await this.persist(notebook);
      })();
      this.loading.set(notebook, loading);
    }
    return loading;
  }

  private persist(notebook: string) {
    const previous = this.persistChains.get(notebook) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const file: JobsFile = { version: JOBS_FILE_VERSION, jobs: this.jobs.get(notebook) ?? [] };
      try {
        await writeJsonAtomically(this.deps.jobsFile(notebook), file);
      } catch (error) {
        console.warn(`[references] Could not save the job queue of ${notebook}:`, error);
      }
    });
    this.persistChains.set(notebook, next);
    return next;
  }

  /** Waits until queued writes of the notebook's jobs file are on disk (tests, shutdown). */
  async flush(notebook: string) {
    await this.persistChains.get(notebook);
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  /** Load every notebook's queue and resume its unfinished jobs. */
  async resumeAll() {
    const notebooks = await this.deps.listNotebooks().catch(() => [] as string[]);
    await Promise.all(notebooks.map(async (notebook) => {
      await this.load(notebook);
      if (this.jobs.get(notebook)?.some(isActiveReferenceJob)) this.pump(notebook);
    }));
  }

  async list(notebook: string): Promise<ReferenceJobStatus[]> {
    await this.load(notebook);
    if (this.jobs.get(notebook)?.some((job) => job.state === "queued")) this.pump(notebook);
    return (this.jobs.get(notebook) ?? []).map(publicStatus);
  }

  async enqueue(notebook: string, kind: ReferenceJobKind, options: { paths?: string[]; webSearch?: boolean } = {}): Promise<ReferenceJobStatus> {
    await this.load(notebook);
    const jobs = this.jobs.get(notebook) ?? [];
    const webSearch = options.webSearch ?? this.deps.settings().webSearchDefault;
    if (kind === "resolve-pdfs") {
      // Asking twice while one is waiting or running is the same request.
      const existing = jobs.find((job) => job.kind === "resolve-pdfs" && isActiveReferenceJob(job) && job.webSearch === webSearch);
      if (existing) return publicStatus(existing);
    }
    const paths = kind === "resolve-paths" ? [...new Set(options.paths ?? [])].slice(0, MAX_JOB_PATHS) : [];
    const job: StoredJob = {
      id: `job_${randomUUID()}`,
      notebook,
      kind,
      state: "queued",
      total: paths.length,
      done: 0,
      failed: 0,
      createdEntryIds: [],
      updatedEntryIds: [],
      errors: [],
      webSearch,
      createdAt: this.deps.now().toISOString(),
      pending: paths,
      prepared: kind === "resolve-paths",
    };
    this.jobs.set(notebook, [...jobs, job]);
    await this.persist(notebook);
    this.pump(notebook);
    return publicStatus(job);
  }

  /** Cancel a queued or running job. Files already resolved stay in the library. Null when the job is unknown. */
  async cancel(notebook: string, jobId: string): Promise<ReferenceJobStatus | null> {
    await this.load(notebook);
    const job = this.jobs.get(notebook)?.find((item) => item.id === jobId);
    if (!job) return null;
    if (job.state === "queued") {
      job.state = "cancelled";
      job.finishedAt = this.deps.now().toISOString();
      this.prune(notebook);
      await this.persist(notebook);
    } else if (job.state === "running") {
      this.controllers.get(job.id)?.abort();
      // The loop marks it cancelled once the files in progress stop.
      await this.runs.get(job.id);
    }
    return publicStatus(job);
  }

  /** Resolves when the notebook's queue is idle (tests). */
  async idle(notebook: string) {
    while (this.pumps.get(notebook)) await this.pumps.get(notebook);
    await this.flush(notebook);
  }

  /**
   * PDFs were added through the app (upload or save). When automatic
   * entries are on (the notebook's setting, else the preference), a burst of
   * additions becomes one `resolve-paths` job after AUTO_CREATE_DEBOUNCE_MS.
   */
  notifyFilesAdded(paths: string[]) {
    for (const relativePath of paths) {
      if (fileKind(relativePath) !== "pdf") continue;
      const notebook = relativePath.split("/")[0];
      if (!notebook) continue;
      const set = this.autoPaths.get(notebook) ?? new Set<string>();
      set.add(relativePath);
      this.autoPaths.set(notebook, set);
      clearTimeout(this.autoTimers.get(notebook));
      const timer = setTimeout(() => void this.flushAutoCreate(notebook), this.deps.autoCreateDebounceMs ?? AUTO_CREATE_DEBOUNCE_MS);
      timer.unref?.();
      this.autoTimers.set(notebook, timer);
    }
  }

  /** Drop pending automatic additions and their timers, e.g. before the data directory changes. Running jobs are not affected. */
  dispose() {
    for (const timer of this.autoTimers.values()) clearTimeout(timer);
    this.autoTimers.clear();
    this.autoPaths.clear();
  }

  /** Enqueue the pending automatic paths of a notebook now. Returns the job, or null when nothing was enqueued. */
  async flushAutoCreate(notebook: string) {
    clearTimeout(this.autoTimers.get(notebook));
    this.autoTimers.delete(notebook);
    const paths = [...(this.autoPaths.get(notebook) ?? [])];
    this.autoPaths.delete(notebook);
    if (!paths.length) return null;
    try {
      const library = await this.deps.readLibrary(notebook);
      const enabled = library.settings?.autoCreateForPdfs ?? this.deps.settings().autoCreateForPdfs;
      if (!enabled) return null;
      return await this.enqueue(notebook, "resolve-paths", { paths });
    } catch (error) {
      console.warn(`[references] Could not start automatic entries for ${notebook}:`, error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Processing
  // -------------------------------------------------------------------------

  private pump(notebook: string) {
    if (this.pumps.get(notebook)) return;
    const run = (async () => {
      try {
        for (;;) {
          const job = this.jobs.get(notebook)?.find((item) => item.state === "queued");
          if (!job) break;
          const run = this.run(job);
          this.runs.set(job.id, run);
          try { await run; } finally { this.runs.delete(job.id); }
        }
      } finally {
        this.pumps.delete(notebook);
      }
    })();
    this.pumps.set(notebook, run);
  }

  private prune(notebook: string) {
    const jobs = this.jobs.get(notebook) ?? [];
    const finished = jobs.filter((job) => !isActiveReferenceJob(job));
    if (finished.length <= FINISHED_JOBS_KEPT) return;
    const drop = new Set(finished.slice(0, finished.length - FINISHED_JOBS_KEPT).map((job) => job.id));
    this.jobs.set(notebook, jobs.filter((job) => !drop.has(job.id)));
  }

  private async run(job: StoredJob) {
    const notebook = job.notebook;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.state = "running";
    job.startedAt ??= this.deps.now().toISOString();
    await this.persist(notebook);
    try {
      if (!job.prepared) {
        const library = await this.deps.readLibrary(notebook);
        job.pending = (await this.deps.listPdfs(notebook)).filter((pdf) => !isFileAttached(library, "pdf", pdf));
        job.total = job.pending.length;
        job.prepared = true;
        await this.persist(notebook);
      }
      await mapWithConcurrency([...job.pending], FILE_CONCURRENCY, async (relativePath) => {
        if (controller.signal.aborted) return;
        job.current = relativePath;
        try {
          const outcome = await this.processFile(job, relativePath, controller.signal);
          if (outcome.created) job.createdEntryIds.push(outcome.created);
          if (outcome.updated && !job.updatedEntryIds.includes(outcome.updated)) job.updatedEntryIds.push(outcome.updated);
          job.done += 1;
        } catch (error) {
          if (controller.signal.aborted && isAbortError(error)) return;
          job.failed += 1;
          if (job.errors.length < MAX_ERRORS_KEPT) job.errors.push({ path: relativePath, message: error instanceof Error ? error.message : String(error) });
        }
        job.pending = job.pending.filter((item) => item !== relativePath);
        if (job.current === relativePath) delete job.current;
        await this.persist(notebook);
      });
      job.state = controller.signal.aborted ? "cancelled" : "done";
    } catch (error) {
      job.state = controller.signal.aborted ? "cancelled" : "failed";
      if (!controller.signal.aborted) job.errors.push({ path: notebook, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.controllers.delete(job.id);
      delete job.current;
      job.finishedAt = this.deps.now().toISOString();
      this.prune(notebook);
      await this.persist(notebook);
    }
  }

  /** Library writes of one notebook happen one after another, so two files of one work cannot both add it. */
  private commit<T>(notebook: string, task: () => Promise<T>) {
    const previous = this.commitChains.get(notebook) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.commitChains.set(notebook, next);
    return next;
  }

  private async processFile(job: StoredJob, relativePath: string, signal: AbortSignal): Promise<{ created?: string; updated?: string }> {
    const notebook = job.notebook;
    if (relativePath.split("/")[0] !== notebook) throw new Error("The file is not in this notebook.");
    const kind = fileKind(relativePath);
    if (!kind) throw new Error("Only PDF and Markdown files can be resolved.");
    const library = await this.deps.readLibrary(notebook);
    // A file that already belongs to an entry has nothing to resolve.
    if (isFileAttached(library, kind, relativePath)) return {};
    const options: ResolveOptions = {
      ...this.deps.resolveOptions,
      library,
      signal,
      webSearch: job.webSearch,
      settings: this.deps.settings(),
      limits: { network: this.network, llm: this.llm },
    };
    const result = kind === "pdf" ? await this.deps.resolvePdf(relativePath, options) : await this.deps.resolveMarkdown(relativePath, options);
    if (signal.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
    return this.commit(notebook, async () => {
      if (result.updates.length) {
        const after = await this.deps.updateLibrary(notebook, result.updates);
        const id = result.updates.map((op) => ("id" in op ? op.id : undefined)).find((value): value is string => !!value && !!after.entries[value]);
        return id ? { updated: id } : {};
      }
      const candidate = result.candidates[0];
      if (!candidate) throw new Error("Nothing could be resolved from this file.");
      const latest = await this.deps.readLibrary(notebook);
      if (isFileAttached(latest, kind, relativePath)) return {};
      const attachment = { kind, path: relativePath } as const;
      const duplicate = exactDuplicate(candidate, latest);
      if (duplicate) {
        try {
          await this.deps.updateLibrary(notebook, [{ op: "attach", id: duplicate.entryId, attachment }]);
          return { updated: duplicate.entryId };
        } catch (error) {
          // The entry was deleted meanwhile: add the file's own entry instead.
          if (!(error instanceof LibraryOpError)) throw error;
        }
      }
      const entry: ReferenceEntryInput = {
        ...candidate,
        status: candidate.status === "unresolved" ? "unresolved" : "needs-review",
        attachments: [...(candidate.attachments ?? []).filter((item) => !(item.kind === kind && item.path === relativePath)), attachment],
      };
      const before = new Set(Object.keys(latest.entries));
      const after = await this.deps.updateLibrary(notebook, [{ op: "add", entry }]);
      const created = Object.values(after.entries).find((item) => !before.has(item.id) && item.attachments.some((existing) => existing.kind === kind && existing.path === relativePath));
      return created ? { created: created.id } : {};
    });
  }
}

const RUNNER_KEY = Symbol.for("libera.referenceJobRunner");

/** The process-wide runner. Creating it resumes jobs interrupted by a restart. */
export function getReferenceJobRunner() {
  const store = globalThis as { [RUNNER_KEY]?: ReferenceJobRunner };
  if (!store[RUNNER_KEY]) {
    store[RUNNER_KEY] = new ReferenceJobRunner();
    void store[RUNNER_KEY].resumeAll();
  }
  return store[RUNNER_KEY];
}

/** Replace the process-wide runner (tests). */
/** The runner, if one exists, without creating it. */
export function currentReferenceJobRunner() {
  return (globalThis as { [RUNNER_KEY]?: ReferenceJobRunner })[RUNNER_KEY];
}

export function setReferenceJobRunner(runner: ReferenceJobRunner | undefined) {
  const store = globalThis as { [RUNNER_KEY]?: ReferenceJobRunner };
  store[RUNNER_KEY] = runner;
}

/** Called where the app writes new files into notebooks (uploads, saves). Cheap when automatic entries are off. */
export function notifyReferenceFilesAdded(paths: string[]) {
  if (!paths.some((relativePath) => /\.pdf$/i.test(relativePath))) return;
  getReferenceJobRunner().notifyFilesAdded(paths);
}
