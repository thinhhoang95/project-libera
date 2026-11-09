import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { copyFile, cp, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { transformReviewBaselines, withMovedReview } from "@/lib/agent/review-store";
import { recordMovedRunFiles, type MovedRunFile } from "@/lib/agent/snapshots";
import { isSharedNotebookPath, sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { latexDependencies } from "@/lib/latex/dependencies";
import { pythonSidecarPath } from "@/lib/python/sidecar";
import { moveTetheredFilesBatch } from "@/lib/references/bib-tether";
import { publishReferenceEvent } from "@/lib/references/library-events";
import { rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { rewriteCitationKeys } from "@/lib/references/citation-syntax";
import { copyReferenceEntries } from "@/lib/references/copy-entries";
import { notifyReferenceFilesAdded, referenceJobsFilePath } from "@/lib/references/jobs";
import { copyReferencesOnMove, type ReferenceMoveResult } from "@/lib/references/moves";
import { migrateImageAnnotations, migratePdfAnnotations } from "@/lib/storage/annotations";
import { ARCHIVE_DIR, IGNORED_DOWNLOAD_ENTRIES, INK_DIR, MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { writeJsonAtomically } from "@/lib/storage/fs-utils";
import { cleanupMarkdownImageAssets, copyMarkdownImageAssets, markdownImageTargets, readMarkdownAssetDocuments, type MarkdownAssetBatch } from "@/lib/storage/markdown-assets";
import { moveReviewPaths } from "@/lib/storage/markdown-reviews";
import { checkNothingLeftAt } from "@/lib/storage/integrity";
import { migrationJournalDirectory, migrationJournalsChanged } from "@/lib/storage/migration-fence";
import { createNotebook, deleteNotebook } from "@/lib/storage/notebooks";
import {
  assertSafeSegment,
  assertSafeUserSegment,
  ensureAdminRoot,
  filePathFromParts,
  getLinkedFolder,
  itemPath,
  markdownAssetsDirectoryPathFromParts,
  notebookPath,
  splitFilePath,
} from "@/lib/storage/paths";
import { moveReferenceAttachmentsBatch, readReferenceLibrary } from "@/lib/storage/references";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { existingSidecars, moveFileSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { fileExistence, libraryNotebookNames, linkCandidates, readNotebookLinkIndex, resolveLinkWith } from "@/lib/storage/library-links";
import { extractNotebookLinkDestinations } from "@/lib/storage/notebook-links";
import { isVisibleTreeEntry, listVisibleNotebookFiles } from "@/lib/storage/tree";
import { renameFileMetadataPathPrefix, renameFileMetadataPaths, renameNotebookPanelExpandedPathPrefix } from "@/lib/storage/workspace-metadata";
import type { LiberaNotebookMetadata } from "@/lib/types";

// Notebook migration: move a selection of files and folders from one local
// notebook to another (or to a new one), with everything Libera keeps for
// them. docs/features/notebook-migration.md describes the behavior.
//
// plan      Reads the selection and the destination. Expands folders,
//           mirrors their layout, keeps both files on a name clash (a free
//           name has no file and no sidecar data), records each file's
//           identity (device, inode, size, mtime), and reports what would
//           block the move or break.
// run       Plans again and refuses when the plan changed since it was shown.
//   staging   Nothing in the source changes. Images notes embed are copied
//             into the destination, and a note whose image paths change is
//             written in full to a hidden staged file beside its destination.
//             Then the journal is written once, with every rewrite map.
//   moving    Each file is published without ever replacing anything: a hard
//             link (same inode, so its dates are kept) from the source, or
//             from its staged copy; only then is the source removed. Its
//             pending agent review is moved under lock before it, and its
//             sidecars right after. The journal is not written per file: on
//             resume, where each file is comes from the disk, checked
//             against the identity recorded in the plan.
//   finalizing  One pass each, the journal recording each step as it ends:
//             folders, stars/tags/reviews, images, reference attachments,
//             cited references, agent review and undo history, reference
//             entries, the search index, and a check for leftovers.
// The finished journal keeps the result until the client acknowledges it,
// so a lost response can still be applied. While a journal is open, the
// fence (migration-fence.ts) keeps saves, sidecar maintenance and review
// settling away from its files.
//
// Shared (collaborative) notebooks are out of scope on both sides.

export type MigrationDestination = {
  notebook: string;
  /** A folder inside the destination notebook, as path segments joined by "/" ("" for its root). */
  folder?: string;
  /**
   * Create the notebook as the first step of the run (the create-notebook
   * dialog's values). `workspaceGroupId` is a group of the active workspace,
   * which the app records itself: it is kept and returned with the result, so
   * it survives an interruption.
   */
  create?: Partial<Pick<LiberaNotebookMetadata, "color" | "emoji" | "groupId">> & { workspaceGroupId?: string | null };
  /**
   * Put each selected file or folder directly in the destination folder,
   * without the folders it was in (Move… of one file). By default the source
   * layout is mirrored. A selected folder keeps its own content either way.
   */
  flat?: boolean;
};

export type MigrationRequest = {
  source: string;
  /** Library paths of the selected files and folders. A folder means all of it. */
  paths: string[];
  destination: MigrationDestination;
};

export type MigrationItem = {
  from: string;
  to: string;
  /** `file`: a file the notebook panel shows. `other`: hidden or unknown content of a selected folder, moved as is. */
  kind: "file" | "other";
  fileType: string | null;
  /** The name changed to keep both files. */
  renamed: boolean;
  /** Bytes; for a hidden folder, of everything in it. */
  size: number;
  /** A hidden folder: how many entries it holds. */
  count?: number;
};

export type MigrationWarningKind = "renamed" | "inbound-links" | "inbound-images" | "outbound-links" | "latex-left-behind" | "latex-includes-moving" | "latex-incomplete" | "cross-device";

export type MigrationWarning = {
  kind: MigrationWarningKind;
  message: string;
  /** The files concerned. For `latex-left-behind`, files the dialog can add to the selection. */
  paths: string[];
};

export type MigrationPlan = {
  token: string;
  source: string;
  destination: { notebook: string; folder: string; create: boolean; flat?: boolean };
  items: MigrationItem[];
  /** Selected folders, moved whole: the source folder is removed when empty. */
  folders: { from: string; to: string }[];
  totalBytes: number;
  crossDevice: boolean;
  warnings: MigrationWarning[];
  /** Reasons the migration cannot run. */
  blockers: string[];
};

type Identity = { dev: number; ino: number; size: number; mtimeMs: number; directory: boolean };
type RootIdentity = { dev: number; ino: number };

/**
 * How a file is published. `link`: a hard link from the source (same
 * device). `rename`: a directory or a file system without hard links.
 * `staged`: the note was rewritten into a staged file. `copy`: another drive.
 */
type Method = "link" | "rename" | "staged" | "copy";

type JournalItem = MigrationItem & {
  identity: Identity;
  method?: Method;
  /**
   * A note's own folders in the destination's `_assets` (images, Python
   * figures). Planning keeps them free, so they are new with the migration
   * and discarding staging removes them whole, even after a crash.
   */
  ownedDirectories?: string[];
  /** A note's images copied while staging, its rewrite map, and its text hashes before and after it. */
  images?: { created: string[]; imageSources: Record<string, string>; before: string; after: string };
};

type FinalizeStep = "folders" | "records" | "assets" | "attachments" | "tether" | "references" | "history" | "entries" | "notify";

type Journal = {
  version: 2;
  id: string;
  createdAt: string;
  updatedAt: string;
  state: "staging" | "moving" | "finalizing" | "interrupted" | "done";
  /** The phase an interrupted migration stopped in. */
  phase: "staging" | "moving" | "finalizing";
  source: string;
  destination: { notebook: string; folder: string };
  create: MigrationDestination["create"] | null;
  createdNotebook: boolean;
  roots: { source: RootIdentity; destination?: RootIdentity };
  items: JournalItem[];
  folders: { from: string; to: string }[];
  /** Destination folders of the selected folders, created even when empty. */
  folderTargets: string[];
  /** Destination folders that did not exist when planned (library paths): removed again, when empty, if staging is undone. */
  createdFolders: string[];
  /** Finalize steps that ended, and the one that started (a step that started but did not end is not run twice). */
  finalized: FinalizeStep[];
  finalizing?: FinalizeStep;
  finishedFolders?: { from: string; to: string }[];
  references?: ReferenceMoveResult | null;
  referenceEntries?: MigrationResult["referenceEntries"];
  /** Records that could not be updated. The files moved; these need attention. */
  bookkeeping: string[];
  result?: MigrationResult;
  error?: string;
};

export type MigrationMove = {
  from: string;
  to: string;
  fileType: string | null;
  imageSources?: Record<string, string>;
  /** The file moved, but its sidecars or records did not all follow yet (the migration stopped). */
  incomplete?: boolean;
};

export type MigrationResult = {
  id: string;
  state: "done" | "interrupted";
  source: string;
  destination: string;
  createdNotebook: boolean;
  /** Files that are at their new path (the panel's files; hidden folder content is not listed). */
  moved: MigrationMove[];
  /** Files still in the source. */
  remaining: string[];
  folders: { from: string; to: string }[];
  references: ReferenceMoveResult | null;
  /** Reference entries of moved PDFs, copied into the destination library. */
  referenceEntries: { copied: number; reused: number; error?: string };
  /** Records that could not be updated (attachments, undo history...). The files moved. */
  bookkeeping: string[];
  /** Sidecars, files or prepared copies still found at a moved item's old path. */
  leftovers: string[];
  /**
   * What the final check could say: `clean` (everything moved and nothing is
   * left at an old path), `incomplete` (files remain, or leftovers), or
   * `unverified` (the source could not be checked).
   */
  check: "clean" | "incomplete" | "unverified";
  /** A workspace group chosen for the new notebook, for the app to record. */
  workspaceGroup?: { notebook: string; groupId: string | null };
  error?: string;
};

export type InterruptedMigration = Pick<Journal, "id" | "createdAt" | "source" | "destination" | "error" | "phase"> & {
  moved: number;
  total: number;
};

const LOCK = Symbol.for("libera.notebookMigration");

/**
 * Tests only: throw at a named point of a run ("staged:<path>",
 * "published:<path>", "finalize:<step>"), leaving the disk as a crash there
 * would. An error with `crash: true` also skips the run's own clean-up, as a
 * crash would.
 */
let injectFault: ((point: string) => void) | null = null;
export function setMigrationFaultForTests(fault: ((point: string) => void) | null) {
  injectFault = fault;
}
const JUNK = (name: string) => IGNORED_DOWNLOAD_ENTRIES.has(name) || name.startsWith("._");
/** Libera's own folders (".libera", ".DS_Store"...) are never notebooks. */
const RESERVED_NOTEBOOK = /^\./;

function journalPath(id: string) {
  if (!/^[a-z0-9-]{8,64}$/i.test(id)) throw new StorageError("Unknown migration.", 404);
  return path.join(migrationJournalDirectory(), `${id}.json`);
}

async function saveJournal(journal: Journal) {
  journal.updatedAt = new Date().toISOString();
  await writeJsonAtomically(journalPath(journal.id), journal);
  migrationJournalsChanged();
}

async function removeJournal(id: string) {
  await rm(journalPath(id), { force: true });
  migrationJournalsChanged();
}

async function readJournal(id: string): Promise<Journal> {
  let journal: Journal;
  try { journal = JSON.parse(await readFile(journalPath(id), "utf8")) as Journal; }
  catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("This migration's journal could not be read.", 404);
  }
  if (journal?.version !== 2 || !Array.isArray(journal.items)) throw new StorageError("This migration's journal was written by another version of Libera.", 409);
  return journal;
}

async function readJournals(): Promise<{ journals: Journal[]; unreadable: string[] }> {
  let names: string[];
  try { names = (await readdir(migrationJournalDirectory())).filter((name) => name.endsWith(".json")); }
  catch { return { journals: [], unreadable: [] }; }
  const journals: Journal[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    try { journals.push(await readJournal(name.slice(0, -".json".length))); }
    catch { unreadable.push(name); }
  }
  return { journals, unreadable };
}

/** Migrations that stopped before finishing (the app quit, a disk error): resume or stop them first. */
export async function listInterruptedMigrations(): Promise<InterruptedMigration[]> {
  return (await readJournals()).journals
    .filter((journal) => journal.state !== "done")
    .map((journal) => ({
      id: journal.id,
      createdAt: journal.createdAt,
      source: journal.source,
      destination: journal.destination,
      error: journal.error,
      phase: journal.phase,
      moved: journal.result?.moved.length ?? 0,
      total: journal.items.filter((item) => item.kind === "file").length,
    }));
}

/** Finished migrations whose result the app has not applied yet (its response was lost). */
export async function listUnacknowledgedMigrations(): Promise<MigrationResult[]> {
  return (await readJournals()).journals.flatMap((journal) => journal.state === "done" && journal.result ? [journal.result] : []);
}

/** Journal files that can't be read (damaged, or from another version of Libera). They block new migrations until set aside. */
export async function listUnreadableMigrations(): Promise<string[]> {
  return (await readJournals()).unreadable;
}

/**
 * Keep an unreadable journal for inspection under another name, so it no
 * longer blocks migrations. Nothing it describes is changed.
 */
export async function setAsideUnreadableMigration(name: string) {
  if (!(await listUnreadableMigrations()).includes(name)) throw new StorageError("That migration journal is not unreadable.", 404);
  const from = path.join(migrationJournalDirectory(), name);
  await rename(from, `${from}.unreadable-${Date.now()}`);
  migrationJournalsChanged();
}

/** The app applied a finished migration's result: its journal goes away. */
export async function acknowledgeMigration(id: string) {
  const journal = await readJournal(id).catch(() => null);
  if (journal && journal.state !== "done") throw new StorageError("This migration has not finished.", 409);
  await removeJournal(id);
}

// ---------------------------------------------------------------------------
// One migration at a time, across processes
// ---------------------------------------------------------------------------

function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A lock file in the journal folder (one write to take it, one to release it), with the in-process flag in front. */
async function exclusively<T>(task: () => Promise<T>): Promise<T> {
  const holder = globalThis as { [LOCK]?: boolean };
  if (holder[LOCK]) throw new StorageError("Another migration is running. Wait for it to finish.", 409);
  holder[LOCK] = true;
  const lockPath = path.join(migrationJournalDirectory(), ".lock");
  try {
    await mkdir(migrationJournalDirectory(), { recursive: true });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw new StorageError("Another migration is running. Wait for it to finish.", 409);
        // A lock whose process is gone (a crash) is taken over.
        const owner = await readFile(lockPath, "utf8").then((text) => JSON.parse(text) as { pid?: number }, () => ({ pid: undefined }));
        if (typeof owner.pid === "number" && owner.pid !== process.pid && processAlive(owner.pid)) {
          throw new StorageError("Another migration is running. Wait for it to finish.", 409);
        }
        await rm(lockPath, { force: true });
      }
    }
    try { return await task(); }
    finally { await rm(lockPath, { force: true }).catch(() => undefined); }
  } finally {
    holder[LOCK] = false;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
//
// Planning only reads: it never loads the library tree (whose upkeep writes
// indexes and prunes sidecars). Links come from each notebook's link index as
// last written, LaTeX projects from a walk of the source notebook, and work
// in progress from the job and recording files.

function isLocalNotebook(name: string) {
  return !sharedNotebookMarker(name) && !isSharedNotebookPath(name);
}

const SPACED_NAME = (part: string) => part !== part.trim();

function relativeParts(source: string, libraryPath: string) {
  if (typeof libraryPath !== "string") throw new StorageError("Paths must be library paths.", 400);
  const parts = libraryPath.split("/");
  if (parts[0] !== source || parts.length < 2) throw new StorageError(`${libraryPath} is not in ${source}.`, 400);
  return parts.slice(1).map((part) => {
    // Names are used exactly as on disk; one with spaces around it would be read as another name.
    if (SPACED_NAME(part)) throw new StorageError(`"${part}" starts or ends with a space. Rename it before migrating.`, 400);
    return assertSafeUserSegment(part, "Path segment");
  });
}

function withSuffix(name: string, index: number) {
  const extension = name.startsWith(".") && name.lastIndexOf(".") === 0 ? "" : path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem}-${index}${extension}`;
}

const lstatOrNull = (target: string) => lstat(target).catch(() => null);

function identityOf(stats: Stats): Identity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, directory: stats.isDirectory() };
}

/** Each folder from the notebook root down to `parts` is a real folder, not a link elsewhere (missing ones are fine). */
async function assertRealFolders(notebook: string, parts: string[], label: string) {
  for (let index = 1; index <= parts.length; index += 1) {
    const stats = await lstatOrNull(rawItemPath(notebook, parts.slice(0, index)));
    if (!stats) return;
    if (stats.isSymbolicLink()) throw new StorageError(`${[notebook, ...parts.slice(0, index)].join("/")} is a link to another folder, so ${label} can't go through it.`, 400);
    if (!stats.isDirectory()) throw new StorageError(`${[notebook, ...parts.slice(0, index)].join("/")} is a file, so a folder can't be created there.`, 409);
  }
}

/** Hidden content of a selected folder (`.git`, `.DS_Store`) has names user paths may not have; it is used exactly as read from the disk. */
function rawItemPath(notebook: string, parts: string[]) {
  const root = notebookPath(notebook);
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\0")) throw new StorageError("Path is invalid.", 400);
  }
  return path.join(root, ...parts);
}

function rawAbsolute(libraryPath: string) {
  const [notebook, ...parts] = libraryPath.split("/");
  return rawItemPath(notebook, parts);
}

function absolute(libraryPath: string) {
  const { notebook, pathParts } = splitFilePath(libraryPath);
  return filePathFromParts(notebook, pathParts);
}

const located = (item: MigrationItem, libraryPath: string) => item.kind === "other" ? rawAbsolute(libraryPath) : absolute(libraryPath);

/** A note's own `_assets` folders (uploads and images; Python figures and code). */
function ownedAssetDirectories(notePath: string) {
  const { notebook, pathParts } = splitFilePath(notePath);
  const python = splitFilePath(pythonSidecarPath(notePath));
  return [markdownAssetsDirectoryPathFromParts(notebook, pathParts), path.dirname(filePathFromParts(python.notebook, python.pathParts))];
}

/** Everything inside a hidden folder, without following links: what moving it really moves. */
async function summarize(directory: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  let entries: Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return { bytes, count }; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    count += 1;
    if (entry.isDirectory()) {
      const inner = await summarize(target);
      bytes += inner.bytes;
      count += inner.count;
    } else bytes += (await lstat(target).catch(() => null))?.size ?? 0;
  }
  return { bytes, count };
}

