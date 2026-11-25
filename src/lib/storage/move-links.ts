import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { transformReviewBaselines } from "@/lib/agent/review-store";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { latexCandidates, latexDependencies, latexOpenable, graphicsPaths, needsExpansion, type LatexCandidateKind } from "@/lib/latex/dependencies";
import { latexPathOccurrences, type LatexPathKind } from "@/lib/latex/path-occurrences";
import { getRelativePath, isLikelyWorkspaceMarkdownLink } from "@/lib/markdown-file-links";
import { rawFileSourcePath } from "@/lib/markdown-image-sources";
import {
  applyPathEdits,
  movedPathEdits,
  movedPathOccurrences,
  rewriteMovedPaths,
  writeChartValue,
  writeDestinationPath,
  writeLatexPath,
  type MovedPathKind,
  type MovedPathRewrite,
  type PathEdit,
  type PathOccurrence,
} from "@/lib/move-rewrites";
import { isLatexCitingPath } from "@/lib/references/latex-cite-syntax";
import { isSlideChartDataFile, resolveDeckRelativePath } from "@/lib/slide-charts";
import { StorageError } from "@/lib/storage/errors";
import { replaceFileIfUnchanged, withPathLocks } from "@/lib/storage/fs-utils";
import { fileExistence, libraryNotebookNames, linkCandidates, resolveLinkWith } from "@/lib/storage/library-links";
import { readMarkdownAssetDocuments } from "@/lib/storage/markdown-assets";
import { rewriteReviewSnapshots } from "@/lib/storage/markdown-reviews";
import { isPathMigrating } from "@/lib/storage/migration-fence";
import { forgetNotebookLinkReads } from "@/lib/storage/notebook-links";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import { refreshNotebookCitations } from "@/lib/storage/reference-citations";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { listVisibleNotebookFiles } from "@/lib/storage/tree";
import type { LiberaLinkRewrites, LiberaLinkSkipReason, LiberaMoveStep } from "@/lib/types";

// Paths in notes follow the files and folders a move took elsewhere
// (docs/features/move-link-refactor.md). Each path is resolved with the
// resolver that reads it, as the notebook check resolves it, once against
// the layout before the move and once against the layout after; only a path
// whose target would change is rewritten, and the new path must find the
// same file again. A path that found nothing before stays as written.
// Planning reads; writing goes through the save path's lock and its
// compare-before-replace, so a note saved meanwhile is read again, never overwritten.

/** One move: a file, or a folder and everything under it. Library paths. */
export type PathMove = { from: string; to: string; folder?: boolean };

/** Which library paths are files: the disk (fileExistence) or, for a shared notebook, the host's manifest. */
export type LinkExistence = Pick<ReturnType<typeof fileExistence>, "check" | "exists">;

/**
 * Where a plan reads from: the notebook's notes (full text), the files it
 * lists (as the layout after the move has them), and the text of one file.
 * The default is the disk; a shared move reads shared notebooks from the host
 * (shared-move-links.ts) because the working copy on disk can lag it.
 */
export type LinkSource = {
  existence: LinkExistence;
  /** `hint` lets a source that must ask the host for each note's text read only the notes that can name a moved item. */
  documents: (notebook: string, hint: DocumentHint) => Promise<{ documents: { documentPath: string; content: string }[]; complete: boolean }>;
  files: (notebook: string) => Promise<{ files: string[]; truncated: boolean }>;
  read: (libraryPath: string) => Promise<string>;
};

/** The moved and arriving names, and where a library path was before the move (itself when it did not move). */
export type DocumentHint = { names: readonly string[]; was: (libraryPath: string) => string };

export const diskLinkSource = (): LinkSource => ({
  existence: fileExistence(),
  documents: (notebook) => readMarkdownAssetDocuments(notebook),
  files: (notebook) => listVisibleNotebookFiles(notebook, { includeArchive: true }),
  read: (libraryPath) => readFile(absolute(libraryPath), "utf8"),
});

