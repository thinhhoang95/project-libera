import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { rewriteCitationKeys } from "@/lib/references/citation-syntax";
import { isValidCitationKey } from "@/lib/references/keys";
import { libraryEntriesByKey, entryForKey } from "@/lib/references/format";
import type { ReferenceLibrary } from "@/lib/references/types";
import { assertNotSharedItem } from "@/lib/collab/shared-notebook";
import { StorageError } from "@/lib/storage/errors";
import { getFileType } from "@/lib/storage/file-types";
import { writeJsonAtomically } from "@/lib/storage/fs-utils";
import { filePathFromParts, notebookSystemDirectoryPath, splitFilePath } from "@/lib/storage/paths";
import { refreshNotebookCitations } from "@/lib/storage/reference-citations";
import { readReferenceLibrary } from "@/lib/storage/references";
import { notifySearchChanges } from "@/lib/storage/search-updates";

// Key rename rewrite (docs/references/plan.md §1.4, "Key change"). After a
// key changes, the old key stays an alias, and the panel offers to update the
// citations that still use it. The rewrite is draft-aware like agent edits:
//
//   preview  every Markdown file in the notebook that cites an old key (the
//            citation index finds candidates, a scan confirms them), with the
//            open drafts the client sent taking the place of saved text, and
//            the SHA-256 of each saved file as `expected`.
//   apply    rewrites each saved file whose hash still matches `expected`,
//            atomically, and returns the rewritten drafts for the client to
//            apply to its open tabs.
//   undo     restores the files of one rewrite, unless they changed since.
//
// Each applied rewrite keeps the original text of the files it changed in
// `<notebook system dir>/references/rewrites/<id>.json`; the last 20 are kept.

export type CitationRewriteMap = Map<string, string>;
export type RewriteExcerpt = { line: number; before: string; after: string };
export type RewritePreviewFile = { path: string; count: number; excerpts: RewriteExcerpt[] };
export type RewritePreview = {
  files: RewritePreviewFile[];
  /** SHA-256 of each listed file's saved text, to pass back when applying. Files that exist only as drafts are absent. */
  expected: Record<string, string>;
};
export type RewriteSkip = { path: string; reason: string };
export type RewriteResult = {
  /** Undo handle; null when no saved file changed. */
  rewriteId: string | null;
  changed: string[];
  skipped: RewriteSkip[];
  /** Rewritten draft text by path, for supplied drafts that cite an old key. */
  draftEdits: Record<string, string>;
};
export type RewriteUndoResult = { restored: string[]; skipped: RewriteSkip[] };

const MAX_MAP_ENTRIES = 500;
const MAX_EXCERPTS = 20;
const MAX_EXCERPT_CHARACTERS = 240;
const KEPT_REWRITES = 20;
const REWRITE_ID = /^rw-[0-9]{13}-[a-f0-9]{12}$/;

export const REWRITE_SKIP_REASONS = {
  changed: "The file changed since the preview. Preview again to include it.",
  notPreviewed: "The file was not in the preview. Preview again to include it.",
  shared: "The file is in a shared notebook and was left unchanged.",
  missing: "The file no longer exists.",
  unreadable: "The file could not be read.",
  changedSinceRewrite: "The file changed after the rewrite and was left as it is.",
} as const;

export function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Replace a file's contents in one rename, so readers never see a partial
 * file. The temporary file is a dotfile beside the target, which the tree
 * and the indexes skip.
 */
