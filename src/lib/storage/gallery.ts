import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { GalleryAlbum, GalleryContents, GalleryPhoto } from "@/lib/image-generation";
import { hasEdits, type PhotoEdits } from "@/lib/photo-edits";
import { renderEditedPhoto, type EditedPhotoFormat } from "@/lib/photo-edits-server";
import { StorageError } from "@/lib/storage/errors";
import { findAvailableFilePath, movePath, pathExists } from "@/lib/storage/fs-utils";
import { assertSafeUserSegment, getDataRoot } from "@/lib/storage/paths";

/**
 * The gallery is a plain folder of images, one level deep. A hidden index
 * (the "shadow" structure) is the source of truth for albums, stars and
 * prompts, and gives every photo an id that survives moves.
 *
 * Files move on disk only when a new album is created: its photos are moved
 * into a folder named after it. Adding photos to an existing album, removing
 * them, or deleting the album only changes the index, so photos are never
 * lost and a photo can belong to several albums.
 */
const GALLERY_DIR = "gallery";
const INDEX_FILE = ".libera-gallery.json";
const THUMBNAILS_DIR = ".thumbnails";
const ORIGINALS_DIR = ".originals";
const THUMBNAIL_SIZE = 640;
const INDEX_VERSION = 2;
const GALLERY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

type PhotoDetails = { prompt?: string; model?: string; createdAt?: string };

type PhotoRecord = {
  path: string;
  createdAt: string;
  prompt?: string;
  model?: string;
  starred?: boolean;
  /** Backup of the unedited file, relative to the originals folder. */
  original?: string;
  width?: number;
  height?: number;
  size: number;
  mtimeMs: number;
};

type AlbumRecord = { id: string; name: string; folder: string; createdAt: string; photoIds: string[] };

type GalleryIndex = {
  version: typeof INDEX_VERSION;
  photos: Record<string, PhotoRecord>;
  albums: AlbumRecord[];
  /** Folders already seen, so a deleted album's folder is not turned back into an album. */
  folders: string[];
  /** Prompts from the first index format, keyed by path, until their files are matched. */
  legacy?: Record<string, PhotoDetails>;
};

export function getGalleryRoot() {
  return path.join(getDataRoot(), GALLERY_DIR);
}

function indexPath() {
  return path.join(getGalleryRoot(), INDEX_FILE);
}

function absolutePath(relative: string) {
  return path.join(getGalleryRoot(), ...relative.split("/"));
}

function folderOf(relative: string) {
  const slash = relative.indexOf("/");
  return slash < 0 ? "" : relative.slice(0, slash);
}

function isVisibleEntry(name: string) {
  return !name.startsWith(".") && name !== "__MACOSX";
}

function isGalleryImage(name: string) {
  return isVisibleEntry(name) && GALLERY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Validate `folder/name.ext` or `name.ext` from a request. */
function resolvePhotoPath(photoPath: string) {
  if (typeof photoPath !== "string" || photoPath.includes("\\") || photoPath.includes("\0")) {
    throw new StorageError("Photo path is invalid.");
  }
  const parts = photoPath.split("/").filter(Boolean);
  if (parts.length < 1 || parts.length > 2) throw new StorageError("Photo path is invalid.");
  const name = assertSafeUserSegment(parts.at(-1) ?? "", "Photo name");
  const folder = parts.length === 2 ? assertSafeUserSegment(parts[0], "Folder name") : "";
  if (!GALLERY_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new StorageError("Only images are kept in the gallery.");
  const relative = folder ? `${folder}/${name}` : name;
  return { name, relative, absolute: absolutePath(relative) };
}

function emptyIndex(): GalleryIndex {
  return { version: INDEX_VERSION, photos: {}, albums: [], folders: [] };
}

async function loadIndex(): Promise<GalleryIndex> {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(await readFile(indexPath(), "utf8")); } catch { return emptyIndex(); }
  if (parsed.version === INDEX_VERSION) {
    return {
      ...emptyIndex(),
      photos: (parsed.photos && typeof parsed.photos === "object" ? parsed.photos : {}) as GalleryIndex["photos"],
      albums: Array.isArray(parsed.albums) ? parsed.albums as AlbumRecord[] : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders.filter((entry): entry is string => typeof entry === "string") : [],
    };
  }
  // The first format kept prompts by path and treated every folder as an album;
  // folders are imported as albums on the first scan, which keeps that meaning.
  return { ...emptyIndex(), legacy: (parsed.photos ?? {}) as Record<string, PhotoDetails> };
}

async function saveIndex(index: GalleryIndex) {
  await mkdir(getGalleryRoot(), { recursive: true });
  const target = indexPath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(index, null, 2) + "\n");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function imageSize(absolute: string) {
  try {
    const metadata = await sharp(absolute, { animated: false }).metadata();
    if (!metadata.width || !metadata.height) return {};
    // EXIF orientations 5–8 are stored on their side.
    return (metadata.orientation ?? 1) >= 5 ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height };
  } catch {
    return {};
  }
}