/** A rewrite planned for one file (by its path after the move), with the hashes of its text before and after. */
export type PlannedLinkRewrite = { path: string; from?: string; rewrite: MovedPathRewrite; before: string; after: string };

/**
 * A rewrite written, with the hashes of the text it replaced and wrote; the
 * text and the edits too when this run wrote it (for review comments). A file
 * an interrupted migration had already rewritten has its planned hashes only.
 */
export type AppliedLinkRewrite = { path: string; from?: string; rewrite: MovedPathRewrite; before: string; after: string; textBefore?: string; edits?: PathEdit[] };

type Skip = LiberaLinkRewrites["skipped"][number];

export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");
const parentOf = (libraryPath: string) => libraryPath.split("/").slice(0, -1).join("/");
const notebookOf = (libraryPath: string) => libraryPath.split("/")[0];
const within = (candidate: string, folder: string) => candidate === folder || candidate.startsWith(`${folder}/`);
const hasEntries = (rewrite: MovedPathRewrite) => Object.values(rewrite).some((map) => map && Object.keys(map).length);
const absolute = (libraryPath: string) => { const { notebook, pathParts } = splitFilePath(libraryPath); return filePathFromParts(notebook, pathParts); };

/**
 * The two layouts. `forward` is where a path is after the moves (itself when
 * it did not move); `backward` where a path now was before (null for one
 * that did not arrive). `before` and `after` say whether a library path is a
 * file in each layout, from one listing of the disk as it is now (after the
 * move): a moved path was there if its destination is now, an arriving one
 * was not, and the rest are as they are. Exact names, as the check matches them.
 */
export function moveLayout(moves: readonly PathMove[], existence: LinkExistence = fileExistence()) {
  const files = new Map(moves.filter((move) => !move.folder).map((move) => [move.from, move.to]));
  const arrivals = new Map(moves.filter((move) => !move.folder).map((move) => [move.to, move.from]));
  const folders = moves.filter((move) => move.folder).sort((a, b) => b.from.length - a.from.length);
  const folderArrivals = moves.filter((move) => move.folder).sort((a, b) => b.to.length - a.to.length);
  const moved = (candidate: string) => {
    const file = files.get(candidate);
    if (file !== undefined) return file;
    const folder = folders.find((move) => within(candidate, move.from));
    return folder ? `${folder.to}${candidate.slice(folder.from.length)}` : null;
  };
  const backward = (candidate: string) => {
    const file = arrivals.get(candidate);
    if (file !== undefined) return file;
    const folder = folderArrivals.find((move) => within(candidate, move.to));
    return folder ? `${folder.from}${candidate.slice(folder.to.length)}` : null;
  };
  const disk = existence;
  return {
    forward: (candidate: string) => moved(candidate) ?? candidate,
    backward,
    /** Looks each path up (and where it is after the move), once; the questions below are then answered from memory. */
    check: async (candidates: Iterable<string>) => {
      const all: string[] = [];
      for (const candidate of candidates) { all.push(candidate); const next = moved(candidate); if (next !== null) all.push(next); }
      await disk.check(all);
    },
    before: (candidate: string) => {
      const next = moved(candidate);
      if (next !== null) return disk.exists(next);
      return backward(candidate) === null && disk.exists(candidate);
    },
    after: (candidate: string) => disk.exists(candidate),
    names: [...new Set(moves.flatMap((move) => [move.from, move.to].map((value) => value.split("/").at(-1)!)))],
    fileMoves: [...files].map(([from, to]) => ({ from, to })),
  };
}

type Layout = ReturnType<typeof moveLayout>;
type Outcome = { next: string } | { skip: LiberaLinkSkipReason } | null;