/** `base`: how many leading parts of `fromParts` are the folders the selected item was in (left out by a flat move). */
type Candidate = { fromParts: string[]; base: number; kind: "file" | "other"; fileType: string | null; identity: Identity; bytes: number; count?: number };

async function expandSelection(source: string, paths: string[]) {
  const linked = !!getLinkedFolder(source);
  const candidates = new Map<string, Candidate>();
  const folders: { parts: string[]; base: number }[] = [];
  const problems: string[] = [];
  let base = 0;
  const add = (fromParts: string[], candidate: Omit<Candidate, "fromParts" | "base">) => {
    if (!candidates.has(fromParts.join("/"))) candidates.set(fromParts.join("/"), { fromParts, base, ...candidate });
  };
  const walk = async (folderParts: string[]) => {
    folders.push({ parts: folderParts, base });
    let entries: Dirent[];
    try { entries = await readdir(rawItemPath(source, folderParts), { withFileTypes: true }); }
    catch { throw new StorageError(`${[source, ...folderParts].join("/")} could not be read.`, 409); }
    for (const entry of entries) {
      const parts = [...folderParts, entry.name];
      // Dirents never follow links: a link is moved as a link, never walked into.
      const stats = await lstat(rawItemPath(source, parts));
      const visible = isVisibleTreeEntry(entry.name, linked);
      if (visible && SPACED_NAME(entry.name) && (entry.isDirectory() || getFileType(entry.name))) {
        problems.push(`"${[source, ...parts].join("/")}" starts or ends with a space. Rename it before migrating.`);
      } else if (entry.isDirectory() && visible) await walk(parts);
      else if (entry.isFile() && visible && getFileType(entry.name)) add(parts, { kind: "file", fileType: getFileType(entry.name), identity: identityOf(stats), bytes: stats.size });
      else if (entry.isDirectory()) {
        const inner = await summarize(rawItemPath(source, parts));
        add(parts, { kind: "other", fileType: null, identity: identityOf(stats), bytes: inner.bytes, count: inner.count });
      } else add(parts, { kind: "other", fileType: null, identity: identityOf(stats), bytes: stats.size });
    }
  };
  for (const selected of [...new Set(paths)].sort()) {
    const parts = relativeParts(source, selected);
    if (parts[0].toLowerCase() === ARCHIVE_DIR) throw new StorageError("Archived files can't be migrated. Restore them first.", 400);
    await assertRealFolders(source, parts.slice(0, -1), "the migration");
    const stats = await lstatOrNull(itemPath(source, parts));
    if (!stats) throw new StorageError(`${selected} no longer exists. Review the selection again.`, 409);
    if (stats.isSymbolicLink()) throw new StorageError(`${selected} is a link, which can't be migrated.`, 400);
    base = parts.length - 1;
    if (stats.isDirectory()) await walk(parts);
    else if (stats.isFile() && getFileType(parts.at(-1) ?? "")) add(parts, { kind: "file", fileType: getFileType(parts.at(-1) ?? ""), identity: identityOf(stats), bytes: stats.size });
    else throw new StorageError(`${selected} can't be migrated.`, 400);
  }
  return { candidates: [...candidates.values()], folders, problems };
}