function birthDate(stats: Stats) {
  return (stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime).toISOString();
}

type ScannedFile = { relative: string; folder: string; name: string; stats: Stats };

async function scanGallery() {
  const root = getGalleryRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory() && isVisibleEntry(entry.name)).map((entry) => entry.name);
  const files: ScannedFile[] = [];
  async function collect(folder: string) {
    const directory = folder ? path.join(root, folder) : root;
    const names = folder ? await readdir(directory).catch(() => [] as string[]) : entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    await Promise.all(names.filter(isGalleryImage).map(async (name) => {
      const stats = await stat(path.join(directory, name)).catch(() => null);
      if (stats?.isFile()) files.push({ relative: folder ? `${folder}/${name}` : name, folder, name, stats });
    }));
  }
  await Promise.all(["", ...folders].map(collect));
  return { folders, files };
}

async function removeOriginal(record: PhotoRecord) {
  if (record.original) await rm(path.join(getGalleryRoot(), ORIGINALS_DIR, record.original), { force: true });
}

/** Bring the index in line with what is on disk. */
async function reconcile(index: GalleryIndex) {
  const { folders, files } = await scanGallery();
  const idByPath = new Map(Object.entries(index.photos).map(([id, record]) => [record.path, id]));
  const seen = new Set<string>();
  const unmatched: ScannedFile[] = [];

  for (const file of files) {
    const id = idByPath.get(file.relative);
    if (!id) { unmatched.push(file); continue; }
    seen.add(id);
    const record = index.photos[id];
    if (record.mtimeMs !== file.stats.mtimeMs || record.size !== file.stats.size) {
      Object.assign(record, { mtimeMs: file.stats.mtimeMs, size: file.stats.size }, await imageSize(path.join(getGalleryRoot(), file.relative)));
    }
  }

  // A folder that is new on disk becomes an album, as it would in a photo library.
  for (const folder of folders) {
    if (index.folders.includes(folder)) continue;
    index.folders.push(folder);
    if (!index.albums.some((album) => album.folder === folder)) {
      const stats = await stat(path.join(getGalleryRoot(), folder)).catch(() => null);
      index.albums.push({ id: randomUUID(), name: folder, folder, createdAt: stats ? birthDate(stats) : new Date().toISOString(), photoIds: [] });
    }
  }
  index.folders = index.folders.filter((folder) => folders.includes(folder) || index.albums.some((album) => album.folder === folder));

  const missing = new Set(Object.keys(index.photos).filter((id) => !seen.has(id)));
  for (const file of unmatched) {
    // A file moved by hand keeps its name and size; keep its stars and albums.
    const movedId = [...missing].find((id) => {
      const record = index.photos[id];
      return path.posix.basename(record.path) === file.name && record.size === file.stats.size;
    });
    if (movedId) {
      index.photos[movedId].path = file.relative;
      missing.delete(movedId);
      continue;
    }
    const legacy = index.legacy?.[file.relative] ?? {};
    const id = randomUUID();
    index.photos[id] = {
      path: file.relative,
      createdAt: legacy.createdAt ?? birthDate(file.stats),
      prompt: legacy.prompt,
      model: legacy.model,
      size: file.stats.size,
      mtimeMs: file.stats.mtimeMs,
      ...await imageSize(path.join(getGalleryRoot(), file.relative)),
    };
    // Photos dropped into an album's folder join that album.
    for (const album of index.albums) if (file.folder && album.folder === file.folder) album.photoIds.push(id);
  }

  for (const id of missing) {
    await removeOriginal(index.photos[id]);
    delete index.photos[id];
  }
  for (const album of index.albums) album.photoIds = [...new Set(album.photoIds.filter((id) => index.photos[id]))];
  delete index.legacy;
}