/** A Markdown link, an `<a href>`, or a library address (`/api/files/raw/...`) in a link or an image. */
async function planDestination(occurrence: PathOccurrence, notePath: string, was: string, layout: Layout): Promise<Outcome> {
  const { value, written } = occurrence;
  const html = occurrence.kind === "html-link" || occurrence.kind === "html-image";
  let raw: string | null;
  try { raw = rawFileSourcePath(value); } catch { return null; }
  if (raw !== null) {
    await layout.check([raw]);
    if (!layout.before(raw)) return null;
    const target = layout.forward(raw);
    if (target === raw) return null;
    const built = writeDestinationPath(written, value, `/api/files/raw/${target}`, html);
    if (!built) return { skip: "unwritable" };
    let reads: string | null;
    try { reads = rawFileSourcePath(built.value); } catch { reads = null; }
    await layout.check([target]);
    return reads === target && layout.after(target) ? { next: built.written } : { skip: "shadowed" };
  }
  // Images are read from the notebook's `_assets` (or by the address above): a move inside a notebook leaves them as they are.
  if (occurrence.kind === "image" || occurrence.kind === "html-image" || !isLikelyWorkspaceMarkdownLink(value)) return null;
  const asked = linkCandidates(value, was);
  await layout.check(asked);
  const found = resolveLinkWith(value, was, layout.before);
  // It found no file: it stays exactly as written.
  if (!found) return null;
  const target = layout.forward(found);
  await layout.check(linkCandidates(value, notePath));
  if (resolveLinkWith(value, notePath, layout.after) === target) return null;
  const opens = async (nextPath: string) => {
    const built = writeDestinationPath(written, value, nextPath, html);
    if (!built) return null;
    await layout.check(linkCandidates(built.value, notePath));
    return resolveLinkWith(built.value, notePath, layout.after) === target ? built.written : null;
  };
  // The style it had: relative to its note (the first place the resolver looks), or from the library root.
  const relative = getRelativePath(parentOf(notePath), target);
  const next = found === asked[0] ? await opens(relative) : (await opens(target)) ?? await opens(relative);
  return next !== null ? { next } : { skip: writeDestinationPath(written, value, relative, html) ? "shadowed" : "unwritable" };
}

/** A chart's data file, read from the note's folder and never past its notebook. */
async function planChart(occurrence: PathOccurrence, notePath: string, was: string, layout: Layout): Promise<Outcome> {
  const data = occurrence.value;
  const found = resolveDeckRelativePath(was, data);
  const now = resolveDeckRelativePath(notePath, data);
  await layout.check([found, now]);
  if (!layout.before(found)) return null;
  const target = layout.forward(found);
  if (now === target && layout.after(target)) return null;
  if (notebookOf(target) !== notebookOf(notePath)) return { skip: "chart-notebook" };
  const relative = getRelativePath(parentOf(notePath), target);
  const next = data.startsWith("./") && !relative.startsWith("../") ? `./${relative}` : relative;
  if (resolveDeckRelativePath(notePath, next) !== target || !isSlideChartDataFile(next)) return { skip: "unwritable" };
  return { next: writeChartValue(occurrence.written, next) };
}

/**
 * A note's rewrite: each path (by kind and spelling) to the text written
 * instead, and the paths left as they are although they no longer open their
 * file, with why. `was` is where the note was before the move.
 */
async function planMarkdown(text: string, notePath: string, was: string, layout: Layout) {
  const rewrite: MovedPathRewrite = {};
  const skipped: { written: string; reason: LiberaLinkSkipReason }[] = [];
  const decided = new Map<string, Outcome>();
  const spans = new Map<number, { written: string; nexts: string[] }>();
  for (const occurrence of movedPathOccurrences(text, notePath)) {
    const key = `${occurrence.kind}\0${occurrence.written}`;
    if (!decided.has(key)) decided.set(key, occurrence.kind === "chart" ? await planChart(occurrence, notePath, was, layout) : await planDestination(occurrence, notePath, was, layout));
    const outcome = decided.get(key)!;
    const span = spans.get(occurrence.start) ?? { written: occurrence.written, nexts: [] };
    span.nexts.push(outcome && "next" in outcome ? outcome.next : occurrence.written);
    spans.set(occurrence.start, span);
  }
  for (const [key, outcome] of decided) {
    const [kind, written] = key.split("\0") as [MovedPathKind, string];
    if (!outcome) continue;
    if ("skip" in outcome) skipped.push({ written, reason: outcome.skip });
    else if (outcome.next !== written) (rewrite[kind] ??= {})[written] = outcome.next;
  }
  // A definition read by a link and an image is changed only when both read the new path as their own (move-rewrites.ts movedPathEdits).
  for (const span of spans.values()) {
    if (new Set(span.nexts).size > 1) skipped.push({ written: span.written, reason: "shared-definition" });
  }
  return { rewrite, skipped };
}