export async function writeTextAtomically(absolutePath: string, text: string) {
  const temporary = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, absolutePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Absolute path of a library-relative file, with the same checks as the file routes. */
export function absoluteNotebookFile(relativePath: string) {
  const { notebook, pathParts } = splitFilePath(relativePath);
  return { notebook, pathParts, absolutePath: filePathFromParts(notebook, pathParts) };
}

async function readSavedText(relativePath: string): Promise<string | null> {
  try { return await readFile(absoluteNotebookFile(relativePath).absolutePath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isSharedFile(relativePath: string) {
  try {
    const { notebook, pathParts } = splitFilePath(relativePath);
    assertNotSharedItem(notebook, pathParts);
    return false;
  } catch {
    return true;
  }
}

/** A rejected rewrite request; the message is shown to the user. */
export class CitationRewriteError extends StorageError {
  constructor(message: string, status = 400) {
    super(message, status);
    this.name = "CitationRewriteError";
  }
}

/**
 * Check a rewrite map against the library: every key is valid, no key maps to
 * itself, and every new key is an entry's key or alias.
 */
export function validateRewriteMap(library: ReferenceLibrary, map: unknown): CitationRewriteMap {
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new CitationRewriteError("The key changes must map old keys to new keys.");
  const entries = Object.entries(map as Record<string, unknown>);
  if (!entries.length) throw new CitationRewriteError("There are no key changes to apply.");
  if (entries.length > MAX_MAP_ENTRIES) throw new CitationRewriteError(`Rewrite at most ${MAX_MAP_ENTRIES} keys at a time.`);
  const byKey = libraryEntriesByKey(library);
  const result: CitationRewriteMap = new Map();
  for (const [from, to] of entries) {
    if (!isValidCitationKey(from)) throw new CitationRewriteError(`“${from}” is not a valid citation key.`);
    if (typeof to !== "string" || !isValidCitationKey(to)) throw new CitationRewriteError(`“${String(to)}” is not a valid citation key.`);
    if (from === to) throw new CitationRewriteError(`“${from}” is mapped to itself.`);
    if (!entryForKey(byKey, to)) throw new CitationRewriteError(`“${to}” is not a key or alias in this notebook's references.`);
    result.set(from, to);
  }
  return result;
}

function validateDrafts(notebook: string, drafts: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (drafts === undefined || drafts === null) return result;
  if (typeof drafts !== "object" || Array.isArray(drafts)) throw new CitationRewriteError("Drafts must map file paths to text.");
  for (const [file, text] of Object.entries(drafts as Record<string, unknown>)) {
    if (typeof text !== "string") throw new CitationRewriteError(`The draft for “${file}” must be text.`);
    // Drafts of files outside the notebook, or of other file types, are not part of this rewrite.
    if (!file.startsWith(`${notebook}/`) || getFileType(file.split("/").at(-1) ?? "") !== "markdown") continue;
    try { absoluteNotebookFile(file); } catch { continue; }
    result.set(file, text);
  }
  return result;
}

/** Saved files citing an old key, from the citation index; the caller confirms each by scanning. */
async function candidateFiles(notebook: string, map: CitationRewriteMap) {
  const { byKey } = await refreshNotebookCitations(notebook, { includeArchive: true });
  const files = new Set<string>();
  for (const from of map.keys()) for (const file of byKey[from] ?? []) files.add(file);
  return files;
}

function clip(line: string) {
  return line.length > MAX_EXCERPT_CHARACTERS ? `${line.slice(0, MAX_EXCERPT_CHARACTERS - 1)}…` : line;
}

/** Changed lines, 1-based. Keys never contain line breaks, so lines stay aligned. */
function excerpts(before: string, after: string): RewriteExcerpt[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const result: RewriteExcerpt[] = [];
  for (let index = 0; index < oldLines.length && result.length < MAX_EXCERPTS; index += 1) {
    if (oldLines[index] !== newLines[index]) {
      result.push({ line: index + 1, before: clip(oldLines[index].replace(/\r$/, "")), after: clip((newLines[index] ?? "").replace(/\r$/, "")) });
    }
  }
  return result;
}

function sortedPaths(paths: Iterable<string>) {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every Markdown file in the notebook citing an old key, drafts in place of saved text. Writes nothing. */
export async function previewCitationRewrite(notebook: string, mapInput: unknown, draftsInput?: unknown): Promise<RewritePreview> {
  const library = await readReferenceLibrary(notebook);
  const map = validateRewriteMap(library, mapInput);
  const drafts = validateDrafts(notebook, draftsInput);
  const candidates = await candidateFiles(notebook, map);
  for (const file of drafts.keys()) candidates.add(file);

  const files: RewritePreviewFile[] = [];
  const expected: Record<string, string> = {};
  for (const file of sortedPaths(candidates)) {
    let saved: string | null;
    try { saved = await readSavedText(file); } catch { saved = null; }
    if (saved !== null) expected[file] = hashText(saved);
    const text = drafts.get(file) ?? saved;
    if (text === null) continue;
    const rewritten = rewriteCitationKeys(text, map);
    if (!rewritten.count) {
      delete expected[file];
      continue;
    }
    files.push({ path: file, count: rewritten.count, excerpts: excerpts(text, rewritten.text) });
  }
  return { files, expected };
}

type RewriteBackupFile = { original: string; written: string };
type RewriteBackup = {
  version: 1;
  id: string;
  notebook: string;
  createdAt: string;
  map: Record<string, string>;
  files: Record<string, RewriteBackupFile>;
  undoneAt?: string;
};

function rewritesDirectory(notebook: string) {
  return path.join(notebookSystemDirectoryPath(notebook), "references", "rewrites");
}

function backupPath(notebook: string, id: string) {
  if (!REWRITE_ID.test(id)) throw new CitationRewriteError("The rewrite id is invalid.");
  return path.join(rewritesDirectory(notebook), `${id}.json`);
}

function newRewriteId() {
  return `rw-${String(Date.now()).padStart(13, "0")}-${randomBytes(6).toString("hex")}`;
}

/** Keep the newest KEPT_REWRITES backups; ids sort by creation time. */
async function pruneBackups(notebook: string) {
  let names: string[];
  try { names = (await readdir(rewritesDirectory(notebook))).filter((name) => REWRITE_ID.test(name.replace(/\.json$/, ""))).sort(); } catch { return; }
  for (const name of names.slice(0, Math.max(0, names.length - KEPT_REWRITES))) {
    await rm(path.join(rewritesDirectory(notebook), name), { force: true }).catch(() => undefined);
  }
}

async function refreshIndex(notebook: string) {
  try { await refreshNotebookCitations(notebook, { includeArchive: true }); } catch (error) {
    console.error(`[references] Could not update the citation index of ${notebook}:`, error);
  }
}

/**
 * Rewrite the saved files from a preview. A file whose saved text no longer
 * hashes to `expected[path]`, or that was not in the preview, is skipped.
 */
export async function applyCitationRewrite(
  notebook: string,
  mapInput: unknown,
  { expected, drafts: draftsInput }: { expected: unknown; drafts?: unknown },
): Promise<RewriteResult> {
  const library = await readReferenceLibrary(notebook);
  const map = validateRewriteMap(library, mapInput);
  const drafts = validateDrafts(notebook, draftsInput);
  if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
    !Object.values(expected).every((value) => typeof value === "string")) {
    throw new CitationRewriteError("Preview the rewrite first, and pass back its `expected` hashes.");
  }
  const expectedHashes = expected as Record<string, string>;
  const candidates = await candidateFiles(notebook, map);
  for (const file of Object.keys(expectedHashes)) if (file.startsWith(`${notebook}/`)) candidates.add(file);

  const changed: string[] = [];
  const skipped: RewriteSkip[] = [];
  const backup: RewriteBackup = { version: 1, id: newRewriteId(), notebook, createdAt: new Date().toISOString(), map: Object.fromEntries(map), files: {} };

  for (const file of sortedPaths(candidates)) {
    let saved: string | null;
    try { saved = await readSavedText(file); } catch {
      skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.unreadable });
      continue;
    }
    if (saved === null) {
      if (Object.hasOwn(expectedHashes, file)) skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.missing });
      continue;
    }
    const rewritten = rewriteCitationKeys(saved, map);
    if (!rewritten.count) continue;
    if (!Object.hasOwn(expectedHashes, file)) {
      skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.notPreviewed });
      continue;
    }
    if (expectedHashes[file] !== hashText(saved)) {
      skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.changed });
      continue;
    }
    if (isSharedFile(file)) {
      skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.shared });
      continue;
    }
    backup.files[file] = { original: saved, written: hashText(rewritten.text) };
    // The backup is written before the first file changes, so every change can be undone.
    if (!changed.length) await writeJsonAtomically(backupPath(notebook, backup.id), backup);
    await writeTextAtomically(absoluteNotebookFile(file).absolutePath, rewritten.text);
    changed.push(file);
  }

  const draftEdits: Record<string, string> = {};
  for (const [file, text] of drafts) {
    const rewritten = rewriteCitationKeys(text, map);
    if (rewritten.count) draftEdits[file] = rewritten.text;
  }

  if (changed.length) {
    await writeJsonAtomically(backupPath(notebook, backup.id), backup);
    await pruneBackups(notebook);
    notifySearchChanges(changed);
    await refreshIndex(notebook);
  }
  return { rewriteId: changed.length ? backup.id : null, changed, skipped, draftEdits };
}