let queue: Promise<unknown> = Promise.resolve();

/** Run one gallery change at a time against a freshly reconciled index. */
function withGallery<T>(change: (index: GalleryIndex) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const index = await loadIndex();
    const before = JSON.stringify(index);
    await reconcile(index);
    const result = await change(index);
    if (JSON.stringify(index) !== before) await saveIndex(index);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

function toContents(index: GalleryIndex): GalleryContents {
  const albumIdsByPhoto = new Map<string, string[]>();
  for (const album of index.albums) {
    for (const id of album.photoIds) albumIdsByPhoto.set(id, [...(albumIdsByPhoto.get(id) ?? []), album.id]);
  }
  const photos: GalleryPhoto[] = Object.entries(index.photos).map(([id, record]) => ({
    id,
    path: record.path,
    name: path.posix.basename(record.path),
    folder: folderOf(record.path),
    albumIds: albumIdsByPhoto.get(id) ?? [],
    createdAt: record.createdAt,
    updatedAt: new Date(record.mtimeMs).toISOString(),
    size: record.size,
    width: record.width,
    height: record.height,
    prompt: record.prompt,
    model: record.model,
    starred: record.starred === true,
    edited: Boolean(record.original),
  }));
  const albums: GalleryAlbum[] = index.albums.map((album) => {
    const cover = album.photoIds
      .map((id) => ({ id, record: index.photos[id] }))
      .sort((first, second) => second.record.createdAt.localeCompare(first.record.createdAt))[0];
    return { id: album.id, name: album.name, folder: album.folder, count: album.photoIds.length, coverId: cover?.id, createdAt: album.createdAt };
  });
  albums.sort((first, second) => first.name.localeCompare(second.name, undefined, { sensitivity: "base", numeric: true }));
  return { root: getGalleryRoot(), albums, photos };
}

function findAlbum(index: GalleryIndex, id: string) {
  const album = index.albums.find((entry) => entry.id === id);
  if (!album) throw new StorageError("That album was not found.", 404);
  return album;
}

function findPhoto(index: GalleryIndex, id: string) {
  const record = index.photos[id];
  if (!record) throw new StorageError("That photo was not found.", 404);
  return record;
}

function assertUniqueAlbumName(index: GalleryIndex, name: string, exceptId?: string) {
  if (index.albums.some((album) => album.id !== exceptId && album.name.toLowerCase() === name.toLowerCase())) {
    throw new StorageError(`An album named “${name}” already exists.`, 409);
  }
}

/** A folder name on disk for an album; a leftover folder with the same name is left alone. */
async function freeFolderName(name: string) {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name} ${attempt}`;
    if (!(await pathExists(path.join(getGalleryRoot(), candidate)))) return candidate;
  }
  throw new StorageError("Could not find a free folder name for the album.", 409);
}

async function moveRecordInto(record: PhotoRecord, folder: string) {
  if (folderOf(record.path) === folder) return;
  const destination = await findAvailableFilePath(path.join(getGalleryRoot(), folder), path.posix.basename(record.path));
  await movePath(absolutePath(record.path), destination.path);
  record.path = folder ? `${folder}/${destination.name}` : destination.name;
}

export function getGallery() {
  return withGallery(toContents);
}

/** Create an album; its photos are moved into a new folder named after it. */
export async function createAlbum(name: string, photoIds: string[] = []) {
  const albumName = assertSafeUserSegment(name, "Album name");
  return withGallery(async (index) => {
    assertUniqueAlbumName(index, albumName);
    const folder = await freeFolderName(albumName);
    await mkdir(path.join(getGalleryRoot(), folder));
    index.folders.push(folder);
    const album: AlbumRecord = { id: randomUUID(), name: albumName, folder, createdAt: new Date().toISOString(), photoIds: [] };
    index.albums.push(album);
    for (const id of new Set(photoIds)) {
      const record = index.photos[id];
      if (!record) continue;
      await moveRecordInto(record, folder);
      album.photoIds.push(id);
    }
    return { album, gallery: toContents(index) };
  });
}

/** Rename an album, and its folder too when that name is free on disk. */
export async function renameAlbum(id: string, name: string) {
  const albumName = assertSafeUserSegment(name, "Album name");
  return withGallery(async (index) => {
    const album = findAlbum(index, id);
    assertUniqueAlbumName(index, albumName, id);
    album.name = albumName;
    const current = path.join(getGalleryRoot(), album.folder);
    const target = path.join(getGalleryRoot(), albumName);
    const caseOnly = album.folder.toLowerCase() === albumName.toLowerCase();
    if (album.folder !== albumName && await pathExists(current) && (caseOnly || !(await pathExists(target)))) {
      await rename(current, target);
      for (const record of Object.values(index.photos)) {
        if (folderOf(record.path) === album.folder) record.path = `${albumName}/${path.posix.basename(record.path)}`;
      }
      index.folders = [...index.folders.filter((folder) => folder !== album.folder), albumName];
      album.folder = albumName;
    }
    return toContents(index);
  });
}

/** Delete an album. Its photos stay where they are on disk and in the gallery. */
export function deleteAlbum(id: string) {
  return withGallery((index) => {
    findAlbum(index, id);
    index.albums = index.albums.filter((album) => album.id !== id);
    return toContents(index);
  });
}

/** Add photos to or remove them from an existing album; files do not move. */
export function updateAlbumPhotos(id: string, { add = [], remove = [] }: { add?: string[]; remove?: string[] }) {
  return withGallery((index) => {
    const album = findAlbum(index, id);
    const removed = new Set(remove);
    album.photoIds = [...new Set([...album.photoIds.filter((photoId) => !removed.has(photoId)), ...add.filter((photoId) => index.photos[photoId])])];
    return toContents(index);
  });
}

export function setPhotosStarred(ids: string[], starred: boolean) {
  return withGallery((index) => {
    for (const id of ids) if (index.photos[id]) index.photos[id].starred = starred || undefined;
    return toContents(index);
  });
}

async function thumbnailPathFor(relative: string) {
  const stats = await stat(absolutePath(relative));
  const key = createHash("sha1").update(`${relative}\0${stats.size}\0${stats.mtimeMs}`).digest("hex");
  return path.join(getGalleryRoot(), THUMBNAILS_DIR, `${key}.webp`);
}

export function deletePhotos(ids: string[]) {
  return withGallery(async (index) => {
    let deleted = 0;
    for (const id of new Set(ids)) {
      const record = index.photos[id];
      if (!record) continue;
      const thumbnail = await thumbnailPathFor(record.path).catch(() => null);
      await rm(absolutePath(record.path), { force: true });
      if (thumbnail) await rm(thumbnail, { force: true });
      await removeOriginal(record);
      delete index.photos[id];
      deleted += 1;
    }
    for (const album of index.albums) album.photoIds = album.photoIds.filter((id) => index.photos[id]);
    return { deleted, gallery: toContents(index) };
  });
}

/** Save a generated image, into an album's folder when one is given. */
export async function writeGalleryPhoto(albumRef: string, fileName: string, body: Buffer, details: PhotoDetails) {
  const safeName = assertSafeUserSegment(fileName, "Photo name");
  return withGallery(async (index) => {
    const reference = albumRef.trim().toLowerCase();
    // Settings from the first version named the album instead of using its id.
    const album = reference ? index.albums.find((entry) => entry.id === albumRef || entry.name.toLowerCase() === reference) : undefined;
    const folder = album?.folder ?? "";
    await mkdir(path.join(getGalleryRoot(), folder), { recursive: true });
    if (folder && !index.folders.includes(folder)) index.folders.push(folder);
    const destination = await findAvailableFilePath(path.join(getGalleryRoot(), folder), safeName);
    await writeFile(destination.path, body, { flag: "wx" });
    const stats = await stat(destination.path);
    const id = randomUUID();
    index.photos[id] = {
      path: folder ? `${folder}/${destination.name}` : destination.name,
      createdAt: details.createdAt ?? new Date().toISOString(),
      prompt: details.prompt,
      model: details.model,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ...await imageSize(destination.path),
    };
    album?.photoIds.push(id);
    return { id, path: index.photos[id].path };
  });
}

export const MAX_GALLERY_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Whether the bytes are an image of the kind the file name says. */
async function isImageContent(extension: string, body: Buffer) {
  if (extension === ".svg") return /<svg[\s>]/i.test(body.subarray(0, 4096).toString("utf8"));
  try {
    const { format } = await sharp(body, { animated: false }).metadata();
    const expected: Record<string, string[]> = { ".png": ["png"], ".jpg": ["jpeg"], ".jpeg": ["jpeg"], ".webp": ["webp"], ".gif": ["gif"] };
    return Boolean(format && expected[extension]?.includes(format));
  } catch {
    return false;
  }
}

/**
 * Add a photo from the user's computer, into an album's folder when an album
 * id is given. Name clashes get a numbered name; nothing is overwritten.
 */
export async function importGalleryPhoto(albumId: string, fileName: string, body: Buffer) {
  const name = path.basename(fileName.replaceAll("\\", "/")).trim();
  const extension = path.extname(name).toLowerCase();
  if (!isGalleryImage(name)) throw new StorageError("Only PNG, JPEG, WebP, GIF and SVG images can be added to the gallery.", 415);
  if (!body.length) throw new StorageError("The file is empty.", 400);
  if (body.length > MAX_GALLERY_UPLOAD_BYTES) throw new StorageError("Photos must be 50 MB or smaller.", 413);
  if (!(await isImageContent(extension, body))) throw new StorageError("The file is not a valid image.", 415);
  if (albumId && !(await withGallery(async (index) => index.albums.some((album) => album.id === albumId)))) {
    throw new StorageError("The album no longer exists.", 404);
  }
  return writeGalleryPhoto(albumId, name, body, {});
}

function editedFormat(relative: string): { format: EditedPhotoFormat; extension: string } {
  const extension = path.extname(relative).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return { format: "jpeg", extension };
  if (extension === ".webp") return { format: "webp", extension };
  // GIF frames cannot be kept through an edit, so the result is a PNG.
  return { format: "png", extension: ".png" };
}

function withExtension(relative: string, extension: string) {
  return relative.slice(0, relative.length - path.extname(relative).length) + extension;
}

/**
 * Apply edits. "replace" keeps a backup of the first original so the photo
 * can be reverted; "copy" saves a new photo beside it in the same albums.
 */
export function editPhoto(id: string, edits: PhotoEdits, mode: "replace" | "copy") {
  return withGallery(async (index) => {
    const record = findPhoto(index, id);
    if (path.extname(record.path).toLowerCase() === ".svg") throw new StorageError("Vector images cannot be edited here.");
    if (!hasEdits(edits)) throw new StorageError("There are no changes to save.");
    const { format, extension } = editedFormat(record.path);
    const body = await renderEditedPhoto(absolutePath(record.path), edits, format);

    if (mode === "copy") {
      const folder = folderOf(record.path);
      const stem = path.posix.basename(record.path, path.extname(record.path));
      const destination = await findAvailableFilePath(path.join(getGalleryRoot(), folder), `${stem} (edited)${extension}`);
      await writeFile(destination.path, body, { flag: "wx" });
      const stats = await stat(destination.path);
      const copyId = randomUUID();
      // Keep the original's date (plus a moment) so the copy sorts beside it.
      index.photos[copyId] = {
        path: folder ? `${folder}/${destination.name}` : destination.name,
        createdAt: new Date(new Date(record.createdAt).getTime() + 1).toISOString(),
        prompt: record.prompt,
        model: record.model,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ...await imageSize(destination.path),
      };
      for (const album of index.albums) if (album.photoIds.includes(id)) album.photoIds.push(copyId);
      return { id: copyId, gallery: toContents(index) };
    }

    const current = absolutePath(record.path);
    if (!record.original) {
      const backupName = `${id}${path.extname(record.path).toLowerCase()}`;
      await mkdir(path.join(getGalleryRoot(), ORIGINALS_DIR), { recursive: true });
      await copyFile(current, path.join(getGalleryRoot(), ORIGINALS_DIR, backupName));
      record.original = backupName;
    }
    const nextRelative = withExtension(record.path, extension);
    const temporary = `${absolutePath(nextRelative)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body);
      await rename(temporary, absolutePath(nextRelative));
    } finally {
      await rm(temporary, { force: true });
    }
    if (nextRelative !== record.path) await rm(current, { force: true });
    const stats = await stat(absolutePath(nextRelative));
    Object.assign(record, { path: nextRelative, size: stats.size, mtimeMs: stats.mtimeMs }, await imageSize(absolutePath(nextRelative)));
    return { id, gallery: toContents(index) };
  });
}