const LATEX_KINDS: Record<LatexPathKind, LatexCandidateKind> = {
  "latex-include": "include", "latex-graphics": "graphics", "latex-pdf": "pdf",
  "latex-listing": "listing", "latex-bibliography": "bibliography", "latex-bibresource": "bibresource",
};

/** `written` again, at `next` (a library path) from `base`'s folder; without the extension when the source left it to TeX. */
function latexSpellings(written: string, base: string, next: string, kind: LatexCandidateKind) {
  const extension = path.extname(next);
  const omitted = extension && path.extname(written).toLowerCase() !== extension.toLowerCase();
  const from = (folder: string) => {
    const relative = getRelativePath(folder, next);
    return omitted ? [relative.slice(0, -extension.length), relative] : [relative];
  };
  // A bibliography is also found from the notebook folder (BIBINPUTS, latex/build.ts), where `../` is not needed.
  const searched = (kind === "bibliography" || kind === "bibresource") && notebookOf(next) === notebookOf(base) ? from(notebookOf(next)) : [];
  return [...new Set([...from(parentOf(base)), ...searched])];
}

/**
 * The LaTeX sources of a notebook, as TeX reads them from each main file's
 * folder (latex/dependencies.ts), before the move and after it. A source
 * built from several main files gets one path that finds each build's file.
 */
async function planLatex(notebook: string, layout: Layout, source: LinkSource) {
  const planned = new Map<string, { from?: string; text: string; rewrite: MovedPathRewrite }>();
  const skipped: Skip[] = [];
  const listing = await source.files(notebook);
  const beforeFiles = new Set<string>();
  for (const file of listing.files) { const was = layout.backward(file) ?? file; if (notebookOf(was) === notebook) beforeFiles.add(was); }
  for (const move of layout.fileMoves) if (notebookOf(move.from) === notebook && notebookOf(move.to) !== notebook) beforeFiles.add(move.from);
  if (![...beforeFiles].some((file) => isLatexCitingPath(file))) return { planned, skipped, incomplete: listing.truncated };
  const texts = new Map<string, string>();
  const read = async (file: string) => {
    const now = layout.forward(file);
    if (!texts.has(now)) texts.set(now, await source.read(now));
    return texts.get(now)!;
  };
  const dependencies = await latexDependencies(notebook, [...beforeFiles], read);
  const prefixes = (main: string) => dependencies.roots.includes(main) && texts.has(layout.forward(main)) ? graphicsPaths(texts.get(layout.forward(main))!) : [];
  const firstFile = async (candidates: string[], exists: (candidate: string) => boolean) => {
    await layout.check(candidates);
    return candidates.find(exists) ?? null;
  };
  for (const [sourceFile, mains] of dependencies.mainFiles) {
    const now = layout.forward(sourceFile);
    const text = texts.get(now);
    if (text === undefined) continue;
    const rewrite: MovedPathRewrite = {};
    const decided = new Set<string>();
    const occurrences = latexPathOccurrences(text);
    // A name written to `\include` anywhere in the file also has to survive the mirror's skipped folders.
    const includes = new Set(occurrences.filter((occurrence) => occurrence.command === "include").map((occurrence) => occurrence.written));
    for (const occurrence of occurrences) {
      const key = `${occurrence.kind}\0${occurrence.written}`;
      if (decided.has(key) || needsExpansion(occurrence.written)) continue;
      decided.add(key);
      const kind = LATEX_KINDS[occurrence.kind];
      // Each build reads the name from its main file's folder: where it found a file, the same file must be found from the main file's new place.
      const builds: { main: string; target: string }[] = [];
      let keeps = true;
      for (const main of mains) {
        const found = await firstFile(latexCandidates(notebook, main, kind, occurrence.written, prefixes(main)), layout.before);
        if (!found) continue;
        const target = layout.forward(found);
        const mainNow = layout.forward(main);
        builds.push({ main: mainNow, target });
        if (await firstFile(latexCandidates(notebookOf(mainNow), mainNow, kind, occurrence.written, prefixes(main)), layout.after) !== target) keeps = false;
      }
      if (keeps) continue;
      let next: string | null = null;
      // Only a spelling the build can open: `../x` and `_folder/x` for \include are refused by the compiler (latexOpenable).
      const viaInclude = includes.has(occurrence.written);
      for (const spelling of latexSpellings(occurrence.written, builds[0].main, builds[0].target, kind)) {
        if (!writeLatexPath(spelling, occurrence.kind) || !latexOpenable(spelling, { include: viaInclude })) continue;
        let all = true;
        for (const build of builds) {
          const main = layout.backward(build.main) ?? build.main;
          if (await firstFile(latexCandidates(notebookOf(build.main), build.main, kind, spelling, prefixes(main)), layout.after) !== build.target) { all = false; break; }
        }
        if (all) { next = spelling; break; }
      }
      if (next === null) skipped.push({ path: now, written: occurrence.written, reason: builds.length > 1 ? "latex-builds" : "unwritable" });
      else (rewrite[occurrence.kind] ??= {})[occurrence.written] = next;
    }
    if (hasEntries(rewrite)) planned.set(now, { ...(now !== sourceFile ? { from: sourceFile } : {}), text, rewrite });
  }
  return { planned, skipped, incomplete: dependencies.incomplete || listing.truncated };
}