type PlanCore = Omit<MigrationPlan, "token" | "warnings" | "blockers">;

function token(plan: PlanCore, identities: ReadonlyMap<string, Identity>, create: MigrationDestination["create"] | undefined, warnings: MigrationWarning[]) {
  return createHash("sha256").update(JSON.stringify([
    plan.source,
    plan.destination,
    create ?? null,
    plan.folders,
    plan.items.map((item) => {
      const identity = identities.get(item.from);
      return [item.from, item.to, item.kind, identity?.ino, identity?.size, identity?.mtimeMs, item.size, item.count ?? null];
    }),
    // What the review showed: a link or LaTeX dependency that appeared since changes the token.
    warnings.map((warning) => [warning.kind, warning.paths]),
  ])).digest("hex").slice(0, 32);
}

/** Work in progress that a move would break, read from the job and recording files (nothing is resumed or cleaned up). */
async function workInProgressBlockers(source: string, folders: string[]) {
  const blockers: string[] = [];
  try {
    const file = JSON.parse(await readFile(referenceJobsFilePath(source), "utf8")) as { jobs?: { kind?: string; state?: string }[] };
    if ((file.jobs ?? []).some((job) => (job.state === "queued" || job.state === "running") && (job.kind === "resolve-pdfs" || job.kind === "resolve-paths"))) {
      blockers.push(`References are being looked up for PDFs in ${source}. Wait for it to finish, or cancel it in References.`);
    }
  } catch { /* No job state. */ }
  try {
    const { unfinishedRecordingDestinations } = await import("@/lib/recording/sessions");
    for (const recording of await unfinishedRecordingDestinations()) {
      if (folders.some((folder) => recording.directory === folder || recording.directory.startsWith(`${folder}/`))) {
        blockers.push(`The recording "${recording.name}" saves into ${recording.directory}. Finish or discard it first.`);
      }
    }
  } catch { /* Recording state unavailable. */ }
  return blockers;
}

async function realRoot(notebook: string) {
  return realpath(notebookPath(notebook)).catch(() => notebookPath(notebook));
}

