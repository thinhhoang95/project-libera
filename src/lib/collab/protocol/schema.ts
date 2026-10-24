// Shape of the collaborative Yjs documents (collaboration map §5).
//
// Each shared text file has three Y.Docs that sync independently, one per
// sub-document. Each shared notebook has one manifest Y.Doc. This module only
// names keys and describes stored values, and it does not import yjs: the
// renderer, host and server each have their own yjs instance, and mixing
// instances breaks `instanceof` checks inside yjs.

import type { Actor } from "./actor";

export const ContentKeys = {
  /** Y.Text holding the file's exact source text. */
  source: "source",
} as const;

export const AnnotationKeys = {
  /** Y.Map<AnchorRecord> keyed by anchorId. */
  anchors: "anchors",
  /** Y.Map<SuggestionRecord> keyed by suggestionId. */
  suggestions: "suggestions",
  /** Y.Map<ReviewScopeRecord> keyed by review id. */
  reviewScopes: "reviewScopes",
} as const;

export const MetaKeys = {
  /** Y.Map with DocMeta fields. */
  meta: "meta",
} as const;

export const ManifestKeys = {
  /** Y.Map<ManifestEntry> keyed by fileId. */
  files: "files",
  /** Y.Map with project-level settings (name is server-side). */
  settings: "settings",
  /** Shared albums only: Y.Map<AlbumPhotoRecord> keyed by the photo's fileId. */
  photos: "photos",
} as const;

/**
 * What a project shares. A notebook is a folder of documents and files; an
 * album is a flat folder of photos in the gallery, with per-photo details
 * (captions, edits) in the manifest's `photos` map.
 */
export type ProjectKind = "notebook" | "album";

export const PROJECT_KINDS: readonly ProjectKind[] = ["notebook", "album"];

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === "string" && (PROJECT_KINDS as readonly string[]).includes(value);
}

/** Keys of an album's `settings` map. */
export const AlbumSettingKeys = {
  /** fileId of the cover photo; the newest photo when unset. */
  cover: "cover",
  /** A single photo shared on its own: shown as a photo, not an album. */
  direct: "direct",
  /** Photos keep their location and camera details (off: they are removed before upload). */
  keepLocation: "keepLocation",
  /** Image-generation prompts and models are shared with the photos. */
  sharePrompts: "sharePrompts",
} as const;

/**
 * Details of one photo in a shared album, beside its manifest entry. Edits
 * are applied to the file (the entry's blob is the edited photo); the
 * unedited photo stays on the server as `originalHash`, so anyone can
 * revert or edit again from the original.
 */
export interface AlbumPhotoRecord {
  fileId: string;
  caption?: string;
  /** Only when the album shares prompts. */
  prompt?: string;
  model?: string;
  /** PhotoEdits (src/lib/photo-edits.ts) applied to `originalHash`. */
  edits?: Record<string, unknown>;
  /** SHA-256 of the unedited photo's bytes. */
  originalHash?: string;
  /** Sort position; photos without one follow, oldest first. */
  order?: number;
  /** Account that added the photo. */
  addedBy: string;
  updatedBy?: string;
  updatedAt: number;
}

/** Photos a shared album accepts. SVG is refused: it can carry scripts. */
export const ALBUM_IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export const MAX_ALBUM_CAPTION_LENGTH = 2000;

/** The media type of an album photo by its name, or null when albums do not take that file. */
export function albumImageType(path: string): string | null {
  const match = /\.[^./\\]+$/.exec(path.toLowerCase());
  return (match && ALBUM_IMAGE_TYPES[match[0]]) || null;
}

/** Validates an album manifest path: one safe file name with a photo extension. */
export function albumPathError(path: string): string | null {
  const problem = manifestPathError(path);
  if (problem) return problem;
  if (path.includes("/")) return "Albums hold photos only, without folders.";
  if (!albumImageType(path)) return "Albums hold PNG, JPEG, WebP and GIF photos only.";
  return null;
}

export type DocKind = "markdown" | "latex" | "text";

export interface DocMeta {
  schemaVersion: number;
  kind: DocKind;
  fileId: string;
}

