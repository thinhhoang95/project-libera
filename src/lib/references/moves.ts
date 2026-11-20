import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { citedKeys, rewriteCitationKeys } from "@/lib/references/citation-syntax";
import { duplicateScore } from "@/lib/references/dedupe";
import { entryForKey, libraryEntriesByKey } from "@/lib/references/format";
import { generateCitationKey, takenCitationKeys } from "@/lib/references/keys";
import { absoluteNotebookFile, hashText, writeTextAtomically } from "@/lib/references/rewrite";
import type { ReferenceEntry, ReferenceLibrary, ReferenceLibraryOp } from "@/lib/references/types";
import { getFileType } from "@/lib/storage/file-types";
import { refreshNotebookCitations } from "@/lib/storage/reference-citations";
import { readReferenceLibrary, ReferenceRevisionConflict, updateReferenceLibrary } from "@/lib/storage/references";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { itemPath, splitDirectoryPath } from "@/lib/storage/paths";

// Cross-notebook copy-on-move (docs/references/plan.md §1.4, "Document moved
// to another notebook"). Each notebook has its own library, so when Markdown
// moves to another notebook, the entries it cites that the destination lacks
// are copied there, after the file move succeeded and in the same request:
//
// - A cited key is resolved against the source library (key or alias). Keys
//   the source library does not know are left alone.
// - The destination entry for the same work is reused: one sharing an
//   identifier (DOI, arXiv ID, PMID, ISBN), else the best fuzzy match scoring
//   at least 0.95. When the cited key does not resolve to it in the
//   destination, the citation is rewritten to the destination's key. Aliases
//   are never added to the destination's entries.
// - Otherwise the entry is copied with a new id, keeping its key (and the
//   aliases) that are free in the destination; a taken key gets a generated
//   one and the document's citations are rewritten to it. Attachment paths
//   are library-relative, so they are kept; the attachment wiring has already
//   remapped those of the moved file itself before this runs.
// - Rewrites are written to the moved files on disk and reported, with the
//   per-file key map, so the client can apply the same change to an open
//   draft. They are planned first (key map and text hashes, handed to
//   `onPlan`) and written after, so a crash between the two can be finished. A failure here never fails the move: it is logged and returned as
//   `error`.

export type MovedMarkdownFile = { from: string; to: string };

export type ReferenceMoveResult = {
  /** Entries copied into the destination library: the key they have there and their new id. */
  copied: { key: string; entryId: string }[];
  /** Cited keys whose work the destination library already had, and that entry's key there. */
  reused: { key: string; destinationKey: string }[];
  /** Citation keys rewritten in the moved files (new paths). */
  renamed: { from: string; to: string; files: string[] }[];
  /** For each rewritten file (new path), the key map the client applies to an open draft of it. */
  drafts: { path: string; map: Record<string, string> }[];
  /** The destination library's revision after the copy; null when it was not changed. */
  destinationRevision: number | null;
  /** Set when copying failed. The files were moved regardless. */
  error?: string;
};

/**
 * One note's planned citation rewrite: the key map and the hashes of the text
 * before and after it. A migration saves these before the first rewritten text
 * is published, so a crash in between is resumed with the right map. Further
 * rewrite kinds (links) get a list of their own next to it.
 */
export type PlannedCitationRewrite = { path: string; map: Record<string, string>; before: string; after: string };

export type CopyReferencesOptions = {
  /** Called once the plan is known and before any note is rewritten (a migration saves it in its journal). */
  onPlan?: (result: ReferenceMoveResult, rewrites: PlannedCitationRewrite[]) => Promise<void>;
};

export function emptyReferenceMoveResult(): ReferenceMoveResult {
  return { copied: [], reused: [], renamed: [], drafts: [], destinationRevision: null };
}

/** A fuzzy match at or above this score counts as the same work. */
export const MOVE_FUZZY_THRESHOLD = 0.95;
const LIBRARY_ATTEMPTS = 3;

export type ReferenceCopyPlan = {
  ops: ReferenceLibraryOp[];
  copied: ReferenceMoveResult["copied"];
  reused: ReferenceMoveResult["reused"];
  /** Cited key → key to write instead, for citations that must change. */
  keyMap: Map<string, string>;
};

