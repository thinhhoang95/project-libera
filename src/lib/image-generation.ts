/**
 * Image generation settings shared by the client and server. Parameters come
 * from OpenRouter's Images API, which describes what each model accepts.
 */

export type ImageParameterDescriptor =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };

export type ImageGenerationModel = {
  id: string;
  name: string;
  description?: string;
  /** Parameters this model accepts, keyed by request field. */
  parameters: Record<string, ImageParameterDescriptor>;
  /** How many reference photos the model takes; absent when it takes none. */
  references?: { min: number; max: number };
};

/** Reference photos are sent as data URLs and must be one of these types. */
export const REFERENCE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** Larger photos are scaled down in the browser before they are sent. */
export const MAX_REFERENCE_IMAGE_EDGE = 2048;
export const MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024;

export type ImageParameterValue = string | number;
export type ImageParameterValues = Record<string, ImageParameterValue>;

export type ImageGenerationDestination =
  /** `album` is an album id ("" for no album). */
  | { kind: "gallery"; album: string }
  /** A notebook folder, as `notebook` or `notebook/folder/…`. */
  | { kind: "folder"; path: string };

export type ImageGenerationSettings = {
  model: string;
  /** Choices are remembered per model so switching models keeps them. */
  paramsByModel: Record<string, ImageParameterValues>;
  destination: ImageGenerationDestination;
};

export const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image";

export const DEFAULT_IMAGE_GENERATION_SETTINGS: ImageGenerationSettings = {
  model: DEFAULT_IMAGE_MODEL,
  paramsByModel: {},
  destination: { kind: "gallery", album: "" },
};

/** Parameters the panel offers. Reference images and raw pixel sizes are left out. */
export const IMAGE_PARAMETER_ORDER = [
  "aspect_ratio",
  "resolution",
  "quality",
  "background",
  "output_format",
  "output_compression",
  "n",
  "seed",
] as const;

export const IMAGE_PARAMETER_LABELS: Record<string, string> = {
  aspect_ratio: "Aspect ratio",
  resolution: "Resolution",
  quality: "Quality / effort",
  background: "Background",
  output_format: "Format",
  output_compression: "Compression",
  n: "Images",
  seed: "Seed",
};

const MAX_MODEL_ID_LENGTH = 200;
const MAX_PATH_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseModelId(value: unknown) {
  return typeof value === "string" && value.trim() && value.length <= MAX_MODEL_ID_LENGTH && !/[\u0000-\u001f\s]/.test(value)
    ? value.trim()
    : null;
}

function parseParameterValues(value: unknown): ImageParameterValues {
  if (!isRecord(value)) return {};
  const result: ImageParameterValues = {};
  for (const key of IMAGE_PARAMETER_ORDER) {
    const entry = value[key];
    if (typeof entry === "string" && entry.length <= 40) result[key] = entry;
    else if (typeof entry === "number" && Number.isFinite(entry)) result[key] = Math.round(entry);
  }
  return result;
}

function parseDestination(value: unknown): ImageGenerationDestination {
  if (isRecord(value) && value.kind === "folder" && typeof value.path === "string" && value.path.trim() && value.path.length <= MAX_PATH_LENGTH) {
    return { kind: "folder", path: value.path.trim().replace(/^\/+|\/+$/g, "") };
  }
  if (isRecord(value) && value.kind === "gallery" && typeof value.album === "string" && value.album.length <= 255) {
    return { kind: "gallery", album: value.album.trim() };
  }
  return DEFAULT_IMAGE_GENERATION_SETTINGS.destination;
}

/** Normalize stored or submitted settings; unknown fields are dropped. */
export function parseImageGenerationSettings(value: unknown): ImageGenerationSettings {
  if (!isRecord(value)) return DEFAULT_IMAGE_GENERATION_SETTINGS;
  const paramsByModel: Record<string, ImageParameterValues> = {};
  if (isRecord(value.paramsByModel)) {
    for (const [model, params] of Object.entries(value.paramsByModel).slice(0, 100)) {
      const id = parseModelId(model);
      if (id) paramsByModel[id] = parseParameterValues(params);
    }
  }
  return {
    model: parseModelId(value.model) ?? DEFAULT_IMAGE_MODEL,
    paramsByModel,
    destination: parseDestination(value.destination),
  };
}

/** Keep only values the model accepts, so stale choices never reach OpenRouter. */
export function validParameterValues(model: ImageGenerationModel, values: ImageParameterValues): ImageParameterValues {
  const result: ImageParameterValues = {};
  for (const key of IMAGE_PARAMETER_ORDER) {
    const descriptor = model.parameters[key];
    const value = values[key];
    if (!descriptor || value === undefined || value === "") continue;
    if (descriptor.type === "enum" && typeof value === "string" && descriptor.values.includes(value)) result[key] = value;
    else if (descriptor.type === "range" && typeof value === "number" && value >= descriptor.min && value <= descriptor.max) result[key] = value;
    else if (descriptor.type === "boolean" && key === "seed" && typeof value === "number" && value >= 0 && value <= 2 ** 31 - 1) result[key] = value;
  }
  return result;
}

export type GalleryPhoto = {
  /** Stable id that survives moves, renames and edits. */
  id: string;
  /** Path inside the gallery folder, `folder/name.png` or `name.png`. */
  path: string;
  name: string;
  /** The folder the file sits in on disk ("" for the gallery's top level). */
  folder: string;
  /** Albums the photo belongs to; a photo can be in several. */
  albumIds: string[];
  createdAt: string;
  /** Changes when the file changes, so cached images refresh after an edit. */
  updatedAt: string;
  size: number;
  width?: number;
  height?: number;
  prompt?: string;
  model?: string;
  starred: boolean;
  /** An unedited original is kept, so the edit can be reverted. */
  edited: boolean;
  /** Set on photos in the Protected Archive: when they were sent there. */
  archivedAt?: string;
};

export type GalleryAlbum = {
  id: string;
  name: string;
  /** The folder created for the album on disk. */
  folder: string;
  count: number;
  coverId?: string;
  createdAt: string;
};

export type GalleryContents = {
  root: string;
  albums: GalleryAlbum[];
  photos: GalleryPhoto[];
  /** Deletions discovered during this scan or change, including old chat attachments. */
  deletedPhotoIds?: string[];
};

/** The Protected Archive, listed only once it is unlocked. */
export type ArchiveContents = {
  photos: GalleryPhoto[];
  deletedPhotoIds?: string[];
};

export function archiveRawUrl(photo: Pick<GalleryPhoto, "name" | "updatedAt" | "size">, thumbnail = false) {
  const query = new URLSearchParams({ v: `${photo.updatedAt}-${photo.size}` });
  if (thumbnail) query.set("thumbnail", "1");
  return `/api/gallery/archive/raw/${encodeURIComponent(photo.name)}?${query}`;
}

export function galleryRawUrl(photo: Pick<GalleryPhoto, "path" | "updatedAt" | "size">, thumbnail = false) {
  const query = new URLSearchParams({ v: `${photo.updatedAt}-${photo.size}` });
  if (thumbnail) query.set("thumbnail", "1");
  return `/api/gallery/raw/${photo.path.split("/").map(encodeURIComponent).join("/")}?${query}`;
}