/**
 * Why a file the move would rewrite must be left alone: a shared notebook's
 * (its text changes only through the host; `throughHost` is a plan whose
 * caller writes those notes that way), or one a migration is moving.
 */
async function blockedFrom(filePath: string, ownMigration: boolean, throughHost: boolean): Promise<LiberaLinkSkipReason | null> {
  if (!throughHost && isSharedNotebookPath(filePath)) return "shared-notebook";
  if (!ownMigration && await isPathMigrating(filePath)) return "migrating";
  return null;
}

/**
 * What the moves change in every note of every local notebook (links between
 * notebooks are library paths) and in the LaTeX sources of the notebooks
 * involved. The link index can lag, so it is not used to narrow the search:
 * every note is read (the same bounded walk as the check's), and parsed when
 * its text names a moved or arriving item, or has a `%`, `&` or `\` that
 * could spell one. `ownMigration`: called by a migration, whose own files
 * the fence would otherwise hold off. `leave`: files not to rewrite (a
 * migration's item that is at both places, for the person to sort out).
 */
export async function planMovedLinks(moves: readonly PathMove[], { ownMigration = false, leave = new Set<string>(), source }: { ownMigration?: boolean; leave?: ReadonlySet<string>; source?: LinkSource } = {}) {
  const reads = source ?? diskLinkSource();
  const layout = moveLayout(moves, reads.existence);
  const notes: PlannedLinkRewrite[] = [];
  const skipped: Skip[] = [];
  const unchecked: string[] = [];
  const add = async (filePath: string, from: string | undefined, text: string, rewrite: MovedPathRewrite) => {
    if (!hasEntries(rewrite) || leave.has(filePath)) return;
    const blocked = await blockedFrom(filePath, ownMigration, source !== undefined);
    if (blocked) {
      for (const map of Object.values(rewrite)) for (const written of Object.keys(map ?? {})) skipped.push({ path: filePath, written, reason: blocked });
      return;
    }
    notes.push({ path: filePath, ...(from ? { from } : {}), rewrite, before: hashText(text), after: hashText(rewriteMovedPaths(text, filePath, rewrite)) });
  };
  for (const notebook of await libraryNotebookNames()) {
    const { documents, complete } = await reads.documents(notebook, { names: layout.names, was: (file) => layout.backward(file) ?? file }).catch(() => ({ documents: [], complete: false }));
    if (!complete) unchecked.push(notebook);
    for (const { documentPath, content } of documents) {
      const was = layout.backward(documentPath) ?? documentPath;
      if (was === documentPath && !layout.names.some((name) => content.includes(name)) && !/[%&\\]/.test(content)) continue;
      const plan = await planMarkdown(content, documentPath, was, layout);
      skipped.push(...plan.skipped.map((skip) => ({ path: documentPath, ...skip })));
      await add(documentPath, was === documentPath ? undefined : was, content, plan.rewrite);
    }
  }
  for (const notebook of new Set(moves.flatMap((move) => [notebookOf(move.from), notebookOf(move.to)]))) {
    try {
      const latex = await planLatex(notebook, layout, reads);
      if (latex.incomplete && !unchecked.includes(notebook)) unchecked.push(notebook);
      skipped.push(...latex.skipped);
      for (const [filePath, { from, text, rewrite }] of latex.planned) await add(filePath, from, text, rewrite);
    } catch (error) {
      console.error(`[move-links] Could not read the LaTeX sources of ${notebook}:`, error);
      if (!unchecked.includes(notebook)) unchecked.push(notebook);
    }
  }
  const seen = new Set<string>();
  return {
    layout,
    notes,
    skipped: skipped.filter((skip) => { const key = `${skip.path}\0${skip.written}\0${skip.reason}`; if (seen.has(key)) return false; seen.add(key); return true; }),
    unchecked,
  };
}

