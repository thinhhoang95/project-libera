import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent, type Stats } from "node:fs";
import { copyFile, cp, link, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { transformReviewBaselines, withMovedReview } from "@/lib/agent/review-store";
import { recordMovedRunFiles, type MovedRunFile } from "@/lib/agent/snapshots";
import { isSharedNotebookPath, sharedNotebookMarker } from "@/lib/collab/shared-notebook";
import { latexDependencies } from "@/lib/latex/dependencies";
import { isSlideChartDataFile, parseSlideChartSpec, resolveDeckRelativePath, slideChartBlocks } from "@/lib/slide-charts";
import { pythonSidecarPath } from "@/lib/python/sidecar";
import { moveTetheredFilesBatch } from "@/lib/references/bib-tether";
import { publishReferenceEvent } from "@/lib/references/library-events";
import { rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { rewriteCitationKeys } from "@/lib/references/citation-syntax";
import { isLatexCitingPath, latexCitedKeys } from "@/lib/references/latex-cite-syntax";
import { copyReferenceEntries } from "@/lib/references/copy-entries";
import { notifyReferenceFilesAdded, referenceJobsFilePath } from "@/lib/references/jobs";
import { applyCitationRewrites, copyReferencesOnMove, type PlannedCitationRewrite, type ReferenceMoveResult } from "@/lib/references/moves";
import { migrateImageAnnotations, migratePdfAnnotations } from "@/lib/storage/annotations";
import { ARCHIVE_DIR, IGNORED_DOWNLOAD_ENTRIES, INK_DIR, MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import { DestinationTakenError, movePathExclusive } from "../../../electron/collab/notebooks/fs-ops";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { writeJsonAtomically } from "@/lib/storage/fs-utils";
import { cleanupMarkdownImageAssets, copyMarkdownImageAssets, markdownImageTargets, readMarkdownAssetDocuments, type MarkdownAssetBatch } from "@/lib/storage/markdown-assets";
import { moveReviewPaths } from "@/lib/storage/markdown-reviews";
import { destinationRecords } from "@/lib/storage/destination-records";
import { checkNothingLeftAt } from "@/lib/storage/integrity";
import { claimNotebooksForMigration, migrationJournalDirectory, migrationJournalsChanged } from "@/lib/storage/migration-fence";
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
  withReadOnlyStorage,
} from "@/lib/storage/paths";
import { inspectReferenceLibrary, moveReferenceAttachmentsBatch, readReferenceLibrary } from "@/lib/storage/references";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { existingSidecars, moveFileSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { fileExistence, libraryNotebookNames, linkCandidates, readNotebookLinkIndex, resolveLinkWith } from "@/lib/storage/library-links";
import { extractNotebookLinkDestinations } from "@/lib/storage/notebook-links";
import { isVisibleTreeEntry, listVisibleNotebookFiles } from "@/lib/storage/tree";
import { renameFileMetadataPathPrefix, renameFileMetadataPaths, renameNotebookPanelExpandedPathPrefix } from "@/lib/storage/workspace-metadata";
import type { LiberaLinkRewrites, LiberaNotebookMetadata } from "@/lib/types";
import { applyMovedLinks, followLinkRewrites, planMovedLinks, type AppliedLinkRewrite, type PathMove, type PlannedLinkRewrite } from "@/lib/storage/move-links";
import { rewriteMovedPaths } from "@/lib/move-rewrites";

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
//             The journal is saved before each item's first write (proof of
//             what staging owns), then once more with every rewrite map. A
//             PDF's or image's old annotation layout is upgraded in the
//             source here, in place: the same data, which cancelling keeps.
//   moving    Each file is published without ever replacing anything: a hard
//             link (same inode, so its dates are kept) from the source, or
//             from its staged copy; only then is the source removed. Its
//             pending agent review is moved under lock before it, and its
//             sidecars right after. The journal is not written per file: on
//             resume, where each file is comes from the disk, checked
//             against the identity recorded in the plan.
//   finalizing  One pass each, the journal recording each step as it ends:
//             folders, stars/tags/reviews, images, reference attachments,
//             paths in notes (move-links.ts, with the committed mapping),
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

export type MigrationWarningKind = "renamed" | "inbound-links" | "inbound-images" | "outbound-links" | "latex-left-behind" | "latex-includes-moving" | "latex-incomplete" | "latex-shadowed" | "latex-citations" | "renamed-records" | "cross-device";

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
  /**
   * Staging began on this item (saved before its first write, after checking
   * that its owned directories did not exist yet): only then is anything under
   * `ownedDirectories` this migration's to remove.
   */
  stagingBegan?: boolean;
  /**
   * Image files staging created, saved as each one is made. Discarding staging
   * removes exactly these (and the folders they leave empty): whatever else is
   * in the note's `_assets` folders arrived from elsewhere. A crash between
   * creating a file and saving it leaves that one copy behind, never a user's file removed.
   */
  createdImages?: string[];
  /**
   * A copy made across drives: a sha256 of the file (a digest of the paths
   * and sizes, for a folder), saved before the copy is published. Recovery
   * accepts a destination only when it still has this content.
   */
  contentHash?: string;
  /** A note's images copied while staging, its rewrite map, and its text hashes before and after it. */
  images?: { created: string[]; imageSources: Record<string, string>; before: string; after: string };
};

type FinalizeStep = "folders" | "records" | "assets" | "attachments" | "tether" | "links" | "references" | "history" | "entries" | "notify";

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
  /** Finalize steps that ended, and the one that started. A step that started but did not end runs again on resume: each is safe to repeat. */
  finalized: FinalizeStep[];
  finalizing?: FinalizeStep;
  /** Steps that threw: how often, and the bookkeeping note kept for it. A step is retried once on resume, then passed over. */
  stepFailures?: Partial<Record<FinalizeStep, { count: number; note: string }>>;
  /** The reference entries of moved PDFs were copied (the step's counts are in `referenceEntries`); a repeat does not copy again. */
  entriesCopied?: boolean;
  finishedFolders?: { from: string; to: string }[];
  references?: ReferenceMoveResult | null;
  /**
   * The citation rewrites of moved notes (key map and text hashes before and
   * after), saved before the first rewritten text is published, and whether
   * they were all written. A resume finishes them with these maps, and
   * accepts a note at its rewritten text as this migration's own.
   */
  citationRewrites?: PlannedCitationRewrite[];
  citationRewritesApplied?: boolean;
  /**
   * The paths rewritten in notes and LaTeX sources so they follow what moved
   * (storage/move-links.ts), planned with the committed mapping and saved
   * before the first file is rewritten: each file's rewrite and its text
   * hashes before and after. A resume applies these same rewrites; a file at
   * its rewritten text is this migration's own (and is not rewritten again).
   */
  linkRewrites?: PlannedLinkRewrite[];
  linkSkipped?: LiberaLinkRewrites["skipped"];
  linkUnchecked?: string[];
  /** The rewrites written (by path), and whether what keeps their text followed (reviews, history, indexes). */
  linksApplied?: string[];
  linkRecordsFollowed?: boolean;
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
  /** Files, and hidden or unknown folder content, still in the source. */
  remaining: string[];
  folders: { from: string; to: string }[];
  references: ReferenceMoveResult | null;
  /** Reference entries of moved PDFs, copied into the destination library. */
  referenceEntries: { copied: number; reused: number; error?: string };
  /** Records that could not be updated (attachments, undo history...). The files moved. */
  bookkeeping: string[];
  /** Sidecars, files or prepared copies still found at a moved item's old path. */
  leftovers: string[];
  /** Moved items not found at their destination, or there with another type or size. Results saved before this field existed lack it. */
  missing?: string[];
  /**
   * What the final check could say: `clean` (every moved item is at its
   * destination with the size it had, nothing selected remains in the source
   * or is left at an old path, and every record followed), `incomplete`
   * (items remain, are missing or are left behind, or records did not
   * follow), or `unverified` (a place could not be checked).
   */
  check: "clean" | "incomplete" | "unverified";
  /** A workspace group chosen for the new notebook, for the app to record. */
  workspaceGroup?: { notebook: string; groupId: string | null };
  /** Paths in notes rewritten to follow the files that moved (moved notes by their new path), and those that could not be. */
  links?: LiberaLinkRewrites;
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

/** `readOnly`: the review's plan, which writes nothing (not even the admin folder). Run's plan may. */
async function buildPlan(request: MigrationRequest, { readOnly = false }: { readOnly?: boolean } = {}) {
  if (!readOnly) await ensureAdminRoot();
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
  /** The spellings planned for each folder name (lowercase), to tell when two differ only in case. */
  const plannedSpellings = new Map<string, string>();
  // One policy for what is already in the destination: the directory's listing,
  // compared case-insensitively, as the namespace is documented. An exact
  // lstat would miss a differently cased entry on a case-sensitive volume.
  const listings = new Map<string, Map<string, string[]>>();
  const listing = async (directory: string) => {
    let names = listings.get(directory);
    if (!names) {
      names = new Map();
      for (const name of create ? [] : await readdir(directory).catch(() => [] as string[])) names.set(name.toLowerCase(), [...(names.get(name.toLowerCase()) ?? []), name]);
      listings.set(directory, names);
    }
    return names;
  };
  /** The entry at `parts` in the destination notebook under any spelling, with the spelling found; null when there is none. */
  const entryAt = async (parts: string[]): Promise<{ stats: Stats; spelled: string[] } | null> => {
    rawItemPath(destinationName, parts);
    let current = notebookPath(destinationName);
    const spelled: string[] = [];
    for (const part of parts) {
      const names = (await listing(current)).get(part.toLowerCase());
      if (!names) return null;
      const name = names.includes(part) ? part : names[0];
      spelled.push(name);
      current = path.join(current, name);
    }
    const stats = await lstatOrNull(current);
    return stats ? { stats, spelled } : null;
  };
  const existence = new Map<string, Stats | null>();
  const existing = async (parts: string[]) => {
    const key = parts.join("/");
    if (!existence.has(key)) {
      const found = create ? null : await entryAt(parts);
      // Another spelling is a different entry on a case-sensitive volume, which the documented namespace does not allow; on a case-insensitive one the exact name reaches it too.
      if (found && found.spelled.join("/") !== key && !(await lstatOrNull(rawItemPath(destinationName, parts)))) {
        blockers.push(`${[destinationName, ...parts].join("/")} differs only in case from the existing ${[destinationName, ...found.spelled].join("/")}. Rename one of them first.`);
      }
      existence.set(key, found?.stats ?? null);
    }
    return existence.get(key)!;
  };
  const createdFolders = new Set<string>();
  const reserveFolder = async (parts: string[]) => {
    for (let index = 1; index <= parts.length; index += 1) {
      const prefix = parts.slice(0, index);
      const libraryPath = [destinationName, ...prefix].join("/");
      const key = libraryPath.toLowerCase();
      if (takenFiles.has(key)) blockers.push(`${libraryPath} would be both a file and a folder.`);
      const planned = plannedSpellings.get(key);
      if (planned === libraryPath) continue;
      // Each exact spelling is validated, even when another spelling of the name already was.
      if (planned) blockers.push(`${libraryPath} and ${planned} differ only in case, so they can't both be created.`);
      else plannedSpellings.set(key, libraryPath);
      takenFolders.add(key);
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
  // Records of an earlier file (stars, tags, review comments, a reference
  // attachment...) can wait at a path with no file: the arriving file would
  // take them over. They are read once for the whole plan.
  const records = candidates.some((candidate) => candidate.kind === "file") ? await destinationRecords() : null;
  // An unreadable review index makes every name look taken: report it, and don't search for a free one.
  if (records?.blocker) blockers.push(records.blocker);
  /** Items renamed only because records of an earlier file are at their name, by target path. */
  const keptFree = new Set<string>();
  const ordered = [...candidates].sort((a, b) => a.fromParts.join("/").localeCompare(b.fromParts.join("/")));
  for (const candidate of ordered) {
    const parent = placed(candidate.fromParts, candidate.base).slice(0, -1);
    const name = candidate.fromParts.at(-1)!;
    await reserveFolder(parent);
    let next = name;
    let firstClash: "file" | "records" | null = null;
    for (let index = 1; ; index += 1) {
      const target = [destinationName, ...parent, next].join("/");
      const key = target.toLowerCase();
      let clash = takenFiles.has(key) || takenFolders.has(key);
      let byRecords = false;
      if (!clash && !create) clash = !!(await entryAt([...parent, next]));
      if (!clash && records && !records.blocker && candidate.kind === "file") {
        byRecords = (await records.at(destinationName, [...parent, next], candidate.fileType)).length > 0;
        clash = byRecords;
      }
      if (!clash && !create) {
        if (candidate.kind === "file") clash = (await existingSidecars(destinationName, [...parent, next], candidate.fileType)).length > 0;
        if (!clash && candidate.fileType === "markdown") {
          for (const directory of ownedAssetDirectories(target)) {
            if (await entryAt(path.relative(notebookPath(destinationName), directory).split(path.sep))) clash = true;
          }
        }
      }
      if (!clash) { takenFiles.add(key); break; }
      if (index === 1) firstClash = byRecords ? "records" : "file";
      next = withSuffix(name, index);
    }
    // macOS junk (.DS_Store, ._*) is not worth keeping twice.
    if (next !== name && candidate.kind === "other" && JUNK(name)) continue;
    const to = [destinationName, ...parent, next].join("/");
    if (next !== name && firstClash === "records") keptFree.add(to);
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
  const warnings = await planWarnings(core, keptFree);
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

/** What a migration would do. Reads only: finding a linked folder does not upgrade its state (paths.ts withReadOnlyStorage). */
export async function planMigration(request: MigrationRequest): Promise<MigrationPlan> {
  return withReadOnlyStorage(async () => (await buildPlan(request, { readOnly: true })).plan);
}

// ---- Warnings ----------------------------------------------------------------

async function planWarnings(plan: PlanCore, keptFree: ReadonlySet<string> = new Set()): Promise<MigrationWarning[]> {
  const warnings: MigrationWarning[] = [];
  const files = plan.items.filter((item) => item.kind === "file");
  const moves = new Map(files.map((item) => [item.from, item.to]));
  const arriving = new Set(moves.values());

  const renamed = files.filter((item) => item.renamed && !keptFree.has(item.to));
  const keptApart = files.filter((item) => item.renamed && keptFree.has(item.to));
  if (keptApart.length) {
    warnings.push({ kind: "renamed-records", message: `${keptApart.length} ${keptApart.length === 1 ? "file is" : "files are"} renamed because stars, tags, comments, reference attachments or other records of an earlier file are kept at the destination name.`, paths: keptApart.map((item) => `${item.from} → ${item.to}`) });
  }
  if (renamed.length) {
    warnings.push({ kind: "renamed", message: `${renamed.length} ${renamed.length === 1 ? "file has" : "files have"} the same name as a file in the destination and will be renamed to keep both.`, paths: renamed.map((item) => `${item.from} → ${item.to}`) });
  }
  if (plan.crossDevice) {
    warnings.push({ kind: "cross-device", message: "The notebooks are on different drives, so files are copied and then removed from the source. Their creation dates are not kept.", paths: [] });
  }

  // Links and chart data that a move changes are rewritten in the links finalize step (docs/features/move-link-refactor.md); the review lists the notes concerned.
  try {
    const disk = fileExistence();
    const check = disk.check;
    const before = disk.exists;
    const after = (candidate: string) => arriving.has(candidate) || (!moves.has(candidate) && before(candidate));

    // Every note is read from disk, not taken from the last saved link index
    // (which can be older than the note): links, chart data and images all come
    // from its text. A note the scan did not reach keeps its indexed links.
    const allMoves = new Map(plan.items.map((item) => [item.from, item.to]));
    const allArriving = new Set(allMoves.values());
    const chartData = (documentPath: string, content: string) => {
      const targets: { data: string; target: string }[] = [];
      for (const block of slideChartBlocks(content)) {
        const parsed = parseSlideChartSpec(block.code);
        if (!("spec" in parsed) || !isSlideChartDataFile(parsed.spec.data)) continue;
        const data = parsed.spec.data!.trim();
        targets.push({ data, target: resolveDeckRelativePath(documentPath, data) });
      }
      return targets;
    };
    // Notes that stay and link to, or chart data from, a file that moves.
    const inbound = new Set<string>();
    // Notes that stay and show a moving image by its library address (`/api/files/raw/...`): the link index leaves embeds out.
    const showing = new Set<string>();
    for (const notebook of await libraryNotebookNames()) {
      const { documents } = await readMarkdownAssetDocuments(notebook);
      const read = new Set(documents.map((note) => note.documentPath));
      const linksOf = new Map<string, string[]>(documents.map((note) => [note.documentPath, extractNotebookLinkDestinations(note.content)]));
      for (const [notePath, hrefs] of Object.entries(await readNotebookLinkIndex(notebook))) if (!read.has(notePath)) linksOf.set(notePath, hrefs);
      for (const [notePath, hrefs] of linksOf) {
        if (moves.has(notePath) || allMoves.has(notePath)) continue;
        for (const href of hrefs) {
          const candidates = linkCandidates(href, notePath);
          if (!candidates.some((candidate) => moves.has(candidate))) continue;
          await check(candidates);
          const target = resolveLinkWith(href, notePath, before);
          if (target && target !== notePath && moves.has(target)) inbound.add(notePath);
        }
      }
      for (const note of documents) {
        if (allMoves.has(note.documentPath)) continue;
        if (chartData(note.documentPath, note.content).some(({ target }) => allMoves.has(target))) inbound.add(note.documentPath);
        if (markdownImageTargets(note.documentPath, note.content).some((target) => target.libraryPath && moves.has(target.libraryPath))) showing.add(note.documentPath);
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
      // A chart reads its data from the note's folder, by the name as written.
      for (const { data, target } of chartData(note.from, content)) {
        const arrived = resolveDeckRelativePath(note.to, data);
        await check([target, arrived]);
        if (!before(target)) continue;
        const expected = allMoves.get(target) ?? target;
        if (arrived !== expected || !(allArriving.has(arrived) || (!allMoves.has(arrived) && before(arrived)))) outbound.add(note.from);
      }
    }
    if (showing.size) warnings.push({ kind: "inbound-images", message: `${showing.size} ${showing.size === 1 ? "note that stays shows" : "notes that stay show"} images you are moving. Their image addresses are updated to follow them.`, paths: [...showing].sort() });
    if (inbound.size) warnings.push({ kind: "inbound-links", message: `${inbound.size} ${inbound.size === 1 ? "note links" : "notes link"} to files you are moving. Those links are updated to follow them.`, paths: [...inbound].sort() });
    if (outbound.size) warnings.push({ kind: "outbound-links", message: `${outbound.size} moving ${outbound.size === 1 ? "note has links" : "notes have links"} that would no longer find their file from the new place. They are updated to keep finding it.`, paths: [...outbound].sort() });
  } catch (error) {
    console.error("[migration] Could not check links:", error);
  }

  try {
    const { files: sourceFiles, truncated } = await listVisibleNotebookFiles(plan.source);
    const { dependencies, references, mainFiles, incomplete } = await latexDependencies(plan.source, sourceFiles);
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
    // A moving file's `\input`, `\includegraphics`... as TeX would resolve them at the final paths
    // (the main file's folder moved with it, a renamed arrival under its new name), against what
    // they resolve to now. A different file or none: a renamed dependency, or one the destination already has.
    const visible = new Set(sourceFiles);
    const landing = fileExistence();
    const shifted = new Set<string>();
    for (const [file, written] of references) {
      const target = moves.get(file);
      if (!target) continue;
      const roots = [...(mainFiles.get(file) ?? [])].sort();
      const root = roots.find((candidate) => moves.has(candidate)) ?? file;
      const rootTarget = moves.get(root) ?? target;
      const rootFrom = root.slice(0, root.lastIndexOf("/") + 1);
      const rootTo = rootTarget.slice(0, rootTarget.lastIndexOf("/") + 1);
      const arrived = (candidate: string) => candidate.startsWith(rootFrom) ? `${rootTo}${candidate.slice(rootFrom.length)}` : moves.get(candidate) ?? candidate;
      for (const reference of written) {
        const current = reference.candidates.find((candidate) => visible.has(candidate));
        if (!current || !moves.has(current)) continue;
        const expected = moves.get(current)!;
        const afterwards = reference.candidates.map(arrived).filter((candidate) => !candidate.startsWith(`${plan.source}/`));
        await landing.check(afterwards.filter((candidate) => !arriving.has(candidate)));
        const found = afterwards.find((candidate) => arriving.has(candidate) || landing.exists(candidate));
        if (found !== expected) shifted.add(`${file}: ${reference.written}`);
      }
    }
    if (shifted.size) warnings.push({ kind: "latex-shadowed", message: `${shifted.size} ${shifted.size === 1 ? "reference in a moving LaTeX file" : "references in moving LaTeX files"} will use a different file, or none, after the move.`, paths: [...shifted].sort() });
    if (incomplete || truncated) warnings.push({ kind: "latex-incomplete", message: `${plan.source} has more or larger LaTeX sources than the check reads, so LaTeX dependencies may be missing from this review.`, paths: [] });
  } catch (error) {
    console.error("[migration] Could not check LaTeX projects:", error);
  }

  // LaTeX sources are not given the cited references when they move (only notes are): the keys they
  // cite that the source library has and the destination's does not.
  try {
    const moving = files.filter((item) => isLatexCitingPath(item.from));
    if (moving.length) {
      const keysOf = async (notebook: string) => {
        const inspected = await inspectReferenceLibrary(notebook).catch(() => null);
        const keys = new Set<string>();
        if (inspected && !("damaged" in inspected)) for (const entry of Object.values(inspected.library?.entries ?? {})) for (const key of [entry.key, ...(entry.aliases ?? [])]) keys.add(key);
        return keys;
      };
      const sourceKeys = await keysOf(plan.source);
      if (sourceKeys.size) {
        const destinationKeys = plan.destination.create ? new Set<string>() : await keysOf(plan.destination.notebook);
        const citing: string[] = [];
        for (const item of moving) {
          let text: string;
          try { text = await readFile(absolute(item.from), "utf8"); } catch { continue; }
          const missing = latexCitedKeys(text).filter((key) => sourceKeys.has(key) && !destinationKeys.has(key));
          if (missing.length) citing.push(`${item.from}: ${missing.join(", ")}`);
        }
        if (citing.length) warnings.push({ kind: "latex-citations", message: `${citing.length} moving LaTeX ${citing.length === 1 ? "file cites" : "files cite"} references of ${plan.source} that ${plan.destination.notebook} does not have. They are not copied with LaTeX files.`, paths: citing.sort() });
      }
    }
  } catch (error) {
    console.error("[migration] Could not check LaTeX citations:", error);
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
  const recording: MarkdownAssetBatch = {
    ...batch,
    onCreated: async (target) => { (item.createdImages ??= []).push(target); await saveJournal(journal); },
  };
  const images = await copyMarkdownImageAssets(item.from, item.to, previous, true, recording);
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

/**
 * Undo one item's staging: its staged note, the images it copied, and the
 * `_assets` folders it made once they are empty. An item staging never began is left entirely
 * alone: whatever is at its planned paths is not this migration's.
 */
async function discardItem(journal: Journal, index: number, item: JournalItem) {
  if (!item.stagingBegan && !item.images) { delete item.method; return; }
  await rm(stagedPath(journal, index, item), { force: true, recursive: true }).catch(() => undefined);
  await rm(`${stagedPath(journal, index, item)}.tmp`, { force: true }).catch(() => undefined);
  for (const created of [...(item.createdImages ?? []), ...(item.images?.created ?? [])]) await rm(created, { force: true }).catch(() => undefined);
  const assets = path.join(notebookPath(item.to.split("/")[0]), MARKDOWN_ASSETS_DIR);
  for (const directory of item.ownedDirectories ?? []) {
    // The folder did not exist when planned, but a sync client or the user can
    // have put files there since: only the images recorded above are this
    // migration's. What they leave empty goes, nothing else.
    await removeEmptyDirectories(directory);
    // Parents left empty, up to and including `_assets`.
    for (let parent = path.dirname(directory); parent.startsWith(assets); parent = path.dirname(parent)) {
      if (!(await rmdir(parent).then(() => true, () => false))) break;
    }
  }
  delete item.images;
  delete item.createdImages;
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

const appeared = (to: string) => new StorageError(`${to} appeared while migrating. Nothing was replaced; review the migration again.`, 409);

/**
 * Move `from` to `to` (a file or a folder) without ever replacing what is
 * there, also when something arrives while it runs: the name is claimed
 * exclusively first (fs-ops), never checked and then renamed over.
 */
async function moveInto(from: string, to: string) {
  try { await movePathExclusive(from, to); }
  catch (error) {
    if (error instanceof DestinationTakenError) throw appeared(to);
    throw error;
  }
}

/** Publish `from` at `to` without ever replacing what is there. Returns false when it had to move instead (no hard links). */
async function publish(from: string, to: string) {
  try {
    await link(from, to);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") throw appeared(to);
    if (!NO_HARD_LINKS.has(code)) throw error;
  }
  await moveInto(from, to);
  return false;
}

/** A sha256 of a file, streamed. */
async function fileHash(target: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A digest of a folder's relative paths, kinds and file contents (links by target), without following links. */
async function directoryDigest(directory: string) {
  const lines: string[] = [];
  const walk = async (current: string, relative: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { lines.push(`d ${name}`); await walk(target, name); }
      else if (entry.isSymbolicLink()) lines.push(`l ${name} ${await readlink(target).catch(() => "")}`);
      else lines.push(`f ${name} ${(await lstat(target)).size} ${await fileHash(target)}`);
    }
  };
  await walk(directory, "");
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The destination holds this migration's file: checked by identity or recorded content, never assumed from a name or a size. */
async function isOurs(journal: Journal, index: number, item: JournalItem, destination: Stats, staged: Stats | null) {
  // A note whose links or citations were rewritten after it was published is a new file (an atomic write), at a text the journal recorded.
  const rewritten = [journal.linkRewrites?.find((planned) => planned.path === item.to)?.after, journal.citationRewrites?.find((planned) => planned.path === item.to)?.after].filter(Boolean);
  if (rewritten.length && destination.isFile()) {
    const text = await readFile(located(item, item.to), "utf8").catch(() => null);
    if (text !== null && rewritten.includes(hashText(text))) return true;
  }
  if (item.method === "link" || item.method === "rename") {
    if (destination.dev === item.identity.dev && destination.ino === item.identity.ino) return true;
    // A folder copied from another drive (`rename` of a folder across drives is a copy): the copy's recorded digest must match.
    if (!item.identity.directory || staged || !destination.isDirectory() || !item.contentHash) return false;
    return await directoryDigest(located(item, item.to)).catch(() => null) === item.contentHash;
  }
  if (staged) return staged.dev === destination.dev && staged.ino === destination.ino;
  if (item.method === "staged") {
    const text = await readFile(located(item, item.to), "utf8").catch(() => null);
    return text !== null && hashText(text) === item.images?.after;
  }
  if (item.identity.directory || !item.contentHash || destination.size !== item.identity.size) return false;
  return await fileHash(located(item, item.to)).catch(() => null) === item.contentHash;
}

/** Where the item is, from the disk. Throws when the disk does not match the migration (an unrelated file, a missing one). */
async function reconcile(journal: Journal, index: number, item: JournalItem): Promise<ItemState> {
  const [source, destination, staged] = await Promise.all([
    lstatOrNull(located(item, item.from)),
    lstatOrNull(located(item, item.to)),
    lstatOrNull(stagedPath(journal, index, item)),
  ]);
  if (destination) {
    if (!(await isOurs(journal, index, item, destination, staged))) {
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
  // A separate copy (not the same inode) holds the text as it was when
  // published: a source edited in place since then has newer content.
  if (!item.identity.directory) {
    const destination = await lstatOrNull(located(item, item.to));
    if (destination && (destination.dev !== stats.dev || destination.ino !== stats.ino) && !sameSource(item, stats)) {
      throw new StorageError(`${item.from} was edited after it was copied to ${item.to}. Both copies were kept; compare them and resume.`, 409);
    }
  }
  if (!item.identity.directory) { await rm(source, { force: true }); return; }
  const destination = located(item, item.to);
  const destinationStats = await lstatOrNull(destination);
  // Never the copy itself: the folder is retired only entry by entry, against what the destination holds.
  if (!destinationStats || (destinationStats.dev === stats.dev && destinationStats.ino === stats.ino)) return;
  const kept = await removeCopiedEntries(source, destination, "");
  if (kept.length) {
    const shown = kept.slice(0, 5).join(", ");
    throw new StorageError(`${item.from} holds ${kept.length} ${kept.length === 1 ? "entry" : "entries"} that changed or arrived after the folder was copied (${shown}${kept.length > 5 ? ", ..." : ""}). They were kept in the source; move or remove them and resume.`, 409);
  }
}

/** An entry of the source is, byte for byte, what the copy holds: only then is it safe to delete. */
async function sameCopy(from: string, to: string, entry: Dirent) {
  try {
    if (entry.isSymbolicLink()) return (await lstat(to)).isSymbolicLink() && (await readlink(from)) === (await readlink(to));
    const before = await lstat(from);
    const copy = await lstat(to);
    if (!before.isFile() || !copy.isFile() || before.size !== copy.size) return false;
    if (await fileHash(from) !== await fileHash(to)) return false;
    // Edited while it was being compared: newer than the copy.
    const after = await lstat(from);
    return after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs;
  } catch { return false; }
}

/**
 * Remove the entries of a folder copied across drives that the copy holds
 * unchanged, and the folders that leave empty. A changed entry, one that
 * arrived after the copy, or one that can't be compared stays. Returns the
 * relative paths kept.
 */
async function removeCopiedEntries(source: string, copy: string, relative: string): Promise<string[]> {
  const kept: string[] = [];
  let entries: Dirent[];
  try { entries = await readdir(source, { withFileTypes: true }); } catch { return [relative || "."]; }
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const from = path.join(source, entry.name);
    const to = path.join(copy, entry.name);
    if (entry.isDirectory()) kept.push(...await removeCopiedEntries(from, to, name));
    else if (await sameCopy(from, to, entry)) { if (!(await rm(from, { force: true }).then(() => true, () => false))) kept.push(name); }
    else kept.push(name);
  }
  // Not recursive: an entry that arrived since the listing keeps the folder.
  if (!kept.length && !(await rmdir(source).then(() => true, () => false))) kept.push(relative || ".");
  return kept;
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
      if (await lstatOrNull(destination)) throw appeared(item.to);
      if ((await stat(path.dirname(destination))).dev === item.identity.dev) {
        await moveInto(source, destination);
        return;
      }
      // A hidden folder on another drive: copied to its staged name first, then renamed into place.
      await rm(staged, { force: true, recursive: true });
      await cp(source, staged, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
      // The copy must match the folder it came from; its digest is what a resume checks the destination against.
      item.contentHash = await directoryDigest(staged);
      if (await directoryDigest(source) !== item.contentHash) throw new StorageError(`${item.from} changed while it was being copied. Nothing was removed; review the migration again.`, 409);
      await saveJournal(journal);
      await moveInto(staged, destination);
      break;
    case "staged":
      if (!(await lstatOrNull(staged))) throw new StorageError(`The prepared copy of ${item.from} is missing. Stop this migration and review it again.`, 409);
      await publish(staged, destination);
      break;
    case "copy": {
      await rm(staged, { force: true });
      await copyFile(source, staged);
      if ((await stat(staged)).size !== item.identity.size) throw new StorageError(`${item.from} could not be copied completely.`, 409);
      // The copy's content, recorded before it is published: a resume accepts a destination only with this content.
      item.contentHash = await fileHash(staged);
      if (await fileHash(source) !== item.contentHash) throw new StorageError(`${item.from} changed while it was being copied. Nothing was removed; review the migration again.`, 409);
      await saveJournal(journal);
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
  if (item.kind === "file") await followSidecars(item);
  return "finished";
}

/** A published file's sidecars follow it. Safe to repeat: nothing left at the old path is nothing to do. */
async function followSidecars(item: JournalItem) {
  const from = splitFilePath(item.from);
  const to = splitFilePath(item.to);
  const fileType = item.fileType ?? "";
  await moveFileSidecars(from.notebook, from.pathParts, to.notebook, to.pathParts, fileType, fileType);
}

/**
 * Whether a published item whose source is gone also has its review and
 * sidecars at the new path, by doing what is left of it (both are safe to
 * repeat). The disk saying the file is published does not say that.
 */
async function completeFollowers(item: JournalItem) {
  if (item.kind !== "file") return;
  await withMovedReview(item.from, item.to, imageTransform(item), async () => undefined);
  await followSidecars(item);
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

/** A note for the result, once: a repeated step does not say the same thing twice. */
function note(journal: Journal, text: string) {
  if (!journal.bookkeeping.includes(text)) journal.bookkeeping.push(text);
}

/**
 * Run a finalize step, ending only when it did: a step that started and did
 * not end (an interruption) runs again on resume, so each one is written to
 * be safe to repeat. A step that throws is noted and retried once on the next
 * resume; failing again, it is passed over with its note kept. Returns false
 * when the steps after it should wait for that retry.
 */
async function step(journal: Journal, name: FinalizeStep, run: () => Promise<void>): Promise<boolean> {
  if (journal.finalized.includes(name)) return true;
  journal.finalizing = name;
  await saveJournal(journal);
  injectFault?.(`finalize:${name}`);
  try {
    injectFault?.(`finalizing:${name}`);
    await run();
  } catch (error) {
    // A simulated crash (tests) stops the run where it is, as a real one would: it is not the step's failure.
    if ((error as { crash?: boolean }).crash) throw error;
    console.error(`[migration] Finalize step ${name} failed:`, error);
    const count = (journal.stepFailures?.[name]?.count ?? 0) + 1;
    const text = `${name}: ${errorText(error)}`;
    journal.stepFailures = { ...journal.stepFailures, [name]: { count, note: text } };
    note(journal, text);
    delete journal.finalizing;
    if (count < 2) {
      await saveJournal(journal);
      return false;
    }
    journal.finalized.push(name);
    await saveJournal(journal);
    return true;
  }
  // A retry that worked takes back the note of the failure before it.
  const failed = journal.stepFailures?.[name];
  if (failed) {
    journal.bookkeeping = journal.bookkeeping.filter((text) => text !== failed.note);
    delete journal.stepFailures![name];
  }
  journal.finalized.push(name);
  delete journal.finalizing;
  await saveJournal(journal);
  return true;
}

async function finalize(journal: Journal, states: ItemState[]) {
  journal.state = "finalizing";
  journal.phase = "finalizing";
  const files = journal.items.filter((item, index) => item.kind === "file" && states[index] === "finished");
  const moves = new Map(files.map((item) => [item.from, item.to]));
  delete journal.error;
  // After a step fails, the ones that follow wait for its retry (they build on its output).
  let halted = false as boolean;
  const run = async (name: FinalizeStep, body: () => Promise<void>) => {
    if (!halted && !(await step(journal, name, body))) halted = true;
  };

  await run("folders", async () => {
    const finished: { from: string; to: string }[] = [];
    for (const folder of [...journal.folders].sort((a, b) => b.from.length - a.from.length)) {
      if (journal.items.some((item, index) => states[index] !== "finished" && item.from.startsWith(`${folder.from}/`))) continue;
      const [notebook, ...parts] = folder.from.split("/");
      await removeEmptyDirectories(itemPath(notebook, parts));
      for (const kind of SIDECAR_KINDS) await removeEmptyDirectories(kind.directoryPath(notebook, parts));
      // Content that arrived after the plan stays, and so does the folder's identity.
      if (await lstatOrNull(itemPath(notebook, parts))) {
        note(journal, `${folder.from} received new content during the migration; it stays in ${journal.source}.`);
        continue;
      }
      finished.push(folder);
    }
    journal.finishedFolders = finished;
  });

  await run("records", async () => {
    await moveReviewPaths(moves);
    await renameFileMetadataPaths(moves);
    for (const folder of journal.finishedFolders ?? []) {
      await renameNotebookPanelExpandedPathPrefix(folder.from, folder.to);
      await renameFileMetadataPathPrefix(folder.from, folder.to);
    }
  });

  await run("assets", async () => {
    // The moved notes' images and uploads, written as embeds for the cleanup scan; images other notes use stay.
    const notes = files.filter((item) => item.images).map((item) => ({ documentPath: item.from, content: Object.keys(item.images!.imageSources).map((source) => `![](<${source}>)`).join("\n") }));
    if (notes.length) await cleanupMarkdownImageAssets(journal.source, notes);
  });

  await run("attachments", async () => {
    const { changed, failures, offline } = await moveReferenceAttachmentsBatch(moves);
    if (offline.length) note(journal, `${offline.join(", ")} ${offline.length === 1 ? "is" : "are"} not connected, so reference attachments or a tethered .bib file there may still point at the old paths. Check Notebook finds them once ${offline.length === 1 ? "it is" : "they are"} connected.`);
    for (const failure of failures) note(journal,`Reference attachments in ${failure.notebook || "a library"} still point at the old paths: ${errorText(failure.error)}`);
    // Open References panels of the libraries that changed reload (one event per library, not per file).
    for (const notebook of changed) {
      try { publishReferenceEvent({ type: "library", notebook, revision: (await readReferenceLibrary(notebook)).revision }); }
      catch { /* The panel catches up when it next loads. */ }
    }
  });

  await run("tether", async () => {
    // A tethered .bib file among the moved files follows, in one pass.
    for (const failure of await moveTetheredFilesBatch(moves)) {
      note(journal, `The tethered .bib file of ${failure.notebook} could not follow its move: ${errorText(failure.error)}`);
    }
  });

  await run("links", async () => {
    // Paths in notes follow what moved, with the committed mapping: only items now at their new path (a partial migration rewrites for what moved).
    // After images (staged with the notes), before citation keys (whose plan reads the text this leaves): the order the app applies too.
    if (journal.linkRewrites === undefined) {
      const moved: PathMove[] = journal.items.flatMap((item, index) => states[index] === "finished" ? [{ from: item.from, to: item.to, ...(item.identity.directory ? { folder: true } : {}) }] : []);
      // An item at both places (its source edited after it was published) is the person's to sort out: neither copy is rewritten.
      const unsettled = new Set(journal.items.flatMap((item, index) => states[index] === "published" ? [item.from, item.to] : []));
      const plan = moved.length ? await planMovedLinks(moved, { ownMigration: true, leave: unsettled }) : { notes: [], skipped: [], unchecked: [] };
      // Saved before the first file is rewritten: a resume applies these, never a plan made from texts already rewritten.
      journal.linkRewrites = plan.notes;
      journal.linkSkipped = plan.skipped;
      journal.linkUnchecked = plan.unchecked;
      await saveJournal(journal);
      injectFault?.("links:planned");
    }
    let applied: AppliedLinkRewrite[] | null = null;
    if (!journal.linksApplied) {
      const outcome = await applyMovedLinks(journal.linkRewrites ?? []);
      applied = outcome.applied;
      journal.linksApplied = applied.map((rewritten) => rewritten.path);
      if (outcome.failed.length) {
        journal.linkSkipped = [...journal.linkSkipped ?? [], ...outcome.failed];
        note(journal, `Links in ${[...new Set(outcome.failed.map((skip) => skip.path))].join(", ")} could not be updated. Check Notebook lists them.`);
      }
      await saveJournal(journal);
    }
    if (!journal.linkRecordsFollowed) {
      // What keeps the rewritten texts follows once: after an interruption, from the journal's hashes.
      const done = new Set(journal.linksApplied);
      const notes = applied ?? (journal.linkRewrites ?? []).filter((planned) => done.has(planned.path));
      // A moved note's undo history follows in the history step, with its other rewrites; the others' here.
      const movedTo = new Set(files.map((item) => item.to));
      for (const failure of await followLinkRewrites(notes, { history: (filePath) => !movedTo.has(filePath) })) note(journal, `Links: ${failure}`);
      journal.linkRecordsFollowed = true;
      await saveJournal(journal);
    }
  });

  await run("references", async () => {
    // References cited by notes follow them. LaTeX sources are never
    // rewritten by reference features, so they are left out, as they are
    // for single moves (references-moves.test.ts).
    const citing = files.filter((item) => item.fileType === "markdown").map((item) => ({ from: item.from, to: item.to }));
    // Its key maps are what the history step rewrites by: a repeat would find the notes already rewritten and map nothing, so the plan is
    // saved before the first note is rewritten, and a resume finishes it from there instead of planning again.
    if (journal.references === undefined) {
      journal.references = citing.length ? await copyReferencesOnMove(journal.source, journal.destination.notebook, citing, {
        onPlan: async (planned, rewrites) => {
          journal.references = planned;
          journal.citationRewrites = rewrites;
          journal.citationRewritesApplied = false;
          await saveJournal(journal);
        },
      }) : null;
      // A failure after the plan was saved is the step's own, so it gets its retry (which finishes the rewrites).
      if (journal.citationRewrites && journal.references?.error) throw new Error(journal.references.error);
      if (journal.citationRewrites) journal.citationRewritesApplied = true;
      await saveJournal(journal);
    } else if (journal.citationRewrites && !journal.citationRewritesApplied) {
      await applyCitationRewrites(journal.citationRewrites);
      journal.citationRewritesApplied = true;
      if (journal.references) delete journal.references.error;
      await saveJournal(journal);
    }
    if (journal.references?.error) note(journal, `Cited references: ${journal.references.error}`);
  });

  await run("history", async () => {
    // Pending agent reviews and undo history see the files as the migration left them.
    const keyMaps = new Map((journal.references?.drafts ?? []).map((draft) => [draft.path, new Map(Object.entries(draft.map))]));
    // Written link rewrites of moved notes: their undo history gets them here, between images and citation keys (the order the file got them).
    const written = new Set(journal.linksApplied ?? []);
    const linkMaps = new Map((journal.linkRewrites ?? []).filter((planned) => written.has(planned.path)).map((planned) => [planned.path, planned.rewrite]));
    const baselines = new Map<string, (text: string) => string>();
    const undo = new Map<string, MovedRunFile>();
    for (const item of files) {
      const images = imageTransform(item);
      const keys = keyMaps.get(item.to);
      const paths = linkMaps.get(item.to);
      const withPaths = paths ? (text: string) => rewriteMovedPaths(images(text), item.to, paths) : images;
      const transform = keys ? (text: string) => rewriteCitationKeys(withPaths(text), keys).text : withPaths;
      if (keys) baselines.set(item.to, (text) => rewriteCitationKeys(text, keys).text);
      let hashes: MovedRunFile["hashes"];
      if ((item.images && (keys || paths || item.images.before !== item.images.after)) || (!item.images && paths)) {
        const now = await readFile(absolute(item.to), "utf8").catch(() => null);
        const before = item.images?.before ?? journal.linkRewrites?.find((planned) => planned.path === item.to)?.before;
        if (now !== null && before) hashes = { before, after: hashText(now) };
      }
      undo.set(item.from, { to: item.to, ...(item.images || keys || paths ? { transform } : {}), ...(hashes ? { hashes } : {}) });
    }
    await transformReviewBaselines(baselines);
    await recordMovedRunFiles(undo);
  });

  await run("entries", async () => {
    // A moved PDF's reference entry is copied into the destination library; other PDFs may get one automatically.
    const pdfs = new Set(files.filter((item) => item.fileType === "pdf").map((item) => item.to));
    // A repeat after the copy keeps its counts: the entries exist now, so copying again would report them as reused.
    const entries: MigrationResult["referenceEntries"] = journal.entriesCopied && journal.referenceEntries ? journal.referenceEntries : { copied: 0, reused: 0 };
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
      if (keys.length && !journal.entriesCopied) {
        const copy = await copyReferenceEntries(journal.source, journal.destination.notebook, keys);
        entries.copied = copy.copied.length;
        entries.reused = copy.reused.length;
        journal.entriesCopied = true;
        await saveJournal(journal);
      }
      notifyReferenceFilesAdded([...pdfs].filter((value) => !attached.has(value)));
    } catch (error) {
      entries.error = errorText(error);
    }
  });

  await run("notify", async () => {
    notifySearchChanges([...moves.keys(), ...moves.values()]);
  });

  if (halted) {
    // A step failed and gets its retry on resume; nothing more runs until then.
    journal.state = "interrupted";
    journal.error = "A final bookkeeping step failed. Resume to try it again.";
    journal.result = await resultOf(journal, states);
    await saveJournal(journal);
    return;
  }
  journal.state = "done";
  journal.result = await resultOf(journal, states);
  await saveJournal(journal);
}

async function resultOf(journal: Journal, states: ItemState[]): Promise<MigrationResult> {
  const moved: MigrationMove[] = [];
  const remaining: string[] = [];
  journal.items.forEach((item, index) => {
    // Hidden or unknown content of a selected folder is not listed as moved, but when it stayed it is not "nothing left" either.
    if (item.kind !== "file") { if (states[index] === "pending") remaining.push(item.from); return; }
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
  const missing: string[] = [];
  let unverified = false;
  const linked = (to: string) => journal.linkRewrites?.find((planned) => planned.path === to);
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
    // Every item counted as moved is at its destination, of the type and size it had.
    for (const [index, item] of journal.items.entries()) {
      if (states[index] === "pending") continue;
      try {
        const stats = await lstatOrNull(located(item, item.to));
        if (!stats) missing.push(`${item.to} (not found)`);
        else if (stats.isDirectory() !== item.identity.directory) missing.push(`${item.to} (is not the ${item.identity.directory ? "folder" : "file"} that moved)`);
        else if (stats.isFile() && (item.images || linked(item.to))) {
          // A file rewritten by the migration: at the text its image, link or citation rewrite left, as the resume reads it.
          const text = await readFile(located(item, item.to), "utf8").catch(() => null);
          const rewrite = journal.citationRewrites?.find((planned) => planned.path === item.to);
          // A file planned for links only (a LaTeX source) is the file that moved at the text the plan read, or at the one it wrote.
          const accepted = [item.images?.after, linked(item.to)?.before, linked(item.to)?.after, rewrite?.after].filter(Boolean);
          if (text === null || !accepted.includes(hashText(text))) missing.push(`${item.to} (is not the note that moved)`);
        } else if (stats.isFile() && stats.size !== item.identity.size) missing.push(`${item.to} (its size is ${stats.size} bytes, not ${item.identity.size})`);
      } catch (error) {
        unverified = true;
        missing.push(`${item.to} (could not be checked: ${errorText(error)})`);
      }
    }
  }
  // Records that did not follow (bookkeeping) are part of "clean" too: the final check says only what it verified.
  const check: MigrationResult["check"] = journal.state !== "done" ? "incomplete" : unverified ? "unverified"
    : remaining.length || leftovers.length || missing.length || journal.bookkeeping.length || moved.some((move) => move.incomplete) ? "incomplete" : "clean";

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
    missing,
    check,
    ...(journal.createdNotebook && journal.create && journal.create.workspaceGroupId !== undefined
      ? { workspaceGroup: { notebook: journal.destination.notebook, groupId: journal.create.workspaceGroupId } } : {}),
    ...(journal.linkRewrites ? { links: {
      rewritten: journal.linkRewrites.filter((planned) => journal.linksApplied?.includes(planned.path)).map((planned) => ({ path: planned.path, rewrite: planned.rewrite })),
      skipped: journal.linkSkipped ?? [],
      unchecked: journal.linkUnchecked ?? [],
    } } : {}),
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
      try { states[index] = await moveItem(journal, index, item, states[index]); }
      catch (error) {
        // Stop never gets stuck on a file it can't finish (a source edited since it was copied): both copies stay, reported as not fully moved.
        if (continueRemaining || states[index] !== "published") throw error;
        note(journal, errorText(error));
      }
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
    if (await untouched(journal.destination.notebook)) await deleteNotebook(journal.destination.notebook, { byMigration: true });
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
    // The intent is recorded before anything is created. Try to fix, Acknowledge and the tree's upkeep
    // are held off until it is on disk; from there the journal keeps them away (migration-fence.ts).
    const release = claimNotebooksForMigration([plan.source, plan.destination.notebook]);
    try { await saveJournal(journal); } finally { release(); }

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
        // Staging may only remove what it made: the item's folders must be free now, and the journal says staging began before it writes anything.
        // A folder this run already made as the parent of an earlier note's folder (`_assets/a` above `_assets/a/b`) is its own.
        const madeAbove = (directory: string) => journal.items.slice(0, index).some((earlier) => earlier.stagingBegan &&
          (earlier.ownedDirectories ?? []).some((owned) => owned.startsWith(`${directory}${path.sep}`)));
        for (const directory of item.ownedDirectories ?? []) {
          if (await lstatOrNull(directory) && !madeAbove(directory)) throw new StorageError(`${directory} appeared since the migration was reviewed. Nothing was replaced; review it again.`, 409);
        }
        item.stagingBegan = true;
        await saveJournal(journal);
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
        // Published and its source gone is not yet finished: its review and sidecars must have followed too, which the disk
        // can't tell from the file alone, so what is left of that is done now. A source still there (kept by Stop) is not a clean move.
        if (state !== "published") states[index] = "pending";
        else if (await lstatOrNull(located(item, item.from))) states[index] = "published";
        else {
          try { await completeFollowers(item); states[index] = "finished"; }
          catch (error) {
            states[index] = "published";
            note(journal, `${item.from}: ${errorText(error)}`);
          }
        }
      }
      await finalize(journal, states);
      return journal.result!;
    }

    return runMoving(journal, mode === "continue");
  });
}