async function buildPlan(request: MigrationRequest) {
  await ensureAdminRoot();
  if (!request || typeof request !== "object") throw new StorageError("Invalid migration request.", 400);
  const blockers: string[] = [];
  const source = assertSafeSegment(typeof request.source === "string" ? request.source : "", "Source notebook");
  const destinationName = assertSafeSegment(typeof request.destination?.notebook === "string" ? request.destination.notebook : "", "Destination notebook");
  const create = !!request.destination?.create;
  if (request.destination?.folder !== undefined && typeof request.destination.folder !== "string") throw new StorageError("Destination folder is invalid.", 400);
  const folderParts = (request.destination?.folder ?? "").split("/").filter(Boolean).map((part) => {
    if (SPACED_NAME(part)) throw new StorageError("Destination folder is invalid.", 400);
    return assertSafeUserSegment(part, "Destination folder");
  });
  if (!Array.isArray(request.paths) || !request.paths.length) throw new StorageError("Select at least one file.", 400);
  if (request.paths.some((value) => typeof value !== "string")) throw new StorageError("Paths must be library paths.", 400);
  if (folderParts[0]?.toLowerCase() === ARCHIVE_DIR) throw new StorageError("Files can't be migrated into the archive.", 400);

  // Notebooks only: never Libera's own folders (".libera"...).
  if (RESERVED_NOTEBOOK.test(source)) throw new StorageError("The source is not a notebook.", 400);
  if (RESERVED_NOTEBOOK.test(destinationName)) throw new StorageError("Notebook names can't start with \".\".", 400);
  // notebookPath throws for a linked folder that is not connected on this computer.
  const sourceRoot = await lstatOrNull(notebookPath(source));
  if (!sourceRoot?.isDirectory()) throw new StorageError("The source notebook was not found.", 404);
  if (!isLocalNotebook(source)) blockers.push(`${source} is a shared notebook. Migration only works between local notebooks.`);
  let destinationRoot: Stats | null = null;
  if (create) {
    if (getLinkedFolder(destinationName)) blockers.push("A linked folder already uses this name.");
    else if (await lstatOrNull(notebookPath(destinationName))) blockers.push(`A notebook named ${destinationName} already exists.`);
  } else {
    destinationRoot = await lstatOrNull(notebookPath(destinationName));
    if (!destinationRoot?.isDirectory()) throw new StorageError("The destination notebook was not found.", 404);
    if (!isLocalNotebook(destinationName)) blockers.push(`${destinationName} is a shared notebook. Migration only works between local notebooks.`);
    // The same folder under two names, or one notebook inside the other (linked folders).
    const [from, to] = await Promise.all([realRoot(source), realRoot(destinationName)]);
    if ((destinationRoot.dev === sourceRoot.dev && destinationRoot.ino === sourceRoot.ino) || from === to) blockers.push("Choose a different destination notebook.");
    else if (to.startsWith(`${from}${path.sep}`) || from.startsWith(`${to}${path.sep}`)) blockers.push(`${source} and ${destinationName} are folders inside one another, which migration can't move between.`);
    if (folderParts.length) {
      try {
        await assertRealFolders(destinationName, folderParts, "the migration");
        if (!(await lstatOrNull(itemPath(destinationName, folderParts)))?.isDirectory()) blockers.push("The destination folder was not found.");
      } catch (error) { blockers.push(error instanceof Error ? error.message : "The destination folder can't be used."); }
    }
  }
  if (destinationName === source) blockers.push("Choose a different destination notebook.");
  const { journals, unreadable } = await readJournals();
  if (journals.some((journal) => journal.state !== "done")) blockers.push("An earlier migration did not finish. Resume or stop it first.");
  if (unreadable.length) blockers.push(`An earlier migration's journal can't be read (${unreadable.join(", ")}). Set it aside in this dialog before migrating again.`);

  const { candidates, folders, problems } = await expandSelection(source, request.paths);
  blockers.push(...problems);
  if (!candidates.length && !folders.length) throw new StorageError("The selection has nothing to migrate.", 400);

  // Mirror the source layout under the destination folder; keep both on a
  // clash. A name is free only with no file, no sidecar data and no `_assets`
  // folder of a note at it, and files and folders share one namespace
  // (case-insensitively).
  const takenFiles = new Set<string>();
  const takenFolders = new Set<string>();
  const existence = new Map<string, Stats | null>();
  const existing = async (parts: string[]) => {
    const key = parts.join("/");
    if (!existence.has(key)) existence.set(key, create ? null : await lstatOrNull(rawItemPath(destinationName, parts)));
    return existence.get(key)!;
  };
  const createdFolders = new Set<string>();
  const reserveFolder = async (parts: string[]) => {
    for (let index = 1; index <= parts.length; index += 1) {
      const prefix = parts.slice(0, index);
      const libraryPath = [destinationName, ...prefix].join("/");
      if (takenFiles.has(libraryPath.toLowerCase())) blockers.push(`${libraryPath} would be both a file and a folder.`);
      if (takenFolders.has(libraryPath.toLowerCase())) continue;
      takenFolders.add(libraryPath.toLowerCase());
      const stats = await existing(prefix);
      if (!stats) createdFolders.add(libraryPath);
      else if (stats.isSymbolicLink()) blockers.push(`${libraryPath} is a link to another folder, so the migration can't go through it.`);
      else if (!stats.isDirectory()) blockers.push(`${libraryPath} is a file, so a folder can't be created there.`);
    }
  };

  const folderTargets: string[] = [];
  const flat = !!request.destination?.flat;
  const placed = (parts: string[], partsBase: number) => [...folderParts, ...(flat ? parts.slice(partsBase) : parts)];
  for (const { parts, base } of folders) {
    const target = placed(parts, base);
    await reserveFolder(target);
    folderTargets.push([destinationName, ...target].join("/"));
  }

  const items: JournalItem[] = [];
  const ordered = [...candidates].sort((a, b) => a.fromParts.join("/").localeCompare(b.fromParts.join("/")));
  for (const candidate of ordered) {
    const parent = placed(candidate.fromParts, candidate.base).slice(0, -1);
    const name = candidate.fromParts.at(-1)!;
    await reserveFolder(parent);
    let next = name;
    for (let index = 1; ; index += 1) {
      const target = [destinationName, ...parent, next].join("/");
      const key = target.toLowerCase();
      let clash = takenFiles.has(key) || takenFolders.has(key);
      if (!clash && !create) {
        clash = !!(await lstatOrNull(rawAbsolute(target)));
        if (!clash && candidate.kind === "file") clash = (await existingSidecars(destinationName, [...parent, next], candidate.fileType)).length > 0;
        if (!clash && candidate.fileType === "markdown") {
          for (const directory of ownedAssetDirectories(target)) if (await lstatOrNull(directory)) clash = true;
        }
      }
      if (!clash) { takenFiles.add(key); break; }
      next = withSuffix(name, index);
    }
    // macOS junk (.DS_Store, ._*) is not worth keeping twice.
    if (next !== name && candidate.kind === "other" && JUNK(name)) continue;
    const to = [destinationName, ...parent, next].join("/");
    items.push({
      from: [source, ...candidate.fromParts].join("/"),
      to,
      kind: candidate.kind,
      fileType: candidate.fileType,
      renamed: next !== name,
      size: candidate.bytes,
      ...(candidate.count !== undefined ? { count: candidate.count } : {}),
      identity: candidate.identity,
      ...(candidate.fileType === "markdown" ? { ownedDirectories: ownedAssetDirectories(to) } : {}),
    });
  }

  const fullFolders = folders
    .filter(({ parts }) => request.paths.includes([source, ...parts].join("/")))
    .map(({ parts, base }) => ({ from: [source, ...parts].join("/"), to: [destinationName, ...placed(parts, base)].join("/") }));

  const destinationDevice = destinationRoot?.dev ?? (await stat(path.dirname(notebookPath(destinationName)))).dev;
  const core: PlanCore = {
    source,
    destination: { notebook: destinationName, folder: folderParts.join("/"), create, ...(flat ? { flat } : {}) },
    items: items.map((item) => ({ from: item.from, to: item.to, kind: item.kind, fileType: item.fileType, renamed: item.renamed, size: item.size, ...(item.count !== undefined ? { count: item.count } : {}) })),
    folders: fullFolders,
    totalBytes: items.reduce((sum, item) => sum + item.size, 0),
    crossDevice: items.some((item) => item.identity.dev !== destinationDevice),
  };
  blockers.push(...await workInProgressBlockers(source, fullFolders.map((folder) => folder.from)));
  const identities = new Map(items.map((item) => [item.from, item.identity]));
  const warnings = await planWarnings(core);
  const plan: MigrationPlan = {
    ...core,
    token: token(core, identities, request.destination.create, warnings),
    warnings,
    blockers: [...new Set(blockers)],
  };
  return {
    plan,
    items,
    folderTargets,
    createdFolders: [...createdFolders],
    roots: { source: { dev: sourceRoot.dev, ino: sourceRoot.ino }, ...(destinationRoot ? { destination: { dev: destinationRoot.dev, ino: destinationRoot.ino } } : {}) },
  };
}