/** The replan of a note whose text changed since it was planned: Markdown is planned afresh, LaTeX keeps its rewrite. */
export const replanMovedNote = (layout: Layout) => async (text: string, note: PlannedLinkRewrite): Promise<MovedPathRewrite> => {
  if (isLatexCitingPath(note.path)) return note.rewrite;
  return (await planMarkdown(text, note.path, note.from ?? note.path, layout)).rewrite;
};

const GONE = "The note is no longer there.";
const CHANGED = "The note changed while its links were being updated.";

/**
 * Writes planned rewrites, each under its file's lock as a save takes it, and
 * only over the text just read (replaceFileIfUnchanged): a file saved
 * meanwhile is read again and the rewrite applied to what it holds now.
 * `replan` plans that newer text afresh (a move in the app); without it, the
 * planned rewrite is applied to it (a migration finishing what its journal
 * says). A file already at its rewritten text is left alone, so applying
 * again (a resumed migration) never chains one path into another.
 */
export async function applyMovedLinks(planned: readonly PlannedLinkRewrite[], replan?: (text: string, note: PlannedLinkRewrite) => Promise<MovedPathRewrite>) {
  const applied: AppliedLinkRewrite[] = [];
  const failed: Skip[] = [];
  for (const note of planned) {
    const target = absolute(note.path);
    const from = note.from ? { from: note.from } : {};
    try {
      await withPathLocks([target], async () => {
        for (let attempt = 0; ; attempt += 1) {
          const bytes = await readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") throw new StorageError(GONE, 409); throw error; });
          const text = bytes.toString("utf8");
          // Bytes that are not UTF-8 would not survive being written back as text.
          if (!Buffer.from(text, "utf8").equals(bytes)) throw new StorageError("The note is not UTF-8 text.", 422);
          const hash = hashText(text);
          if (hash === note.after) { applied.push({ path: note.path, ...from, rewrite: note.rewrite, before: note.before, after: note.after }); return; }
          const rewrite = hash === note.before || !replan ? note.rewrite : await replan(text, note);
          const edits = movedPathEdits(text, note.path, rewrite);
          if (!edits.length) return;
          const next = applyPathEdits(text, edits);
          try { await replaceFileIfUnchanged(target, Buffer.from(next, "utf8"), bytes, { gone: GONE, changed: CHANGED }); }
          catch (error) { if (error instanceof StorageError && error.message === CHANGED && attempt < 2) continue; throw error; }
          applied.push({ path: note.path, ...from, rewrite, before: hash, after: hashText(next), textBefore: text, edits });
          return;
        }
      });
    } catch (error) {
      console.error(`[move-links] Could not update the links of ${note.path}:`, error);
      for (const map of Object.values(note.rewrite)) for (const written of Object.keys(map ?? {})) failed.push({ path: note.path, written, reason: "unreadable" });
    }
  }
  return { applied, failed };
}

