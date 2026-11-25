import { readdir, readFile } from "node:fs/promises";
import { listReviewEntryPaths } from "@/lib/agent/review-store";
import { isEmptyReview, type ReviewDocument } from "@/lib/markdown-review";
import { legacyPythonSidecarPath } from "@/lib/python/sidecar";
import { bibTetherStatePath, readTetherTarget } from "@/lib/references/bib-tether";
import { foldedFileName } from "@/lib/storage/file-names";
import { pathExists } from "@/lib/storage/fs-utils";
import { filePathFromParts, getStateRoot, referenceLibraryPath, relativeFilePath, splitFilePath } from "@/lib/storage/paths";
import { libraryNotebookNames } from "@/lib/storage/library-links";
import { readOrphans } from "@/lib/storage/pdf-sidecars";
import { inspectReferenceLibrary } from "@/lib/storage/references";
import { inspectLegacyReviewKeys, inspectReviewDocuments, inspectReviewKeys } from "@/lib/storage/review-files";
import { existingSidecars, legacyAnnotationSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { inspectWorkspaceMetadata } from "@/lib/storage/workspace-metadata";

// What records of a file that was there before a path still holds (stars,
// tags, review comments, pending agent changes, undo history, a reference
// attachment, a .bib tether, sidecars other than caches, side files set
// aside without an identity), for a batch of paths: everything shared is
// read once, then each path is answered from memory. Reads only.
// The one reader of these records for every destination check: a single move
// (leftoverRecords in storage/files.ts), a copy, an archive, a batch, a
// migration. A store that can't be read is never read as empty: a review index or the like is a blocker; a damaged reference library or tether file holds back the paths it still names.

// What a file's records are called to the user.
const RECORD_NAMES: Record<string, string> = {
  "pdf-annotations": "annotations", "image-annotations": "annotations", "pdf-outline": "outline", transcript: "transcript", "transcript-companion": "transcript",
  definitions: "definitions", ink: "ink", python: "Python code",
};

/** A store's bytes as a path is looked for in them: JSON escapes undone, each name folded. */
const normalizedText = (text: string) => foldedFileName(text.replace(/\\u([0-9a-f]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16))).replace(/\\\//g, "/"));

/** A library path as the check compares it: each segment folded (NFC and case), so another spelling of a name is the same path. */
const folded = (libraryPath: string) => libraryPath.split("/").map(foldedFileName).join("/");

/**
 * Paths a store names, asked by spelling: another spelling of the name counts, except for a case-only
 * rename (`exact`), where the file's own records are under the old spelling.
 */
class PathSet {
  private readonly exact = new Set<string>();
  private readonly alias = new Set<string>();
  add(libraryPath: string) { this.exact.add(libraryPath); this.alias.add(folded(libraryPath)); }
  has(libraryPath: string, exact: boolean) { return exact ? this.exact.has(libraryPath) : this.alias.has(folded(libraryPath)); }
}
const pathSet = (paths: Iterable<string>) => { const set = new PathSet(); for (const item of paths) set.add(item); return set; };

/** The side file kind of each kind of set-aside record (pdf-sidecars.ts readOrphans). */
const SET_ASIDE_SIDE_FILE_KINDS: Record<string, string> = { annotations: "pdf-annotations", outline: "pdf-outline", definitions: "definitions" };

export type DestinationOptions = {
  /** The path is the file's own under another spelling of its name (a case-only rename): the sidecars found there are its own. */
  ownSidecars?: boolean;
  /** The file being moved there from the same notebook: it is not a rival owner of older-layout records. */
  moving?: string[];
  /** Kinds the host owns in a shared notebook: never a leftover Check Notebook could clear (S-C1), so they don't block the path. */
  hostOwned?: (kind: string) => boolean;
};

/**
 * Why no name can be shown free of review comments, or null. A review index
 * that can't be read says nothing about any one path, so every name looks
 * occupied; asking for the next free name would never end. Name allocation
 * reports this first and stops (Archive File, Archive Folder, migration).
 */
export async function reviewIndexBlocker(): Promise<string | null> {
  const { damaged } = await inspectReviewKeys(getStateRoot());
  return damaged === undefined ? null : `The review comments index can't be read (${damaged}), so no free name can be found. Check the notebook, then try again.`;
}

export async function destinationRecords() {
  const caches = new Set(SIDECAR_KINDS.filter((kind) => kind.cache).map((kind) => kind.id));
  const root = getStateRoot();
  /** Stores that could not be read: they say nothing about any one path, so no path is shown free (never read as empty). */
  const unreadable: string[] = [];
  const reviewKeys = await inspectReviewKeys(root);
    const reviewed = pathSet(reviewKeys.keys);
  const legacyReviews = await inspectLegacyReviewKeys(root);
  if (legacyReviews.damaged !== undefined) unreadable.push(`The older review comments database (${legacyReviews.damaged})`);
  // A review still waiting in the older database is a review at its path.
  const waiting = pathSet(legacyReviews.keys);
  const pendingEntries = await listReviewEntryPaths();
  if (pendingEntries.unreadable) unreadable.push(`${pendingEntries.unreadable} pending agent ${pendingEntries.unreadable === 1 ? "change" : "changes"}`);
  const pending = pathSet(pendingEntries.paths);
  const { metadata, damaged: metadataDamaged } = await inspectWorkspaceMetadata();
  if (metadataDamaged !== undefined) unreadable.push(`The stars and tags (${metadataDamaged})`);
  const starred = pathSet(metadata.starredFilePaths);
  const tagged = pathSet(Object.keys(metadata.fileTags));
  // Every library may attach a file, and may be tethered to one; read without a lock and without quarantining a damaged one.
  const attached = new PathSet();
  const tethered = new PathSet();
  // A damaged library or tether file is not a blocker for every path (Check Notebook reports it for its own notebook and calls it
  // unverified elsewhere): it only holds back the paths its bytes still name, or all of them when even the bytes can't be read.
  const damagedStores: { label: string; mentions: (relative: string) => Promise<boolean> }[] = [];
  const damagedStore = (label: string, file: string, notebook: string) => {
    let text: Promise<string | null> | undefined;
    damagedStores.push({ label, mentions: async (relative) => {
      text ??= readFile(file, "utf8").then(normalizedText, () => null);
      const raw = await text;
      if (raw === null) return true;
      return raw.includes(normalizedText(relative)) || (relative.startsWith(`${notebook}/`) && raw.includes(normalizedText(relative.slice(notebook.length + 1))));
    } });
  };
  for (const library of await libraryNotebookNames()) {
    const inspected = await inspectReferenceLibrary(library).catch((error: unknown) => ({ damaged: error instanceof Error ? error.message : String(error) }));
    if ("damaged" in inspected) damagedStore(`The reference library of ${library} (${inspected.damaged})`, referenceLibraryPath(library), library);
    else for (const entry of Object.values(inspected.library?.entries ?? {})) for (const attachment of entry.attachments) if (attachment.kind !== "url") attached.add(attachment.path);
    const tether = await readTetherTarget(library).catch((error: unknown) => ({ damaged: error instanceof Error ? error.message : String(error) }));
    if (tether && "damaged" in tether) damagedStore(`The .bib tether of ${library} (${tether.damaged})`, bibTetherStatePath(library), library);
    else if (tether && "libraryPath" in tether) tethered.add(tether.libraryPath);
  }
  // The agent's undo history: restoring a run writes the file back at its path.
  const undo = new PathSet();
  const { listRunFiles } = await import("@/lib/agent/snapshots");
  const runs = await listRunFiles();
  if (runs.unreadable) unreadable.push(`${runs.unreadable} agent undo ${runs.unreadable === 1 ? "record" : "records"}`);
  for (const file of runs.files) if (!file.shared && !file.reverted) undo.add(file.path);
  // Side files set aside for a path, per notebook, read when first asked.
  // Kept by side file kind, so a kind the host owns can be left out (DestinationOptions.hostOwned).
  const setAside = new Map<string, Promise<Map<string, PathSet>>>();
  const setAsideFor = (notebook: string) => {
    let known = setAside.get(notebook);
    if (!known) {
      // Only a record with no identity is given to whatever file arrives at its path (one with an identity waits for its own bytes).
      known = readOrphans(notebook).then((orphans) => {
        const byKind = new Map<string, PathSet>();
        for (const { record } of orphans) {
          if (record.source) continue;
          const kind = SET_ASIDE_SIDE_FILE_KINDS[record.kind] ?? record.kind;
          if (!byKind.has(kind)) byKind.set(kind, new PathSet());
          byKind.get(kind)!.add(record.originalPath);
        }
        return byKind;
      });
      setAside.set(notebook, known);
    }
    return known;
  };

  return {
    /** Set when the review index, or another store of records, can't be read: `at` then can't tell, which is not "occupied". */
    blocker: reviewKeys.damaged !== undefined
      ? await reviewIndexBlocker()
      : unreadable.length ? `${unreadable[0]} can't be read, so it can't be told which names are free. Check the notebook, then try again.` : null,
    /** The names of the records still at `parts` of `notebook`; empty when the path is free of them. */
    async at(notebook: string, parts: string[], fileType: string | null, options: DestinationOptions = {}): Promise<string[]> {
      const relative = relativeFilePath(notebook, parts);
      const exact = options.ownSidecars === true;
      const kept = new Set<string>();
      if (!options.ownSidecars) {
        // Older annotation layouts too (legacyAnnotationSidecars): the arriving file would be given them.
        for (const sidecar of [...await existingSidecars(notebook, parts, fileType), ...await legacyAnnotationSidecars(notebook, parts, fileType, options.moving)]) {
          if (caches.has(sidecar.kind) || options.hostOwned?.(sidecar.kind)) continue;
          // An ink folder with nothing in it holds no strokes.
          if (sidecar.kind === "ink" && !(await readdir(sidecar.path).catch(() => ["?"])).length) continue;
          kept.add(RECORD_NAMES[sidecar.kind] ?? sidecar.kind);
        }
        // The original layout of a note's Python code: attached to the note of that name when it is opened.
        if (fileType === "markdown" && !kept.has("Python code")) {
          const legacy = legacyPythonSidecarPath(relative);
          // A note renamed within its folder keeps its own code at the same legacy path.
          const own = options.moving && folded(legacyPythonSidecarPath(relativeFilePath(notebook, options.moving))) === folded(legacy);
          if (!own) {
            const found = splitFilePath(legacy);
            if (await pathExists(filePathFromParts(found.notebook, found.pathParts))) kept.add("Python code");
          }
        }
        if ([...(await setAsideFor(notebook))].some(([kind, paths]) => !options.hostOwned?.(kind) && paths.has(relative, exact))) kept.add("set-aside side file");
      }
      // A review that can't be read can't be shown to be empty; an empty one is what opening a note makes.
      if (reviewKeys.damaged !== undefined || reviewed.has(relative, true)) {
        const documents = await inspectReviewDocuments<ReviewDocument>(root, relative);
        if (!documents || !documents.every(isEmptyReview)) kept.add("review comments");
      } else if (reviewed.has(relative, exact) || waiting.has(relative, exact)) kept.add("review comments");
      if (pending.has(relative, exact)) kept.add("pending agent changes");
      if (undo.has(relative, exact)) kept.add("undo history");
      if (starred.has(relative, exact)) kept.add("star");
      if (tagged.has(relative, exact)) kept.add("tags");
      if (attached.has(relative, exact)) kept.add("reference attachment");
      if (tethered.has(relative, exact)) kept.add(".bib tether");
      for (const store of damagedStores) if (await store.mentions(relative)) kept.add(`${store.label} may hold records here`);
      return [...kept];
    },
  };
}
