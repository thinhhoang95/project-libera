import type { LiberaFileNode, LiberaFileType } from "@/lib/types";

/** Shared by the Global Search API and its client. Nothing here may touch the server. */

export type SearchFileKind = LiberaFileType;
export const SEARCH_FILE_KINDS: SearchFileKind[] = ["markdown", "pdf", "latex", "text", "image"];

/** An image placed in the query box. */
export type SearchImageRef =
  | { kind: "file"; path: string; name: string }
  | { kind: "gallery"; id: string; path: string; name: string }
  | { kind: "upload"; name: string; dataUrl: string };

/** The query box in reading order: text runs with images between them. */
export type SearchQueryPart =
  | { type: "text"; text: string }
  | { type: "image"; image: SearchImageRef };

export type SearchRequest = {
  parts: SearchQueryPart[];
  kinds?: SearchFileKind[];
  /** Library file paths the current workspace shows; omitted when everything is visible. */
  scope?: string[];
  /** Files in archive folders are left out unless the library shows the archive. */
  includeArchive?: boolean;
  limit?: number;
};

/** Where a hit is inside its file. Offsets and lines refer to the file's source text. */
export type SearchLocation = {
  page?: number;
  line?: number;
  endLine?: number;
  start?: number;
  end?: number;
  /** The section the passage belongs to, outermost heading first, joined with " › ". */
  section?: string;
};

export type SearchHit = {
  chunkId: number;
  /** Fused rank score, only meaningful relative to other hits. */
  score: number;
  /** Cosine similarity to the query when the hit came from the vector index. */
  similarity?: number;
  semantic: boolean;
  keyword: boolean;
  text: string;
  location: SearchLocation;
};

export type SearchGalleryPhoto = {
  id: string;
  path: string;
  name: string;
  updatedAt: string;
  size: number;
  prompt?: string;
};

export type SearchResultFile = {
  key: string;
  source: "library" | "gallery";
  kind: SearchFileKind;
  name: string;
  /** The library path, or the path inside the gallery folder. */
  path: string;
  file?: LiberaFileNode;
  photo?: SearchGalleryPhoto;
  score: number;
  hits: SearchHit[];
};

export type SearchResponse = {
  results: SearchResultFile[];
  mode: "hybrid" | "semantic" | "keyword";
  /** Words from the query used for keyword matching and highlighting. */
  terms: string[];
  tookMs: number;
  warning?: string;
};

export type SearchModelStatus = {
  configured: boolean;
  vision: boolean;
  state: "unconfigured" | "idle" | "loading" | "ready" | "error";
  error?: string;
  textWeights?: string;
  visionWeights?: string;
  textDtype?: string;
  visionDtype?: string | null;
  dimensions: number;
};

export type SearchIndexStatus = {
  state: "idle" | "scanning" | "embedding" | "paused" | "error";
  /** Automatic updates are disabled in Preferences; manual actions still work. */
  backgroundIndexing?: boolean;
  /** False until the first index is built or an existing one is chosen. */
  exists: boolean;
  /** Set when the stored vectors were made with another model or size; they are not searched. */
  mismatch?: string;
  /** The index file was chosen in Preferences rather than the default location. */
  customIndex: boolean;
  model: SearchModelStatus;
  files: number;
  chunks: number;
  embeddedChunks: number;
  images: number;
  failedFiles: number;
  /** Progress of the current pass. */
  done: number;
  total: number;
  current?: string;
  lastScanAt?: string;
  indexPath: string;
  error?: string;
};

export const SEARCH_QUERY_PREFIX = "task: search result | query: ";
export const SEARCH_IMAGE_PLACEHOLDER = "<|image|>";
export const MAX_SEARCH_QUERY_IMAGES = 4;
export const MAX_SEARCH_UPLOAD_BYTES = 12 * 1024 * 1024;

// Function words and search phrasing carry no keyword signal; the embedding handles their meaning.
const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "could", "did", "do",
  "does", "doing", "down", "during", "each", "few", "for", "from", "further", "get", "got", "had", "has", "have",
  "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just",
  "me", "more", "most", "my", "need", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "our",
  "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was",
  "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you",
  "your", "find", "show", "search", "look", "looking", "like", "similar", "image", "images", "photo", "photos",
  "picture", "pictures", "notes", "note", "documents", "document", "files", "file",
]);