/** The destination entry for the same work as `entry`: an identifier match first, else the best fuzzy match ≥ 0.95. */
export function matchingDestinationEntry(entry: ReferenceEntry, destination: ReferenceEntry[]): ReferenceEntry | null {
  let best: ReferenceEntry | null = null;
  let bestScore = 0;
  for (const candidate of destination) {
    const { score, reason } = duplicateScore(entry, candidate);
    if (reason && reason !== "fuzzy") return candidate;
    if (reason === "fuzzy" && score >= MOVE_FUZZY_THRESHOLD && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * What copying the entries behind `keys` from `source` into `destination`
 * takes. Pure: `newId` and `now` are injected for tests.
 */
export function planReferenceCopy(
  source: ReferenceLibrary,
  destination: ReferenceLibrary,
  keys: Iterable<string>,
  { now = new Date().toISOString(), newId = () => `ref_${randomUUID()}` }: { now?: string; newId?: () => string } = {},
): ReferenceCopyPlan {
  const sourceByKey = libraryEntriesByKey(source);
  const groups = new Map<string, { entry: ReferenceEntry; keys: string[] }>();
  for (const key of keys) {
    const entry = entryForKey(sourceByKey, key);
    if (!entry) continue;
    const group = groups.get(entry.id) ?? { entry, keys: [] };
    if (!group.keys.includes(key)) group.keys.push(key);
    groups.set(entry.id, group);
  }

  const destinationEntries = Object.values(destination.entries);
  const destinationByKey = libraryEntriesByKey(destination);
  const taken = new Set(takenCitationKeys(destinationEntries).map((key) => key.toLowerCase()));
  const plan: ReferenceCopyPlan = { ops: [], copied: [], reused: [], keyMap: new Map() };

  for (const { entry, keys: cited } of groups.values()) {
    const match = matchingDestinationEntry(entry, destinationEntries);
    if (match) {
      for (const key of cited) {
        plan.reused.push({ key, destinationKey: match.key });
        if (entryForKey(destinationByKey, key) !== match) plan.keyMap.set(key, match.key);
      }
      continue;
    }
    const key = taken.has(entry.key.toLowerCase()) ? generateCitationKey(entry.csl, taken) : entry.key;
    taken.add(key.toLowerCase());
    const aliases: string[] = [];
    for (const alias of entry.aliases) {
      if (taken.has(alias.toLowerCase())) continue;
      taken.add(alias.toLowerCase());
      aliases.push(alias);
    }
    const copy: ReferenceEntry = { ...structuredClone(entry), id: newId(), key, aliases, updatedAt: now };
    plan.ops.push({ op: "put", entry: copy });
    plan.copied.push({ key, entryId: copy.id });
    for (const citedKey of cited) if (citedKey !== key && !aliases.includes(citedKey)) plan.keyMap.set(citedKey, key);
  }
  return plan;
}

/** Library-relative paths of the Markdown files under a folder (for a folder moved across notebooks). */
export async function markdownFilesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  const { notebook, pathParts } = splitDirectoryPath(directory);
  const absolutePath = itemPath(notebook, pathParts);
  async function walk(absolute: string, relative: string) {
    let entries: Dirent[];
    try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(childAbsolute, childRelative);
      else if (entry.isFile() && getFileType(entry.name) === "markdown") files.push(childRelative);
    }
  }
  await walk(absolutePath, directory);
  return files.sort();
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "The cited references could not be copied.";
}

/** Fills `result` as it goes, so a late failure still reports what was done. */
async function copyReferences(sourceNotebook: string, destinationNotebook: string, files: MovedMarkdownFile[], result: ReferenceMoveResult, options: CopyReferencesOptions) {
  const texts = new Map<string, string>();
  const keys = new Set<string>();
  for (const { to } of files) {
    const text = await readFile(absoluteNotebookFile(to).absolutePath, "utf8");
    // Narrative `@key`s count when the source library knows them (planReferenceCopy skips the others).
    const cited = citedKeys(text, { allNarrative: true });
    if (!cited.length) continue;
    texts.set(to, text);
    for (const key of cited) keys.add(key);
  }
  if (!keys.size) return;

  // Read after the move: the attachment wiring has already remapped the moved files' paths.
  const source = await readReferenceLibrary(sourceNotebook);
  const sourceByKey = libraryEntriesByKey(source);
  if (![...keys].some((key) => entryForKey(sourceByKey, key))) return;

  let plan: ReferenceCopyPlan | null = null;
  for (let attempt = 1; !plan; attempt += 1) {
    const destination = await readReferenceLibrary(destinationNotebook);
    const candidate = planReferenceCopy(source, destination, keys);
    if (!candidate.ops.length) { plan = candidate; break; }
    try {
      result.destinationRevision = (await updateReferenceLibrary(destinationNotebook, destination.revision, candidate.ops)).revision;
      plan = candidate;
    } catch (error) {
      // Another writer changed the destination meanwhile: plan again against its new state.
      if (!(error instanceof ReferenceRevisionConflict) || attempt >= LIBRARY_ATTEMPTS) throw error;
    }
  }
  result.copied = plan.copied;
  result.reused = plan.reused;

  const renamed = new Map<string, { from: string; to: string; files: string[] }>();
  const rewrites: PlannedCitationRewrite[] = [];
  for (const [file, text] of texts) {
    const cited = new Set(citedKeys(text, { allNarrative: true }));
    const map = new Map([...plan.keyMap].filter(([from]) => cited.has(from)));
    if (!map.size) continue;
    const next = rewriteCitationKeys(text, map);
    if (!next.count) continue;
    rewrites.push({ path: file, map: Object.fromEntries(map), before: hashText(text), after: hashText(next.text) });
    result.drafts.push({ path: file, map: Object.fromEntries(map) });
    for (const [from, to] of map) {
      const entry = renamed.get(from) ?? { from, to, files: [] };
      entry.files.push(file);
      renamed.set(from, entry);
    }
  }
  result.renamed = [...renamed.values()];
  if (!rewrites.length) return;
  await options.onPlan?.(result, rewrites);
  await applyCitationRewrites(rewrites);
}

/**
 * Write planned citation rewrites. Safe to repeat: a note already at its
 * rewritten text is left alone (rewriting again could chain one key into
 * another), one still at the text planned from is rewritten, and any other
 * text is not touched. Every note is tried; failures are thrown at the end.
 */
export async function applyCitationRewrites(rewrites: PlannedCitationRewrite[]) {
  const rewritten: string[] = [];
  const failures: string[] = [];
  for (const rewrite of rewrites) {
    try {
      const target = absoluteNotebookFile(rewrite.path).absolutePath;
      const text = await readFile(target, "utf8");
      const hash = hashText(text);
      if (hash === rewrite.after) continue;
      if (hash !== rewrite.before) { failures.push(`${rewrite.path} changed while its citations were being rewritten.`); continue; }
      const next = rewriteCitationKeys(text, new Map(Object.entries(rewrite.map)));
      if (hashText(next.text) !== rewrite.after) { failures.push(`${rewrite.path} could not be rewritten as planned.`); continue; }
      await writeTextAtomically(target, next.text);
      rewritten.push(rewrite.path);
    } catch (error) {
      failures.push(`${rewrite.path}: ${errorMessage(error)}`);
    }
  }
  if (rewritten.length) {
    notifySearchChanges(rewritten);
    // The index is keyed by mtime and size and would heal on its next request; refreshing now keeps it current.
    for (const notebook of new Set(rewritten.map((file) => file.split("/")[0]))) {
      await refreshNotebookCitations(notebook).catch((error) => {
        console.error(`[references] Could not update the citation index of ${notebook}:`, error);
      });
    }
  }
  if (failures.length) throw new Error(failures.join(" "));
}

/**
 * Copy the references cited by Markdown files that moved from one notebook to
 * another (`files` are library-relative, `to` paths already on disk). Never
 * throws: a failure is logged and returned in `error`.
 */
export async function copyReferencesOnMove(sourceNotebook: string, destinationNotebook: string, files: MovedMarkdownFile[], options: CopyReferencesOptions = {}): Promise<ReferenceMoveResult> {
  if (sourceNotebook === destinationNotebook) return emptyReferenceMoveResult();
  const markdown = files.filter(({ to }) => getFileType(to.split("/").at(-1) ?? "") === "markdown");
  if (!markdown.length) return emptyReferenceMoveResult();
  const result = emptyReferenceMoveResult();
  try {
    await copyReferences(sourceNotebook, destinationNotebook, markdown, result, options);
    return result;
  } catch (error) {
    console.error(`[references] Could not copy the references cited by files moved from ${sourceNotebook} to ${destinationNotebook}:`, error);
    return { ...result, error: errorMessage(error) };
  }
}
