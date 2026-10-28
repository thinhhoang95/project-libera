import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { inkFileName } from "@/lib/ink/authors";
import { canWriteInkFile, emptyInkAuthorFile, normalizeInkFrame } from "@/lib/ink/codec";
import { IDENTITY_PHOTO_VIEW, composePhotoViews, normalizePhotoInkView, photoViewMatrix, photoViewSize, type PhotoInkView } from "@/lib/ink/frame";
import { applyInkOps, mergeInkFiles } from "@/lib/ink/merge";
import { inkToSvg } from "@/lib/ink/svg";
import type { InkAuthorFile } from "@/lib/ink/types";
import type { EditedPhotoFormat } from "@/lib/photo-edits-server";
import { StorageError } from "@/lib/storage/errors";
import { moveFileIfExists, pathExists, writeJsonAtomically } from "@/lib/storage/fs-utils";
import { chunkPayload, inkAuthor, normalizeInkOps, publishInkFile, readInkFolder, withInkLock, type InkPayload } from "@/lib/storage/ink";
import { cachedPdfIdentity } from "@/lib/storage/pdf-identity";

// Ink on gallery photos (docs/ink-plan.md, "Gallery photos"). The gallery
// bakes edits into the file, so strokes are kept on the photo as it was when
// first inked (the "original"), with `state.json` saying how the file shown
// today is made from it: the rotate, flip and crop of every edit since. An
// edit composes into that view, a revert undoes it, and a copy takes both.
//
// Ink lives in `gallery/.libera-ink/<photo id>/photo.<author>.ink`, by photo
// id so it follows the photo through moves, and moves to the Protected
// Archive's own `.libera-ink/` with the photo. gallery.ts calls these
// functions with the photo's file; this module never reads the gallery index.

export const PHOTO_CHUNK = "photo";
const STATE_FILE = "state.json";

type PhotoInkState = {
  version: 1;
  /** The photo's pixel size (EXIF upright) when it was first inked: the strokes' units. */
  original: { width: number; height: number };
  /** How today's file is made from that photo. */
  view: PhotoInkView;
  /** SHA-256 of the file as Libera last left it; another value means it changed outside Libera. */
  sha256: string | null;
  /** The ink was drawn on the unedited photo, so Revert brings back the identity view. */
  basedOnOriginal: boolean;
  /** A copy's unedited file may already include the source's turns and crop. */
  originalView?: PhotoInkView;
};

export type PhotoInkPayload = InkPayload & {
  photo: {
    original: { width: number; height: number };
    view: PhotoInkView;
    /** The size of the file shown today. */
    viewSize: { width: number; height: number };
    /** The file changed outside Libera since it was inked: the ink may no longer line up. */
    changed: boolean;
  };
};

/** Where a photo is: in the gallery, or in the Protected Archive. */
export type PhotoLocation = { root: string; id: string };

const inkFolder = ({ root, id }: PhotoLocation) => {
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new StorageError("Photo id is invalid.");
  return path.join(root, ".libera-ink", id);
};

async function readState(folder: string): Promise<PhotoInkState | null> {
  try {
    const value = JSON.parse(await readFile(path.join(folder, STATE_FILE), "utf8")) as Partial<PhotoInkState>;
    const original = normalizeInkFrame({ unit: "px", ...value.original });
    if (!original) return null;
    return {
      version: 1,
      original: { width: original.width, height: original.height },
      view: normalizePhotoInkView(value.view),
      sha256: typeof value.sha256 === "string" ? value.sha256 : null,
      basedOnOriginal: value.basedOnOriginal === true,
      ...(value.originalView ? { originalView: normalizePhotoInkView(value.originalView) } : {}),
    };
  } catch {
    return null;
  }
}

const writeState = (folder: string, state: PhotoInkState) => writeJsonAtomically(path.join(folder, STATE_FILE), state);

async function fileHash(absolute: string) {
  return (await cachedPdfIdentity(absolute).catch(() => null))?.contentHash ?? null;
}

/** A photo's pixel size as shown (EXIF orientations 5–8 are stored on their side). */
export async function uprightSize(absolute: string) {
  const metadata = await sharp(absolute, { animated: false }).metadata();
  if (!metadata.width || !metadata.height) throw new StorageError("This photo's size cannot be read.");
  return (metadata.orientation ?? 1) >= 5 ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height };
}

async function payload(location: PhotoLocation, absolute: string, files: InkAuthorFile[], state: PhotoInkState | null): Promise<PhotoInkPayload> {
  const author = await inkAuthor();
  const viewSize = await uprightSize(absolute);
  const view = state?.view ?? IDENTITY_PHOTO_VIEW;
  return {
    path: location.id,
    author: author.key,
    chunks: [chunkPayload(PHOTO_CHUNK, files, author.key)],
    photo: {
      original: state?.original ?? viewSize,
      view,
      viewSize,
      changed: Boolean(state && files.length && (!state.sha256 || (await fileHash(absolute)) !== state.sha256)),
    },
  };
}

export async function readPhotoInk(location: PhotoLocation, absolute: string): Promise<PhotoInkPayload> {
  const folder = inkFolder(location);
  const files = (await readInkFolder(folder, new Set([PHOTO_CHUNK]))).get(PHOTO_CHUNK) ?? [];
  return payload(location, absolute, files, await readState(folder));
}

