import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listReviewEntryPaths } from "@/lib/agent/review-store";
import { listRunFiles } from "@/lib/agent/snapshots";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { latexDependencies } from "@/lib/latex/dependencies";
import { isLatexCitingPath } from "@/lib/references/latex-cite-syntax";
import { slideChartBlocks, isSlideChartDataFile, parseSlideChartSpec, resolveDeckRelativePath } from "@/lib/slide-charts";
import { decideInkSource, foldedAliasOf } from "@/lib/storage/ink";
import { readTetherTarget } from "@/lib/references/bib-tether";
import { ARCHIVE_DIR, MARKDOWN_ASSETS_DIR, MARKDOWN_EXTENSIONS, ORPHANED_SIDECARS_DIR } from "@/lib/storage/constants";
import { planBibMirror } from "@/lib/references/bib-mirror";
import type { ReferenceLibrary } from "@/lib/references/types";
import { readIndexedLibraryRows } from "@/lib/search/database";
import { latexBuildProductFilter } from "@/lib/search/latex-products";
import { getSearchPreferences, searchIndexFile } from "@/lib/search/settings";
import { readFileSignature } from "@/lib/storage/file-signature";
import { citationIndexPath, readCitationIndex } from "@/lib/storage/reference-citations";
import { fileExistence, libraryNotebookNames, linkCandidates, resolveLinkTargetWith } from "@/lib/storage/library-links";
import { decodeMarkdownHeadingHash, findMarkdownHeadingAnchorIndex, markdownHeadingAnchors, type MarkdownHeadingAnchor } from "@/lib/markdown-heading-anchors";
import { markdownHtmlAnchors } from "@/lib/markdown-link-occurrences";
import { listLegacyAnnotations, savedAnnotationIds, type SavedAnnotationIds } from "@/lib/storage/annotations";
import { parseTranscript, transcriptCompanionFilePath } from "@/lib/storage/transcripts";
import { markdownImageTargets, unreferencedMarkdownAssets } from "@/lib/storage/markdown-assets";
import { extractNotebookLinkDestinations, forgetNotebookLinkReads, linkIndexPath, readLinkIndex } from "@/lib/storage/notebook-links";
import { assertSafeSegment, audioPeaksPath, getLinkedFolder, withReadOnlyStorage, getStateRoot, notebookMetadataPath, notebookPath, notebookSystemDirectoryPath, orphanedSidecarsDirectoryPath, relativeFilePath, filePathFromParts, splitFilePath, transcriptPath } from "@/lib/storage/paths";
import { inspectReferenceLibrary } from "@/lib/storage/references";
import { inspectLegacyReviewKeys, inspectReviewDocumentProblems, inspectReviewKeys } from "@/lib/storage/review-files";
import { listSidecars, findOrphanedSidecars, SIDECAR_KINDS, type SidecarInspection } from "@/lib/storage/sidecars";
import { matchByIdentity, mayBeBack, readOrphans, slotTakenBy, upkeepReattachesByContent } from "@/lib/storage/pdf-sidecars";
import { hostOwnsSideFile, livePdfMarkIds, manifestFile, manifestHasFile, manifestHasFolder, mayBeArriving, readManifestView, readSharedSync } from "@/lib/storage/shared-manifest-view";
import { isGeneratedPath, isShareablePath } from "../../../electron/collab/notebooks/fs-ops";
import { getFileType } from "@/lib/storage/file-types";
import { pythonSidecarDocumentPath, pythonSidecarPath } from "@/lib/python/sidecar";
import { foldedFileName } from "@/lib/storage/file-names";
import { listVisibleNotebookFiles } from "@/lib/storage/tree";
import { inspectWorkspaceMetadata } from "@/lib/storage/workspace-metadata";
import { StorageError } from "@/lib/storage/errors";

// The notebook check: one place that says whether a notebook is sound, by
// asking the modules that own each kind of state (sidecars.ts,
// markdown-assets.ts, library-links.ts, latex/dependencies.ts, the review,
// undo, reference and migration stores) what they hold and checking it
// against the disk. It only reads: it never loads the library tree (whose
// upkeep writes indexes and prunes sidecars) and repairs nothing (repair.ts
// does, on confirmation). It runs on demand, never in the background. The migration's final check
// (storage/migration.ts) uses checkNothingLeftAt from here.

export type IntegritySeverity = "error" | "warning" | "info";

export type IntegrityCheckId = "notebook" | "sidecars" | "assets" | "images" | "links" | "latex" | "records" | "references" | "indexes" | "migrations" | "sharing";

/** Arguments of a `lib.storage.integrity` message. */
export type SayParams = Record<string, string | number>;

/** A message the dialog shows in the interface language: a `lib.storage.integrity` key and its arguments. */
export type Say = { code: string; params?: SayParams };

/** A `Say` with its English text, which stays in `note` for readers of the report that do not translate. */
type Said = Say & { text: string };

const said = (code: string, text: string, params?: SayParams): Said => ({ code, text, ...(params ? { params } : {}) });
const say = (code: string, params?: SayParams, fixCode?: string) => ({ code, ...(params ? { params } : {}), ...(fixCode ? { fixCode } : {}) });

export type IntegrityFinding = {
  check: IntegrityCheckId;
  /** `error`: something is broken where you will see it. `warning`: data that points nowhere. `info`: harmless, for the record. */
  severity: IntegritySeverity;
  /** The library path concerned (or the closest one). */
  path: string;
  /** The English text; the dialog shows `code` in the interface language instead (`lib.storage.integrity` messages). */
  message: string;
  /** What would set it right. Nothing is changed by the check itself. */
  fix?: string;
  /** The `lib.storage.integrity` message for `message`, and the arguments of it and of `fixCode`, the one for `fix`. */
  code?: string;
  params?: SayParams;
  fixCode?: string;
  /** What Acknowledge (cleanup.ts) removes to clear this finding, on confirmation. On a shared notebook only what is this computer's, once the host has confirmed the manifest. */
  clear?: CleanupAction[];
  /**
   * Shared notebooks only: whether Try to fix can pair this finding's record with the file of the same name (this computer's records,
   * with the host's file list confirming). Not set on other notebooks, where Try to fix is offered for what a move outside the app can cause.
   */
  repairable?: boolean;
};

/**
 * Something stale that Acknowledge removes: what is left of a file that is
 * gone, a side file saved for another version of its file, an out-of-date
 * cache or index. Paths are library paths; cleanup.ts says what each costs.
 * `gone` names the file whose absence makes it stale: cleanup.ts checks it
 * is still gone right before removing anything.
 */
export type CleanupAction = (
  /** `identified`: the side file records the bytes of the file it was made for and no file in the notebook has them (never set in a shared notebook, where owners are not looked for by content). */
  | { type: "side-file"; kind: string; filePath: string; identified?: true }
  | { type: "ink-files"; filePath: string; names: string[] }
  | { type: "set-aside"; file: string; identified?: true }
  | { type: "asset"; path: string }
  | { type: "star"; path: string }
  | { type: "tags"; path: string }
  | { type: "review"; path: string }
  | { type: "agent-review"; path: string }
  /** One attachment of one reference, in `library`'s reference library. */
  | { type: "attachment"; library: string; entry: string; path: string }
  /** The tether, as long as it is still to `target`. */
  | { type: "tether"; target: string }
  | { type: "bib-mirror" }
  | { type: "citations" }
) & { gone?: string };

export type IntegrityCheckResult = {
  id: IntegrityCheckId;
  label: string;
  /** `incomplete`: only part of it could be checked (see `note`); `failed`: it could not run. */
  status: "ok" | "findings" | "incomplete" | "failed";
  /** English; `notes` says the same in `lib.storage.integrity` messages (more than one when several things are partial). */
  note?: string;
  notes?: Say[];
};

export type IntegrityReport = {
  notebook: string;
  checkedAt: string;
  durationMs: number;
  /** `partial` when a check failed, could only partly run, or a limit was reached: then the report can't say the notebook is clear. */
  completeness: "complete" | "partial";
  /** The check was stopped on request; `checks` lists those that ran. */
  cancelled?: boolean;
  checks: IntegrityCheckResult[];
  findings: IntegrityFinding[];
  counts: { files: number; notes: number; sidecars: number };
  /** What the check cost, and the limits it ran under. */
  statistics: { entriesVisited: number; filesRead: number; bytesRead: number; probes: number };
  limits: IntegrityLimits;
};

/** Bounds of one check, so a huge notebook can't keep the disk busy: reaching one makes the affected checks partial. */
export type IntegrityLimits = { entries: number; bytes: number; milliseconds: number; findings: number };
export const DEFAULT_INTEGRITY_LIMITS: IntegrityLimits = { entries: 20_000, bytes: 64 * 1024 * 1024, milliseconds: 30_000, findings: 10_000 };

export type IntegrityProgress = { check: IntegrityCheckId; label: string; index: number; total: number };

export type VerifyOptions = {
  /** Aborts the check between steps (the dialog closing, the request going away). */
  signal?: AbortSignal;
  onProgress?: (progress: IntegrityProgress) => void;
  limits?: Partial<IntegrityLimits>;
};

/** One line of the streamed check (`/api/notebooks/verify?stream=1`), newline-delimited JSON. */
export type IntegrityStreamLine =
  | ({ type: "progress" } & IntegrityProgress)
  | { type: "report"; report: IntegrityReport }
  | { type: "error"; error: string };

/** Thrown when a check is stopped on request. */
export class IntegrityCheckCancelled extends Error {}

/**
 * One check's budget: entries visited, bytes read, time. Loops ask `allows()`
 * before more work; once a limit is reached it says which, and the check in
 * progress reports itself partial.
 */
export class IntegrityBudget {
  readonly statistics = { entriesVisited: 0, filesRead: 0, bytesRead: 0, probes: 0 };
  private readonly deadline: number;
  reached: string | null = null;
  /** `reached`, as a `lib.storage.integrity` message. */
  reachedSay: Say | null = null;

  constructor(readonly limits: IntegrityLimits, private readonly signal?: AbortSignal) {
    this.deadline = Date.now() + limits.milliseconds;
  }

  /** Throws when cancelled; false (with `reached` set) when a limit is used up. */
  allows() {
    if (this.signal?.aborted) throw new IntegrityCheckCancelled("The check was cancelled.");
    if (this.reached) return false;
    if (Date.now() > this.deadline) { const seconds = Math.round(this.limits.milliseconds / 1000); this.reached = `the ${seconds} s time limit`; this.reachedSay = { code: "timeLimitReached", params: { seconds } }; }
    else if (this.statistics.entriesVisited > this.limits.entries) { this.reached = `the limit of ${this.limits.entries} entries`; this.reachedSay = { code: "entryLimitReached", params: { count: this.limits.entries } }; }
    else if (this.statistics.bytesRead > this.limits.bytes) { const megabytes = Math.round(this.limits.bytes / 1024 / 1024); this.reached = `the limit of ${megabytes} MB read`; this.reachedSay = { code: "byteLimitReached", params: { megabytes } }; }
    return !this.reached;
  }

  /**
   * Whether `bytes` more can still be read within the byte limit. Asked
   * before a file is read, so one the budget can't hold is never read: when
   * it can't, the budget is used up (`reached` says so).
   */
  admits(bytes: number) {
    if (this.reached) return false;
    if (this.statistics.bytesRead + bytes <= this.limits.bytes) return true;
    const megabytes = Math.round(this.limits.bytes / 1024 / 1024);
    this.reached = `the limit of ${megabytes} MB read`;
    this.reachedSay = { code: "byteLimitReached", params: { megabytes } };
    return false;
  }

  read(bytes: number) { this.statistics.filesRead += 1; this.statistics.bytesRead += bytes; }
  /** Bytes of a file being streamed (hashing), counted as they pass so a stop is not held up by a big file. */
  streamed(bytes: number) { this.statistics.bytesRead += bytes; }
  visit(entries = 1) { this.statistics.entriesVisited += entries; }
  probe() { this.statistics.probes += 1; }
}

