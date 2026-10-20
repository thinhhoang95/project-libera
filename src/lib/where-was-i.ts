// "Where was I": a small record of each notebook's last working session, kept
// so the notebook home can say what you were doing (docs/features/where-was-i.md).
//
// Pure and DOM-free: the renderer builds entries with it and the server
// clamps what it is sent with the same limits.

import { diffTexts } from "./text-hunks";
import type { LiberaFileNode } from "./types";

/** Files kept per notebook and session: edited files first, then new ones, then the latest viewed. */
export const MAX_RECAP_FILES = 12;
/** New files that were never opened, kept per notebook and session, so a bulk upload leaves room for the rest. */
export const MAX_RECAP_UNOPENED_NEW_FILES = 6;
/** Notebooks with more files keep no list of known files; "changed since you left" then relies on dates. */
export const MAX_KNOWN_FILES = 5000;
/** Changed passages kept per file. */
export const MAX_RECAP_CROPS = 2;
/** Characters kept of each side of a changed passage. */
export const MAX_RECAP_CROP_CHARS = 240;
/** Texts above this size are not diffed; the file only counts as edited. */
const MAX_DIFF_TEXT_CHARS = 400_000;

/** Who changed a shared document during the session. Local notebooks are always "you". */
export type RecapAuthor = "you" | "others" | "mixed";

export type RecapCrop = { removed?: string; added?: string };

export type RecapFileEntry = {
  /** Path inside the notebook, so a renamed notebook keeps its record. */
  path: string;
  name: string;
  fileType: string;
  /** Last time the file was open in this session (for a new file never opened, when it was added). */
  lastAt: string;
  edited: boolean;
  /** The file was added to the notebook during the session. */
  created?: boolean;
  /** A new file that was never opened in this session (an upload, a saved recording, a file another program added). */
  unopened?: boolean;
  /** Characters added and removed over the session. */
  added?: number;
  removed?: number;
  crops?: RecapCrop[];
  by?: RecapAuthor;
};

export type RecapSession = {
  id: string;
  startedAt: string;
  endedAt: string;
  files: RecapFileEntry[];
  /**
   * The notebook's files when the session was last written, as path hashes
   * (encodeKnownFiles). A file missing from it is new since then, even when it
   * kept old dates (a Finder copy, a sync).
   */
  knownFiles?: string;
};

export type RecapSummary = {
  sessionId: string;
  bullets: string[];
  model: string;
  generatedAt: string;
};

/** What the notebook home shows: the newest finished session, from any device. */
export type RecapView = {
  /** Where Was I is turned off in Preferences: no card. */
  disabled?: true;
  session: RecapSession | null;
  /** Set when the session was recorded by another installation (a synced folder). */
  deviceName?: string;
  summary: RecapSummary | null;
  /** The notebook is shared through collaboration. */
  shared: boolean;
  /** Summaries are turned on in Preferences → AI and an OpenRouter key is set. */
  summariesEnabled: boolean;
};

/** The body of a session write: this window's session and the notebooks it touched. */
export type RecapSessionUpdate = {
  sessionId: string;
  startedAt: string;
  notebooks: Record<string, RecapFileEntry[]>;
  /** Per notebook: path hashes, or null to discard an inventory that is now incomplete. */
  knownFiles?: Record<string, string | null>;
};

/** FNV-1a over a path inside the notebook. Collisions only hide a new file, so 32 bits is plenty. */
export function hashRecapPath(path: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Sorted 4-byte path hashes in base64: about 5.4 characters per file. Null for very large notebooks. */
export function encodeKnownFiles(paths: Iterable<string>): string | null {
  const hashes = [...new Set([...paths].map(hashRecapPath))].sort((a, b) => a - b);
  if (hashes.length > MAX_KNOWN_FILES) return null;
  let binary = "";
  for (const hash of hashes) binary += String.fromCharCode(hash >>> 24, (hash >>> 16) & 255, (hash >>> 8) & 255, hash & 255);
  return btoa(binary);
}

export function decodeKnownFiles(value: string | null | undefined): Set<number> | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    if (binary.length % 4) return null;
    const hashes = new Set<number>();
    for (let index = 0; index < binary.length; index += 4) {
      hashes.add(((binary.charCodeAt(index) << 24) | (binary.charCodeAt(index + 1) << 16) | (binary.charCodeAt(index + 2) << 8) | binary.charCodeAt(index + 3)) >>> 0);
    }
    return hashes;
  } catch {
    return null;
  }
}

/** A list of known files as sent by a client, or undefined when it is not valid base64 of whole hashes. */
export function normalizeKnownFiles(value: unknown) {
  if (typeof value !== "string" || !value || value.length > Math.ceil((MAX_KNOWN_FILES * 4) / 3) + 4) return undefined;
  return decodeKnownFiles(value) ? value : undefined;
}

function clip(text: string, fromEnd = false) {
  const compact = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length <= MAX_RECAP_CROP_CHARS) return compact;
  return fromEnd
    ? `…${compact.slice(compact.length - MAX_RECAP_CROP_CHARS + 1)}`
    : `${compact.slice(0, MAX_RECAP_CROP_CHARS - 1)}…`;
}

/**
 * The size of a change and its largest passages, clipped. Small on purpose:
 * it only has to remind a model (and you) what the edit was about.
 */