/**
 * A Yjs RelativePosition serialized with `Y.relativePositionToJSON`. Kept as
 * plain JSON so the value is atomic inside a Y.Map and the server can inspect
 * it without decoding.
 */
export type RelativePositionJSON = {
  type?: { client: number; clock: number } | null;
  tname?: string | null;
  item?: { client: number; clock: number } | null;
  assoc?: number;
};

export interface AnchorRecord {
  id: string;
  kind: "comment" | "review-scope";
  start: RelativePositionJSON;
  end: RelativePositionJSON;
  /** Account that created the anchor (commenters may only change their own). */
  createdBy: string;
  createdAt: number;
}

export type SuggestionStatus = "pending" | "accepted" | "rejected" | "stale" | "withdrawn";

export interface SuggestionRecord {
  id: string;
  /** Linked suggestions share a group and are accepted or rejected together. */
  groupId?: string;
  actor: Actor;
  /** Account whose rights the suggestion uses (the user, or the user an AI acted for). */
  createdBy: string;
  start: RelativePositionJSON;
  end: RelativePositionJSON;
  /** The original text between start and end when the suggestion was made. */
  baseQuote: string;
  /** Proposed replacement; "" proposes a deletion. */
  replacement: string;
  /** Optional explanation (agentic review fills this in). */
  reason?: string;
  title?: string;
  /** Comment threads this suggestion addresses. */
  threadIds?: string[];
  status: SuggestionStatus;
  createdAt: number;
  updatedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  staleReason?: "text-changed" | "target-removed";
  /**
   * Set by the server on accept: where the replacement now is in content
   * (start sticks to its first character, end to its last). Revert checks
   * that this range still holds `replacement`.
   */
  appliedStart?: RelativePositionJSON;
  appliedEnd?: RelativePositionJSON;
}

export interface ReviewScopeRecord {
  reviewId: string;
  anchorId: string;
  createdBy: string;
  createdAt: number;
}

export type ManifestEntryKind = "doc" | "blob" | "folder";

export interface ManifestEntry {
  fileId: string;
  /** Path relative to the notebook root, with "/" separators. */
  path: string;
  kind: ManifestEntryKind;
  /** For kind "doc": the document id on the server. */
  docId?: string;
  docKind?: DocKind;
  /** For kind "blob": SHA-256 hex of the file's bytes. */
  blobHash?: string;
  size?: number;
  mime?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export const TEXT_DOC_EXTENSIONS: Record<string, DocKind> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".tex": "latex",
  ".bib": "latex",
  ".sty": "latex",
  ".cls": "latex",
  ".txt": "text",
  ".json": "text",
  ".yaml": "text",
  ".yml": "text",
  ".csv": "text",
  ".py": "text",
  ".js": "text",
  ".ts": "text",
  ".css": "text",
  ".html": "text",
};

/** The document kind for a path, or null when the file is stored as a blob. */
export function docKindForPath(path: string): DocKind | null {
  const match = /\.[^./\\]+$/.exec(path.toLowerCase());
  if (!match) return null;
  return TEXT_DOC_EXTENSIONS[match[0]] ?? null;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const FORBIDDEN_CHARACTERS = /[<>:"|?*\u0000-\u001f\\]/;

/**
 * Validates a manifest path. Returns an error message, or null when the path
 * is safe to materialize on Windows, macOS and Linux.
 */
export function manifestPathError(path: string): string | null {
  if (typeof path !== "string" || path.length === 0) return "Path is empty.";
  if (path.length > 1024) return "Path is too long.";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return "Path must be relative.";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return "Path has an empty segment.";
    if (segment === "." || segment === "..") return "Path may not contain . or .. segments.";
    if (segment.length > 255) return "A path segment is too long.";
    if (FORBIDDEN_CHARACTERS.test(segment)) return "Path contains a forbidden character.";
    if (WINDOWS_RESERVED.test(segment)) return "Path uses a reserved Windows name.";
    if (/[. ]$/.test(segment)) return "A path segment may not end with a dot or space.";
    if (segment.startsWith(".libera")) return "Paths starting with .libera are reserved.";
  }
  return null;
}

/** Case-insensitive key used to detect two manifest entries that clash on disk. */
export function manifestPathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}
