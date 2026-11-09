import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { listReviewEntryPaths } from "@/lib/agent/review-store";
import { listRunFiles } from "@/lib/agent/snapshots";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { latexDependencies } from "@/lib/latex/dependencies";
import { readTetherTarget } from "@/lib/references/bib-tether";
import { ARCHIVE_DIR, ORPHANED_SIDECARS_DIR } from "@/lib/storage/constants";
import { planBibMirror } from "@/lib/references/bib-mirror";
import type { ReferenceLibrary } from "@/lib/references/types";
import { readIndexedLibraryPaths } from "@/lib/search/database";
import { searchIndexFile } from "@/lib/search/settings";
import { citationIndexPath, readCitationIndex } from "@/lib/storage/reference-citations";
import { fileExistence, libraryNotebookNames, linkCandidates, resolveLinkTargetWith } from "@/lib/storage/library-links";
import { decodeMarkdownHeadingHash, findMarkdownHeadingAnchorIndex, markdownHeadingAnchors, type MarkdownHeadingAnchor } from "@/lib/markdown-heading-anchors";
import { savedAnnotationIds } from "@/lib/storage/annotations";
import { parseTranscript } from "@/lib/storage/transcripts";
import { markdownImageTargets, readMarkdownAssetDocuments, unreferencedMarkdownAssets } from "@/lib/storage/markdown-assets";
import { extractNotebookLinkDestinations, linkIndexPath, readLinkIndex } from "@/lib/storage/notebook-links";
import { assertSafeSegment, audioPeaksPath, getLinkedFolder, withReadOnlyStorage, getStateRoot, notebookMetadataPath, notebookPath, notebookSystemDirectoryPath, orphanedSidecarsDirectoryPath, transcriptPath } from "@/lib/storage/paths";
import { inspectReferenceLibrary } from "@/lib/storage/references";
import { inspectReviewKeys } from "@/lib/storage/review-files";
import { existingSidecars, listSidecars, findOrphanedSidecars, type SidecarInspection } from "@/lib/storage/sidecars";
import { matchByIdentity, readOrphans } from "@/lib/storage/pdf-sidecars";
import { getFileType } from "@/lib/storage/file-types";
import { pythonSidecarDocumentPath, pythonSidecarPath } from "@/lib/python/sidecar";
import { listVisibleNotebookFiles } from "@/lib/storage/tree";
import { readWorkspaceMetadata } from "@/lib/storage/workspace-metadata";
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

export type IntegrityCheckId = "notebook" | "sidecars" | "assets" | "images" | "links" | "latex" | "records" | "references" | "indexes" | "migrations";

export type IntegrityFinding = {
  check: IntegrityCheckId;
  /** `error`: something is broken where you will see it. `warning`: data that points nowhere. `info`: harmless, for the record. */
  severity: IntegritySeverity;
  /** The library path concerned (or the closest one). */
  path: string;
  message: string;
  /** What would set it right. Nothing is changed by the check itself. */
  fix?: string;
  /** What Acknowledge (cleanup.ts) removes to clear this finding, on confirmation. */
  clear?: CleanupAction[];
};

/**
 * Something stale that Acknowledge removes: what is left of a file that is
 * gone, a side file saved for another version of its file, an out-of-date
 * cache or index. Paths are library paths; cleanup.ts says what each costs.
 * `gone` names the file whose absence makes it stale: cleanup.ts checks it
 * is still gone right before removing anything.
 */
export type CleanupAction = (
  | { type: "side-file"; kind: string; filePath: string }
  | { type: "ink-files"; filePath: string; names: string[] }
  | { type: "set-aside"; file: string }
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
  note?: string;
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

  constructor(readonly limits: IntegrityLimits, private readonly signal?: AbortSignal) {
    this.deadline = Date.now() + limits.milliseconds;
  }

  /** Throws when cancelled; false (with `reached` set) when a limit is used up. */
  allows() {
    if (this.signal?.aborted) throw new IntegrityCheckCancelled("The check was cancelled.");
    if (this.reached) return false;
    if (Date.now() > this.deadline) this.reached = `the ${Math.round(this.limits.milliseconds / 1000)} s time limit`;
    else if (this.statistics.entriesVisited > this.limits.entries) this.reached = `the limit of ${this.limits.entries} entries`;
    else if (this.statistics.bytesRead > this.limits.bytes) this.reached = `the limit of ${Math.round(this.limits.bytes / 1024 / 1024)} MB read`;
    return !this.reached;
  }

  read(bytes: number) { this.statistics.filesRead += 1; this.statistics.bytesRead += bytes; }
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
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const under = (libraryPath: string, notebook: string) => libraryPath.startsWith(`${notebook}/`);

/** `73` → "1:13", `3723` → "1:02:03". */
function clock(seconds: number) {
  const whole = Math.floor(seconds);
  const parts = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  return (parts[0] ? parts : parts.slice(1)).map((part, index) => index ? String(part).padStart(2, "0") : String(part)).join(":");
}

/** A recording's length, from its transcript or else its waveform; null when neither says. */
async function recordingDuration(libraryPath: string) {
  const [notebook, ...parts] = libraryPath.split("/");
  for (const [file, read] of [
    [transcriptPath(notebook, parts), (value: unknown) => parseTranscript(value)?.audio.duration],
    [audioPeaksPath(notebook, parts), (value: unknown) => (value as { duration?: unknown } | null)?.duration],
  ] as const) {
    try {
      const duration = read(JSON.parse(await readFile(file, "utf8")));
      if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) return duration;
    } catch { /* None saved, or unreadable: the next one may say. */ }
  }
  return null;
}