/** What a migration would do. */
export async function planMigration(request: MigrationRequest): Promise<MigrationPlan> {
  return (await buildPlan(request)).plan;
}

// ---- Warnings ----------------------------------------------------------------

async function planWarnings(plan: PlanCore): Promise<MigrationWarning[]> {
  const warnings: MigrationWarning[] = [];
  const files = plan.items.filter((item) => item.kind === "file");
  const moves = new Map(files.map((item) => [item.from, item.to]));
  const arriving = new Set(moves.values());

  const renamed = files.filter((item) => item.renamed);
  if (renamed.length) {
    warnings.push({ kind: "renamed", message: `${renamed.length} ${renamed.length === 1 ? "file has" : "files have"} the same name as a file in the destination and will be renamed to keep both.`, paths: renamed.map((item) => `${item.from} → ${item.to}`) });
  }
  if (plan.crossDevice) {
    warnings.push({ kind: "cross-device", message: "The notebooks are on different drives, so files are copied and then removed from the source. Their creation dates are not kept.", paths: [] });
  }

  // Markdown links are not rewritten when files move (docs/features/related-notebooks.md).
  try {
    const disk = fileExistence();
    const check = disk.check;
    const before = disk.exists;
    const after = (candidate: string) => arriving.has(candidate) || (!moves.has(candidate) && before(candidate));

    // Notes that stay and link to a file that moves.
    const inbound = new Set<string>();
    for (const notebook of await libraryNotebookNames()) {
      for (const [notePath, hrefs] of Object.entries(await readNotebookLinkIndex(notebook))) {
        if (moves.has(notePath)) continue;
        for (const href of hrefs) {
          const candidates = linkCandidates(href, notePath);
          if (!candidates.some((candidate) => moves.has(candidate))) continue;
          await check(candidates);
          const target = resolveLinkWith(href, notePath, before);
          if (target && target !== notePath && moves.has(target)) inbound.add(notePath);
        }
      }
    }
    // Moving notes whose links resolve elsewhere from their new place (both ends moving included).
    const outbound = new Set<string>();
    for (const note of files.filter((item) => item.fileType === "markdown")) {
      let content: string;
      try { content = await readFile(absolute(note.from), "utf8"); } catch { continue; }
      for (const href of extractNotebookLinkDestinations(content)) {
        await check([...linkCandidates(href, note.from), ...linkCandidates(href, note.to)]);
        const target = resolveLinkWith(href, note.from, before);
        if (!target || target === note.from) continue;
        const expected = moves.get(target) ?? target;
        if (resolveLinkWith(href, note.to, after) !== expected) outbound.add(note.from);
      }
    }
    // Notes that stay and show a moving image by its library address (`/api/files/raw/...`): the link index leaves embeds out.
    const showing = new Set<string>();
    const { documents } = await readMarkdownAssetDocuments(plan.source);
    for (const note of documents) {
      if (moves.has(note.documentPath)) continue;
      if (markdownImageTargets(note.documentPath, note.content).some((target) => target.libraryPath && moves.has(target.libraryPath))) showing.add(note.documentPath);
    }
    if (showing.size) warnings.push({ kind: "inbound-images", message: `${showing.size} ${showing.size === 1 ? "note that stays shows" : "notes that stay show"} images you are moving. Those images will no longer show there.`, paths: [...showing].sort() });
    if (inbound.size) warnings.push({ kind: "inbound-links", message: `${inbound.size} ${inbound.size === 1 ? "note links" : "notes link"} to files you are moving. Those links will stop working.`, paths: [...inbound].sort() });
    if (outbound.size) warnings.push({ kind: "outbound-links", message: `${outbound.size} moving ${outbound.size === 1 ? "note has links" : "notes have links"} that will no longer find their file from the new place.`, paths: [...outbound].sort() });
  } catch (error) {
    console.error("[migration] Could not check links:", error);
  }

  try {
    const { files: sourceFiles, truncated } = await listVisibleNotebookFiles(plan.source);
    const { dependencies, mainFiles, incomplete } = await latexDependencies(plan.source, sourceFiles);
    const leftBehind = new Set<string>();
    const lost = new Set<string>();
    for (const [file, needs] of dependencies) {
      for (const needed of needs) {
        if (moves.has(file) && !moves.has(needed)) leftBehind.add(needed);
        if (!moves.has(file) && moves.has(needed)) lost.add(file);
      }
      // A chapter that moves without its main file can't be typeset there.
      if (moves.has(file)) for (const main of mainFiles.get(file) ?? []) if (main !== file && !moves.has(main)) leftBehind.add(main);
    }
    if (leftBehind.size) warnings.push({ kind: "latex-left-behind", message: `Moving LaTeX files use ${leftBehind.size} ${leftBehind.size === 1 ? "file" : "files"} that you are not moving. Add them to keep the project compiling.`, paths: [...leftBehind].sort() });
    if (lost.size) warnings.push({ kind: "latex-includes-moving", message: `${lost.size} LaTeX ${lost.size === 1 ? "file that stays uses" : "files that stay use"} files you are moving.`, paths: [...lost].sort() });
    if (incomplete || truncated) warnings.push({ kind: "latex-incomplete", message: `${plan.source} has more or larger LaTeX sources than the check reads, so LaTeX dependencies may be missing from this review.`, paths: [] });
  } catch (error) {
    console.error("[migration] Could not check LaTeX projects:", error);
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

const hashText = (text: string) => createHash("sha256").update(text).digest("hex");

/** Beside the destination, so publishing it is a link on the same drive; hidden from the tree. */
function stagedPath(journal: Journal, index: number, item: JournalItem) {
  return path.join(path.dirname(located(item, item.to)), `.libera-migrating-${journal.id}-${index}`);
}

/** Keep a copy's dates: on macOS, setting a modification time before the creation time moves the creation time back too. */
async function keepDates(target: string, identity: Identity, birthtime: Date) {
  const modified = new Date(identity.mtimeMs);
  await utimes(target, modified, birthtime).catch(() => undefined);
  await utimes(target, modified, modified).catch(() => undefined);
}

async function stageItem(journal: Journal, index: number, item: JournalItem, batch: MarkdownAssetBatch) {
  const destinationDirectory = path.dirname(located(item, item.to));
  await mkdir(destinationDirectory, { recursive: true });
  const sameDevice = (await stat(destinationDirectory)).dev === item.identity.dev;
  if (item.kind === "other") { item.method = sameDevice || item.identity.directory ? "rename" : "copy"; return; }
  const from = splitFilePath(item.from);
  if (item.fileType === "pdf") await migratePdfAnnotations(from.notebook, from.pathParts);
  if (item.fileType === "image") await migrateImageAnnotations(from.notebook, from.pathParts);
  item.method = sameDevice ? "link" : "copy";
  if (item.fileType !== "markdown") return;

  const source = absolute(item.from);
  const previous = await readFile(source, "utf8");
  const images = await copyMarkdownImageAssets(item.from, item.to, previous, true, batch);
  try {
    if (await readFile(source, "utf8") !== previous) throw new StorageError(`${item.from} changed while it was being prepared. Try again.`, 409);
    item.images = { created: images.created, imageSources: images.imageSources, before: hashText(previous), after: hashText(images.content) };
    if (images.content === previous) return;
    // The rewritten note is written in full before anything moves.
    const staged = stagedPath(journal, index, item);
    const temporary = `${staged}.tmp`;
    await writeFile(temporary, images.content, "utf8");
    await keepDates(temporary, item.identity, (await stat(source)).birthtime);
    await rename(temporary, staged);
    item.method = "staged";
  } catch (error) {
    await images.discard();
    delete item.images;
    throw error;
  }
}

/** Undo staging: staged notes and copied images. The source was never touched. */
/** Undo one item's staging: its staged note, and the `_assets` folders it owns (new with the migration). */
async function discardItem(journal: Journal, index: number, item: JournalItem) {
  await rm(stagedPath(journal, index, item), { force: true, recursive: true }).catch(() => undefined);
  await rm(`${stagedPath(journal, index, item)}.tmp`, { force: true }).catch(() => undefined);
  for (const created of item.images?.created ?? []) await rm(created, { force: true }).catch(() => undefined);
  const assets = path.join(notebookPath(item.to.split("/")[0]), MARKDOWN_ASSETS_DIR);
  for (const directory of item.ownedDirectories ?? []) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    // Parents left empty, up to and including `_assets`.
    for (let parent = path.dirname(directory); parent.startsWith(assets); parent = path.dirname(parent)) {
      if (!(await rmdir(parent).then(() => true, () => false))) break;
    }
  }
  delete item.images;
  delete item.method;
}

/** Undo staging: staged notes, copied images, and the folders it made. The source was never touched. */
async function discardStaging(journal: Journal) {
  for (const [index, item] of journal.items.entries()) await discardItem(journal, index, item);
  // Folders that did not exist when planned, deepest first, when nothing else went into them.
  for (const folder of [...journal.createdFolders].sort((a, b) => b.length - a.length)) {
    await rmdir(rawAbsolute(folder)).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

type ItemState = "pending" | "published" | "finished";

const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV", "EMLINK"]);

/** Publish `from` at `to` without ever replacing what is there. Returns false when it had to rename instead (no hard links). */
async function publish(from: string, to: string) {
  try {
    await link(from, to);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") throw new StorageError(`${to} appeared while migrating. Nothing was replaced; review the migration again.`, 409);
    if (!NO_HARD_LINKS.has(code)) throw error;
  }
  if (await lstatOrNull(to)) throw new StorageError(`${to} appeared while migrating. Nothing was replaced; review the migration again.`, 409);
  await rename(from, to);
  return false;
}

/** The destination holds this migration's file: checked by identity, never assumed from a name. */
async function isOurs(journal: Journal, index: number, item: JournalItem, destination: Stats, staged: Stats | null, source: Stats | null) {
  if (item.method === "link" || item.method === "rename") {
    if (destination.dev === item.identity.dev && destination.ino === item.identity.ino) return true;
    // A folder copied from another drive (`rename` of a folder across drives is a copy).
    return item.identity.directory && !source && !staged && destination.isDirectory();
  }
  if (staged) return staged.dev === destination.dev && staged.ino === destination.ino;
  if (item.method === "staged") {
    const text = await readFile(located(item, item.to), "utf8").catch(() => null);
    return text !== null && hashText(text) === item.images?.after;
  }
  return !item.identity.directory && destination.size === item.identity.size;
}

/** Where the item is, from the disk. Throws when the disk does not match the migration (an unrelated file, a missing one). */
async function reconcile(journal: Journal, index: number, item: JournalItem): Promise<ItemState> {
  const [source, destination, staged] = await Promise.all([
    lstatOrNull(located(item, item.from)),
    lstatOrNull(located(item, item.to)),
    lstatOrNull(stagedPath(journal, index, item)),
  ]);
  if (destination) {
    if (!(await isOurs(journal, index, item, destination, staged, source))) {
      throw new StorageError(`${item.to} is not the file this migration moved there. Nothing was replaced or removed; check it and resume.`, 409);
    }
    return "published";
  }
  if (!source) throw new StorageError(`${item.from} is missing, so it can't be moved. Check it and resume.`, 409);
  return "pending";
}

function sameSource(item: JournalItem, stats: Stats) {
  return stats.dev === item.identity.dev && stats.ino === item.identity.ino &&
    (item.identity.directory || (stats.size === item.identity.size && stats.mtimeMs === item.identity.mtimeMs));
}

/** Remove the source once the destination holds the file (and the staged copy, which is the destination's other name). */
async function retireSource(journal: Journal, index: number, item: JournalItem) {
  const staged = stagedPath(journal, index, item);
  await rm(staged, { force: true, recursive: true });
  const source = located(item, item.from);
  const stats = await lstatOrNull(source);
  if (!stats) return;
  if (stats.dev !== item.identity.dev || stats.ino !== item.identity.ino) {
    throw new StorageError(`${item.from} changed while migrating. Both copies were kept; check them and resume.`, 409);
  }
  await rm(source, { force: true, recursive: item.identity.directory });
}

/** The file (or hidden entry) itself. */
async function commit(journal: Journal, index: number, item: JournalItem) {
  const source = located(item, item.from);
  const destination = located(item, item.to);
  const staged = stagedPath(journal, index, item);
  const sourceStats = await lstat(source);
  if (!sameSource(item, sourceStats)) throw new StorageError(`${item.from} changed since the migration was reviewed. Review it again.`, 409);
  await mkdir(path.dirname(destination), { recursive: true });
  switch (item.method) {
    case "link":
      // Same inode under the new name, so its dates and identity stay.
      if (!(await publish(source, destination))) return;
      break;
    case "rename":
      if (await lstatOrNull(destination)) throw new StorageError(`${item.to} appeared while migrating. Nothing was replaced; review the migration again.`, 409);
      if ((await stat(path.dirname(destination))).dev === item.identity.dev) {
        await rename(source, destination);
        return;
      }
      // A hidden folder on another drive: copied to its staged name first, then renamed into place.
      await rm(staged, { force: true, recursive: true });
      await cp(source, staged, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
      await rename(staged, destination);
      break;
    case "staged":
      if (!(await lstatOrNull(staged))) throw new StorageError(`The prepared copy of ${item.from} is missing. Stop this migration and review it again.`, 409);
      await publish(staged, destination);
      break;
    case "copy": {
      await rm(staged, { force: true });
      await copyFile(source, staged);
      if ((await stat(staged)).size !== item.identity.size) throw new StorageError(`${item.from} could not be copied completely.`, 409);
      await keepDates(staged, item.identity, sourceStats.birthtime);
      await publish(staged, destination);
      break;
    }
    default:
      throw new StorageError(`${item.from} was not prepared. Stop this migration and review it again.`, 409);
  }
  injectFault?.(`published:${item.from}`);
  await retireSource(journal, index, item);
}

/** A note's image rewrites, as applied to its text: for review baselines and undo history. */
function imageTransform(item: JournalItem) {
  const sources = item.images?.imageSources ?? {};
  return Object.keys(sources).length ? (text: string) => rewriteMarkdownImageSources(text, sources) : (text: string) => text;
}

async function moveItem(journal: Journal, index: number, item: JournalItem, state: ItemState): Promise<ItemState> {
  if (state === "pending") {
    if (item.kind === "file") await withMovedReview(item.from, item.to, imageTransform(item), () => commit(journal, index, item));
    else await commit(journal, index, item);
    state = "published";
  } else {
    // Published by an earlier run that stopped before the source or review followed.
    await retireSource(journal, index, item);
    if (item.kind === "file") await withMovedReview(item.from, item.to, imageTransform(item), async () => undefined);
  }
  if (item.kind === "file") {
    const from = splitFilePath(item.from);
    const to = splitFilePath(item.to);
    const fileType = item.fileType ?? "";
    await moveFileSidecars(from.notebook, from.pathParts, to.notebook, to.pathParts, fileType, fileType);
  }
  return "finished";
}

// ---------------------------------------------------------------------------
// Finalizing
// ---------------------------------------------------------------------------

/** Empty folders left in the source after their content moved, deepest first. */
async function removeEmptyDirectories(directory: string) {
  let entries: Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name));
    // Finder recreates .DS_Store as folders empty out; it never keeps a folder alive.
    else if (JUNK(entry.name)) await rm(path.join(directory, entry.name), { force: true });
  }
  await rmdir(directory).catch(() => undefined);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A step runs once: a step that started and did not end (an interruption) is reported instead of run again. */
async function step(journal: Journal, name: FinalizeStep, run: () => Promise<void>) {
  if (journal.finalized.includes(name)) return;
  if (journal.finalizing === name) {
    journal.bookkeeping.push(`The step "${name}" was interrupted and was not run again; check it by hand.`);
  } else {
    journal.finalizing = name;
    await saveJournal(journal);
    injectFault?.(`finalize:${name}`);
    try { await run(); }
    catch (error) {
      journal.bookkeeping.push(`${name}: ${errorText(error)}`);
      console.error(`[migration] Finalize step ${name} failed:`, error);
    }
  }
  journal.finalized.push(name);
  delete journal.finalizing;
}

async function finalize(journal: Journal, states: ItemState[]) {
  journal.state = "finalizing";
  journal.phase = "finalizing";
  const files = journal.items.filter((item, index) => item.kind === "file" && states[index] === "finished");
  const moves = new Map(files.map((item) => [item.from, item.to]));

  await step(journal, "folders", async () => {
    const finished: { from: string; to: string }[] = [];
    for (const folder of [...journal.folders].sort((a, b) => b.from.length - a.from.length)) {
      if (journal.items.some((item, index) => states[index] !== "finished" && item.from.startsWith(`${folder.from}/`))) continue;
      const [notebook, ...parts] = folder.from.split("/");
      await removeEmptyDirectories(itemPath(notebook, parts));
      for (const kind of SIDECAR_KINDS) await removeEmptyDirectories(kind.directoryPath(notebook, parts));
      // Content that arrived after the plan stays, and so does the folder's identity.
      if (await lstatOrNull(itemPath(notebook, parts))) {
        journal.bookkeeping.push(`${folder.from} received new content during the migration; it stays in ${journal.source}.`);
        continue;
      }
      finished.push(folder);
    }
    journal.finishedFolders = finished;
  });

  await step(journal, "records", async () => {
    await moveReviewPaths(moves);
    await renameFileMetadataPaths(moves);
    for (const folder of journal.finishedFolders ?? []) {
      await renameNotebookPanelExpandedPathPrefix(folder.from, folder.to);
      await renameFileMetadataPathPrefix(folder.from, folder.to);
    }
  });

  await step(journal, "assets", async () => {
    // The moved notes' images and uploads, written as embeds for the cleanup scan; images other notes use stay.
    const notes = files.filter((item) => item.images).map((item) => ({ documentPath: item.from, content: Object.keys(item.images!.imageSources).map((source) => `![](<${source}>)`).join("\n") }));
    if (notes.length) await cleanupMarkdownImageAssets(journal.source, notes);
  });

  await step(journal, "attachments", async () => {
    const { changed, failures } = await moveReferenceAttachmentsBatch(moves);
    for (const failure of failures) journal.bookkeeping.push(`Reference attachments in ${failure.notebook || "a library"} still point at the old paths: ${errorText(failure.error)}`);
    // Open References panels of the libraries that changed reload (one event per library, not per file).
    for (const notebook of changed) {
      try { publishReferenceEvent({ type: "library", notebook, revision: (await readReferenceLibrary(notebook)).revision }); }
      catch { /* The panel catches up when it next loads. */ }
    }
  });

  await step(journal, "tether", async () => {
    // A tethered .bib file among the moved files follows, in one pass.
    for (const failure of await moveTetheredFilesBatch(moves)) {
      journal.bookkeeping.push(`The tethered .bib file of ${failure.notebook} could not follow its move: ${errorText(failure.error)}`);
    }
  });

  await step(journal, "references", async () => {
    // References cited by notes follow them. LaTeX sources are never
    // rewritten by reference features, so they are left out, as they are
    // for single moves (references-moves.test.ts).
    const citing = files.filter((item) => item.fileType === "markdown").map((item) => ({ from: item.from, to: item.to }));
    journal.references = citing.length ? await copyReferencesOnMove(journal.source, journal.destination.notebook, citing) : null;
    if (journal.references?.error) journal.bookkeeping.push(`Cited references: ${journal.references.error}`);
  });

  await step(journal, "history", async () => {
    // Pending agent reviews and undo history see the files as the migration left them.
    const keyMaps = new Map((journal.references?.drafts ?? []).map((draft) => [draft.path, new Map(Object.entries(draft.map))]));
    const baselines = new Map<string, (text: string) => string>();
    const undo = new Map<string, MovedRunFile>();
    for (const item of files) {
      const images = imageTransform(item);
      const keys = keyMaps.get(item.to);
      const transform = keys ? (text: string) => rewriteCitationKeys(images(text), keys).text : images;
      if (keys) baselines.set(item.to, (text) => rewriteCitationKeys(text, keys).text);
      let hashes: MovedRunFile["hashes"];
      if (item.images && (keys || item.images.before !== item.images.after)) {
        const now = await readFile(absolute(item.to), "utf8").catch(() => null);
        if (now !== null) hashes = { before: item.images.before, after: hashText(now) };
      }
      undo.set(item.from, { to: item.to, ...(item.images || keys ? { transform } : {}), ...(hashes ? { hashes } : {}) });
    }
    await transformReviewBaselines(baselines);
    await recordMovedRunFiles(undo);
  });

  await step(journal, "entries", async () => {
    // A moved PDF's reference entry is copied into the destination library; other PDFs may get one automatically.
    const pdfs = new Set(files.filter((item) => item.fileType === "pdf").map((item) => item.to));
    const entries: MigrationResult["referenceEntries"] = { copied: 0, reused: 0 };
    journal.referenceEntries = entries;
    if (!pdfs.size) return;
    try {
      const library = await readReferenceLibrary(journal.source);
      const attached = new Set<string>();
      const keys: string[] = [];
      for (const entry of Object.values(library.entries)) {
        const paths = entry.attachments.flatMap((attachment) => attachment.kind === "url" ? [] : [attachment.path]).filter((value) => pdfs.has(value));
        if (!paths.length) continue;
        keys.push(entry.key);
        for (const value of paths) attached.add(value);
      }
      if (keys.length) {
        const copy = await copyReferenceEntries(journal.source, journal.destination.notebook, keys);
        entries.copied = copy.copied.length;
        entries.reused = copy.reused.length;
      }
      notifyReferenceFilesAdded([...pdfs].filter((value) => !attached.has(value)));
    } catch (error) {
      entries.error = errorText(error);
    }
  });

  await step(journal, "notify", async () => {
    notifySearchChanges([...moves.keys(), ...moves.values()]);
  });

  journal.state = "done";
  journal.result = await resultOf(journal, states);
  await saveJournal(journal);
}

async function resultOf(journal: Journal, states: ItemState[]): Promise<MigrationResult> {
  const moved: MigrationMove[] = [];
  const remaining: string[] = [];
  journal.items.forEach((item, index) => {
    if (item.kind !== "file") return;
    if (states[index] === "pending") { remaining.push(item.from); return; }
    moved.push({
      from: item.from,
      to: item.to,
      fileType: item.fileType,
      ...(item.images && Object.keys(item.images.imageSources).length ? { imageSources: item.images.imageSources } : {}),
      ...(states[index] === "published" ? { incomplete: true } : {}),
    });
  });

  // What the final check can say: nothing of a moved item left at its old
  // path (the item itself, a sidecar), and no prepared copy left anywhere.
  // The notebook check's definition of "nothing left" (storage/integrity.ts).
  let leftovers: string[] = [];
  let unverified = false;
  if (journal.state === "done") {
    const places: Parameters<typeof checkNothingLeftAt>[0] = [];
    for (const [index, item] of journal.items.entries()) {
      try {
        places.push({ label: `${item.to} (prepared copy)`, absolutePath: stagedPath(journal, index, item) });
        if (states[index] === "pending") continue;
        places.push({ label: item.from, absolutePath: located(item, item.from), ...(item.kind === "file" ? { libraryPath: item.from, fileType: item.fileType } : {}) });
      } catch (error) {
        unverified = true;
        leftovers.push(`${item.from} (could not be checked: ${errorText(error)})`);
      }
    }
    const check = await checkNothingLeftAt(places);
    leftovers = [...leftovers, ...check.leftovers];
    unverified ||= check.unverified;
  }
  const check: MigrationResult["check"] = journal.state !== "done" ? "incomplete" : unverified ? "unverified"
    : remaining.length || leftovers.length || moved.some((move) => move.incomplete) ? "incomplete" : "clean";

  return {
    id: journal.id,
    state: journal.state === "done" ? "done" : "interrupted",
    source: journal.source,
    destination: journal.destination.notebook,
    createdNotebook: journal.createdNotebook,
    moved,
    remaining,
    folders: journal.finishedFolders ?? [],
    references: journal.references ?? null,
    referenceEntries: journal.referenceEntries ?? { copied: 0, reused: 0 },
    bookkeeping: journal.bookkeeping,
    leftovers,
    check,
    ...(journal.createdNotebook && journal.create && journal.create.workspaceGroupId !== undefined
      ? { workspaceGroup: { notebook: journal.destination.notebook, groupId: journal.create.workspaceGroupId } } : {}),
    ...(journal.error ? { error: journal.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Run and resume
// ---------------------------------------------------------------------------

/** A notebook made for this migration that nothing else wrote into: only its metadata and Libera's own empty or index files. */
async function untouched(notebook: string) {
  const root = notebookPath(notebook);
  let entries: string[];
  try { entries = await readdir(root); } catch { return false; }
  if (entries.some((name) => name !== ".libera-notebook.json" && name !== ".libera" && name !== MARKDOWN_ASSETS_DIR && name !== INK_DIR)) return false;
  const onlyIndexes = async (directory: string): Promise<boolean> => {
    let children: Dirent[];
    try { children = await readdir(directory, { withFileTypes: true }); } catch { return true; }
    for (const child of children) {
      if (child.isDirectory()) { if (!(await onlyIndexes(path.join(directory, child.name)))) return false; }
      else if (!["notebook-links.json", "citations.json", ".DS_Store"].includes(child.name)) return false;
    }
    return true;
  };
  for (const name of [".libera", MARKDOWN_ASSETS_DIR, INK_DIR]) if (!(await onlyIndexes(path.join(root, name)))) return false;
  return true;
}

async function interrupt(journal: Journal, error: unknown) {
  journal.state = "interrupted";
  journal.error = errorText(error);
  console.error("[migration] Stopped:", error);
  await saveJournal(journal);
}

/** Moving and finalizing. `continueRemaining` false (Stop): files not moved yet stay, and what moved is finished. */
async function runMoving(journal: Journal, continueRemaining: boolean): Promise<MigrationResult> {
  const states: ItemState[] = [];
  // Images and other files first, notes last: a note never points at an image that has not arrived.
  const order = journal.items.map((item, index) => ({ item, index })).sort((a, b) => Number(a.item.fileType === "markdown") - Number(b.item.fileType === "markdown"));
  try {
    for (const [index, item] of journal.items.entries()) {
      try { states[index] = await reconcile(journal, index, item); }
      catch (error) {
        // Stop never gets stuck on a file it can't account for: that file is left alone and reported.
        if (continueRemaining) throw error;
        states[index] = "pending";
        journal.bookkeeping.push(errorText(error));
      }
    }
    journal.state = "moving";
    journal.phase = "moving";
    delete journal.error;
    await saveJournal(journal);
    for (const { item, index } of order) {
      if (states[index] === "pending" && !continueRemaining) {
        await discardItem(journal, index, item);
        continue;
      }
      states[index] = await moveItem(journal, index, item, states[index]);
    }
  } catch (error) {
    // Where each unfinished file is now comes from the disk: the one that failed may already be published.
    for (const [index, item] of journal.items.entries()) {
      if (states[index] !== "finished") states[index] = await reconcile(journal, index, item).catch(() => "pending" as const);
    }
    journal.error = errorText(error);
    journal.result = await resultOf({ ...journal, state: "interrupted" }, states);
    await interrupt(journal, error);
    return journal.result;
  }
  await finalize(journal, states);
  return journal.result!;
}

async function rollBackCreatedNotebook(journal: Journal) {
  if (!journal.createdNotebook) return;
  try {
    if (await untouched(journal.destination.notebook)) await deleteNotebook(journal.destination.notebook);
  } catch (error) { console.error("[migration] Could not remove the empty notebook:", error); }
}

/**
 * Carry out a migration. `token` is the plan's token as shown to the user:
 * when the notebooks changed since, nothing moves and the dialog shows the new plan.
 */
export async function runMigration(request: MigrationRequest, expectedToken: string): Promise<MigrationResult> {
  if (typeof expectedToken !== "string") throw new StorageError("Invalid migration request.", 400);
  return exclusively(async () => {
    const { plan, items, roots, folderTargets, createdFolders } = await buildPlan(request);
    if (plan.blockers.length) throw new StorageError(plan.blockers[0], 409);
    if (plan.token !== expectedToken) throw new StorageError("The notebooks changed since this migration was reviewed. Review it again.", 409);

    const now = new Date().toISOString();
    const journal: Journal = {
      version: 2,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      state: "staging",
      phase: "staging",
      source: plan.source,
      destination: { notebook: plan.destination.notebook, folder: plan.destination.folder },
      create: plan.destination.create ? { ...(request.destination.create ?? {}) } : null,
      createdNotebook: plan.destination.create,
      roots,
      items,
      folders: plan.folders,
      folderTargets,
      createdFolders,
      finalized: [],
      bookkeeping: [],
    };
    // The intent is recorded before anything is created.
    await saveJournal(journal);

    const batch: MarkdownAssetBatch = { moved: new Map(items.filter((item) => item.kind === "file").map((item) => [item.from, item.to])), copied: new Map() };
    try {
      if (journal.create) {
        const create = journal.create;
        await createNotebook(plan.destination.notebook, { color: create.color, emoji: create.emoji, groupId: create.groupId ?? null });
        const created = await stat(notebookPath(plan.destination.notebook));
        journal.roots.destination = { dev: created.dev, ino: created.ino };
      }
      // Selected folders are recreated, empty ones included.
      for (const folder of journal.folderTargets) await mkdir(rawAbsolute(folder), { recursive: true });
      for (const [index, item] of journal.items.entries()) {
        await stageItem(journal, index, item, batch);
        injectFault?.(`staged:${item.from}`);
      }
    } catch (error) {
      if ((error as { crash?: boolean }).crash) throw error;
      // Nothing in the source changed: undo staging and forget the migration.
      await discardStaging(journal);
      await rollBackCreatedNotebook(journal);
      await removeJournal(journal.id);
      throw error;
    }
    // Every rewrite map is on disk before the first file moves.
    journal.state = "moving";
    journal.phase = "moving";
    await saveJournal(journal);
    return runMoving(journal, true);
  });
}

/** Before resuming: the notebooks are still the local folders the migration started with, and nothing blocks it. */
async function assertResumable(journal: Journal) {
  const check = async (name: string, recorded: RootIdentity | undefined) => {
    if (!isLocalNotebook(name)) throw new StorageError(`${name} is a shared notebook now, so the migration can't continue. Stop sharing it, or move the files back by hand.`, 409);
    const stats = await lstatOrNull(notebookPath(name));
    if (!stats?.isDirectory()) throw new StorageError(`${name} is not available on this computer. Reconnect it and resume.`, 409);
    if (recorded && (stats.dev !== recorded.dev || stats.ino !== recorded.ino)) throw new StorageError(`${name} is not the folder the migration started with (a linked folder was reconnected elsewhere?). Check it before resuming.`, 409);
  };
  await check(journal.source, journal.roots.source);
  if (journal.phase !== "staging" || !journal.createdNotebook) await check(journal.destination.notebook, journal.roots.destination);
  const blockers = await workInProgressBlockers(journal.source, journal.folders.map((folder) => folder.from));
  if (blockers.length) throw new StorageError(blockers[0], 409);
}

/**
 * An interrupted migration: `continue` moves the rest, `stop` finishes only
 * what had already moved and leaves the rest in the source.
 */
export async function resumeMigration(id: string, mode: "continue" | "stop"): Promise<MigrationResult> {
  return exclusively(async () => {
    const journal = await readJournal(id);
    if (journal.state === "done") throw new StorageError("This migration already finished.", 409);
    await assertResumable(journal);

    if (journal.phase === "staging") {
      // It stopped before any file moved: undo staging, either way.
      await discardStaging(journal);
      await rollBackCreatedNotebook(journal);
      journal.state = "done";
      journal.result = await resultOf(journal, journal.items.map(() => "pending"));
      journal.result.error = "The migration stopped before moving any file. Review it again to migrate.";
      await saveJournal(journal);
      return journal.result;
    }

    if (journal.phase === "finalizing") {
      const states: ItemState[] = [];
      for (const [index, item] of journal.items.entries()) {
        const state = await reconcile(journal, index, item);
        states[index] = state === "published" ? "finished" : "pending";
      }
      await finalize(journal, states);
      return journal.result!;
    }

    return runMoving(journal, mode === "continue");
  });
}