export function summarizeTextChange(before: string, after: string): Pick<RecapFileEntry, "added" | "removed" | "crops"> | null {
  if (before === after) return null;
  if (before.length > MAX_DIFF_TEXT_CHARS || after.length > MAX_DIFF_TEXT_CHARS) {
    return { added: Math.max(0, after.length - before.length), removed: Math.max(0, before.length - after.length) };
  }
  const hunks = diffTexts(before, after);
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    added += hunk.toB - hunk.fromB;
    removed += hunk.toA - hunk.fromA;
  }
  const crops = [...hunks]
    .sort((a, b) => (b.toB - b.fromB + b.toA - b.fromA) - (a.toB - a.fromB + a.toA - a.fromA))
    .slice(0, MAX_RECAP_CROPS)
    // Keep reading order among the largest passages.
    .sort((a, b) => a.fromB - b.fromB)
    .map((hunk) => {
      const removedText = clip(before.slice(hunk.fromA, hunk.toA));
      const addedText = clip(after.slice(hunk.fromB, hunk.toB));
      return { ...(removedText ? { removed: removedText } : {}), ...(addedText ? { added: addedText } : {}) };
    })
    .filter((crop) => crop.added || crop.removed);
  return { added, removed, ...(crops.length ? { crops } : {}) };
}

function recapRank(file: RecapFileEntry) {
  return file.edited ? 2 : file.created ? 1 : 0;
}

/**
 * Edited files first, then new files, then viewed ones, newest first within
 * each group; at most MAX_RECAP_FILES, of which MAX_RECAP_UNOPENED_NEW_FILES
 * new files that were never opened.
 */
export function rankRecapFiles(files: RecapFileEntry[]) {
  let unopened = 0;
  return [...files]
    .sort((a, b) => recapRank(b) - recapRank(a) || b.lastAt.localeCompare(a.lastAt))
    .filter((file) => !file.unopened || ++unopened <= MAX_RECAP_UNOPENED_NEW_FILES)
    .slice(0, MAX_RECAP_FILES);
}

const AUTHORS = new Set<RecapAuthor>(["you", "others", "mixed"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

export function isRecapDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && Number.isFinite(Date.parse(value));
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/** Clamps an entry sent by a client to the limits above, or null when it is unusable. */
export function normalizeRecapFileEntry(input: unknown): RecapFileEntry | null {
  const value = input as Partial<RecapFileEntry> | null;
  const path = text(value?.path, 1024).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  const lastAt = text(value?.lastAt, 40);
  const crops = (Array.isArray(value?.crops) ? value.crops : []).slice(0, 10).flatMap((crop: RecapCrop) => {
    const removed = text(crop?.removed, MAX_RECAP_CROP_CHARS);
    const added = text(crop?.added, MAX_RECAP_CROP_CHARS);
    return removed || added ? [{ ...(removed ? { removed } : {}), ...(added ? { added } : {}) }] : [];
  }).slice(0, MAX_RECAP_CROPS);
  const added = count(value?.added);
  const removed = count(value?.removed);
  return {
    path,
    name: text(value?.name, 255) || path.split("/").at(-1)!,
    fileType: text(value?.fileType, 32) || "file",
    lastAt: isRecapDate(lastAt) ? lastAt : new Date().toISOString(),
    edited: value?.edited === true,
    ...(value?.created === true ? { created: true } : {}),
    ...(value?.created === true && value?.unopened === true ? { unopened: true } : {}),
    ...(added !== undefined ? { added } : {}),
    ...(removed !== undefined ? { removed } : {}),
    ...(crops.length ? { crops } : {}),
    ...(value?.by && AUTHORS.has(value.by) ? { by: value.by } : {}),
  };
}

/** Strips list markers and emphasis from a model's lines; keeps two to four bullets. */
export function parseRecapBullets(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*•–]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^([-*•–]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").trim())
    .filter(Boolean)
    .map((line) => (line.length > 220 ? `${line.slice(0, 219)}…` : line))
    .slice(0, 4);
}

/** A file that changed after the last session ended. */
export type RecapAwayChange = { file: LiberaFileNode; kind: "new" | "updated"; at: string };

function latest(...dates: (string | undefined)[]) {
  return dates.reduce<string>((max, date) => (date && date > max ? date : max), "");
}

/**
 * Files changed since the session ended, newest first. With the session's
 * list of known files, a file missing from it is new whatever its dates say
 * (a Finder copy or a sync keeps them). Without one, dates decide: creation
 * time, modification time, and the inode change time, which moves even when
 * a copy keeps the other two.
 */
export function changesSinceSession(
  files: readonly LiberaFileNode[],
  notebook: string,
  session: Pick<RecapSession, "endedAt" | "knownFiles">,
  options: { toleranceMs?: number; exclude?: ReadonlySet<string> } = {},
): RecapAwayChange[] {
  if (!isRecapDate(session.endedAt)) return [];
  const since = new Date(new Date(session.endedAt).getTime() + (options.toleranceMs ?? 0)).toISOString();
  const known = decodeKnownFiles(session.knownFiles);
  const changes: RecapAwayChange[] = [];
  for (const file of files) {
    if (options.exclude?.has(file.path) || !file.path.startsWith(`${notebook}/`)) continue;
    const updated = file.updatedAt > since;
    let isNew: boolean;
    if (known) {
      isNew = !known.has(hashRecapPath(file.path.slice(notebook.length + 1)));
    } else {
      const created = file.createdAt > since;
      const moved = (file.changedAt ?? "") > since;
      if (!updated && !created && !moved) continue;
      isNew = created || (moved && !updated);
    }
    if (!isNew && !updated) continue;
    changes.push({ file, kind: isNew ? "new" : "updated", at: isNew ? latest(file.createdAt, file.changedAt, file.updatedAt) : file.updatedAt });
  }
  return changes.sort((a, b) => b.at.localeCompare(a.at));
}