/** Whether something is at a path. `unknown` (no permission, a drive error) is never reported as missing. */
async function probe(absolutePath: string): Promise<"present" | "absent" | "unknown"> {
  try { await lstat(absolutePath); return "present"; }
  catch (error) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unknown"; }
}

/**
 * Nothing is left at these places: each item itself, and for a file its
 * sidecars. The migration's final check; `unverified` when a place could not
 * be checked.
 */
export async function checkNothingLeftAt(items: { label: string; absolutePath: string; libraryPath?: string; fileType?: string | null }[]) {
  const leftovers: string[] = [];
  let unverified = false;
  for (const item of items) {
    try {
      const state = await probe(item.absolutePath);
      if (state === "present") leftovers.push(item.label);
      if (state === "unknown") { unverified = true; leftovers.push(`${item.label} (could not be checked)`); }
      if (!item.libraryPath || item.fileType === undefined) continue;
      const [notebook, ...parts] = item.libraryPath.split("/");
      for (const sidecar of await existingSidecars(notebook, parts, item.fileType)) leftovers.push(`${item.label} (${sidecar.kind})`);
    } catch (error) {
      unverified = true;
      leftovers.push(`${item.label} (could not be checked: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { leftovers, unverified };
}

/**
 * Check a notebook. Reads only, down to where things are found: the linked
 * folders' state is read without its upgrades (paths.ts withReadOnlyStorage).
 * Findings say what is wrong and how to set it right.
 */
export function verifyNotebook(name: string, options: VerifyOptions = {}): Promise<IntegrityReport> {
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

  const findings: IntegrityFinding[] = [];
  const checks: IntegrityCheckResult[] = [];
  const disk = fileExistence();
  const counts = { files: 0, notes: 0, sidecars: 0 };

  // One walk and one read of the notes, shared by every check.
  const staged: string[] = [];
  const visible = await listVisibleNotebookFiles(notebook, {
    limit: limits.entries,
    onHidden: (libraryPath, entryName) => { budget.visit(); if (entryName.startsWith(".libera-migrating-")) staged.push(libraryPath); },
  });
  budget.visit(visible.files.length);
  counts.files = visible.files.length;
  const notes = await readMarkdownAssetDocuments(notebook);
  counts.notes = notes.documents.length;
  for (const note of notes.documents) budget.read(note.content.length);
  /** Notes within the byte budget; the checks that read notes say when some were left out. */
  const readable = (() => {
    let bytes = 0;
    return notes.documents.filter((note) => (bytes += note.content.length) <= limits.bytes);
  })();
  const notesCut = readable.length < notes.documents.length ? `${notes.documents.length - readable.length} notes were left out (the limit of ${Math.round(limits.bytes / 1024 / 1024)} MB read).` : null;
  let cancelled = false;

  /** Each image embed's target is probed once, by the checks that ask about it. */
  const probes = new Map<string, Promise<"present" | "absent" | "unknown">>();
  const probeOnce = (absolutePath: string) => {
    if (!probes.has(absolutePath)) probes.set(absolutePath, probe(absolutePath));
    return probes.get(absolutePath)!;
  };

  const order = Object.keys(LABELS) as IntegrityCheckId[];
  let findingsCut = false;
  const run = async (id: IntegrityCheckId, check: (add: (finding: Omit<IntegrityFinding, "check">) => void) => Promise<string | void>) => {
    if (cancelled) return;
    options.onProgress?.({ check: id, label: LABELS[id], index: order.indexOf(id), total: order.length });
    const before = findings.length;
    try {
      budget.allows();
      const add = (finding: Omit<IntegrityFinding, "check">) => {
        if (findings.length >= limits.findings) { findingsCut = true; return; }
        findings.push({ check: id, ...finding });
      };
      let incomplete = await check(add);
      if (!incomplete && budget.reached) incomplete = `Stopped at ${budget.reached}.`;
      if (!incomplete && findingsCut) incomplete = `Only the first ${limits.findings} findings are listed.`;
      checks.push({ id, label: LABELS[id], status: incomplete ? "incomplete" : findings.length > before ? "findings" : "ok", ...(incomplete ? { note: incomplete } : {}) });
    } catch (error) {
      if (error instanceof IntegrityCheckCancelled) { cancelled = true; return; }
      checks.push({ id, label: LABELS[id], status: "failed", note: error instanceof Error ? error.message : String(error) });
    }
  };

  await run("notebook", async (add) => {
    if (isSharedNotebookPath(notebook)) add({ severity: "info", path: notebook, message: "This is a shared notebook. Its files are kept in step by collaboration; this check covers what is on this computer." });
    let text: string | null = null;
    try { text = await readFile(notebookMetadataPath(notebook), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "The notebook's settings file could not be read."; }
    if (text === null) add({ severity: "info", path: notebook, message: "The notebook has no settings file, so its color, emoji and group are the defaults.", fix: "Edit the notebook and save to write one." });
    else {
      try { JSON.parse(text); }
      catch { add({ severity: "error", path: notebook, message: "The notebook's settings file can't be read, so its color, emoji and group are the defaults.", fix: "Restore it from your sync service's version history; saving the notebook's settings writes a new one." }); }
    }
    if (visible.truncated) return `${notebook} has more files than one check reads (${visible.files.length}).`;
  });

  await run("sidecars", async (add) => {
    const { sidecars, unreadable } = await listSidecars(notebook);
    counts.sidecars = sidecars.length;
    const orphans = await findOrphanedSidecars(notebook, sidecars);
    const orphaned = new Set(orphans.map((orphan) => orphan.path));
    /** The file each side file was made for (size and content hash), as it recorded it. */
    const identities = new Map<string, { size: number; contentHash: string }>();
    let unreadSidecars = 0;
    budget.visit(sidecars.length);
    // Each owner's reading of what it saved (sidecars.ts `inspect`), and the
    // file's size against the one the side file was made for: a stat, not a
    // hash. PDFs and images are read only to find where a missing file went
    // (below), and only those of the size it had.
    const sizes = new Map<string, number | null>();
    const sizeOf = async (fileParts: string[]) => {
      const key = fileParts.join("/");
      if (!sizes.has(key)) {
        budget.probe();
        const stats = await lstat(path.join(notebookPath(notebook), ...fileParts)).catch(() => null);
        sizes.set(key, stats?.isFile() ? stats.size : null);
      }
      return sizes.get(key) ?? null;
    };
    const outdatedCaches = new Map<string, CleanupAction[]>();
    const name = (kind: string) => kind.replace(/-/g, " ");
    for (const sidecar of sidecars) {
      if (!budget.allows()) break;
      const kind = sidecar.kindInfo;
      const sources: NonNullable<SidecarInspection["source"]>[] = [];
      if (kind.layout === "folder") {
        if (!kind.inspectFolder) continue;
        let ink;
        try { ink = await kind.inspectFolder(sidecar.path, getFileType(sidecar.fileParts.at(-1) ?? "") ?? ""); } catch { unreadSidecars += 1; continue; }
        budget.read(ink.bytes);
        if (ink.unreadable.length) add({ severity: "error", path: sidecar.filePath, message: `${plural(ink.unreadable.length, "ink file")} of ${sidecar.filePath} can't be read, so ${ink.unreadable.length === 1 ? "its" : "their"} ink is not shown (${ink.unreadable.slice(0, 3).join(", ")}).`, fix: "Restore them from your sync service's version history." });
        if (ink.misplaced.length) add({ severity: "info", path: sidecar.filePath, message: `${plural(ink.misplaced.length, "ink file")} of ${sidecar.filePath} ${ink.misplaced.length === 1 ? "belongs" : "belong"} to a page or block this kind of file doesn't have, so ${ink.misplaced.length === 1 ? "it is" : "they are"} never shown.`, clear: [{ type: "ink-files", filePath: sidecar.filePath, names: ink.misplaced }] });
        if (ink.droppedStrokes) add({ severity: "warning", path: sidecar.filePath, message: `${plural(ink.droppedStrokes, "stroke")} in the ink of ${sidecar.filePath} can't be read and ${ink.droppedStrokes === 1 ? "is" : "are"} not shown.`, fix: "Restore the ink folder from your sync service's version history before drawing on that page again." });
        sources.push(...ink.sources.map((source) => ({ size: source.size, contentHash: source.sha256 })));
      } else {
        let text: string;
        try { text = await readFile(sidecar.path, "utf8"); } catch { unreadSidecars += 1; continue; }
        budget.read(text.length);
        let inspection: SidecarInspection | null = null;
        let valid = true;
        try { const value = JSON.parse(text); inspection = kind.inspect ? kind.inspect(value) : null; valid = !kind.inspect || inspection !== null; } catch { valid = false; }
        if (kind.cache) {
          // Caches make themselves again; one line per kind says how many would be.
          if (!valid || (inspection?.source && !orphaned.has(sidecar.path) && await sizeOf(sidecar.fileParts) !== inspection.source.size)) outdatedCaches.set(kind.id, [...outdatedCaches.get(kind.id) ?? [], { type: "side-file", kind: kind.id, filePath: sidecar.filePath }]);
          continue;
        }
        if (!valid) { add({ severity: "error", path: sidecar.filePath, message: `The saved ${name(sidecar.kind)} of ${sidecar.filePath} can't be read.`, fix: "Restore it from a backup or your sync service's version history." }); continue; }
        if (inspection?.dropped) add({ severity: "warning", path: sidecar.filePath, message: `${inspection.dropped} ${inspection.records} in the saved ${name(sidecar.kind)} of ${sidecar.filePath} can't be read: they are not shown, and are lost the next time it is saved.`, fix: "Restore the side file from your sync service's version history before changing it." });
        if (inspection?.source) sources.push(inspection.source);
      }
      const identity = sources.find((source) => source.contentHash);
      if (identity?.contentHash) identities.set(sidecar.path, { size: identity.size, contentHash: identity.contentHash });
      if (!sources.length || orphaned.has(sidecar.path)) continue;
      const size = await sizeOf(sidecar.fileParts);
      if (size !== null && sources.some((recorded) => recorded.size !== size)) {
        add({ severity: "info", path: sidecar.filePath, message: `The ${name(sidecar.kind)} of ${sidecar.filePath} was saved for another version of the file (its size differs), so it may no longer match it.`, fix: "Open the file to see whether it still matches; make it again if not.", clear: [{ type: "side-file", kind: sidecar.kind, filePath: sidecar.filePath }] });
      }
    }
    for (const [kind, clear] of outdatedCaches) {
      const count = clear.length;
      add({ severity: "info", path: notebook, message: `${count} ${kind === "pdf-text" ? (count === 1 ? "PDF text cache is" : "PDF text caches are") : (count === 1 ? "waveform is" : "waveforms are")} out of date or can't be read; ${count === 1 ? "it is" : "they are"} made again when needed.`, clear });
    }
    // Side files of files that are gone. The tree's reconciliation moves a
    // PDF's side files and the ink of a PDF or image to the one file with the
    // bytes they recorded (pdf-sidecars.ts matchByIdentity); the same rule
    // says here where they will go. Only files of the recorded size are hashed.
    const follows = (kind: string, fileType: string | null) =>
      (fileType === "pdf" && ["pdf-annotations", "pdf-outline", "definitions"].includes(kind)) || (kind === "ink" && (fileType === "pdf" || fileType === "image"));
    const sized = new Map<string, Promise<{ path: string; size: number }[]>>();
    const filesOfType = (fileType: string) => {
      if (!sized.has(fileType)) sized.set(fileType, (async () => {
        const found: { path: string; size: number }[] = [];
        for (const file of visible.files) {
          if (getFileType(file) !== fileType) continue;
          budget.probe();
          const size = await sizeOf(file.split("/").slice(1));
          if (size !== null) found.push({ path: file, size });
        }
        return found;
      })());
      return sized.get(fileType)!;
    };
    const hashes = new Map<string, Promise<string | null>>();
    const taken = (kind: string) => new Set(sidecars.filter((sidecar) => sidecar.kind === kind && !orphaned.has(sidecar.path)).map((sidecar) => sidecar.filePath.toLowerCase()));
    const owner = async (kind: string, fileType: string | null, identity: { size: number; contentHash: string } | undefined) => {
      if (!identity || !follows(kind, fileType)) return null;
      const candidates = kind === "ink" ? [...await filesOfType("pdf"), ...await filesOfType("image")] : await filesOfType(fileType!);
      return matchByIdentity(identity, candidates, taken(kind), hashes);
    };
    for (const orphan of orphans) {
      if (!budget.allows()) break;
      const what = `Saved ${name(orphan.kind)} of ${orphan.filePath}, which is not in the notebook`;
      const moved = await owner(orphan.kind, getFileType(orphan.filePath), identities.get(orphan.path));
      add(moved
        ? { severity: "info", path: orphan.filePath, message: `${what}, belong to ${moved}: the same file, moved outside the app. They go to it the next time the notebook is opened.` }
        : { severity: "warning", path: orphan.filePath, message: `${what}.`, fix: "Put the file back where it was and it is found again. If it is gone for good, the side file can be removed from the notebook's .libera folder; keep a copy if unsure.", clear: [{ type: "side-file", kind: orphan.kind, filePath: orphan.filePath, gone: orphan.filePath }] });
    }
    // Side files set aside for files that left the notebook outside the app,
    // waiting for them to come back. Those whose file is back go to it the
    // next time the notebook is opened, by the owners' rules
    // (pdf-sidecars.ts reconcilePdfSidecars, ink.ts reconcileInkFolders): the
    // same bytes, or, with none recorded, the file back under its old path
    // without side files of that kind. They are never stale.
    const listed = new Set(visible.files);
    const comesBack = async (kind: string, fileType: string | null, originalPath: string, identity: { size: number; contentHash: string } | null) =>
      identity ? owner(kind, fileType, identity) : listed.has(originalPath) && !taken(kind).has(originalPath.toLowerCase()) ? originalPath : null;
    const returning: string[] = [];
    const kinds = { annotations: "pdf-annotations", outline: "pdf-outline", definitions: "definitions" } as const;
    for (const { file, record } of await readOrphans(notebook)) {
      if (!budget.allows()) break;
      const moved = await comesBack(kinds[record.kind], "pdf", record.originalPath, record.source ?? null);
      if (moved) { returning.push(file); add({ severity: "info", path: moved, message: `Saved ${name(kinds[record.kind])} set aside when ${record.originalPath} left the notebook belong to ${moved}${record.source ? ", the same file" : ""}. They go to it the next time the notebook is opened.` }); }
    }
    const setAsideInk = orphanedSidecarsDirectoryPath(notebook, "ink");
    for (const entry of await readdir(setAsideInk, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !budget.allows()) continue;
      const directory = path.join(setAsideInk, entry.name);
      let record: { originalPath?: unknown; source?: { size?: unknown; sha256?: unknown } | null } | null = null;
      try { record = JSON.parse(await readFile(path.join(directory, "record.json"), "utf8")); } catch { /* Not a set-aside record the owner reads. */ }
      if (typeof record?.originalPath !== "string") continue;
      const source = record.source && typeof record.source.size === "number" && typeof record.source.sha256 === "string" ? { size: record.source.size, contentHash: record.source.sha256 } : null;
      const moved = await comesBack("ink", getFileType(record.originalPath), record.originalPath, source);
      if (moved) { returning.push(directory); add({ severity: "info", path: moved, message: `Ink set aside when ${record.originalPath} left the notebook belongs to ${moved}. It goes to it the next time the notebook is opened.` }); }
    }
    const isReturning = (file: string) => returning.some((kept) => file === kept || file.startsWith(`${kept}${path.sep}`));
    const setAside = path.join(notebookSystemDirectoryPath(notebook), ORPHANED_SIDECARS_DIR);
    const kept: CleanupAction[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && !isReturning(file)) kept.push({ type: "set-aside", file: path.relative(setAside, file).split(path.sep).join("/") });
      }
    };
    await walk(setAside);
    if (kept.length) add({ severity: "info", path: notebook, message: `${kept.length} side ${kept.length === 1 ? "file is" : "files are"} kept for files that left the notebook outside the app, in case they come back.`, clear: kept });
    if (unreadable.length || unreadSidecars) return `${unreadable.length + unreadSidecars} side ${unreadable.length + unreadSidecars === 1 ? "file or folder" : "files or folders"} could not be read.`;
  });

  await run("assets", async (add) => {
    const unused = await unreferencedMarkdownAssets(notebook, notes);
    if (unused === null) return "Some notes could not be read, so unused images can't be told apart.";
    // An image whose name a note's missing embed has is most likely that
    // embed's image, left behind when the note moved: it is kept for the
    // embed to be pointed at again, never offered to Acknowledge.
    const embedded = new Set<string>();
    if (unused.some((asset) => !asset.toLowerCase().endsWith(".py"))) {
      for (const note of readable) {
        for (const target of markdownImageTargets(note.documentPath, note.content)) {
          if (target.absolutePath && await probeOnce(target.absolutePath) !== "present") embedded.add(path.basename(target.absolutePath).toLowerCase());
        }
      }
    }
    // Python code is named after its note: code whose name a note without
    // code of its own would have is most likely that note's, its folder
    // moved or renamed. It is kept too.
    const codeNames = new Map<string, string>();
    if (unused.some((asset) => asset.toLowerCase().endsWith(".py"))) {
      for (const file of visible.files) {
        if (getFileType(file) !== "markdown") continue;
        const own = pythonSidecarPath(file);
        if (await probeOnce(path.join(notebookPath(notebook), ...own.split("/").slice(1))) === "absent") codeNames.set(own.slice(own.lastIndexOf("/") + 1).toLowerCase(), file);
      }
    }
    for (const asset of unused) {
      const python = asset.toLowerCase().endsWith(".py");
      const name = asset.slice(asset.lastIndexOf("/") + 1).toLowerCase();
      const wanted = !python && embedded.has(name);
      const owner = python ? codeNames.get(name) : undefined;
      add(python
        ? owner
          ? { severity: "warning", path: asset, message: `Python code of a note that is not in the notebook, named like ${owner}: probably its code, left behind when a folder moved.`, fix: `Move it to ${pythonSidecarPath(owner)} to give it back to ${owner}.` }
          : { severity: "warning", path: asset, message: "Python code of a note that is not in the notebook.", fix: "Move the note back and it is found again; remove the code only once you no longer need it.", clear: [{ type: "asset", path: asset, ...(pythonSidecarDocumentPath(asset) ? { gone: pythonSidecarDocumentPath(asset)! } : {}) }] }
        : wanted
          ? { severity: "info", path: asset, message: "An image no note shows, but a note shows a missing image of this name: probably this one, left behind when the note moved.", fix: "Point the note's image at this file, or insert it again." }
          : { severity: "info", path: asset, message: "An image no note shows (an open, unsaved note may still use it).", fix: "It can be removed once no note needs it.", clear: [{ type: "asset", path: asset }] });
    }
  });

  await run("images", async (add) => {
    let unchecked = 0;
    for (const note of readable) {
      if (!budget.allows()) break;
      for (const target of markdownImageTargets(note.documentPath, note.content)) {
        budget.probe();
        if (!target.absolutePath) { add({ severity: "warning", path: note.documentPath, message: `The image address "${target.source}" can't be read.` }); continue; }
        const state = await probeOnce(target.absolutePath);
        if (state === "unknown") unchecked += 1;
        if (state === "absent") add({ severity: "error", path: note.documentPath, message: `Shows ${target.libraryPath ?? target.source}, which is missing.`, fix: "Put the image back, or insert it again." });
      }
    }
    if (!notes.complete || unchecked || notesCut) return unchecked ? `${unchecked} images could not be checked.` : notesCut ?? "Some notes could not be read.";
  });

  await run("links", async (add) => {
    let uncheckedLinks = 0;
    // What a link asks of its file is checked too: a heading of a note, an
    // annotation of a PDF or image, a moment in a recording. Each target is
    // read once (headings from the notes already read, annotation ids and
    // a recording's length from their side files).
    const byPath = new Map(readable.map((note) => [note.documentPath, note]));
    const headings = new Map<string, MarkdownHeadingAnchor[]>();
    const hasHeading = (note: { documentPath: string; content: string }, fragment: string) => {
      if (!headings.has(note.documentPath)) headings.set(note.documentPath, markdownHeadingAnchors(note.content));
      if (findMarkdownHeadingAnchorIndex(headings.get(note.documentPath)!, fragment) >= 0) return true;
      // An HTML anchor (`<a id="…">`) is a place to link to as well.
      const name = decodeMarkdownHeadingHash(fragment);
      return note.content.includes(`id="${name}"`) || note.content.includes(`name="${name}"`);
    };
    const annotationIds = new Map<string, Promise<Set<string> | null>>();
    const durations = new Map<string, Promise<number | null>>();
    const durationOf = (libraryPath: string) => {
      if (!durations.has(libraryPath)) durations.set(libraryPath, recordingDuration(libraryPath));
      return durations.get(libraryPath)!;
    };
    const opensAtStart = "it opens the file at its start.";
    for (const note of readable) {
      if (!budget.allows()) break;
      for (const href of extractNotebookLinkDestinations(note.content)) {
        if (href.startsWith("#")) {
          if (href.length > 1 && !hasHeading(note, href)) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" finds no heading in this note.`, fix: "Point it at a heading's current title." });
          continue;
        }
        const candidates = linkCandidates(href, note.documentPath);
        if (!candidates.length) continue;
        await disk.check(candidates);
        const target = resolveLinkTargetWith(href, note.documentPath, disk.exists);
        if (!target) {
          if (candidates.some(disk.unknown)) { uncheckedLinks += 1; continue; }
          add({ severity: "warning", path: note.documentPath, message: `The link "${href}" finds no file.`, fix: "Point the link at the file's current place." });
          continue;
        }
        if (target.unreadablePosition) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" keeps a place in ${target.path} that can't be read; ${opensAtStart}`, fix: "Link to the place again." });
        if (target.headingFragment && getFileType(target.path) === "markdown") {
          const linked = byPath.get(target.path);
          if (linked && !hasHeading(linked, target.headingFragment)) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" finds no heading "${decodeMarkdownHeadingHash(target.headingFragment)}" in ${target.path}; ${opensAtStart}`, fix: "Point it at a heading's current title." });
        }
        const view = target.metadata?.viewState;
        const annotation = view?.pdf?.selectedAnnotationId ?? view?.image?.selectedAnnotationId;
        if (annotation) {
          budget.probe();
          if (!annotationIds.has(target.path)) annotationIds.set(target.path, savedAnnotationIds(target.path));
          const ids = await annotationIds.get(target.path)!;
          if (ids && !ids.has(annotation)) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" points at an annotation of ${target.path} that is no longer there; ${opensAtStart}`, fix: "Link to the place again." });
        }
        const time = view?.audio?.currentTime;
        if (time !== undefined && time > 0) {
          const duration = await durationOf(target.path);
          if (duration && time > duration + 1) add({ severity: "warning", path: note.documentPath, message: `The link "${href}" points at ${clock(time)}, past the end of ${target.path} (${clock(duration)}).`, fix: "Link to the moment again." });
        }
      }
    }
    if (!notes.complete || uncheckedLinks || notesCut) return uncheckedLinks ? `${uncheckedLinks} links could not be checked.` : notesCut ?? "Some notes could not be read.";
  });

  await run("latex", async (add) => {
    const { references, incomplete } = await latexDependencies(notebook, visible.files);
    const what = { include: "includes", bibliography: "uses the bibliography", graphics: "shows" } as const;
    let unchecked = 0;
    for (const [file, written] of references) {
      if (!budget.allows()) break;
      for (const reference of written) {
        await disk.check(reference.candidates);
        if (reference.candidates.some(disk.exists)) continue;
        // A file the tree does not list (.sty, .cls, an image type it does not show) may still be on disk.
        let state: "present" | "absent" | "unknown" = "absent";
        for (const candidate of reference.candidates) {
          const [owner, ...parts] = candidate.split("/");
          const found = await probe(path.join(notebookPath(owner), ...parts));
          if (found === "present") { state = "present"; break; }
          if (found === "unknown") state = "unknown";
        }
        if (state === "unknown") unchecked += 1;
        if (state === "absent") add({ severity: "error", path: file, message: `${what[reference.kind]} "${reference.written}", which is not found.`, fix: "Add the file, or correct the path (paths are read from the main file's folder)." });
      }
    }
    if (incomplete || visible.truncated) return "Large LaTeX projects are only partly read.";
    if (unchecked) return `${unchecked} LaTeX references could not be checked.`;
  });

  await run("records", async (add) => {
    const metadata = await readWorkspaceMetadata();
    // A file that could not be checked is never reported as missing.
    const missing = async (libraryPath: string) => { await disk.check([libraryPath]); return !disk.exists(libraryPath) && !disk.unknown(libraryPath); };
    for (const starred of metadata.starredFilePaths) {
      if (under(starred, notebook) && await missing(starred)) add({ severity: "warning", path: starred, message: "Starred, but the file is missing.", fix: "Unstar it, or put the file back.", clear: [{ type: "star", path: starred, gone: starred }] });
    }
    for (const tagged of Object.keys(metadata.fileTags)) {
      if (under(tagged, notebook) && await missing(tagged)) add({ severity: "warning", path: tagged, message: "Has tags, but the file is missing.", fix: "Put the file back, or its tags stay unused.", clear: [{ type: "tags", path: tagged, gone: tagged }] });
    }
    // Read without migrating older review storage (readReviewKeys would).
    const reviews = await inspectReviewKeys(getStateRoot());
    if (reviews.damaged) add({ severity: "error", path: notebook, message: `The review comments' index can't be read (${reviews.damaged}).`, fix: "Restore .libera/reviews/index.json from your sync service's version history." });
    if (reviews.legacy) add({ severity: "info", path: notebook, message: "Older review storage is waiting to be converted; it is the next time review comments load." });
    for (const key of new Set(reviews.keys)) {
      if (under(key, notebook) && await missing(key)) add({ severity: "info", path: key, message: "Review comments are kept for this file, which is missing.", clear: [{ type: "review", path: key, gone: key }] });
    }
    const pending = await listReviewEntryPaths();
    if (pending.unreadable) add({ severity: "warning", path: notebook, message: `${pending.unreadable} pending agent ${pending.unreadable === 1 ? "review can't" : "reviews can't"} be read (in any notebook).` });
    for (const reviewed of pending.paths) {
      if (under(reviewed, notebook) && await missing(reviewed)) add({ severity: "warning", path: reviewed, message: "The agent's changes to this file wait for review, but the file is missing.", fix: "Put the file back to review them; they are dropped the next time reviews load.", clear: [{ type: "agent-review", path: reviewed, gone: reviewed }] });
    }
    const runs = await listRunFiles();
    if (runs.unreadable) add({ severity: "info", path: notebook, message: `${runs.unreadable} agent ${runs.unreadable === 1 ? "run's" : "runs'"} undo history can't be read (in any notebook).` });
    for (const file of runs.files) {
      if (!file.shared && !file.reverted && under(file.path, notebook) && await missing(file.path)) {
        add({ severity: "info", path: file.path, message: "An agent run can't be undone for this file, which is missing." });
      }
    }
  });

  let ownLibrary = null as ReferenceLibrary | null;
  await run("references", async (add) => {
    for (const library of await libraryNotebookNames()) {
      let inspected;
      try { inspected = await inspectReferenceLibrary(library); } catch { continue; }
      if (library === notebook && !("damaged" in inspected)) ownLibrary = inspected.library ?? null;
      if ("damaged" in inspected) {
        // The app sets a damaged library aside when it next opens it; until then, its attachments count for nothing.
        if (library === notebook) add({ severity: "error", path: notebook, message: `The notebook's reference library can't be read (${inspected.damaged})`, fix: "Restore .libera/references/library.json from a backup or your sync service's version history before opening References, which would set the damaged file aside and start an empty library." });
        continue;
      }
      for (const entry of Object.values(inspected.library?.entries ?? {})) {
        for (const attachment of entry.attachments) {
          if (attachment.kind === "url") continue;
          if (library !== notebook && !under(attachment.path, notebook)) continue;
          await disk.check([attachment.path]);
          if (!disk.exists(attachment.path) && !disk.unknown(attachment.path)) {
            add({ severity: "warning", path: attachment.path, message: `Attached to the reference "${entry.key}" in ${library}'s library, but missing.`, fix: "Put the file back (it is re-attached when found), or detach it in References.", clear: [{ type: "attachment", library, entry: entry.id, path: attachment.path, gone: attachment.path }] });
          }
        }
      }
    }
    const tether = await readTetherTarget(notebook);
    if (tether && "damaged" in tether) {
      add({ severity: "warning", path: notebook, message: `The .bib tether's settings can't be read (${tether.damaged}).`, fix: "Choose the tethered file again in References." });
    } else if (tether && "libraryPath" in tether) {
      await disk.check([tether.libraryPath]);
      if (!disk.exists(tether.libraryPath) && !disk.unknown(tether.libraryPath)) add({ severity: "warning", path: tether.libraryPath, message: "The library is tethered to this .bib file, which is missing.", fix: "Put the file back, or choose the tethered file again in References.", clear: [{ type: "tether", target: tether.libraryPath, gone: tether.libraryPath }] });
    } else if (tether && await probe(tether.absolutePath) === "absent") {
      add({ severity: "warning", path: notebook, message: `The library is tethered to ${tether.absolutePath}, which is missing.`, fix: "Reconnect the drive, or choose the tethered file again in References.", clear: [{ type: "tether", target: tether.absolutePath }] });
    }
  });

  await run("indexes", async (add) => {
    // Indexes the app keeps up to date by itself, compared with what they
    // index: each entry's content hash against the notes already read (no
    // file is read again for this). Out of date is not broken, so all of
    // this is for the record.
    const hashes = new Map(readable.map((note) => [note.documentPath, createHash("sha256").update(note.content, "utf8").digest("hex")]));
    const outdated = async (files: Record<string, { contentHash: string }>) => {
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
      const count = await outdated((await readLinkIndex(linkIndexPath(notebook))).files);
      if (count) add({ severity: "info", path: notebook, message: `The link index is out of date for ${plural(count, "note")}, so links to a file and related notebooks may be off until the notebook is next opened.` });
    }
    if (await probe(citationIndexPath(notebook)) === "present") {
      const count = await outdated((await readCitationIndex(citationIndexPath(notebook))).files);
      if (count) add({ severity: "info", path: notebook, message: `The citation index is out of date for ${plural(count, "file")}; it is brought up to date the next time citations are listed.`, clear: [{ type: "citations" }] });
    }
    if (ownLibrary) {
      const mirror = await planBibMirror(notebook, ownLibrary);
      const again = "It is written again after the next change in References.";
      if (mirror.status === "write") add({ severity: "info", path: mirror.path, message: mirror.exists ? "The .bib mirror is out of date with the reference library." : "The .bib mirror is on, but references.bib is not written yet.", fix: again, clear: [{ type: "bib-mirror" }] });
      if (mirror.status === "protected") add({ severity: "info", path: mirror.editedPath, message: `references.bib was changed outside Libera, so the library's bibliography goes to ${mirror.path} instead${mirror.current ? "" : ", which is out of date"}.`, fix: `Cite ${mirror.path} in LaTeX, or remove the edited references.bib so that Libera writes it again.` });
    }
    // Global Search, read without opening the index for writing; skipped when that can't be done.
    const indexed = readIndexedLibraryPaths(searchIndexFile(), notebook);
    if (indexed) {
      const listed = new Set(visible.files);
      let gone = 0;
      for (const file of indexed) {
        if (listed.has(file) || !under(file, notebook)) continue;
        if (!budget.allows()) break;
        budget.probe();
        await disk.check([file]);
        if (!disk.exists(file) && !disk.unknown(file)) gone += 1;
      }
      if (gone) add({ severity: "info", path: notebook, message: `Global Search still lists ${plural(gone, "file")} no longer in the notebook; it catches up the next time it runs.` });
    }
  });

  await run("migrations", async (add) => {
    // Imported here: the migration module uses this one for its own check.
    const { listInterruptedMigrations, listUnreadableMigrations } = await import("@/lib/storage/migration");
    for (const migration of await listInterruptedMigrations()) {
      if (migration.source === notebook || migration.destination.notebook === notebook) {
        add({ severity: "error", path: notebook, message: `A migration from ${migration.source} to ${migration.destination.notebook} did not finish.`, fix: "Open Migration and choose Move the rest or Stop here." });
      }
    }
    for (const name of await listUnreadableMigrations()) {
      add({ severity: "warning", path: notebook, message: `A migration journal (${name}) can't be read; it may concern this notebook.`, fix: "Open Migration to set it aside after checking the notebooks it moved between." });
    }
    for (const copy of staged) {
      add({ severity: "warning", path: copy, message: "A prepared copy left by a migration.", fix: "Finish or stop the migration; if none is open, the copy can be deleted." });
    }
  });

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