/** The query's text, with a placeholder where each image sits. */
export function searchQueryText(parts: SearchQueryPart[], placeholder = SEARCH_IMAGE_PLACEHOLDER) {
  return parts
    .map((part) => (part.type === "text" ? part.text : ` ${placeholder} `))
    .join("")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Plain text of the query, without images. */
export function searchQueryPlainText(parts: SearchQueryPart[]) {
  return searchQueryText(parts, " ").replace(/\s+/g, " ").trim();
}

/** Words worth matching literally: quoted phrases and non-trivial words. */
export function searchQueryTerms(text: string) {
  const terms: string[] = [];
  const phrasePattern = /"([^"]+)"/g;
  let remaining = text;

  for (const match of text.matchAll(phrasePattern)) {
    const phrase = match[1].trim().replace(/\s+/g, " ");
    if (phrase) terms.push(phrase);
  }

  remaining = remaining.replace(phrasePattern, " ");

  for (const word of remaining.match(/[\p{L}\p{N}][\p{L}\p{N}_'.-]*/gu) ?? []) {
    const normalized = word.replace(/[.'-]+$/u, "");
    if (normalized.length < 2 && !/\p{N}/u.test(normalized)) continue;
    if (STOP_WORDS.has(normalized.toLowerCase())) continue;
    if (!terms.some((term) => term.toLowerCase() === normalized.toLowerCase())) terms.push(normalized);
  }

  return terms.slice(0, 16);
}

export function searchKindLabel(kind: SearchFileKind) {
  switch (kind) {
    case "markdown":
      return "Note";
    case "pdf":
      return "PDF";
    case "latex":
      return "LaTeX";
    case "text":
      return "Text & code";
    case "image":
      return "Image";
  }
}

export function searchLocationLabel(kind: SearchFileKind, location: SearchLocation) {
  const parts: string[] = [];
  if (location.page) parts.push(`Page ${location.page}`);
  if (location.section) parts.push(location.section);
  if (!location.page && location.line && kind !== "markdown") {
    parts.push(location.endLine && location.endLine > location.line ? `Lines ${location.line}–${location.endLine}` : `Line ${location.line}`);
  }
  return parts.join(" · ");
}

/** Lower-case text without diacritics, with each folded character's offset in the original. */
export function foldText(text: string) {
  let folded = "";
  const offsets: number[] = [];

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const base = character.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase() || character.toLowerCase();
    for (let position = 0; position < base.length; position += 1) offsets.push(index);
    folded += base;
    index += character.length;
  }

  offsets.push(text.length);
  return { folded, offsets };
}

/**
 * Where the query's words occur in a text, ignoring case and accents, as
 * sorted, non-overlapping [start, end) ranges of the original text.
 */
export function findTermRanges(text: string, terms: string[]) {
  if (!text || !terms.length) return [];
  const { folded, offsets } = foldText(text);
  const ranges: Array<[number, number]> = [];

  for (const term of terms) {
    const needle = foldText(term.trim()).folded.replace(/\s+/g, " ");
    if (!needle) continue;
    const haystack = needle.includes(" ") ? folded.replace(/\s/g, " ") : folded;
    for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + needle.length)) {
      // Match word starts only, as keyword search does (prefixes included).
      if (from > 0 && /[\p{L}\p{N}]/u.test(haystack[from - 1])) continue;
      ranges.push([offsets[from], offsets[from + needle.length]]);
    }
  }

  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** A window of about `length` characters, around the first matched word when there is one. */
export function snippetWindow(text: string, terms: string[], length = 280) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= length) return { text: compact, clippedStart: false, clippedEnd: false };

  const first = findTermRanges(compact, terms)[0];
  let start = first ? Math.max(0, first[0] - Math.floor(length / 3)) : 0;
  if (start > 0) {
    const space = compact.indexOf(" ", start);
    if (space >= 0 && space < start + 24) start = space + 1;
  }
  let end = Math.min(compact.length, start + length);
  if (end < compact.length) {
    const space = compact.lastIndexOf(" ", end);
    if (space > start + length / 2) end = space;
  }
  return { text: compact.slice(start, end), clippedStart: start > 0, clippedEnd: end < compact.length };
}