/** Put back the photo as it was before its first edit. */
export function revertPhoto(id: string) {
  return withGallery(async (index) => {
    const record = findPhoto(index, id);
    if (!record.original) throw new StorageError("This photo has no earlier version.");
    const backup = path.join(getGalleryRoot(), ORIGINALS_DIR, record.original);
    const restored = withExtension(record.path, path.extname(record.original));
    await copyFile(backup, absolutePath(restored));
    if (restored !== record.path) await rm(absolutePath(record.path), { force: true });
    await rm(backup, { force: true });
    const stats = await stat(absolutePath(restored));
    Object.assign(record, { path: restored, original: undefined, size: stats.size, mtimeMs: stats.mtimeMs }, await imageSize(absolutePath(restored)));
    return toContents(index);
  });
}

export async function readGalleryPhoto(photoPath: string) {
  const photo = resolvePhotoPath(photoPath);
  return {
    name: photo.name,
    body: await readFile(photo.absolute),
    contentType: CONTENT_TYPES[path.extname(photo.name).toLowerCase()] ?? "application/octet-stream",
  };
}

/** Thumbnails are cached by the file's identity on disk, so edits made anywhere show up. */
export async function readGalleryThumbnail(photoPath: string) {
  const photo = resolvePhotoPath(photoPath);
  // Vector images are already small and scale cleanly.
  if (path.extname(photo.name).toLowerCase() === ".svg") return readGalleryPhoto(photoPath);
  const target = await thumbnailPathFor(photo.relative);
  try {
    return { name: photo.name, body: await readFile(target), contentType: "image/webp" };
  } catch {
    const body = await sharp(photo.absolute, { animated: false })
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body).catch(() => undefined);
    return { name: photo.name, body, contentType: "image/webp" };
  }
}
