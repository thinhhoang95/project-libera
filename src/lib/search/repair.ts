import type { SearchGalleryPhoto } from "@/lib/global-search";
import type { IndexedFile } from "@/lib/search/database";
import type { LiberaFileNode } from "@/lib/types";

/**
 * Repairing an index that was built elsewhere, typically on another computer.
 *
 * Paths in the index are relative to the library, but they can still drift: a
 * linked folder or notebook may carry another name there, a file system may
 * store names in another Unicode form or letter case, and a gallery whose own
 * index was not copied gives its photos new ids. Such entries no longer match
 * any file, so a scan would split and store those files again under new keys.
 * The repair finds the file each entry stands for and moves the entry there,
 * keeping its passages and vectors. Entries that match no file are stale.
 */

export type IndexRelocation = {
  id: number;
  key: string;
  path: string;
  name: string;
  notebook: string;
  meta: string | null;
};

export type IndexRepairPlan = {
  relocations: IndexRelocation[];
  /** Entries that match no current file; the scan removes them once it has finished. */
  stale: number[];
};

/** A path compared without regard to separators, Unicode form or letter case. */
export function comparablePath(value: string) {
  return value.normalize("NFC").replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").toLowerCase();
}

/** The path inside its notebook or linked folder. */
function pathInNotebook(value: string) {
  const comparable = comparablePath(value);
  const slash = comparable.indexOf("/");
  return slash < 0 ? comparable : comparable.slice(slash + 1);
}

function signatureSize(signature: string) {
  return Number(signature.split(":")[0]);
}

export function galleryMeta(photo: SearchGalleryPhoto): SearchGalleryPhoto {
  return {
    id: photo.id,
    path: photo.path,
    name: photo.name,
    updatedAt: photo.updatedAt,
    size: photo.size,
    prompt: photo.prompt,
  };
}

function group<T>(items: T[], keyOf: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

/** The single unclaimed candidate, preferring one of the same size when there are several. */
function pick<T>(candidates: T[] | undefined, claimed: Set<T>, size: number, sizeOf: (item: T) => number) {
  const open = (candidates ?? []).filter((candidate) => !claimed.has(candidate));
  if (open.length === 1) return open[0];
  const sameSize = open.filter((candidate) => sizeOf(candidate) === size);
  return sameSize.length === 1 ? sameSize[0] : undefined;
}

/**
 * Match the index's entries to the files found now. `files` and `photos` are
 * what the scan will index, so an entry for something it skips is stale too.
 */
export function planIndexRepair(
  indexed: IndexedFile[],
  files: LiberaFileNode[],
  photos: SearchGalleryPhoto[],
): IndexRepairPlan {
  const current = new Set([...files.map((file) => file.path), ...photos.map((photo) => `gallery:${photo.id}`)]);
  const indexedKeys = new Set(indexed.map((entry) => entry.key));
  const orphans = indexed.filter((entry) => !current.has(entry.key));
  const relocations: IndexRelocation[] = [];
  const stale: number[] = [];
  if (!orphans.length) return { relocations, stale };

  // Only files without an entry of their own can take one over.
  const newFiles = files.filter((file) => !indexedKeys.has(file.path));
  const newPhotos = photos.filter((photo) => !indexedKeys.has(`gallery:${photo.id}`));
  const filesByPath = group(newFiles, (file) => comparablePath(file.path));
  const filesByInnerPath = group(newFiles, (file) => `${file.fileType}\u0000${pathInNotebook(file.path)}`);
  const photosByPath = group(newPhotos, (photo) => comparablePath(photo.path));
  const claimedFiles = new Set<LiberaFileNode>();
  const claimedPhotos = new Set<SearchGalleryPhoto>();
  const fileSize = (file: LiberaFileNode) => file.size;

  // Exact matches up to form and case first, so a renamed notebook cannot take them.
  const unmatched: IndexedFile[] = [];
  for (const entry of orphans) {
    const size = signatureSize(entry.signature);
    if (entry.source === "gallery") {
      const photo = pick(photosByPath.get(comparablePath(entry.path)), claimedPhotos, size, (item) => item.size);
      if (!photo) {
        stale.push(entry.id);
        continue;
      }
      claimedPhotos.add(photo);
      relocations.push({
        id: entry.id,
        key: `gallery:${photo.id}`,
        path: photo.path,
        name: photo.name,
        notebook: "",
        meta: JSON.stringify(galleryMeta(photo)),
      });
      continue;
    }

    const file = pick(filesByPath.get(comparablePath(entry.path)), claimedFiles, size, fileSize);
    if (file?.fileType === entry.kind) {
      claimedFiles.add(file);
      relocations.push({ id: entry.id, key: file.path, path: file.path, name: file.name, notebook: file.notebook, meta: entry.meta });
    } else {
      unmatched.push(entry);
    }
  }

  // Then the same path inside a notebook or linked folder that has another name.
  for (const entry of unmatched) {
    const file = pick(
      filesByInnerPath.get(`${entry.kind}\u0000${pathInNotebook(entry.path)}`),
      claimedFiles,
      signatureSize(entry.signature),
      fileSize,
    );
    if (!file) {
      stale.push(entry.id);
      continue;
    }
    claimedFiles.add(file);
    relocations.push({ id: entry.id, key: file.path, path: file.path, name: file.name, notebook: file.notebook, meta: entry.meta });
  }

  return { relocations, stale };
}