/** Restore the files of one rewrite, except those edited since. A rewrite is undone once. */
export async function undoCitationRewrite(notebook: string, rewriteId: unknown): Promise<RewriteUndoResult> {
  if (typeof rewriteId !== "string" || !REWRITE_ID.test(rewriteId)) throw new CitationRewriteError("The rewrite id is invalid.");
  const target = backupPath(notebook, rewriteId);
  let backup: RewriteBackup;
  try {
    backup = JSON.parse(await readFile(target, "utf8")) as RewriteBackup;
  } catch {
    throw new CitationRewriteError("That rewrite can no longer be undone.", 404);
  }
  if (backup?.version !== 1 || backup.notebook !== notebook || !backup.files || typeof backup.files !== "object") {
    throw new CitationRewriteError("That rewrite can no longer be undone.", 404);
  }
  if (backup.undoneAt) throw new CitationRewriteError("That rewrite was already undone.", 409);

  const restored: string[] = [];
  const skipped: RewriteSkip[] = [];
  for (const [file, { original, written }] of Object.entries(backup.files)) {
    let current: string | null;
    try { current = await readSavedText(file); } catch {
      skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.unreadable });
      continue;
    }
    if (current === null) { skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.missing }); continue; }
    if (hashText(current) !== written) { skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.changedSinceRewrite }); continue; }
    if (isSharedFile(file)) { skipped.push({ path: file, reason: REWRITE_SKIP_REASONS.shared }); continue; }
    await writeTextAtomically(absoluteNotebookFile(file).absolutePath, original);
    restored.push(file);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeJsonAtomically(target, { ...backup, undoneAt: new Date().toISOString() });
  if (restored.length) {
    notifySearchChanges(restored);
    await refreshIndex(notebook);
  }
  return { restored, skipped };
}