/** This author's changes to a photo's ink. `edited`: the file is already an edit of an earlier original. */
export async function writePhotoInk(location: PhotoLocation, absolute: string, edited: boolean, opsValue: unknown): Promise<PhotoInkPayload> {
  const folder = inkFolder(location);
  const ops = normalizeInkOps(opsValue);
  const author = await inkAuthor();
  const target = path.join(folder, inkFileName(PHOTO_CHUNK, author.key));
  return withInkLock(target, async () => {
    let state = await readState(folder);
    if (!state) {
      // The first ink: strokes are measured on the photo as it is now.
      state = { version: 1, original: await uprightSize(absolute), view: IDENTITY_PHOTO_VIEW, sha256: await fileHash(absolute), basedOnOriginal: !edited };
      await mkdir(folder, { recursive: true });
      await writeState(folder, state);
    }
    const files = (await readInkFolder(folder, new Set([PHOTO_CHUNK]))).get(PHOTO_CHUNK) ?? [];
    const others = files.filter((file) => file.author.key !== author.key);
    const own = files.find((file) => file.author.key === author.key) ?? emptyInkAuthorFile(author, { unit: "px", ...state.original });
    if (!canWriteInkFile(own)) throw new StorageError("This ink was saved by a newer version of Libera. Update Libera to change it.", 409);
    const next = applyInkOps(own, ops, others);
    if (next !== own) await publishInkFile(target, next);
    return payload(location, absolute, next !== own ? [...others, next] : files, state);
  });
}

/** After a file changed outside Libera: keep the ink where it is, or discard it. */
export async function resolveChangedPhotoInk(location: PhotoLocation, absolute: string, action: "keep" | "discard") {
  const folder = inkFolder(location);
  if (action === "discard") {
    await rm(folder, { recursive: true, force: true });
    return;
  }
  const state = await readState(folder);
  if (state) await writeState(folder, { ...state, sha256: await fileHash(absolute) });
}

const geometry = (edits: PhotoInkView): PhotoInkView => normalizePhotoInkView(edits);

/** An edit was baked into the file in place: the ink's view takes it on. */
export async function photoEditedInPlace(location: PhotoLocation, absolute: string, edits: PhotoInkView) {
  const folder = inkFolder(location);
  const state = await readState(folder);
  if (!state) return;
  await writeState(folder, { ...state, view: composePhotoViews(state.view, geometry(edits)), sha256: await fileHash(absolute) });
}

/** The photo was put back as it was before its first edit. */
export async function photoReverted(location: PhotoLocation, absolute: string) {
  const folder = inkFolder(location);
  const state = await readState(folder);
  if (!state) return;
  // Ink drawn on an already-edited photo was not drawn on this original: its
  // place is unknown, so it is shown as changed for the reader to keep or discard.
  await writeState(folder, state.basedOnOriginal
    ? { ...state, view: state.originalView ?? IDENTITY_PHOTO_VIEW, sha256: await fileHash(absolute) }
    : { ...state, sha256: null });
}

/** A copy of a photo (edited or not) takes its ink, every author's. */
export async function copyPhotoInk(from: PhotoLocation, to: PhotoLocation, toAbsolute: string, edits: PhotoInkView | null) {
  const source = inkFolder(from);
  const state = await readState(source);
  const files = (await readInkFolder(source, new Set([PHOTO_CHUNK]))).get(PHOTO_CHUNK) ?? [];
  if (!state || !files.length) return;
  const target = inkFolder(to);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const file of files) await publishInkFile(path.join(target, inkFileName(PHOTO_CHUNK, file.author.key)), file);
  const view = edits ? composePhotoViews(state.view, geometry(edits)) : state.view;
  await writeState(target, {
    ...state,
    view,
    originalView: view,
    basedOnOriginal: true,
    sha256: await fileHash(toAbsolute),
  });
}

/** The photo went to or came back from the Protected Archive. */
export async function movePhotoInk(from: PhotoLocation, to: PhotoLocation) {
  await moveFileIfExists(inkFolder(from), inkFolder(to));
}

export async function deletePhotoInk(location: PhotoLocation) {
  await rm(inkFolder(location), { recursive: true, force: true });
}

export async function hasPhotoInk(location: PhotoLocation) {
  return pathExists(inkFolder(location));
}

/**
 * The photo as shown today with its ink drawn on top, after every color step
 * so the ink is not graded with the photo. Null when it has no ink.
 */
export async function renderPhotoWithInk(location: PhotoLocation, absolute: string, format: EditedPhotoFormat): Promise<Buffer | null> {
  const folder = inkFolder(location);
  const state = await readState(folder);
  const files = (await readInkFolder(folder, new Set([PHOTO_CHUNK]))).get(PHOTO_CHUNK) ?? [];
  const merged = mergeInkFiles(files);
  if (!state || !merged.strokes.length) return null;
  const size = photoViewSize(state.original, state.view);
  const shown = await uprightSize(absolute);
  const svg = inkToSvg(merged.strokes.map((item) => item.stroke), { unit: "px", ...state.original }, "Ink", {
    width: shown.width,
    height: shown.height,
    // Cropping rounds to whole pixels; scale the last fraction away so the ink lands on the file as it is.
    matrix: scaleMatrix(photoViewMatrix(state.original, state.view), shown.width / size.width, shown.height / size.height),
  });
  const image = sharp(absolute, { animated: false }).rotate().composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  return format === "jpeg" ? image.jpeg({ quality: 92 }).toBuffer() : format === "webp" ? image.webp({ quality: 92 }).toBuffer() : image.png().toBuffer();
}

function scaleMatrix([a, b, c, d, e, f]: readonly number[], sx: number, sy: number) {
  return [a * sx, b * sy, c * sx, d * sy, e * sx, f * sy];
}
