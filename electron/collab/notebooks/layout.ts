// From manifest entries to paths on disk.
//
// The manifest is keyed by fileId and may hold paths that cannot coexist on a
// case-insensitive file system ("Notes.md" and "notes.md"), or that would be
// unsafe to write. computeLayout gives every valid entry one disk path,
// deterministically: every machine sorts entries the same way (createdAt,
// then fileId), so everyone picks the same winner and the same visible suffix
// for the others ("notes (2).md"), and no two entries ever write one file.

import type * as Y from "yjs";

import { ManifestKeys, manifestPathKey, type DocKind, type ManifestEntry, type ManifestEntryKind } from "../../../src/lib/collab/protocol/schema";
import { isShareablePath } from "./fs-ops";

const ENTRY_KINDS: readonly ManifestEntryKind[] = ["doc", "blob", "folder"];
const DOC_KINDS: readonly DocKind[] = ["markdown", "latex", "text"];

/** Reads and validates the manifest's files map. Malformed records are skipped. */
export function readManifest(doc: Y.Doc): Map<string, ManifestEntry> {
  const files = doc.getMap<unknown>(ManifestKeys.files);
  const entries = new Map<string, ManifestEntry>();
  for (const [fileId, value] of files.entries()) {
    const entry = parseEntry(fileId, value);
    if (entry) entries.set(fileId, entry);
  }
  return entries;
}

function parseEntry(fileId: string, value: unknown): ManifestEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !ENTRY_KINDS.includes(record.kind as ManifestEntryKind)) return null;
  const kind = record.kind as ManifestEntryKind;
  if (kind === "doc" && (typeof record.docId !== "string" || !DOC_KINDS.includes(record.docKind as DocKind))) return null;
  if (kind === "blob" && (typeof record.blobHash !== "string" || !/^[0-9a-f]{64}$/.test(record.blobHash))) return null;
  return {
    fileId,
    path: record.path,
    kind,
    ...(kind === "doc" ? { docId: record.docId as string, docKind: record.docKind as DocKind } : {}),
    ...(kind === "blob" ? { blobHash: record.blobHash as string } : {}),
    ...(typeof record.size === "number" ? { size: record.size } : {}),
    ...(typeof record.mime === "string" ? { mime: record.mime } : {}),
    createdBy: typeof record.createdBy === "string" ? record.createdBy : "",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}

/** The plain JSON stored for an entry (the server requires plain JSON values). */
export function entryRecord(entry: ManifestEntry): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
}

export interface Layout {
  /** fileId → disk path relative to the notebook root. */
  paths: Map<string, string>;
  /** Directories (relative) the layout needs, folder entries and parents of files. */
  directories: Set<string>;
  /** Entries that cannot be placed (invalid or unsafe paths), with the reason. */
  refused: Array<{ fileId: string; path: string; reason: string }>;
}

function compareEntries(a: ManifestEntry, b: ManifestEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0;
}

function withSuffix(name: string, index: number): string {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  return `${stem} (${index})${extension}`;
}

export function computeLayout(entries: Iterable<ManifestEntry>): Layout {
  const sorted = [...entries].sort(compareEntries);
  const paths = new Map<string, string>();
  const refused: Layout["refused"] = [];
  // Directory spellings: the first entry (in sorted order) to mention a
  // directory names it; later spellings that differ only in case share it,
  // the way a case-insensitive file system would.
  const directoryNames = new Map<string, string>();
  const taken = new Map<string, string>();
  const directories = new Set<string>();

  const placeDirectory = (segments: string[]): string => {
    let disk = "";
    for (const segment of segments) {
      const candidate = disk ? `${disk}/${segment}` : segment;
      const key = manifestPathKey(candidate);
      let name = directoryNames.get(key);
      if (!name) {
        name = candidate;
        directoryNames.set(key, name);
      }
      disk = name;
      directories.add(disk);
    }
    return disk;
  };

  const valid: ManifestEntry[] = [];
  for (const entry of sorted) {
    if (!isShareablePath(entry.path)) {
      refused.push({ fileId: entry.fileId, path: entry.path, reason: "The path is not allowed in a shared notebook." });
      continue;
    }
    valid.push(entry);
  }
  // Directories first, so a file can never claim a name a folder needs.
  for (const entry of valid) {
    const segments = entry.path.split("/");
    placeDirectory(entry.kind === "folder" ? segments : segments.slice(0, -1));
  }
  for (const directory of directories) taken.set(manifestPathKey(directory), directory);
  for (const entry of valid) {
    const segments = entry.path.split("/");
    if (entry.kind === "folder") {
      paths.set(entry.fileId, placeDirectory(segments));
      continue;
    }
    const parent = placeDirectory(segments.slice(0, -1));
    const name = segments[segments.length - 1];
    let candidate = parent ? `${parent}/${name}` : name;
    for (let index = 2; taken.has(manifestPathKey(candidate)); index += 1) {
      const suffixed = withSuffix(name, index);
      candidate = parent ? `${parent}/${suffixed}` : suffixed;
    }
    taken.set(manifestPathKey(candidate), candidate);
    paths.set(entry.fileId, candidate);
  }
  return { paths, directories, refused };
}

/** Entries whose manifest path is `relative` or inside it (case-insensitive). */
export function entriesUnder(entries: Iterable<ManifestEntry>, relative: string): ManifestEntry[] {
  const key = manifestPathKey(relative);
  return [...entries].filter((entry) => {
    const entryKey = manifestPathKey(entry.path);
    return entryKey === key || entryKey.startsWith(`${key}/`);
  });
}
