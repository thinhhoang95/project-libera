import { readdir } from "node:fs/promises";
import { listReviewEntryPaths } from "@/lib/agent/review-store";
import { isEmptyReview, type ReviewDocument } from "@/lib/markdown-review";
import { getStateRoot, relativeFilePath } from "@/lib/storage/paths";
import { libraryNotebookNames } from "@/lib/storage/library-links";
import { inspectReferenceLibrary } from "@/lib/storage/references";
import { inspectReviewDocuments, inspectReviewKeys } from "@/lib/storage/review-files";
import { existingSidecars, legacyAnnotationSidecars, SIDECAR_KINDS } from "@/lib/storage/sidecars";
import { readWorkspaceMetadata } from "@/lib/storage/workspace-metadata";

// What records of a file that was there before a path still holds (stars,
// tags, review comments, pending agent changes, a reference attachment,
// sidecars other than caches), for a batch of paths: everything shared is
// read once, then each path is answered from memory. Reads only.
// The per-path rules are those of leftoverRecords in storage/files.ts.

// What a file's records are called to the user.
const RECORD_NAMES: Record<string, string> = {
  "pdf-annotations": "annotations", "image-annotations": "annotations", "pdf-outline": "outline", transcript: "transcript", "transcript-companion": "transcript",
  definitions: "definitions", ink: "ink", python: "Python code",
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
  const reviewKeys = await inspectReviewKeys(root);
  const reviewed = new Set(reviewKeys.keys);
  const pending = new Set((await listReviewEntryPaths()).paths);
  const metadata = await readWorkspaceMetadata();
  // Every library may attach a file; read without a lock and without quarantining a damaged one.
  const attached = new Set<string>();
  for (const library of await libraryNotebookNames()) {
    const inspected = await inspectReferenceLibrary(library).catch(() => null);
    if (!inspected || "damaged" in inspected) continue;
    for (const entry of Object.values(inspected.library?.entries ?? {})) {
      for (const attachment of entry.attachments) if (attachment.kind !== "url") attached.add(attachment.path);
    }
  }

  return {
    /** Set when the review index is unreadable: `at` then answers "review comments" for every path, which is "can't tell", not "occupied". */
    blocker: reviewKeys.damaged === undefined ? null : await reviewIndexBlocker(),
    /** The names of the records still at `parts` of `notebook`; empty when the path is free of them. */
    async at(notebook: string, parts: string[], fileType: string | null): Promise<string[]> {
      const relative = relativeFilePath(notebook, parts);
      const kept = new Set<string>();
      // Older annotation layouts too (legacyAnnotationSidecars): the arriving file would be given them.
      for (const sidecar of [...await existingSidecars(notebook, parts, fileType), ...await legacyAnnotationSidecars(notebook, parts, fileType)]) {
        if (caches.has(sidecar.kind)) continue;
        // An ink folder with nothing in it holds no strokes.
        if (sidecar.kind === "ink" && !(await readdir(sidecar.path).catch(() => ["?"])).length) continue;
        kept.add(RECORD_NAMES[sidecar.kind] ?? sidecar.kind);
      }
      // A review that can't be read can't be shown to be empty; an empty one is what opening a note makes.
      if (reviewKeys.damaged !== undefined || reviewed.has(relative)) {
        const reviews = await inspectReviewDocuments<ReviewDocument>(root, relative);
        if (!reviews || !reviews.every(isEmptyReview)) kept.add("review comments");
      }
      if (pending.has(relative)) kept.add("pending agent changes");
      if (metadata.starredFilePaths.includes(relative)) kept.add("star");
      if (metadata.fileTags[relative]) kept.add("tags");
      if (attached.has(relative)) kept.add("reference attachment");
      return [...kept];
    },
  };
}