const LABELS: Record<IntegrityCheckId, string> = {
  notebook: "Notebook settings",
  sidecars: "Annotations, ink, transcripts and other side files",
  assets: "Note images and Python code",
  images: "Images in notes",
  links: "Links in notes",
  latex: "LaTeX includes, figures and bibliographies",
  records: "Stars, tags, reviews and undo history",
  references: "Reference attachments and .bib tether",
  indexes: "Link, citation and search indexes, .bib mirror",
  migrations: "Migrations",
  sharing: "Shared notebook",
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const under = (libraryPath: string, notebook: string) => libraryPath.startsWith(`${notebook}/`);
/**
 * The one archive scope: every module that decides from the notebook's files
 * (the check, Try to fix, Acknowledge, the tree's upkeep) lists them with the
 * archive (`_archive`) included, so an archived file counts wherever it can
 * change a verdict (where a side file went, whether Python code has an owner,
 * a LaTeX source). Pass what `listVisibleNotebookFiles` takes besides it.
 */
export const listNotebookInventory = (notebook: string, options: Omit<NonNullable<Parameters<typeof listVisibleNotebookFiles>[1]>, "includeArchive"> = {}) =>
  listVisibleNotebookFiles(notebook, { ...options, includeArchive: true });

/**
 * Whether a listing saw every file. When not (cut by a limit, or a folder
 * that could not be read), a decision that needs "no other file has this
 * name, bytes or owner" can't be made: such a check is partial and offers
 * nothing for deletion.
 */
export const inventoryComplete = (listing: { truncated: boolean; unreadable: readonly string[] }) => !listing.truncated && listing.unreadable.length === 0;

/** A check that could not look at `count` files (no permission, a drive that is not connected) says so instead of passing them. */
const filesUnchecked = (count: number) => said("filesUnchecked", `${plural(count, "file")} could not be checked (no permission, or a drive that is not connected), so what depends on ${count === 1 ? "it" : "them"} is not judged.`, { count });

/** `73` → "1:13", `3723` → "1:02:03". */
function clock(seconds: number) {
  const whole = Math.floor(seconds);
  const parts = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  return (parts[0] ? parts : parts.slice(1)).map((part, index) => index ? String(part).padStart(2, "0") : String(part)).join(":");
}

/**
 * A recording's length, from its transcript or else its waveform, but only a
 * length saved for this recording as it is now (the size it was made for, as
 * the owners judge their caches). `stale` says a saved length exists that
 * does not belong to the file (replaced since) or the file could not be
 * measured, so the position of a link can't be judged; null and not stale:
 * nothing saved.
 */
const readTranscriptLength = (value: unknown) => { const transcript = parseTranscript(value); return transcript && { duration: transcript.audio.duration, size: transcript.audio.size }; };

async function recordingDuration(libraryPath: string): Promise<{ duration: number | null; stale: boolean }> {
  const [notebook, ...parts] = libraryPath.split("/");
  let size: number;
  try { size = (await stat(filePathFromParts(notebook, parts))).size; } catch { return { duration: null, stale: true }; }
  let stale = false;
  for (const [file, read] of [
    [transcriptPath(notebook, parts), readTranscriptLength],
    // A shared recording's transcript (or one a takedown left beside it) is the companion file next to it.
    [transcriptCompanionFilePath(notebook, parts), readTranscriptLength],
    [audioPeaksPath(notebook, parts), (value: unknown) => { const peaks = value as { key?: unknown; duration?: unknown } | null; return { duration: peaks?.duration, size: typeof peaks?.key === "string" ? Number(peaks.key.split(":")[0]) : NaN }; }],
  ] as const) {
    try {
      const saved = read(JSON.parse(await readFile(file, "utf8")));
      if (!saved || typeof saved.duration !== "number" || !Number.isFinite(saved.duration) || saved.duration <= 0) continue;
      if (saved.size === size) return { duration: saved.duration, stale: false };
      stale = true;
    } catch { /* None saved, or unreadable: the next one may say. */ }
  }
  return { duration: null, stale };
}

/** Whether something is at a path. `unknown` (no permission, a drive error) is never reported as missing. */
async function probe(absolutePath: string): Promise<"present" | "absent" | "unknown"> {
  try { await lstat(absolutePath); return "present"; }
  catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unknown"; }
}

/**
 * Whether a readable file is at a path, for the consumers that open it as one
 * (an image, a TeX source): a folder, or a link whose target is gone, is
 * `absent`; `unknown` (no permission, a drive error) is never reported as missing.
 */
async function probeFile(absolutePath: string): Promise<"present" | "absent" | "unknown"> {
  try {
    if (!(await stat(absolutePath)).isFile()) return "absent";
    await access(absolutePath, constants.R_OK);
    return "present";
  } catch (error) { return ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unknown"; }
}

/**
 * A file's bytes, read within the byte budget: its size is checked before the
 * read (a file the budget can't hold is never read: the budget is then used
 * up) and the bytes actually read are counted. Null when not read, whether
 * for the budget or because it can't be read; `budget.reached` tells which.
 */
async function readWithin(budget: IntegrityBudget, file: string): Promise<Buffer | null> {
  budget.allows();
  let size: number;
  try { size = (await stat(file)).size; } catch { return null; }
  if (!budget.admits(size)) return null;
  try {
    const bytes = await readFile(file);
    budget.read(bytes.length);
    return bytes;
  } catch { return null; }
}

/**
 * The SHA-256 of a file, streamed so that a stop or a spent budget ends it
 * between chunks instead of after the whole file. "over-budget" when the file
 * would pass the byte limit or the budget ran out meanwhile; null when it
 * can't be read. A stop throws `IntegrityCheckCancelled`.
 */
async function hashWithin(budget: IntegrityBudget, file: string, size: number): Promise<string | null | "over-budget"> {
  // A file too big for what is left is not compared (reported per file), while smaller ones still can be.
  if (!budget.allows() || budget.statistics.bytesRead + size > budget.limits.bytes) return "over-budget";
  const hash = createHash("sha256");
  budget.read(0);
  try {
    for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
      budget.streamed(chunk.length);
      if (!budget.allows()) return "over-budget";
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof IntegrityCheckCancelled) throw error;
    return null;
  }
  return hash.digest("hex");
}

/** The places a file's side files live (one per kind that applies to its type, and a note's Python code), as `existingSidecars` looks them up. */
function sidecarSlots(libraryPath: string, fileType: string | null) {
  const [notebook, ...parts] = libraryPath.split("/");
  const slots: { kind: string; absolutePath: string }[] = [];
  if (!fileType) return slots;
  for (const kind of SIDECAR_KINDS) if (kind.appliesTo(fileType)) slots.push({ kind: kind.id, absolutePath: kind.filePath(notebook, parts) });
  if (fileType === "markdown") {
    const python = splitFilePath(pythonSidecarPath(libraryPath));
    slots.push({ kind: "python", absolutePath: filePathFromParts(python.notebook, python.pathParts) });
  }
  return slots;
}

/**
 * Nothing is left at these places: each item itself, its side files, and the
 * records that name its old path (stars, tags, review comments, pending agent
 * changes, reference attachments, the tether, side files set aside for it).
 * The migration's final check; `unverified` when a place or a store could not
 * be checked, which is never read as clean.
 */
export async function checkNothingLeftAt(items: { label: string; absolutePath: string; libraryPath?: string; fileType?: string | null }[]) {
  const leftovers: string[] = [];
  let unverified = false;
  const unchecked = (label: string, why?: string) => { unverified = true; leftovers.push(`${label} (could not be checked${why ? `: ${why}` : ""})`); };
  const files: { label: string; libraryPath: string }[] = [];
  for (const item of items) {
    try {
      const state = await probe(item.absolutePath);
      if (state === "present") leftovers.push(item.label);
      if (state === "unknown") unchecked(item.label);
      if (!item.libraryPath || item.fileType === undefined) continue;
      files.push({ label: item.label, libraryPath: item.libraryPath });
      for (const slot of sidecarSlots(item.libraryPath, item.fileType)) {
        const found = await probe(slot.absolutePath);
        if (found === "present") leftovers.push(`${item.label} (${slot.kind})`);
        if (found === "unknown") unchecked(`${item.label} (${slot.kind})`);
      }
    } catch (error) {
      unchecked(item.label, error instanceof Error ? error.message : String(error));
    }
  }
  if (files.length) await recordsLeftAt(files, leftovers, unchecked);
  return { leftovers, unverified };
}

/** The stores that keep a record by a file's path, asked whether any still names one of `files`. */
async function recordsLeftAt(files: { label: string; libraryPath: string }[], leftovers: string[], unchecked: (label: string, why?: string) => void) {
  const labelOf = new Map(files.map((file) => [file.libraryPath, file.label]));
  const found = (libraryPath: string, record: string) => { const label = labelOf.get(libraryPath); if (label !== undefined) leftovers.push(`${label} (${record})`); };
  const guarded = async (what: string, read: () => Promise<void>) => { try { await read(); } catch (error) { unchecked(what, error instanceof Error ? error.message : String(error)); } };
  await guarded("stars and tags", async () => {
    const { metadata, damaged } = await inspectWorkspaceMetadata();
    if (damaged) return unchecked("stars and tags", damaged);
    for (const starred of metadata.starredFilePaths) found(starred, "star");
    for (const tagged of Object.keys(metadata.fileTags)) found(tagged, "tags");
  });
  await guarded("review comments", async () => {
    const reviews = await inspectReviewKeys(getStateRoot());
    if (reviews.damaged) return unchecked("review comments", reviews.damaged);
    for (const key of reviews.keys) found(key, "review comments");
  });
  await guarded("pending agent reviews", async () => {
    const pending = await listReviewEntryPaths();
    if (pending.unreadable) unchecked("pending agent reviews", `${pending.unreadable} could not be read`);
    for (const reviewed of pending.paths) found(reviewed, "agent changes");
  });
  await guarded("reference attachments", async () => {
    for (const library of await libraryNotebookNames()) {
      let inspected;
      try { inspected = await inspectReferenceLibrary(library); } catch (error) { unchecked(`reference library of ${library}`, error instanceof Error ? error.message : String(error)); continue; }
      if ("damaged" in inspected) { unchecked(`reference library of ${library}`, inspected.damaged); continue; }
      for (const entry of Object.values(inspected.library?.entries ?? {})) for (const attachment of entry.attachments) if (attachment.kind !== "url") found(attachment.path, "reference attachment");
    }
  });
  // Every notebook's tether, not only those of the notebooks the files are in: a library in another notebook may be tethered to a .bib here.
  const owners = new Set(files.map((file) => file.libraryPath.split("/")[0]));
  const tethered = new Set(owners);
  await guarded("notebooks with a .bib tether", async () => { for (const library of await libraryNotebookNames()) tethered.add(library); });
  for (const notebook of tethered) {
    await guarded(`.bib tether of ${notebook}`, async () => {
      const tether = await readTetherTarget(notebook);
      // A tether that can't be read is unverified only where it could name these files: in a notebook they are in, or any other (it may point here).
      if (tether && "damaged" in tether) return unchecked(`.bib tether of ${notebook}`, tether.damaged);
      if (tether && "libraryPath" in tether) found(tether.libraryPath, ".bib tether");
    });
    if (!owners.has(notebook)) continue;
    await guarded(`side files set aside in ${notebook}`, async () => {
      for (const { record } of await readOrphans(notebook)) found(record.originalPath, "set-aside side file");
    });
  }
}

/**
 * What Acknowledge may remove in a shared notebook: this computer's own records (stars, tags, review comments, attachments, local side files
 * of a file the manifest no longer lists, caches, set-aside copies, the citation index). Never what the host owns (ink, transcripts, live
 * marks, Python code, images and files of the notebook) and never a record judged only by the version of a file that may still be arriving.
 */
export function sharedMayClear(action: CleanupAction, notebook: string): boolean {
  // A record of a path the manifest does not govern (the notebook's local `_archive`, another notebook's file) is this computer's whatever its kind: the disk decides it, as in a local notebook.
  const subject = action.gone ?? (action.type === "side-file" || action.type === "ink-files" ? action.filePath : "path" in action ? action.path : null);
  if (subject && action.type !== "asset" && !isSharedNotebookPath(subject)) return true;
  switch (action.type) {
    case "star": case "tags": case "review": case "attachment": case "citations": case "tether": return true;
    // What Try to fix refuses as the host's (live PDF marks, ink) is not offered for removal either: one rule.
    case "set-aside": return !hostOwnsSideFile(action.file.startsWith("ink/") ? "ink" : action.file.startsWith("annotations/") ? "pdf-annotations" : "", notebook);
    // A live PDF's marks sidecar left at a path the manifest no longer lists (an earlier build's) is reported, so it is clearable once the manifest confirms the path is gone (`staleness` holds it when listed or arriving); Try to fix still refuses it as the host's.
    case "side-file": return (!hostOwnsSideFile(action.kind, notebook) && (Boolean(action.gone) || action.kind === "pdf-text" || action.kind === "audio-peaks")) || (action.kind === "pdf-annotations" && Boolean(action.gone));
    default: return false;
  }
}

type NoteDocument = { documentPath: string; content: string };

/**
 * The notebook's Markdown notes, read within the check's budget: notes are read
 * one by one while the budget allows (time, entries, and `byteLimit` of raw
 * bytes, taken from the file's size before it is read); those after that are
 * only counted, so a huge or slow collection can't exceed the budget before
 * the first check starts. The walk asks the budget at each entry, so a stop
 * ends it. `complete` is false when some folder or note could not be read,
 * or notes were left out.
 */
async function readNotes(notebook: string, budget: IntegrityBudget, byteLimit: number) {
  const documents: NoteDocument[] = [];
  let remaining = 20_000;
  let complete = true;
  let leftOut = 0;
  let byteLimited = false;
  let spent = false;
  let bytes = 0;
  const visit = async (parts: string[]) => {
    let entries;
    try { entries = await readdir(path.join(notebookPath(notebook), ...parts), { withFileTypes: true }); }
    catch { complete = false; return; }
    for (const entry of entries) {
      if (--remaining < 0) { complete = false; return; }
      if (entry.name.startsWith(".") || [MARKDOWN_ASSETS_DIR, "node_modules", "__pycache__", "bower_components"].includes(entry.name)) continue;
      const next = [...parts, entry.name];
      if (entry.isDirectory()) {
        // A folder not entered may hold notes that are not even counted: the notes are not complete.
        if (spent || !budget.allows()) { spent = true; complete = false; continue; }
        await visit(next);
        continue;
      }
      if (!entry.isFile() || !MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (spent || !budget.allows()) { spent = true; leftOut += 1; continue; }
      // The size is checked before the read, and the bytes actually read are counted after it.
      let size: number;
      try { size = (await stat(filePathFromParts(notebook, next))).size; }
      catch { complete = false; continue; }
      if (bytes + size > byteLimit) { spent = true; byteLimited = true; leftOut += 1; continue; }
      let raw: Buffer;
      try { raw = await readFile(filePathFromParts(notebook, next)); }
      catch { complete = false; continue; }
      if (bytes + raw.length > byteLimit) { spent = true; byteLimited = true; leftOut += 1; continue; }
      bytes += raw.length;
      budget.visit();
      budget.read(raw.length);
      documents.push({ documentPath: relativeFilePath(notebook, next), content: raw.toString("utf8") });
    }
  };
  await visit([]);
  return { documents, complete: complete && leftOut === 0, leftOut, byteLimited };
}

/**
 * Check a notebook. Reads only, down to where things are found: the linked
 * folders' state is read without its upgrades (paths.ts withReadOnlyStorage).
 * Findings say what is wrong and how to set it right.
 */
export function verifyNotebook(name: string, options: VerifyOptions = {}): Promise<IntegrityReport> {
  // A shared notebook's pending record moves are applied by the verify route before this (settleSharedRecordsBeforeCheck): the check itself only reads.
  return withReadOnlyStorage(() => checkNotebook(name, options));
}

async function checkNotebook(name: string, options: VerifyOptions): Promise<IntegrityReport> {
  const started = Date.now();
  const limits = { ...DEFAULT_INTEGRITY_LIMITS, ...options.limits };
  const budget = new IntegrityBudget(limits, options.signal);
  const notebook = assertSafeSegment(name, "Notebook name");
  if (notebook.startsWith(".")) throw new StorageError("That is not a notebook.", 400);
  if (getLinkedFolder(notebook)?.unresolved) throw new StorageError(`${notebook} is not connected on this computer. Reconnect it to check it.`, 409);
  if (!(await lstat(notebookPath(notebook)).catch(() => null))?.isDirectory()) throw new StorageError("Notebook not found.", 404);

  const shared = isSharedNotebookPath(notebook);
  /** A shared notebook is compared with the host's file list (read only), read before the walk so that a change during the check shows. */
  const manifestBefore = shared ? await readManifestView(notebook) : null;
  /** The file list was the same at the end of the check, so what was concluded from it stands. */
  let manifestStable = manifestBefore?.state === "ok";
  const checkIds = (Object.keys(LABELS) as IntegrityCheckId[]).filter((id) => id !== "sharing" || shared);
  const findings: IntegrityFinding[] = [];
  const checks: IntegrityCheckResult[] = [];
  const disk = fileExistence();
  /** The shared notebook lists this file (so one the disk lacks is still arriving, not gone). */
  const listed = (libraryPath: string) => manifestBefore?.state === "ok" && isSharedNotebookPath(libraryPath) && manifestHasFile(manifestBefore, libraryPath);
  /** Files the manifest lists that this computer does not have yet. */
  let undeliveredFiles: Promise<string[]> | null = null;
  const undelivered = () => undeliveredFiles ??= (async () => {
    if (manifestBefore?.state !== "ok") return [];
    const files = [...manifestBefore.files.keys()];
    await disk.check(files);
    return files.filter((file) => !disk.exists(file) && !disk.unknown(file));
  })();
  const manifestUnavailable = manifestBefore?.state === "unavailable"
    ? said("sharedManifestUnavailable", `The host could not give the shared notebook's file list (${manifestBefore.reason}), so what depends on it was not judged.`, { reason: manifestBefore.reason })
    : null;
  const counts = { files: 0, notes: 0, sidecars: 0 };
  /** The notebooks in the library; a linked folder that is not connected here is still a notebook, never a vanished one. */
  const knownNotebooks = await libraryNotebookNames();
  const isVanished = (name: string) => !!name && !name.startsWith(".") && !knownNotebooks.includes(name) && !getLinkedFolder(name);

  // One walk and one read of the notes, shared by every check. Progress is
  // reported before them: on a large or slow notebook they are most of the wait.
  options.onProgress?.({ check: "notebook", label: LABELS.notebook, index: 0, total: checkIds.length });
  let announced = true;
  const staged: string[] = [];
  // One archive scope for every check: the archive is listed, as Try to fix
  // lists it, so an archived file counts wherever it can change a verdict (a
  // side file's return, a note's Python code, a LaTeX source). Each entry is
  // counted and the budget asked as the walk goes.
  const visible = await listNotebookInventory(notebook, {
    limit: limits.entries,
    onEntry: () => { budget.visit(); return budget.allows(); },
    onHidden: (libraryPath, entryName) => { if (entryName.startsWith(".libera-migrating-")) staged.push(libraryPath); },
  });
  counts.files = visible.files.length;
  /** Not every file was listed: where a side file went, or whether a note owns some code, can't be told then. */
  const inventoryCut = !inventoryComplete(visible);
  const unreadableFolders = said("foldersUnreadable",
    `${plural(visible.unreadable.length, "folder")} could not be read (${visible.unreadable.slice(0, 3).join(", ")}${visible.unreadable.length > 3 ? ", …" : ""}), so files in ${visible.unreadable.length === 1 ? "it" : "them"} were not seen.`,
    { count: visible.unreadable.length, names: visible.unreadable.slice(0, 3).join(", ") + (visible.unreadable.length > 3 ? ", …" : "") });
  const notebookTooLarge = said("notebookTooLarge", `${notebook} has more files than one check reads (${visible.files.length}).`, { name: notebook, count: visible.files.length });
  const notes = await readNotes(notebook, budget, limits.bytes);
  counts.notes = notes.documents.length + notes.leftOut;
  /** Notes read within the budget; the checks that read notes say when some were left out. */
  const readable = notes.documents;
  const notesCut = notes.leftOut
    ? notes.byteLimited || !budget.reachedSay
      ? said("notesLeftOut", `${notes.leftOut} notes were left out (the limit of ${Math.round(limits.bytes / 1024 / 1024)} MB read).`,
        { count: notes.leftOut, megabytes: Math.round(limits.bytes / 1024 / 1024) })
      : said("stoppedAt", `Stopped at ${budget.reached}.`, { reason: budget.reachedSay.code, ...budget.reachedSay.params })
    : null;
  let cancelled = false;

  /** Each image embed's target is probed once, by the checks that ask about it. */
  const probes = new Map<string, Promise<"present" | "absent" | "unknown">>();
  const probeOnce = (absolutePath: string) => {
    if (!probes.has(absolutePath)) probes.set(absolutePath, probe(absolutePath));
    return probes.get(absolutePath)!;
  };

  const fileProbes = new Map<string, Promise<"present" | "absent" | "unknown">>();
  const probeFileOnce = (absolutePath: string) => {
    if (!fileProbes.has(absolutePath)) fileProbes.set(absolutePath, probeFile(absolutePath));
    return fileProbes.get(absolutePath)!;
  };

  const absoluteOf = (libraryPath: string) => { const [owner, ...parts] = libraryPath.split("/"); return path.join(notebookPath(owner), ...parts); };

  const order = checkIds;
  let findingsCut = false;
  const run = async (id: IntegrityCheckId, check: (add: (finding: Omit<IntegrityFinding, "check">) => void) => Promise<Said | Said[] | void>) => {
    if (cancelled) return;
    // The first check was announced before the notes were read.
    if (id === "notebook" && announced) announced = false;
    else options.onProgress?.({ check: id, label: LABELS[id], index: order.indexOf(id), total: order.length });
    const before = findings.length;
    try {
      // A check is not started once the budget is gone: it would read past the limit it reports.
      if (!budget.allows()) {
        const reason = said("stoppedAt", `Stopped at ${budget.reached}.`, { reason: budget.reachedSay!.code, ...budget.reachedSay!.params });
        checks.push({ id, label: LABELS[id], status: "incomplete", note: reason.text, notes: [{ code: reason.code, params: reason.params }] });
        return;
      }
      const add =(finding: Omit<IntegrityFinding, "check">) => {
        if (findings.length >= limits.findings) { findingsCut = true; return; }
        findings.push({ check: id, ...finding });
      };
      const returned = await check(add);
      let incomplete: Said[] = returned ? (Array.isArray(returned) ? returned : [returned]) : [];
      if (!incomplete.length && budget.reached && budget.reachedSay) incomplete = [said("stoppedAt", `Stopped at ${budget.reached}.`, { reason: budget.reachedSay.code, ...budget.reachedSay.params })];
      if (!incomplete.length && findingsCut) incomplete = [said("onlyFirstFindings", `Only the first ${limits.findings} findings are listed.`, { count: limits.findings })];
      checks.push({
        id, label: LABELS[id], status: incomplete.length ? "incomplete" : findings.length > before ? "findings" : "ok",
        ...(incomplete.length ? { note: incomplete.map((item) => item.text).join(" "), notes: incomplete.map(({ code, params }) => ({ code, ...(params ? { params } : {}) })) } : {}),
      });
    } catch (error) {
      if (error instanceof IntegrityCheckCancelled) { cancelled = true; return; }
      checks.push({ id, label: LABELS[id], status: "failed", note: error instanceof Error ? error.message : String(error) });
    }
  };

  await run("notebook", async (add) => {
    if (isSharedNotebookPath(notebook)) add({ severity: "info", path: notebook, message: "This is a shared notebook. Its files are kept in step by collaboration; this check compares this computer with the host's file list.", ...say("sharedNotebook") });
    let text: string | null = null;
    try { text = await readFile(notebookMetadataPath(notebook), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return said("settingsUnreadable", "The notebook's settings file could not be read."); }
    if (text === null) add({ severity: "info", path: notebook, message: "The notebook has no settings file, so its color, emoji and group are the defaults.", fix: "Edit the notebook and save to write one.", ...say("noSettingsFile", undefined, "noSettingsFileFix") });
    else {
      try { JSON.parse(text); }
      catch { add({ severity: "error", path: notebook, message: "The notebook's settings file can't be read, so its color, emoji and group are the defaults.", fix: "Restore it from your sync service's version history; saving the notebook's settings writes a new one.", ...say("settingsCorrupt", undefined, "settingsCorruptFix") }); }
    }
    if (visible.truncated) return notebookTooLarge;
    if (visible.unreadable.length) return unreadableFolders;
  });

  await run("sidecars", async (add) => {
    const { sidecars, unreadable } = await listSidecars(notebook, { companions: true });
    counts.sidecars = sidecars.length;
    // A shared notebook's files are the manifest's: a side file is orphaned when the host's list has no file at its path (a listed file not yet on the disk is arriving; a retired copy still on the disk is gone). Without the list nothing is judged.
    // Decided per path: the notebook's local `_archive` is not in the manifest, so its files are judged on the disk.
    const orphans = manifestBefore
      ? [
        ...manifestBefore.state === "ok" ? sidecars.filter((sidecar) => isSharedNotebookPath(sidecar.filePath) && !manifestHasFile(manifestBefore, sidecar.filePath)).map(({ kind, path, filePath }) => ({ kind, path, filePath })) : [],
        ...await findOrphanedSidecars(notebook, sidecars.filter((sidecar) => !isSharedNotebookPath(sidecar.filePath))),
      ]
      : await findOrphanedSidecars(notebook, sidecars);
    const orphaned = new Set(orphans.map((orphan) => orphan.path));
    /** The file each side file was made for (size and content hash), as it recorded it. */
    const identities = new Map<string, { size: number; contentHash: string }>();
    let unreadSidecars = 0;
    /** Side files that could not be read: what they say about their file is unknown, so nothing is offered for removal on their account. */
    const unread = new Set<string>();
    budget.visit(sidecars.length);
    // Each owner's reading of what it saved (sidecars.ts `inspect`), and the
    // file's size against the one the side file was made for: a stat, not a
    // hash. PDFs and images are read only to find where a missing file went
    // (below), and only those of the size it had.
    const sizes = new Map<string, number | null>();
    /** Files whose size could not be read for a reason other than being gone (no permission, a drive error): not compared, never passed. */
    const sizeUnknown = new Set<string>();
    const sizeOf = async (fileParts: string[]) => {
      const key = fileParts.join("/");
      if (!sizes.has(key)) {
        budget.probe();
        const stats = await lstat(path.join(notebookPath(notebook), ...fileParts)).catch((error: NodeJS.ErrnoException) => { if (!["ENOENT", "ENOTDIR"].includes(error.code ?? "")) sizeUnknown.add(key); return null; });
        sizes.set(key, stats?.isFile() ? stats.size : null);
      }
      return sizes.get(key) ?? null;
    };
    // Where a side file recorded the hash of its file, a file of the same size
    // is compared by content too (a document replaced by another of the same
    // size is not the one the side file was made for). Reading counts against
    // the byte budget; a file the budget no longer covers is reported as not
    // compared, never passed.
    const fileHashes = new Map<string, Promise<string | null | "over-budget">>();
    const notCompared = new Set<string>();
    const hashOf = (fileParts: string[], size: number) => {
      const key = fileParts.join("/");
      if (!fileHashes.has(key)) fileHashes.set(key, hashWithin(budget, path.join(notebookPath(notebook), ...fileParts), size));
      return fileHashes.get(key)!;
    };
    /** Whether the file's content is not the one recorded (same size assumed); null when it could not be compared, which is counted as not compared. */
    const contentDiffers = async (filePath: string, fileParts: string[], size: number, recorded: string) => {
      const hash = await hashOf(fileParts, size);
      if (hash === "over-budget" || hash === null) { notCompared.add(filePath); return null; }
      return hash.toLowerCase() !== recorded.toLowerCase();
    };
    const outdatedCaches = new Map<string, CleanupAction[]>();
    const name = (kind: string) => kind.replace(/-/g, " ");
    for (const sidecar of sidecars) {
      if (!budget.allows()) break;
      const kind = sidecar.kindInfo;
      const sources: NonNullable<SidecarInspection["source"]>[] = [];
      /** Ink: each author file's recorded source, by file name. */
      let inkSources: { name: string; size: number; contentHash: string | null }[] = [];
      /** Ink: the folder holds author files drawn on different bytes, which the upkeep takes whole to no file (ink.ts decideInkSource). */
      let inkConflict = false;
      if (kind.layout === "folder") {
        if (!kind.inspectFolder) continue;
        let ink;
        try { ink = await kind.inspectFolder(sidecar.path, getFileType(sidecar.fileParts.at(-1) ?? "") ?? ""); } catch { unreadSidecars += 1; unread.add(sidecar.path); continue; }
        budget.read(ink.bytes);
        if (ink.unreadable.length && orphaned.has(sidecar.path)) unread.add(sidecar.path);
        if (ink.unreadable.length) add({ severity: "error", path: sidecar.filePath, message: `${plural(ink.unreadable.length, "ink file")} of ${sidecar.filePath} can't be read, so ${ink.unreadable.length === 1 ? "its" : "their"} ink is not shown (${ink.unreadable.slice(0, 3).join(", ")}).`, fix: "Restore them from your sync service's version history.", ...say("inkUnreadable", { count: ink.unreadable.length, path: sidecar.filePath, names: ink.unreadable.slice(0, 3).join(", ") }, "inkUnreadableFix") });
        if (ink.misplaced.length) add({ severity: "info", path: sidecar.filePath, message: `${plural(ink.misplaced.length, "ink file")} of ${sidecar.filePath} ${ink.misplaced.length === 1 ? "belongs" : "belong"} to a page or block this kind of file doesn't have, so ${ink.misplaced.length === 1 ? "it is" : "they are"} never shown.`, clear: [{ type: "ink-files", filePath: sidecar.filePath, names: ink.misplaced }], ...say("inkMisplaced", { count: ink.misplaced.length, path: sidecar.filePath }) });
        if (ink.droppedStrokes) add({ severity: "warning", path: sidecar.filePath, message: `${plural(ink.droppedStrokes, "stroke")} in the ink of ${sidecar.filePath} can't be read and ${ink.droppedStrokes === 1 ? "is" : "are"} not shown.`, fix: "Restore the ink folder from your sync service's version history before drawing on that page again.", ...say("strokesUnreadable", { count: ink.droppedStrokes, path: sidecar.filePath }, "strokesUnreadableFix") });
        sources.push(...ink.sources.map((source) => ({ size: source.size, contentHash: source.sha256 })));
        inkSources = ink.sourceFiles.map(({ name, source }) => ({ name, size: source.size, contentHash: source.sha256 || null }));
        inkConflict = decideInkSource(ink.sources) === "conflict";
      } else {
        const bytes = await readWithin(budget, sidecar.path);
        // The budget, not the file, is why nothing more is read: the check says where it stopped.
        if (!bytes) { if (budget.reached) break; unreadSidecars += 1; unread.add(sidecar.path); continue; }
        const text = bytes.toString("utf8");
        let inspection: SidecarInspection | null = null;
        let valid = true;
        try { const value = JSON.parse(text); inspection = kind.inspect ? kind.inspect(value) : null; valid = !kind.inspect || inspection !== null; } catch { valid = false; }
        if (kind.cache) {
          // Caches make themselves again; one line per kind says how many would be.
          if (!valid || (inspection?.source && !orphaned.has(sidecar.path) && await sizeOf(sidecar.fileParts) !== inspection.source.size)) outdatedCaches.set(kind.id, [...outdatedCaches.get(kind.id) ?? [], { type: "side-file", kind: kind.id, filePath: sidecar.filePath }]);
          continue;
        }
        // What a damaged side file says about its file is unknown: if its file is gone it is not offered for removal (it may be the only copy of an identity that finds the file).
        if (!valid) { if (orphaned.has(sidecar.path)) unread.add(sidecar.path); add({ severity: "error", path: sidecar.filePath, message: `The saved ${name(sidecar.kind)} of ${sidecar.filePath} can't be read.`, fix: "Restore it from a backup or your sync service's version history.", ...say("sideFileUnreadable", { kind: sidecar.kind, path: sidecar.filePath }, "sideFileUnreadableFix") }); continue; }
        if (inspection?.dropped) add({ severity: "warning", path: sidecar.filePath, message: `${inspection.dropped} ${inspection.records} in the saved ${name(sidecar.kind)} of ${sidecar.filePath} can't be read: they are not shown, and are lost the next time it is saved.`, fix: "Restore the side file from your sync service's version history before changing it.", ...say("sideFileDropped", { dropped: inspection.dropped, records: inspection.records, kind: sidecar.kind, path: sidecar.filePath }, "sideFileDroppedFix") });
        if (inspection?.source) sources.push(inspection.source);
      }
      // One rule with the upkeep: a folder of several versions names no one file, so none is promised it and its ink is not offered for removal.
      if (inkConflict) unread.add(sidecar.path);
      const identity = inkConflict ? undefined : sources.find((source) => source.contentHash);
      if (identity?.contentHash) identities.set(sidecar.path, { size: identity.size, contentHash: identity.contentHash });
      if (!sources.length || orphaned.has(sidecar.path)) continue;
      const size = await sizeOf(sidecar.fileParts);
      if (size === null) { if (sizeUnknown.has(sidecar.fileParts.join("/"))) notCompared.add(sidecar.filePath); continue; }
      if (kind.layout === "folder") {
        // One page's file with an old size is not the folder: the pages drawn on the current version stay.
        const stale = inkSources.filter((recorded) => recorded.size !== size).map((recorded) => recorded.name);
        if (stale.length) add({ severity: "info", path: sidecar.filePath, message: `${plural(stale.length, "ink file")} of ${sidecar.filePath} ${stale.length === 1 ? "was" : "were"} drawn on another version of the file (its size differs), so ${stale.length === 1 ? "it" : "they"} may no longer fit it (${stale.slice(0, 3).join(", ")}).`, fix: "Open the file to see whether the ink still fits; the pages drawn on the current version are kept.", clear: [{ type: "ink-files", filePath: sidecar.filePath, names: stale }], ...say("inkStale", { count: stale.length, path: sidecar.filePath, names: stale.slice(0, 3).join(", ") }, "inkStaleFix") });
        const sameSize = inkSources.filter((recorded) => recorded.size === size && recorded.contentHash);
        if (sameSize.length) {
          // The same size, another content: the file was replaced.
          const hash = await hashOf(sidecar.fileParts, size);
          if (hash === "over-budget" || hash === null) notCompared.add(sidecar.filePath);
          const changed = typeof hash === "string" ? sameSize.filter((recorded) => recorded.contentHash!.toLowerCase() !== hash.toLowerCase()).map((recorded) => recorded.name) : [];
          if (changed.length) add({ severity: "info", path: sidecar.filePath, message: `${plural(changed.length, "ink file")} of ${sidecar.filePath} ${changed.length === 1 ? "was" : "were"} drawn on another file (its content differs, though its size is the same), so ${changed.length === 1 ? "it" : "they"} may no longer fit it (${changed.slice(0, 3).join(", ")}).`, fix: "Open the file to see whether the ink still fits; the pages drawn on the current version are kept.", clear: [{ type: "ink-files", filePath: sidecar.filePath, names: changed }], ...say("inkStaleContent", { count: changed.length, path: sidecar.filePath, names: changed.slice(0, 3).join(", ") }, "inkStaleFix") });
        }
      } else if (sources.some((recorded) => recorded.size !== size) || (await Promise.all(sources.filter((recorded) => recorded.contentHash).map((recorded) => contentDiffers(sidecar.filePath, sidecar.fileParts, size, recorded.contentHash!)))).some((differs) => differs === true)) {
        const sameBytes = !sources.some((recorded) => recorded.size !== size);
        // Annotations and comments are people's work on a version that may differ only a little: never offered for removal.
        const work = kind.id === "pdf-annotations" || kind.id === "image-annotations";
        add({ severity: "info", path: sidecar.filePath, message: `The ${name(sidecar.kind)} of ${sidecar.filePath} was saved for another version of the file (${sameBytes ? "its content differs, though its size is the same" : "its size differs"}), so it may no longer match it.`, fix: work ? "Open the file to see whether it still matches; they are kept either way." : "Open the file to see whether it still matches; make it again if not.", ...(work ? {} : { clear: [{ type: "side-file", kind: sidecar.kind, filePath: sidecar.filePath }] }), ...say(sameBytes ? "sideFileStaleContent" : "sideFileStale", { kind: sidecar.kind, path: sidecar.filePath }, work ? "sideFileStaleFixKept" : "sideFileStaleFix") });
      }
    }
    for (const [kind, clear] of outdatedCaches) {
      const count = clear.length;
      add({ severity: "info", path: notebook, message: `${count} ${kind === "pdf-text" ? (count === 1 ? "PDF text cache is" : "PDF text caches are") : (count === 1 ? "waveform is" : "waveforms are")} out of date or can't be read; ${count === 1 ? "it is" : "they are"} made again when needed.`, clear, ...say(kind === "pdf-text" ? "pdfTextOutOfDate" : "waveformsOutOfDate", { count }) });
    }
    // Side files of files that are gone. The tree's reconciliation moves a
    // PDF's side files and the ink of a PDF or image to the one file with the
    // bytes they recorded (pdf-sidecars.ts matchByIdentity); the same rule
    // says here where they will go. Only files of the recorded size are hashed.
    const follows = (kind: string, fileType: string | null) =>
      (fileType === "pdf" && ["pdf-annotations", "pdf-outline", "definitions"].includes(kind)) || (kind === "ink" && (fileType === "pdf" || fileType === "image"));
    const sized = new Map<string, Promise<{ path: string; size: number }[]>>();
    /** The candidates were not all measured (the budget ran out): a file of the recorded size may be among those left out. */
    let candidatesCut = false;
    const filesOfType = (fileType: string) => {
      if (!sized.has(fileType)) sized.set(fileType, (async () => {
        const found: { path: string; size: number }[] = [];
        for (const file of visible.files) {
          if (getFileType(file) !== fileType) continue;
          if (!budget.allows()) { candidatesCut = true; break; }
          budget.probe();
          const size = await sizeOf(file.split("/").slice(1));
          if (size !== null) found.push({ path: file, size });
          else if (sizeUnknown.has(file.split("/").slice(1).join("/"))) candidatesCut = true;
        }
        return found;
      })());
      return sized.get(fileType)!;
    };
    const hashes = new Map<string, Promise<string | null>>();
    /** Whether a file's slot for this kind of side file is taken: the upkeep's own test (the file system's case rules), not a lower-cased guess. */
    const slotTaken = (kind: string) => slotTakenBy(SIDECAR_KINDS.find((candidate) => candidate.id === kind)!.filePath);
    /** Hashes the same-size candidates one by one within the budget (matchByIdentity would hash them outside it); one not compared is counted as such. */
    const hashSameSize = async (sameSize: { path: string; size: number }[]) => {
      for (const candidate of sameSize) {
        if (hashes.has(candidate.path)) continue;
        const hash = await hashOf(candidate.path.split("/").slice(1), candidate.size);
        if (typeof hash !== "string") notCompared.add(candidate.path);
        hashes.set(candidate.path, Promise.resolve(typeof hash === "string" ? hash : null));
      }
    };
    /**
     * Where the file a side file was made for went: its path; null when no
     * file has its bytes; "unknown" when a file of its size could not be
     * hashed (budget, a stop, a read error), so one may have them. Each
     * candidate is hashed in turn within the budget (matchByIdentity would
     * hash them outside it), and one not compared is counted as such.
     */
    const owner = async (kind: string, fileType: string | null, identity: { size: number; contentHash: string } | undefined): Promise<string | null | "unknown"> => {
      if (!identity || !follows(kind, fileType)) return null;
      const candidates = kind === "ink" ? [...await filesOfType("pdf"), ...await filesOfType("image")] : await filesOfType(fileType!);
      const taken = slotTaken(kind);
      const sameSize: { path: string; size: number }[] = [];
      for (const candidate of candidates) if (candidate.size === identity.size && !(await taken(candidate.path))) sameSize.push(candidate);
      await hashSameSize(sameSize);
      const found = await matchByIdentity(identity, candidates, taken, hashes);
      if (found) return found;
      for (const candidate of sameSize) if (await hashes.get(candidate.path) === null) return "unknown";
      return null;
    };
    for (const orphan of orphans) {
      if (!budget.allows()) break;
      const what = `Saved ${name(orphan.kind)} of ${orphan.filePath}, which is not in the notebook`;
      // The upkeep reattaches by content only where upkeepReattachesByContent says so: never promised in a shared notebook, where it does not.
      let moved = upkeepReattachesByContent(notebook) ? await owner(orphan.kind, getFileType(orphan.filePath), identities.get(orphan.path)) : null;
      // Ink follows its file renamed only in case or Unicode normalization (ink.ts reconcileInkFolders, by the name rule), with or without recorded bytes.
      if (moved === null && orphan.kind === "ink" && upkeepReattachesByContent(notebook)) moved = await foldedAliasOf(orphan.filePath);
      // Offered for removal only when every input is known: a side file that could not be read, a listing that was cut, a candidate that could not be hashed may each hide the file it follows.
      const decided = moved === null && !unread.has(orphan.path) && (shared || (!inventoryCut && !candidatesCut));
      add(moved !== null && moved !== "unknown"
        ? { severity: "info", path: orphan.filePath, message: `${what}, belong to ${moved}: the same file, moved outside the app. They go to it the next time the notebook is opened.`, ...say("orphanSideFileMoved", { kind: orphan.kind, path: orphan.filePath, moved }) }
        : { severity: "warning", path: orphan.filePath, message: `${what}.`, fix: "Put the file back where it was and it is found again. If it is gone for good, the side file can be removed from the notebook's .libera folder; keep a copy if unsure.", ...(decided ? { clear: [{ type: "side-file", kind: orphan.kind, filePath: orphan.filePath, gone: orphan.filePath, ...(identities.has(orphan.path) && upkeepReattachesByContent(notebook) ? { identified: true as const } : {}) }] } : {}), ...say("orphanSideFile", { kind: orphan.kind, path: orphan.filePath }, shared ? "orphanSideFileSharedFix" : "orphanSideFileFix") });
    }
    // Notes still in an older layout, keyed by file name alone: read without
    // upgrading them (annotations.ts listLegacyAnnotations). The migrator gives
    // them to the one file of that name when it is opened, and sets them aside
    // when there are several.
    const older = await listLegacyAnnotations(notebook);
    if (older.unreadable) unreadSidecars += 1;
    for (const { kind, name: fileName, owners } of older.legacy) {
      if (owners.length === 1) {
        const owned = `${notebook}/${owners[0].join("/")}`;
        add({ severity: "info", path: owned, message: `Saved ${kind} annotations of ${owned} are still in an older layout; they are moved to it the next time it is opened.`, ...say("legacyAnnotations", { kind, path: owned }) });
      } else if (owners.length) {
        add({ severity: "warning", path: notebook, message: `Saved ${kind} annotations of "${fileName}" are in an older layout that does not say which of ${owners.length} files of that name they belong to, so none of them gets them: they are set aside the next time one is opened.`, fix: "Copy the notes out of the notebook's .libera folder if you want to keep them; they can't be matched to a file by name alone.", ...say("legacyAnnotationsAmbiguous", { kind, name: fileName, count: owners.length }, "legacyAnnotationsAmbiguousFix") });
      } else {
        add({ severity: "info", path: notebook, message: `Saved ${kind} annotations of "${fileName}" are in an older layout and no file of that name is in the notebook. A file of that name that comes back, alone in the notebook, is given them.`, ...say("legacyAnnotationsNoFile", { kind, name: fileName }) });
      }
    }
    // Side files set aside for files that left the notebook outside the app,
    // waiting for them to come back. Those whose file is back go to it the
    // next time the notebook is opened, by the owners' rules
    // (pdf-sidecars.ts reconcilePdfSidecars, ink.ts reconcileInkFolders): the
    // same bytes, or, with none recorded, the file back under its old path
    // without side files of that kind. They are never stale.
    const comesBack = async (kind: string, fileType: string | null, originalPath: string, identity: { size: number; contentHash: string } | null): Promise<string | null | "unknown"> => {
      if (!upkeepReattachesByContent(notebook)) {
        // The shared upkeep (reconcilePdfSidecars): only back under its old path, as the same bytes, with the slot free; ink never.
        if (kind === "ink" || !identity || (await disk.isFile(originalPath)) !== true || await slotTaken(kind)(originalPath)) return null;
        // The host records each blob's hash: it is compared, and the file is never read (an online-only placeholder would be downloaded).
        if (manifestBefore?.state !== "ok") return "unknown";
        const recorded = manifestFile(manifestBefore, originalPath)?.blobHash;
        return !recorded ? "unknown" : recorded.toLowerCase() === identity.contentHash.toLowerCase() ? originalPath : null;
      }
      return identity ? owner(kind, fileType, identity) : (await disk.isFile(originalPath)) === true && !(await slotTaken(kind)(originalPath)) ? originalPath : null;
    };
    /**
     * Whether the owner of a set-aside record may be back though nothing is
     * reattached (its slot is taken, or its bytes match several files): the
     * upkeep's expiry rule (`mayBeBack`), so such work is kept, never offered.
     */
    const mayReturn = async (kind: string, fileType: string | null, originalPath: string, identity: { size: number; contentHash: string } | null) => {
      // A shared notebook's owner may be back when the host lists its old path (or cannot say), or the disk has it.
      if (shared && isSharedNotebookPath(originalPath)) return manifestBefore?.state !== "ok" || manifestHasFile(manifestBefore, originalPath) || (await disk.isFile(originalPath)) !== false;
      // The notebook's local `_archive` is not the manifest's: the disk decides there.
      if (shared) return (await disk.isFile(originalPath)) !== false;
      const candidates = identity && follows(kind, fileType) ? (kind === "ink" ? [...await filesOfType("pdf"), ...await filesOfType("image")] : await filesOfType(fileType!)) : [];
      if (identity) await hashSameSize(candidates.filter((candidate) => candidate.size === identity.size));
      return mayBeBack({ originalPath, source: identity }, candidates, hashes, (libraryPath) => disk.isFile(libraryPath));
    };
    /** Set-aside records whose fate is unknown (a candidate could not be hashed, the budget ran out): kept, never offered for removal. */
    const unsettled: string[] = [];
    const returning: string[] = [];
    /** Records read, judged and not coming back: what each covers (a record file, or an ink folder), and whether it names the bytes it was kept for. */
    const settled = new Map<string, { identified: boolean }>();
    /** Ink folders that have their record but no ink (a move that failed halfway left them): nothing is kept in them. */
    const leaked: string[] = [];
    const kinds = { annotations: "pdf-annotations", outline: "pdf-outline", definitions: "definitions" } as const;
    const byContent = upkeepReattachesByContent(notebook);
    for (const { file, record } of await readOrphans(notebook)) {
      if (!budget.allows()) { unsettled.push(file); continue; }
      const moved = await comesBack(kinds[record.kind], "pdf", record.originalPath, record.source ?? null);
      if (moved === "unknown" || (moved === null && await mayReturn(kinds[record.kind], "pdf", record.originalPath, record.source ?? null))) unsettled.push(file);
      else if (moved) { returning.push(file); add({ severity: "info", path: moved, message: `Saved ${name(kinds[record.kind])} set aside when ${record.originalPath} left the notebook belong to ${moved}${record.source ? ", the same file" : ""}. They go to it the next time the notebook is opened.`, ...say("sideSetAside", { kind: kinds[record.kind], originalPath: record.originalPath, path: moved, sameFile: record.source ? "yes" : "no" }) }); }
      else settled.set(file, { identified: byContent && !!record.source });
    }
    const setAsideInk = orphanedSidecarsDirectoryPath(notebook, "ink");
    for (const entry of await readdir(setAsideInk, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(setAsideInk, entry.name);
      if (!budget.allows()) { unsettled.push(directory); continue; }
      let record: { originalPath?: unknown; source?: { size?: unknown; sha256?: unknown } | null } | null = null;
      try { record = JSON.parse(await readFile(path.join(directory, "record.json"), "utf8")); } catch { /* Not a set-aside record the owner reads: not judged below, and so never offered. */ }
      if (typeof record?.originalPath !== "string") continue;
      // A record with no ink beside it promises nothing to anyone: it is not a file that may come back, nor one kept for it.
      const holdsInk = (await lstat(path.join(directory, "ink")).catch(() => null))?.isDirectory() === true;
      if (!holdsInk) { leaked.push(directory); continue; }
      const source = record.source && typeof record.source.size === "number" && typeof record.source.sha256 === "string" ? { size: record.source.size, contentHash: record.source.sha256 } : null;
      const moved = await comesBack("ink", getFileType(record.originalPath), record.originalPath, source);
      if (moved === "unknown" || (moved === null && await mayReturn("ink", getFileType(record.originalPath), record.originalPath, source))) unsettled.push(directory);
      else if (moved) { returning.push(directory); add({ severity: "info", path: moved, message: `Ink set aside when ${record.originalPath} left the notebook belongs to ${moved}. It goes to it the next time the notebook is opened.`, ...say("inkSetAside", { originalPath: record.originalPath, path: moved }) }); }
      else settled.set(directory, { identified: byContent && !!source });
    }
    returning.push(...unsettled);
    const under = (file: string, root: string) => file === root || file.startsWith(`${root}${path.sep}`);
    const isReturning = (file: string) => returning.some((kept) => under(file, kept));
    const setAside = path.join(notebookSystemDirectoryPath(notebook), ORPHANED_SIDECARS_DIR);
    const kept: CleanupAction[] = [];
    /** Files whose record could not be read or does not say whose they are: what they were kept for is unknown, so they are never offered. */
    const unattributed: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && !isReturning(file) && !leaked.some((folder) => under(file, folder))) {
          const owner = [...settled].find(([root]) => under(file, root));
          if (owner) kept.push({ type: "set-aside", file: path.relative(setAside, file).split(path.sep).join("/"), ...(owner[1].identified ? { identified: true as const } : {}) });
          else unattributed.push(path.relative(setAside, file).split(path.sep).join("/"));
        }
      }
    };
    await walk(setAside);
    if (kept.length) add({ severity: "info", path: notebook, message: `${kept.length} side ${kept.length === 1 ? "file is" : "files are"} kept for files that left the notebook outside the app, in case they come back.`, ...(!inventoryCut && !candidatesCut && !budget.reached ? { clear: kept } : {}), ...say("sideFilesKept", { count: kept.length }) });
    if (unattributed.length) add({ severity: "warning", path: notebook, message: unattributed.length === 1 ? "1 set-aside side file can't be matched to the file it was kept for (its record is missing or damaged), so it is left alone." : `${unattributed.length} set-aside side files can't be matched to the files they were kept for (their records are missing or damaged), so they are left alone.`, fix: "Look in the notebook's .libera/orphaned-sidecars folder; remove what you no longer need by hand.", ...say("sideFilesUnattributed", { count: unattributed.length }, "sideFilesUnattributedFix") });
    if (leaked.length) add({ severity: "info", path: notebook, message: leaked.length === 1 ? "1 set-aside ink folder has a record but no ink (a move that did not finish left it): nothing is kept in it, and nothing comes back from it." : `${leaked.length} set-aside ink folders have a record but no ink (a move that did not finish left them): nothing is kept in them, and nothing comes back from them.`, fix: "They can be removed by hand from the notebook's .libera/orphaned-sidecars/ink folder.", ...say("setAsideInkEmpty", { count: leaked.length }, "setAsideInkEmptyFix") });
    const partial: Said[] = [];
    if (unreadable.length || unreadSidecars) partial.push(said("sideFilesUnreadable", `${unreadable.length + unreadSidecars} side ${unreadable.length + unreadSidecars === 1 ? "file or folder" : "files or folders"} could not be read.`, { count: unreadable.length + unreadSidecars }));
    // A file the budget no longer covered was not compared with what its side files were made for: it is not passed.
    if (notCompared.size) partial.push(said("sideFileContentUnverified", `The content of ${plural(notCompared.size, "file")} was not compared with what its side files were made for (the limit of ${Math.round(limits.bytes / 1024 / 1024)} MB read).`, { count: notCompared.size, megabytes: Math.round(limits.bytes / 1024 / 1024) }));
    // A file back in a folder that could not be listed is not seen to be back: what is kept for it can't be called stale.
    if (visible.truncated) partial.push(notebookTooLarge);
    else if (visible.unreadable.length && !partial.length) partial.push(unreadableFolders);
    if (manifestUnavailable) partial.push(manifestUnavailable);
    return partial;
  });

  await run("assets", async (add) => {
    const unused = await unreferencedMarkdownAssets(notebook, notes);
    if (unused === null) return said("notesUnreadForUnused", "Some notes could not be read, so unused images can't be told apart.");
    // An image whose name a note's missing embed has is most likely that
    // embed's image, left behind when the note moved: it is kept for the
    // embed to be pointed at again, never offered to Acknowledge.
    const embedded = new Set<string>();
    // An image address that can't be read may be any image: with one, no image is offered for removal.
    let addressUnread = false;
    if (unused.some((asset) => !asset.toLowerCase().endsWith(".py"))) {
      for (const note of readable) {
        for (const target of markdownImageTargets(note.documentPath, note.content)) {
          if (!target.absolutePath && !target.libraryPath) addressUnread = true;
          if (target.absolutePath && await probeFileOnce(target.absolutePath) !== "present") embedded.add(foldedFileName(path.basename(target.absolutePath)));
        }
      }
    }
    // Python code is named after its note: code whose name a note without
    // code of its own would have is most likely that note's, its folder
    // moved or renamed. It is kept too.
    const codeNames = new Map<string, string>();
    const hasCode = unused.some((asset) => asset.toLowerCase().endsWith(".py"));
    /** The notes that could own some code were not all seen (listing cut, a probe that could not say, the budget): no code is offered for removal. */
    let ownersCut = hasCode && inventoryCut;
    let unknownOwners = 0;
    if (hasCode) {
      for (const file of visible.files) {
        if (getFileType(file) !== "markdown") continue;
        if (!budget.allows()) { ownersCut = true; break; }
        const own = pythonSidecarPath(file);
        const state = await probeOnce(path.join(notebookPath(notebook), ...own.split("/").slice(1)));
        if (state === "absent") codeNames.set(foldedFileName(own.slice(own.lastIndexOf("/") + 1)), file);
        else if (state === "unknown") { ownersCut = true; unknownOwners += 1; }
      }
    }
    for (const asset of unused) {
      const python = asset.toLowerCase().endsWith(".py");
      const name = foldedFileName(asset.slice(asset.lastIndexOf("/") + 1));
      const wanted = !python && embedded.has(name);
      const owner = python ? codeNames.get(name) : undefined;
      add(python
        ? owner
          ? { severity: "warning", path: asset, message: `Python code of a note that is not in the notebook, named like ${owner}: probably its code, left behind when a folder moved.`, fix: `Move it to ${pythonSidecarPath(owner)} to give it back to ${owner}.`, ...say("pythonCodeOfMovedFolder", { owner, sidecarPath: pythonSidecarPath(owner) }, "pythonCodeOfMovedFolderFix") }
          : { severity: "warning", path: asset, message: "Python code of a note that is not in the notebook.", fix: "Move the note back and it is found again; remove the code only once you no longer need it.", ...(ownersCut ? {} : { clear: [{ type: "asset", path: asset, ...(pythonSidecarDocumentPath(asset) ? { gone: pythonSidecarDocumentPath(asset)! } : {}) }] }), ...say("pythonCodeOrphan", undefined, "pythonCodeOrphanFix") }
        : wanted
          ? { severity: "info", path: asset, message: "An image no note shows, but a note shows a missing image of this name: probably this one, left behind when the note moved.", fix: "Point the note's image at this file, or insert it again.", ...say("imageLeftBehind", undefined, "imageLeftBehindFix") }
          : { severity: "info", path: asset, message: "An image no note shows (an open, unsaved note may still use it).", fix: "It can be removed once no note needs it.", ...(addressUnread ? {} : { clear: [{ type: "asset", path: asset }] }), ...say("imageUnused", undefined, "imageUnusedFix") });
    }
    // A shared notebook's notes (or images) not yet on this computer may be the ones that use this code or these images.
    const waiting = shared && (manifestBefore?.state !== "ok" || (await undelivered()).length) ? [manifestUnavailable ?? said("sharedFilesNotHere", "Some of the shared notebook's files are not on this computer yet, so images and code that only they use can't be told apart.")] : [];
    if (ownersCut) return [visible.truncated ? notebookTooLarge : visible.unreadable.length ? unreadableFolders : unknownOwners ? filesUnchecked(unknownOwners) : null, ...waiting].filter((item): item is Said => item !== null);
    if (waiting.length) return waiting;
  });

  await run("images", async (add) => {
    let unchecked = 0;
    for (const note of readable) {
      if (!budget.allows()) break;
      for (const target of markdownImageTargets(note.documentPath, note.content)) {
        budget.probe();
        if (!target.absolutePath) { add({ severity: "warning", path: note.documentPath, message: `The image address "${target.source}" can't be read.`, ...say("imageAddressUnreadable", { source: target.source }) }); continue; }
        const state = await probeFileOnce(target.absolutePath);
        if (state === "unknown") unchecked += 1;
        // A shared notebook's image the host lists is arriving, not missing.
        if (state === "absent" && target.libraryPath && listed(target.libraryPath)) { unchecked += 1; continue; }
        if (state === "absent") add({ severity: "error", path: note.documentPath, message: `Shows ${target.libraryPath ?? target.source}, which is missing.`, fix: "Put the image back, or insert it again.", ...say("imageMissing", { target: target.libraryPath ?? target.source }, "imageMissingFix") });
      }
    }
    if (!notes.complete || unchecked || notesCut) return unchecked ? said("imagesUnchecked", `${unchecked} images could not be checked.`, { count: unchecked }) : notesCut ?? said("notesUnread", "Some notes could not be read.");
  });

  await run("links", async (add) => {
    let uncheckedLinks = 0;
    // What a link asks of its file is checked too: a heading of a note, an
    // annotation of a PDF or image, a moment in a recording. Each target is
    // read once (headings from the notes already read, annotation ids and
    // a recording's length from their side files).
    const byPath = new Map(readable.map((note) => [note.documentPath, note]));
    const headings = new Map<string, MarkdownHeadingAnchor[]>();
    const htmlAnchors = new Map<string, Set<string>>();
    const hasHeading = (note: { documentPath: string; content: string }, fragment: string) => {
      if (!headings.has(note.documentPath)) headings.set(note.documentPath, markdownHeadingAnchors(note.content));
      if (findMarkdownHeadingAnchorIndex(headings.get(note.documentPath)!, fragment) >= 0) return true;
      // An HTML anchor (`<a id="…">`) is a place to link to as well: a real `id` or `name` attribute, in either quote style.
      if (!htmlAnchors.has(note.documentPath)) htmlAnchors.set(note.documentPath, markdownHtmlAnchors(note.content));
      return htmlAnchors.get(note.documentPath)!.has(decodeMarkdownHeadingHash(fragment));
    };
    const annotationIds = new Map<string, Promise<SavedAnnotationIds>>();
    const durations = new Map<string, ReturnType<typeof recordingDuration>>();
    const durationOf = (libraryPath: string) => {
      if (!durations.has(libraryPath)) durations.set(libraryPath, recordingDuration(libraryPath));
      return durations.get(libraryPath)!;
    };
    const opensAtStart = "it opens the file at its start.";
    // A live PDF's marks are the live document's, not its recovery sidecar's (which lags or is absent): asked once per PDF, only for a PDF a link points into. Unknown is partial.
    const annotationIdsOf = async (libraryPath: string): Promise<SavedAnnotationIds> => {
      if (!shared || getFileType(libraryPath) !== "pdf") return savedAnnotationIds(libraryPath);
      const live = await livePdfMarkIds(libraryPath);
      return live.state === "ids" ? live : live.state === "sidecar" ? savedAnnotationIds(libraryPath) : { state: "unreadable" };
    };
    for (const note of readable) {
      if (!budget.allows()) break;
      // A chart's data file is read from the note's folder, found as a link is (the exact name).
      for (const block of slideChartBlocks(note.content)) {
        const parsed = parseSlideChartSpec(block.code);
        if (!("spec" in parsed) || !isSlideChartDataFile(parsed.spec.data)) continue;
        const data = parsed.spec.data!.trim();
        const target = resolveDeckRelativePath(note.documentPath, data);
        await disk.check([target]);
        if (disk.unknown(target)) uncheckedLinks += 1;
        else if (!disk.exists(target) && listed(target)) uncheckedLinks += 1;
        else if (!disk.exists(target)) add({ severity: "warning", path: note.documentPath, message: `The chart at line ${block.line} reads its data from "${data}", which is missing.`, fix: "Put the file back, or point the chart at its current place.", ...say("chartDataMissing", { line: block.line, data }, "chartDataMissingFix") });
      }
      for (const href of extractNotebookLinkDestinations(note.content)) {
        if (href.startsWith("#")) {
          if (href.length > 1 && !hasHeading(note, href)) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" finds no heading in this note.`, fix: "Point it at a heading's current title.", ...say("linkNoHeading", { href }, "linkNoHeadingFix") });
          continue;
        }
        const candidates = linkCandidates(href, note.documentPath);
        if (!candidates.length) continue;
        await disk.check(candidates);
        const target = resolveLinkTargetWith(href, note.documentPath, disk.exists);
        if (!target) {
          if (candidates.some(disk.unknown) || candidates.some(listed)) { uncheckedLinks += 1; continue; }
          add({ severity: "warning", path: note.documentPath, message: `The link "${href}" finds no file.`, fix: "Point the link at the file's current place.", ...say("linkNoFile", { href }, "linkNoFileFix") });
          continue;
        }
        if (target.unreadablePosition) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" keeps a place in ${target.path} that can't be read; ${opensAtStart}`, fix: "Link to the place again.", ...say("linkPositionUnreadable", { href, path: target.path }, "linkPositionFix") });
        if (target.headingFragment && getFileType(target.path) === "markdown") {
          const linked = byPath.get(target.path);
          if (linked && !hasHeading(linked, target.headingFragment)) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" finds no heading "${decodeMarkdownHeadingHash(target.headingFragment)}" in ${target.path}; ${opensAtStart}`, fix: "Point it at a heading's current title.", ...say("linkHeadingMissingInFile", { href, heading: decodeMarkdownHeadingHash(target.headingFragment), path: target.path }, "linkHeadingMissingInFileFix") });
        }
        const view = target.metadata?.viewState;
        const annotation = view?.pdf?.selectedAnnotationId ?? view?.image?.selectedAnnotationId;
        if (annotation) {
          budget.probe();
          if (!annotationIds.has(target.path)) annotationIds.set(target.path, annotationIdsOf(target.path));
          const saved = await annotationIds.get(target.path)!;
          // No side file: the annotations are gone. An older layout or an unreadable one can't be judged here.
          if (saved.state === "legacy" || saved.state === "unreadable") uncheckedLinks += 1;
          else if (saved.state === "absent" || !saved.ids.has(annotation)) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" points at an annotation of ${target.path} that is no longer there; ${opensAtStart}`, fix: "Link to the place again.", ...say("linkAnnotationGone", { href, path: target.path }, "linkAnnotationGoneFix") });
        }
        const time = view?.audio?.currentTime;
        if (time !== undefined && time > 0) {
          const { duration, stale } = await durationOf(target.path);
          // A length saved for another version of the recording says nothing about this one.
          if (stale && !duration) uncheckedLinks += 1;
          else if (duration && time > duration + 1) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" points at ${clock(time)}, past the end of ${target.path} (${clock(duration)}).`, fix: "Link to the moment again.", ...say("linkPastEnd", { href, time: clock(time), path: target.path, duration: clock(duration) }, "linkPastEndFix") });
        }
      }
    }
    if (!notes.complete || uncheckedLinks || notesCut) return uncheckedLinks ? said("linksUnchecked", `${uncheckedLinks} links could not be checked.`, { count: uncheckedLinks }) : notesCut ?? said("notesUnread", "Some notes could not be read.");
  });

  await run("latex", async (add) => {
    const { builds, incomplete, unresolved } = await latexDependencies(notebook, visible.files);
    const what = { include: "includes", bibliography: "uses the bibliography", graphics: "shows" } as const;
    let unchecked = 0;
    // Each main file's build is checked on its own: a chapter two mains share names its files relative to each.
    for (const [file, written] of builds) {
      if (!budget.allows()) break;
      for (const reference of written) {
        await disk.check(reference.candidates);
        if (reference.candidates.some(disk.exists)) continue;
        // A file the tree does not list (.sty, .cls, an image type it does not show) may still be on disk; TeX needs a readable file, so a folder or a dangling link is not one.
        let state: "present" | "absent" | "unknown" = "absent";
        for (const candidate of reference.candidates) {
          const [owner, ...parts] = candidate.split("/");
          const found = await probeFileOnce(path.join(notebookPath(owner), ...parts));
          if (found === "present") { state = "present"; break; }
          if (found === "unknown") state = "unknown";
        }
        if (state === "absent" && reference.candidates.some(listed)) state = "unknown";
        if (state === "unknown") unchecked += 1;
        if (state === "absent" && reference.main === file) add({ severity: "error", path: file, message: `${what[reference.kind]} "${reference.written}", which is not found.`, fix: "Add the file, or correct the path (paths are read from the main file's folder).", ...say("latexMissing", { kind: reference.kind, written: reference.written }, "latexMissingFix") });
        // A chapter is built from its main file: the one that loses the file is named.
        else if (state === "absent") add({ severity: "error", path: file, message: `${what[reference.kind]} "${reference.written}", which is not found when building ${reference.main}.`, fix: "Add the file, or correct the path (paths are read from the main file's folder).", ...say("latexMissingInBuild", { part: reference.kind, written: reference.written, main: reference.main }, "latexMissingFix") });
      }
    }
    const notes = [
      incomplete || visible.truncated ? said("latexPartlyRead", "Large LaTeX projects are only partly read.") : null,
      // A project in a folder that could not be listed is not seen at all.
      visible.unreadable.length ? unreadableFolders : null,
      unchecked ? said("latexUnchecked", `${unchecked} LaTeX references could not be checked.`, { count: unchecked }) : null,
      unresolved ? said("latexMacroUnresolved", `${plural(unresolved, "LaTeX reference")} use${unresolved === 1 ? "s" : ""} a macro (\\name or #1), so ${unresolved === 1 ? "its file" : "their files"} can't be told without running TeX and ${unresolved === 1 ? "was" : "were"} not checked.`, { count: unresolved }) : null,
    ].filter((item): item is Said => item !== null);
    if (notes.length) return notes;
  });

  await run("records", async (add) => {
    const { metadata, damaged } = await inspectWorkspaceMetadata();
    if (damaged) add({ severity: "error", path: notebook, message: `The file that keeps stars, tags and notebook groups can't be read (${damaged}), so none are shown and none can be checked.`, fix: "Restore .libera-workspace.json from your sync service's version history before starring or tagging anything, which would replace it.", ...say("starsDamaged", { reason: damaged }, "starsDamagedFix") });
    // A file that could not be checked is never reported as missing.
    const unknownPaths = new Set<string>();
    const missing = async (libraryPath: string) => {
      // A shared notebook's file is there when the host lists it (a listed file the disk lacks is arriving), gone when it does not. Without the list a missing file is not judged.
      // Decided by the path, not the notebook: the notebook's local `_archive` and other notebooks' files are the disk's.
      const byManifest = manifestBefore !== null && isSharedNotebookPath(libraryPath);
      if (byManifest && manifestBefore.state === "ok") return !manifestHasFile(manifestBefore, libraryPath);
      await disk.check([libraryPath]);
      if (disk.unknown(libraryPath) || (byManifest && !disk.exists(libraryPath))) { unknownPaths.add(libraryPath); return false; }
      return !disk.exists(libraryPath);
    };
    /** A starred or tagged path may be a folder: the manifest's folders for a shared path, and a folder only this computer has (or any folder in a local notebook) is judged on the disk. */
    const folderThere = async (libraryPath: string) => {
      if (manifestBefore?.state === "ok" && isSharedNotebookPath(libraryPath) && manifestHasFolder(manifestBefore, libraryPath)) return true;
      const [owner, ...parts] = libraryPath.split("/");
      if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) return false;
      try { return (await lstat(path.join(notebookPath(owner), ...parts))).isDirectory(); } catch { return false; }
    };
    const missingEntry = async (libraryPath: string) => (await missing(libraryPath)) && !(await folderThere(libraryPath));
    for (const starred of metadata.starredFilePaths) {
      if (under(starred, notebook) && await missingEntry(starred)) add({ severity: "warning", path: starred, message: "Starred, but the file is missing.", fix: "Unstar it, or put the file back.", clear: [{ type: "star", path: starred, gone: starred }], ...say("starredFileMissing", undefined, "starredFileMissingFix") });
    }
    for (const tagged of Object.keys(metadata.fileTags)) {
      if (under(tagged, notebook) && await missingEntry(tagged)) add({ severity: "warning", path: tagged, message: "Has tags, but the file is missing.", fix: "Put the file back, or its tags stay unused.", clear: [{ type: "tags", path: tagged, gone: tagged }], ...say("taggedFileMissing", undefined, "taggedFileMissingFix") });
    }
    // Read without migrating older review storage (readReviewKeys would).
    const reviews = await inspectReviewKeys(getStateRoot());
    if (reviews.damaged) add({ severity: "error", path: notebook, message: `The review comments' index can't be read (${reviews.damaged}).`, fix: "Restore .libera/reviews/index.json from your sync service's version history.", ...say("reviewIndexDamaged", { reason: reviews.damaged }, "reviewIndexDamagedFix") });
    // The older single-file database is read as it is, never converted: its keys are checked like the index's.
    const legacy = reviews.legacy ? await inspectLegacyReviewKeys(getStateRoot()) : { keys: [] as string[], damaged: undefined };
    if (legacy.damaged) add({ severity: "warning", path: notebook, message: `The older review storage can't be read (${legacy.damaged}).`, fix: "Restore .libera/markdown-reviews.json from your sync service's version history.", ...say("reviewLegacyUnreadable", { reason: legacy.damaged }, "reviewLegacyUnreadableFix") });
    else if (reviews.legacy) add({ severity: "info", path: notebook, message: "Older review storage is waiting to be converted; it is the next time review comments load.", ...say("reviewLegacy") });
    // An index entry whose document is not on disk (not synced yet, or lost) or can't be read (corrupt, truncated): its comments are
    // people's work, so neither is ever offered for removal, whether or not the note is still there.
    const undelivered = new Set<string>();
    for (const { id, key, problem, reason } of await inspectReviewDocumentProblems(getStateRoot(), (key) => under(key, notebook))) {
      undelivered.add(key);
      if (problem === "unreadable") { add({ severity: "warning", path: key, message: `The review comments of ${key} can't be read (${reason}); they are kept as they are.`, fix: `Restore .libera/reviews/${id}.json from your sync service's version history.`, ...say("reviewDocumentUnreadable", { path: key, reason: reason ?? "", id }, "reviewDocumentUnreadableFix") }); continue; }
      add({ severity: "warning", path: key, message: `The review comments of ${key} are not on this computer: they may not have synced yet, or are lost.`, fix: `Wait for your sync service to finish; if they don't arrive, restore .libera/reviews/${id}.json from its version history.`, ...say("reviewsNotOnComputer", { path: key }, "reviewsNotOnComputerFix") });
    }
    // A key only the older database holds is reported but not offered for removal: converting it is the app's step.
    const indexed = new Set(reviews.keys);
    for (const key of new Set([...reviews.keys, ...legacy.keys])) {
      if (under(key, notebook) && !undelivered.has(key) && await missing(key)) add({ severity: "info", path: key, message: "Review comments are kept for this file, which is missing.", ...(indexed.has(key) ? { clear: [{ type: "review" as const, path: key, gone: key }] } : {}), ...say("reviewFileMissing") });
    }
    const pending = await listReviewEntryPaths();
    if (pending.unreadable) add({ severity: "warning", path: notebook, message: `${pending.unreadable} pending agent ${pending.unreadable === 1 ? "review can't" : "reviews can't"} be read (in any notebook).`, ...say("pendingAgentReviewsUnreadable", { count: pending.unreadable }) });
    for (const reviewed of pending.paths) {
      if (under(reviewed, notebook) && await missing(reviewed)) add({ severity: "warning", path: reviewed, message: "The agent's changes to this file wait for review, but the file is missing.", fix: "Put the file back to review them; they are dropped the next time reviews load.", clear: [{ type: "agent-review", path: reviewed, gone: reviewed }], ...say("agentChangesMissing", undefined, "agentChangesMissingFix") });
    }
    const runs = await listRunFiles();
    if (runs.unreadable) add({ severity: "info", path: notebook, message: `${runs.unreadable} agent ${runs.unreadable === 1 ? "run's" : "runs'"} undo history can't be read (in any notebook).`, ...say("agentRunsUnreadable", { count: runs.unreadable }) });
    for (const file of runs.files) {
      if (!file.shared && !file.reverted && under(file.path, notebook) && await missing(file.path)) {
        add({ severity: "info", path: file.path, message: "An agent run can't be undone for this file, which is missing.", ...say("agentRunFileMissing") });
      }
    }

    // Records keyed to a notebook that is not in the library at all: its folder
    // was renamed or removed outside the app. Only the current notebook's
    // prefix is examined above, and the old name can no longer be checked, so
    // they are reported here, by whichever notebook is checked. Nothing is changed.
    const vanished = new Map<string, { stars: number; tags: number; reviews: number; pending: number; history: number; paths: Set<string> }>();
    const keep = (kind: "stars" | "tags" | "reviews" | "pending" | "history", libraryPath: string) => {
      const [owner, ...rest] = libraryPath.split("/");
      if (!rest.length || !isVanished(owner)) return;
      if (!vanished.has(owner)) vanished.set(owner, { stars: 0, tags: 0, reviews: 0, pending: 0, history: 0, paths: new Set() });
      const entry = vanished.get(owner)!;
      entry[kind] += 1;
      entry.paths.add(rest.join("/"));
    };
    for (const starred of metadata.starredFilePaths) keep("stars", starred);
    for (const tagged of Object.keys(metadata.fileTags)) keep("tags", tagged);
    for (const key of new Set([...reviews.keys, ...legacy.keys])) keep("reviews", key);
    for (const reviewed of pending.paths) keep("pending", reviewed);
    for (const file of runs.files) if (!file.shared && !file.reverted) keep("history", file.path);
    for (const [name, entry] of vanished) {
      // A likely new name: the one notebook that has every file path these records name (at most 20 are tried).
      const sample = [...entry.paths].slice(0, 20);
      const matching: string[] = [];
      for (const candidate of knownNotebooks) {
        if (candidate === name) continue;
        await disk.check(sample.map((rest) => `${candidate}/${rest}`));
        if (sample.length && sample.every((rest) => disk.exists(`${candidate}/${rest}`))) matching.push(candidate);
      }
      const renamed = matching.length === 1 ? matching[0] : "none";
      const params = { name, stars: entry.stars, tags: entry.tags, reviews: entry.reviews, pending: entry.pending, history: entry.history, renamed };
      add({ severity: "warning", path: name, message: `Records are kept for a notebook named ${name}, which is not in the library any more (stars: ${entry.stars}, tags: ${entry.tags}, review comments: ${entry.reviews}, pending agent reviews: ${entry.pending}, undo history: ${entry.history}).${renamed === "none" ? "" : ` ${renamed} has files at the same paths: it may be the same notebook, renamed outside the app.`}`, fix: `Rename the folder back to ${name} to bring them back; nothing was changed.`, ...say("vanishedNotebookRecords", params, "vanishedNotebookRecordsFix") });
    }
    // A record whose file could not be checked is neither reported nor passed.
    if (unknownPaths.size) return manifestUnavailable ?? filesUnchecked(unknownPaths.size);
  });

  let ownLibrary = null as ReferenceLibrary | null;
  await run("references", async (add) => {
    /** Inputs that could not be read or probed: another library's attachments into this notebook, a linked attachment, the tether's target. */
    let unchecked = 0;
    for (const library of await libraryNotebookNames()) {
      let inspected;
      try { inspected = await inspectReferenceLibrary(library); } catch { unchecked += 1; continue; }
      if (library === notebook && !("damaged" in inspected)) ownLibrary = inspected.library ?? null;
      if ("damaged" in inspected) {
        // The app sets a damaged library aside when it next opens it; until then, its attachments count for nothing.
        if (library === notebook) add({ severity: "error", path: notebook, message: `The notebook's reference library can't be read (${inspected.damaged})`, fix: "Restore .libera/references/library.json from a backup or your sync service's version history before opening References, which would set the damaged file aside and start an empty library.", ...say("referenceLibraryDamaged", { reason: inspected.damaged }, "referenceLibraryDamagedFix") });
        // Another notebook's damaged library may attach files of this one: they can't be seen.
        else unchecked += 1;
        continue;
      }
      for (const entry of Object.values(inspected.library?.entries ?? {})) {
        for (const attachment of entry.attachments) {
          if (attachment.kind === "url") continue;
          if (library !== notebook && !under(attachment.path, notebook)) continue;
          await disk.check([attachment.path]);
          if (disk.unknown(attachment.path)) unchecked += 1;
          // A shared notebook's attachment is missing when the host does not list it; without the list it is not judged.
          let gone: boolean;
          if (manifestBefore && under(attachment.path, notebook) && isSharedNotebookPath(attachment.path)) {
            if (manifestBefore.state === "ok") gone = !manifestHasFile(manifestBefore, attachment.path);
            else { gone = false; if (!disk.exists(attachment.path) && !disk.unknown(attachment.path)) unchecked += 1; }
          } else gone = !disk.exists(attachment.path) && !disk.unknown(attachment.path);
          if (gone) {
            add({ severity: "warning", path: attachment.path, message: `Attached to the reference "${entry.key}" in ${library}'s library, but missing.`, fix: "Put the file back (it is re-attached when found), or detach it in References.", clear: [{ type: "attachment", library, entry: entry.id, path: attachment.path, gone: attachment.path }], ...say("referenceAttachmentMissing", { key: entry.key, library }, "referenceAttachmentMissingFix") });
          }
        }
      }
    }
    const tether = await readTetherTarget(notebook);
    if (tether && "damaged" in tether) {
      add({ severity: "warning", path: notebook, message: `The .bib tether's settings can't be read (${tether.damaged}).`, fix: "Choose the tethered file again in References.", ...say("tetherSettingsDamaged", { reason: tether.damaged }, "tetherSettingsDamagedFix") });
    } else if (tether && "libraryPath" in tether) {
      await disk.check([tether.libraryPath]);
      if (disk.unknown(tether.libraryPath)) unchecked += 1;
      // A tether to a shared file: the host's list decides (a listed file the disk lacks is arriving; one it no longer lists is gone, a retired copy still on the disk or not). Without the list it is not judged.
      let tetherGone = !disk.exists(tether.libraryPath) && !disk.unknown(tether.libraryPath);
      if (manifestBefore && under(tether.libraryPath, notebook) && isSharedNotebookPath(tether.libraryPath)) {
        if (manifestBefore.state === "ok") tetherGone = !manifestHasFile(manifestBefore, tether.libraryPath);
        else { tetherGone = false; if (!disk.exists(tether.libraryPath)) unchecked += 1; }
      }
      if (tetherGone) add({ severity: "warning", path: tether.libraryPath, message: "The library is tethered to this .bib file, which is missing.", fix: "Put the file back, or choose the tethered file again in References.", clear: [{ type: "tether", target: tether.libraryPath, gone: tether.libraryPath }], ...say("tetherFileMissing", undefined, "tetherFileMissingFix") });
    } else if (tether) {
      const state = await probe(tether.absolutePath);
      // A folder that is gone too may be a drive that is unplugged: not for Acknowledge to forget.
      if (state === "unknown") unchecked += 1;
      else if (state === "absent") {
        const folder = await probe(path.dirname(tether.absolutePath));
        if (folder === "unknown") unchecked += 1;
        else if (folder === "absent") add({ severity: "warning", path: notebook, message: `The library is tethered to ${tether.absolutePath}, which is not found, nor is its folder: it may be on a drive that is not connected.`, fix: "Reconnect the drive, or choose the tethered file again in References.", ...say("tetherDriveNotFound", { path: tether.absolutePath }, "tetherDriveNotFoundFix") });
        else add({ severity: "warning", path: notebook, message: `The library is tethered to ${tether.absolutePath}, which is missing.`, fix: "Put the file back, or choose the tethered file again in References.", clear: [{ type: "tether", target: tether.absolutePath }], ...say("tetherFileMissingAt", { path: tether.absolutePath }, "tetherFileMissingAtFix") });
      }
    }
    if (unchecked) return filesUnchecked(unchecked);
  });

  await run("indexes", async (add) => {
    // Indexes the app keeps up to date by itself, compared with what they
    // index: each entry's content hash against the notes already read (no
    // file is read again for this). Out of date is not broken, so all of
    // this is for the record.
    const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
    const hashes = new Map(readable.map((note) => [note.documentPath, sha(note.content)]));
    // The indexes hash a file's bytes and the notes were read as text: where
    // invalid UTF-8 became U+FFFD the two differ forever, so those are read
    // again as bytes. One that can't be (or no budget) is left out, not judged.
    for (const note of readable) {
      if (!note.content.includes("\uFFFD")) continue;
      hashes.delete(note.documentPath);
      if (!budget.allows()) continue;
      const bytes = await readWithin(budget, absoluteOf(note.documentPath));
      if (bytes) hashes.set(note.documentPath, sha(bytes));
    }
    /** The citation index covers LaTeX sources as well, hashed here (against the byte budget) for that comparison only. */
    const citationHashes = async () => {
      const all = new Map(hashes);
      for (const file of visible.files) {
        if (!isLatexCitingPath(file) || all.has(file)) continue;
        if (!budget.allows()) break;
        const bytes = await readWithin(budget, absoluteOf(file));
        if (bytes) all.set(file, sha(bytes));
      }
      return all;
    };
    const outdated = async (files: Record<string, { contentHash: string }>, hashes: Map<string, string>) => {
      let count = 0;
      for (const [file, entry] of Object.entries(files)) {
        if (!under(file, notebook)) continue;
        const hash = hashes.get(file);
        if (hash !== undefined) { if (hash !== entry.contentHash) count += 1; continue; }
        budget.probe();
        await disk.check([file]);
        if (!disk.exists(file) && !disk.unknown(file)) count += 1;
      }
      // A note not indexed yet (the archive is indexed only when shown).
      for (const file of hashes.keys()) if (!(file in files) && file.split("/")[1] !== ARCHIVE_DIR) count += 1;
      return count;
    };
    // An index not built yet is not out of date: it is built when first needed.
    if (await probe(linkIndexPath(notebook)) === "present") {
      const count = await outdated((await readLinkIndex(linkIndexPath(notebook))).files, hashes);
      // The next refresh must read the notes again, not reuse what this process read before
      // (a change that kept a note's size and times is how the index fell behind).
      if (count) forgetNotebookLinkReads(notebook);
      if (count) add({ severity: "info", path: notebook, message: `The link index is out of date for ${plural(count, "note")}, so links to a file and related notebooks may be off until the notebook is next opened.`, ...say("linkIndexOutOfDate", { count }) });
    }
    if (await probe(citationIndexPath(notebook)) === "present") {
      const count = await outdated((await readCitationIndex(citationIndexPath(notebook))).files, await citationHashes());
      if (count) add({ severity: "info", path: notebook, message: `The citation index is out of date for ${plural(count, "file")}; it is brought up to date the next time citations are listed.`, clear: [{ type: "citations" }], ...say("citationIndexOutOfDate", { count }) });
    }
    if (ownLibrary) {
      const mirror = await planBibMirror(notebook, ownLibrary);
      const again = "It is written again after the next change in References.";
      if (mirror.status === "write") add({ severity: "info", path: mirror.path, message: mirror.exists ? "The .bib mirror is out of date with the reference library." : "The .bib mirror is on, but references.bib is not written yet.", fix: again, clear: [{ type: "bib-mirror" }], ...say(mirror.exists ? "bibMirrorOutOfDate" : "bibMirrorNotWritten", undefined, "bibMirrorFix") });
      if (mirror.status === "protected") add({ severity: "info", path: mirror.editedPath, message: `references.bib was changed outside Libera, so the library's bibliography goes to ${mirror.path} instead${mirror.current ? "" : ", which is out of date"}.`, fix: `Cite ${mirror.path} in LaTeX, or remove the edited references.bib so that Libera writes it again.`, ...say("bibMirrorProtected", { path: mirror.path, current: mirror.current ? "true" : "false" }, "bibMirrorProtectedFix") });
    }
    // Global Search, read without opening the index for writing; skipped when that can't be done.
    const searchFile = searchIndexFile();
    const indexed = readIndexedLibraryRows(searchFile, notebook);
    const skipped: Said[] = [];
    // An index not built yet has nothing to compare; one that is there but can't be read safely is a check that did not run: the report is partial.
    if (!indexed && await probe(searchFile) !== "absent") skipped.push(said("globalSearchSkipped", "Global Search was not compared with the notebook: its index could not be read without opening it for writing."));
    if (indexed) {
      const listed = new Set(visible.files);
      // A row spelled differently from a listed file (a case-only rename the volume still opens under both names) is obsolete, though its path "exists".
      const spelling = foldedFileName;
      const listedSpellings = new Set(visible.files.map(spelling));
      const rows = new Map(indexed.map((row) => [row.path, row]));
      let gone = 0, changed = 0, missing = 0;
      for (const { path: file, signature, status } of indexed) {
        if (!under(file, notebook)) continue;
        if (listed.has(file)) {
          // A row at a path that now holds another file (moved away and replaced) carries the old file's signature. A PDF's or recording's signature has extra parts after "|".
          if (status !== "ok" || !budget.allows()) continue;
          budget.probe();
          try { if (await readFileSignature(filePathFromParts(notebook, file.split("/").slice(1))) !== signature.split("|")[0]) changed += 1; } catch { /* Not judged. */ }
          continue;
        }
        if (!budget.allows()) break;
        if (listedSpellings.has(spelling(file))) { gone += 1; continue; }
        budget.probe();
        await disk.check([file]);
        if (!disk.exists(file) && !disk.unknown(file)) gone += 1;
      }
      // Files Search would index but has no row for (a move's destination). Not before the index holds this notebook at all, and not from a walk cut short.
      if (indexed.length && !visible.truncated) {
        const indexImages = getSearchPreferences().indexImages;
        const isBuildProduct = latexBuildProductFilter();
        const root = notebookPath(notebook);
        for (const file of visible.files) {
          if (rows.has(file) || (!indexImages && getFileType(file) === "image")) continue;
          if (!budget.allows()) break;
          budget.probe();
          try { if (await isBuildProduct(filePathFromParts(notebook, file.split("/").slice(1)), root)) continue; } catch { continue; }
          missing += 1;
        }
      }
      if (gone) add({ severity: "info", path: notebook, message: `Global Search still lists ${plural(gone, "file")} no longer in the notebook; it catches up the next time it runs.`, ...say("globalSearchStale", { count: gone }) });
      if (changed) add({ severity: "info", path: notebook, message: `Global Search holds the text of an earlier file for ${plural(changed, "path")}; it catches up the next time it runs.`, ...say("globalSearchChanged", { count: changed }) });
      if (missing) add({ severity: "info", path: notebook, message: `Global Search has no entry yet for ${plural(missing, "file")}; it catches up the next time it runs.`, ...say("globalSearchMissing", { count: missing }) });
    }
    if (skipped.length) return skipped;
  });

  await run("migrations", async (add) => {
    // Imported here: the migration module uses this one for its own check.
    const { listInterruptedMigrations, listUnreadableMigrations } = await import("@/lib/storage/migration");
    for (const migration of await listInterruptedMigrations()) {
      if (migration.source === notebook || migration.destination.notebook === notebook) {
        add({ severity: "error", path: notebook, message: `A migration from ${migration.source} to ${migration.destination.notebook} did not finish.`, fix: "Open Migration and choose Move the rest or Stop here.", ...say("migrationUnfinished", { source: migration.source, destination: migration.destination.notebook }, "migrationUnfinishedFix") });
      }
      // An unfinished migration that names a notebook that is gone (renamed or removed outside the app): reported by whichever notebook is checked. A destination still to be created (staging) is not gone.
      const gone = [migration.source, ...(migration.phase === "staging" ? [] : [migration.destination.notebook])].filter(isVanished);
      if (gone.length) add({ severity: "warning", path: notebook, message: `The unfinished migration from ${migration.source} to ${migration.destination.notebook} names ${gone.join(" and ")}, which ${gone.length === 1 ? "is" : "are"} not in the library any more (renamed or removed outside the app).`, fix: "Rename the folder back so that Migration can finish or stop it.", ...say("migrationVanishedNotebook", { source: migration.source, destination: migration.destination.notebook, missing: gone.join(", "), count: gone.length }, "migrationVanishedNotebookFix") });
    }
    for (const name of await listUnreadableMigrations()) {
      add({ severity: "warning", path: notebook, message: `A migration journal (${name}) can't be read; it may concern this notebook.`, fix: "Open Migration to set it aside after checking the notebooks it moved between.", ...say("migrationJournalUnreadable", { name }, "migrationJournalUnreadableFix") });
    }
    for (const copy of staged) {
      add({ severity: "warning", path: copy, message: "A prepared copy left by a migration.", fix: "Finish or stop the migration; if none is open, the copy can be deleted.", ...say("migrationPreparedCopy", undefined, "migrationPreparedCopyFix") });
    }
  });

  if (shared) await run("sharing", async (add) => {
    const before = manifestBefore!;
    if (before.state !== "ok") { manifestStable = false; return manifestUnavailable!; }
    // One more listing, to see that the host's view did not change during the check; if it did, nothing is concluded and nothing is retried.
    const after = await readManifestView(notebook);
    if (after.state !== "ok" || after.stamp !== before.stamp) {
      manifestStable = false;
      return said("sharedManifestChanged", "The shared notebook's file list changed while it was being checked, so this computer was not compared with it. Check again in a moment.");
    }
    const sync = await readSharedSync(notebook);
    let syncUnknown = false;
    let unchecked = 0;
    const files = [...before.files.values()].sort((a, b) => a.path.localeCompare(b.path));
    await disk.check(files.map((entry) => entry.path));
    for (const entry of files) {
      if (!budget.allows()) break;
      budget.visit();
      if (disk.unknown(entry.path)) { unchecked += 1; continue; }
      let problem: "missing" | "differs" | null = null;
      if (!disk.exists(entry.path)) problem = "missing";
      else if (entry.kind === "blob" && entry.size !== undefined) {
        // Size only, from a stat: a file is never read (or downloaded) for this.
        budget.probe();
        const stats = await lstat(absoluteOf(entry.path)).catch(() => null);
        if (stats?.isFile() && stats.size !== entry.size) problem = "differs";
      }
      if (!problem) continue;
      const arriving = mayBeArriving(entry, sync);
      if (arriving === "unknown") syncUnknown = true;
      if (arriving === true) add({ severity: "info", path: entry.path, message: "Sync is still bringing this file to this computer.", ...say("sharedFileArriving") });
      else if (problem === "missing") add({ severity: "warning", path: entry.path, message: "The shared notebook has this file, but it is not on this computer, and sync is not behind.", fix: "Check again once sync has finished.", ...say("sharedFileMissingHere", undefined, "sharedFileMissingHereFix") });
      else add({ severity: "warning", path: entry.path, message: "This computer has another version of this file than the shared notebook (its size differs), and sync is not behind.", fix: "Check again once sync has finished.", ...say("sharedFileDiffers", undefined, "sharedFileMissingHereFix") });
    }
    for (const file of visible.files) {
      const relative = file.split("/").slice(1).join("/");
      if (relative.split("/")[0] === ARCHIVE_DIR || before.files.has(file) || !isShareablePath(relative) || isGeneratedPath(relative)) continue;
      add({ severity: "info", path: file, message: "This file is on this computer but not in the shared notebook's file list: the host has not added it yet, or it is an old copy of a file removed from the shared notebook.", fix: "Check again in a moment. If it stays, it is not shared: remove it if it is an old copy.", ...say("sharedFileNotListed", undefined, "sharedFileNotListedFix") });
    }
    const notes = [
      unchecked ? filesUnchecked(unchecked) : null,
      syncUnknown ? said("sharedSyncUnknown", "The host's sync state could not be read, so a file still arriving can't be told from one that is missing.") : null,
      visible.truncated ? notebookTooLarge : visible.unreadable.length ? unreadableFolders : null,
    ].filter((item): item is Said => item !== null);
    if (notes.length) return notes;
  });

  if (shared) {
    // What the report says can be done (the dialog offers only that): Acknowledge removes this computer's own records, never the host's, and only on a manifest the host confirmed and that held still; Try to fix pairs this computer's records the same way.
    const usable = manifestBefore?.state === "ok" && manifestStable;
    const pairable = new Set(["starredFileMissing", "taggedFileMissing", "reviewFileMissing", "referenceAttachmentMissing"]);
    for (const finding of findings) {
      if (finding.clear) {
        const kept = usable ? finding.clear.filter((action) => sharedMayClear(action, notebook)) : [];
        if (kept.length) finding.clear = kept; else delete finding.clear;
      }
      finding.repairable = usable && (pairable.has(finding.code ?? "") || (finding.code === "orphanSideFile" && !hostOwnsSideFile(String(finding.params?.kind ?? ""), notebook)));
    }
  }

  const partial = cancelled || checks.some((check) => check.status === "failed" || check.status === "incomplete");
  return {
    notebook,
    checkedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    completeness: partial ? "partial" : "complete",
    ...(cancelled ? { cancelled } : {}),
    checks,
    findings,
    counts,
    statistics: budget.statistics,
    limits,
  };
}