/**
 * What keeps a rewritten file's text, besides the file: pending agent reviews
 * (their baseline), review comments (snapshot and anchors), the agent's undo
 * history (`history`: its original and draft, and the hash it wrote, carried
 * over), the link and citation indexes and Global Search. Each is tried;
 * returns what failed.
 */
export async function followLinkRewrites(applied: readonly AppliedLinkRewrite[], { history = () => true }: { history?: (filePath: string) => boolean } = {}) {
  const failures: string[] = [];
  if (!applied.length) return failures;
  const attempt = async (what: string, run: () => Promise<unknown>) => {
    try { await run(); } catch (error) { failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const transform = (note: AppliedLinkRewrite) => (text: string) => rewriteMovedPaths(text, note.path, note.rewrite);
  await attempt("pending agent reviews", () => transformReviewBaselines(new Map(applied.map((note) => [note.path, transform(note)]))));
  await attempt("review comments", () => rewriteReviewSnapshots(applied.flatMap((note) => note.textBefore !== undefined && note.edits ? [{ path: note.path, before: note.textBefore, edits: note.edits }] : [])));
  const kept = applied.filter((note) => history(note.path));
  if (kept.length) {
    await attempt("undo history", async () => {
      // Imported here: snapshots reaches back into storage through shared-writes.
      const { recordMovedRunFiles } = await import("@/lib/agent/snapshots");
      await recordMovedRunFiles(new Map(kept.map((note) => [note.path, { to: note.path, transform: transform(note), hashes: { before: note.before, after: note.after } }])));
    });
  }
  // Derived indexes: Search and the link index read the notes again; the citation index is brought up to date now.
  // A refresh that fails only lags (the next tree load heals it, Check Notebook says so as info): logged, not a failure of the move.
  notifySearchChanges(applied.map((note) => note.path));
  for (const note of applied) forgetNotebookLinkReads(notebookOf(note.path), note.path);
  for (const notebook of new Set(applied.map((note) => notebookOf(note.path)))) {
    await refreshNotebookCitations(notebook).catch((error) => console.error(`[move-links] Could not update the citation index of ${notebook}:`, error));
  }
  return failures;
}

/**
 * After a move in the app committed: plan, write and follow. Never throws:
 * the move stands, and a failure is the `links` step of `unfinished`. Check
 * Notebook then lists what is broken.
 */
export async function followMovedLinks(moves: readonly PathMove[]): Promise<{ links: LiberaLinkRewrites; unfinished?: LiberaMoveStep }> {
  try {
    const plan = await planMovedLinks(moves);
    const { applied, failed } = await applyMovedLinks(plan.notes, replanMovedNote(plan.layout));
    const failures = await followLinkRewrites(applied);
    const links: LiberaLinkRewrites = { rewritten: applied.map((note) => ({ path: note.path, rewrite: note.rewrite })), skipped: [...plan.skipped, ...failed], unchecked: plan.unchecked };
    const problems = [...(failed.length ? [`${new Set(failed.map((skip) => skip.path)).size} notes could not be updated`] : []), ...failures];
    return { links, ...(problems.length ? { unfinished: { step: "links", status: "failed", message: problems.join("; ") } } : {}) };
  } catch (error) {
    console.error("[move-links] Links did not follow the move:", error);
    return { links: { rewritten: [], skipped: [], unchecked: [] }, unfinished: { step: "links", status: "failed", message: error instanceof Error ? error.message : String(error) } };
  }
}
