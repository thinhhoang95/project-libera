import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { watch, type FSWatcher, type Stats } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { ArchiveContents, GalleryAlbum, GalleryContents, GalleryPhoto } from "@/lib/image-generation";
import { galleryImageSize } from "@/lib/image-generation";
import { hasEdits, type PhotoEdits } from "@/lib/photo-edits";
import { editedPhotoFormat, renderEditedPhoto } from "@/lib/photo-edits-server";
import { StorageError } from "@/lib/storage/errors";
import { fetchSharedOriginal, inviteToProject, shareAlbum as shareAlbumOnHost, updateSharedAlbum } from "@/lib/collab/host-client";
import type { InviteRequest } from "@/lib/collab/local-api";
import { albumImageType } from "@/lib/collab/protocol/schema";
import { assertCanChangeFolder, assertNotSharedFolder, forgetHostAlbums, sharedAlbumMarker, sharedFolder, sharingError } from "@/lib/storage/gallery-sharing";
import { findAvailableFilePath, moveFileIfExists, movePath, pathExists } from "@/lib/storage/fs-utils";
import { assertSafeUserSegment, getDataRoot } from "@/lib/storage/paths";
import { notifySearchChanges } from "@/lib/storage/search-updates";
import { pruneGalleryChatPhotos } from "@/lib/storage/document-chat";
import {
  copyPhotoInk,
  deletePhotoInk,
  movePhotoInk,
  photoEditedInPlace,
  photoReverted,
  readPhotoInk,
  renderPhotoWithInk,
  resolveChangedPhotoInk,
  writePhotoInk,
  type PhotoLocation,
} from "@/lib/storage/gallery-ink";

// libvips can keep source files open after metadata/thumbnail reads. Windows
// then rejects deletes, moves and replacements of those photos with EBUSY.
// Keep the memory/operation caches, but release file handles after each read.
if (process.platform === "win32") sharp.cache({ files: 0 });

/**
 * The gallery is a plain folder of images, one level deep. A hidden index
 * (the "shadow" structure) is the source of truth for albums, stars and
 * prompts, and gives every photo an id that survives moves.
 *
 * Files move on disk only when a new album is created: its photos are moved
 * into a folder named after it. Adding photos to an existing album, removing
 * them, or deleting the album only changes the index, so photos are never
 * lost and a photo can belong to several albums.
 *
 * Photos sent to the Protected Archive move into a hidden folder, which the
 * scan skips, so they leave every view, album and picker. Their thumbnails and
 * unedited originals go with them, and each remembers its folder and albums so
 * it can be put back where it was.
 */
const GALLERY_DIR = "gallery";
const INDEX_FILE = ".libera-gallery.json";
const THUMBNAILS_DIR = ".thumbnails";
const ORIGINALS_DIR = ".originals";
const PROTECTED_DIR = ".protected";
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

/** A photo in the Protected Archive; `path` is its file name in the archive folder. */
type ArchivedRecord = PhotoRecord & {
  archivedAt: string;
  /** Where the photo was, so restoring puts it back. */
  folder: string;
  albumIds: string[];
};

type GalleryIndex = {
  version: typeof INDEX_VERSION;
  photos: Record<string, PhotoRecord>;
  albums: AlbumRecord[];
  /** Folders already seen, so a deleted album's folder is not turned back into an album. */
  folders: string[];
  /** Photos in the Protected Archive, keyed by the id they had in the gallery. */
  archive: Record<string, ArchivedRecord>;
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

function protectedRoot() {
  return path.join(getGalleryRoot(), PROTECTED_DIR);
}

/** Where a photo's ink is kept (gallery-ink.ts): beside the gallery, or the Protected Archive. */
const inkInGallery = (id: string): PhotoLocation => ({ root: getGalleryRoot(), id });
const inkInArchive = (id: string): PhotoLocation => ({ root: protectedRoot(), id });

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
  return { version: INDEX_VERSION, photos: {}, albums: [], folders: [], archive: {} };
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
      archive: (parsed.archive && typeof parsed.archive === "object" ? parsed.archive : {}) as GalleryIndex["archive"],
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
    await deletePhotoInk(inkInGallery(id));
    delete index.photos[id];
  }
  for (const album of index.albums) album.photoIds = [...new Set(album.photoIds.filter((id) => index.photos[id]))];
  delete index.legacy;
}

let queue: Promise<unknown> = Promise.resolve();
let galleryWatcher: FSWatcher | null = null;
let watchedRoot = "";
let galleryDirty = true;

function watchGallery() {
  const root = getGalleryRoot();
  if (watchedRoot === root && galleryWatcher) return;
  galleryWatcher?.close();
  watchedRoot = root;
  galleryDirty = true;
  try {
    galleryWatcher = watch(root, { recursive: true }, (_event, name) => {
      const parts = String(name ?? "").replaceAll("\\", "/").split("/");
      if (parts.some((part) => part.startsWith(".") && part !== PROTECTED_DIR)) return;
      galleryDirty = true;
    });
    galleryWatcher.on("error", () => { galleryDirty = true; galleryWatcher?.close(); galleryWatcher = null; });
    galleryWatcher.unref();
  } catch { galleryWatcher = null; }
}
const thumbnailReads = new Set<Promise<unknown>>();
// Snapshots share this transient array so cleanup can append notices before returning.
const deletionNotices = new WeakMap<GalleryIndex, string[]>();

function queuedThumbnail<T>(read: () => Promise<T>): Promise<T> {
  // Readers can run together. Mutations wait for earlier readers, and new
  // readers wait for mutations, so a late render cannot recreate a swept file.
  const task = queue.then(read);
  thumbnailReads.add(task);
  void task.finally(() => thumbnailReads.delete(task)).catch(() => undefined);
  return task;
}

function thumbnailName(relative: string, stats: Pick<PhotoRecord, "size" | "mtimeMs">, size = THUMBNAIL_SIZE) {
  const hash = createHash("sha1").update(`${relative}\0${stats.size}\0${stats.mtimeMs}`).digest("hex");
  return `${hash}${size === THUMBNAIL_SIZE ? "" : `-${size}`}.webp`;
}

/** Cached previews are disposable; sweep old versions and pre-existing orphaned files. */
async function pruneThumbnails(records: Record<string, PhotoRecord>, root: string) {
  const directory = path.join(root, THUMBNAILS_DIR);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const current = new Set(Object.values(records).map((record) => thumbnailName(record.path, record)));
  await Promise.all(entries.filter((entry) => entry.isFile() && /^[a-f0-9]{40}(?:-(?:160|320|1280|2048))?\.webp$/.test(entry.name) && !current.has(entry.name.replace(/-(160|320|1280|2048)(?=\.webp$)/, "")))
    .map((entry) => rm(path.join(directory, entry.name), { force: true })));
}

/** Run one gallery change at a time against a freshly reconciled index. */
function withGallery<T>(change: (index: GalleryIndex) => Promise<T> | T, forceScan = false): Promise<T> {
  const reads = [...thumbnailReads];
  const next = queue.then(() => Promise.allSettled(reads)).then(async () => {
    const index = await loadIndex();
    watchGallery();
    const notices: string[] = [];
    deletionNotices.set(index, notices);
    const idsBefore = [...Object.keys(index.photos), ...Object.keys(index.archive)];
    const before = JSON.stringify(index);
    const searchablePhotos = () => JSON.stringify(Object.entries(index.photos).map(([id, photo]) =>
      [id, photo.path, photo.size, photo.mtimeMs, photo.prompt]));
    const photosBefore = searchablePhotos();
    if (forceScan || galleryDirty || !galleryWatcher) {
      galleryDirty = false;
      try { await reconcile(index); await reconcileArchive(index); }
      catch (error) { galleryDirty = true; throw error; }
    }
    const result = await change(index);
    await pruneThumbnails(index.photos, getGalleryRoot());
    await pruneThumbnails(index.archive, protectedRoot());
    if (JSON.stringify(index) !== before) await saveIndex(index);
    const remaining = new Set([...Object.keys(index.photos), ...Object.keys(index.archive)]);
    notices.push(...new Set([...idsBefore.filter((id) => !remaining.has(id)), ...await pruneGalleryChatPhotos(remaining)]));
    if (searchablePhotos() !== photosBefore) notifySearchChanges(undefined, true);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

function toPhoto(id: string, record: PhotoRecord, albumIds: string[]): GalleryPhoto {
  return {
    id,
    path: record.path,
    name: path.posix.basename(record.path),
    folder: folderOf(record.path),
    albumIds,
    createdAt: record.createdAt,
    updatedAt: new Date(record.mtimeMs).toISOString(),
    size: record.size,
    width: record.width,
    height: record.height,
    prompt: record.prompt,
    model: record.model,
    starred: record.starred === true,
    edited: Boolean(record.original),
  };
}

function toContents(index: GalleryIndex): GalleryContents {
  const albumIdsByPhoto = new Map<string, string[]>();
  for (const album of index.albums) {
    for (const id of album.photoIds) albumIdsByPhoto.set(id, [...(albumIdsByPhoto.get(id) ?? []), album.id]);
  }
  const photos = Object.entries(index.photos).map(([id, record]) => toPhoto(id, record, albumIdsByPhoto.get(id) ?? []));
  const albums: GalleryAlbum[] = index.albums.map((album) => {
    const cover = album.photoIds
      .map((id) => ({ id, record: index.photos[id] }))
      .sort((first, second) => second.record.createdAt.localeCompare(first.record.createdAt))[0];
    return { id: album.id, name: album.name, folder: album.folder, count: album.photoIds.length, coverId: cover?.id, createdAt: album.createdAt };
  });
  albums.sort((first, second) => first.name.localeCompare(second.name, undefined, { sensitivity: "base", numeric: true }));
  return { root: getGalleryRoot(), albums, photos, deletedPhotoIds: deletionNotices.get(index) };
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

/** Whether a photo's file sits in a shared album's folder. */
function inSharedFolder(record: PhotoRecord) {
  const folder = folderOf(record.path);
  return Boolean(folder) && sharedAlbumMarker(getGalleryRoot(), folder) !== null;
}

/** A copy of a photo in `folder` ("" for the top level), with its own id; returns the id. */
async function copyRecordInto(index: GalleryIndex, id: string, folder: string, name?: string) {
  const record = index.photos[id];
  const destination = await findAvailableFilePath(path.join(getGalleryRoot(), folder), name ?? path.posix.basename(record.path));
  await copyFile(absolutePath(record.path), destination.path);
  const stats = await stat(destination.path);
  const copyId = randomUUID();
  index.photos[copyId] = {
    path: folder ? `${folder}/${destination.name}` : destination.name,
    createdAt: record.createdAt,
    prompt: record.prompt,
    model: record.model,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    width: record.width,
    height: record.height,
  };
  await copyPhotoInk(inkInGallery(id), inkInGallery(copyId), destination.path, null);
  return copyId;
}

/**
 * Puts a photo in a shared album's `folder`: moved, unless that would take it
 * out of another shared album or another album, in which case it is copied
 * (members may remove or edit it). Returns the id of the photo now there.
 */
async function placeRecordIn(index: GalleryIndex, id: string, folder: string, { exceptAlbumId }: { exceptAlbumId?: string } = {}) {
  const record = index.photos[id];
  if (folderOf(record.path) === folder) return id;
  const otherAlbums = index.albums.some((album) => album.id !== exceptAlbumId && album.photoIds.includes(id));
  if (inSharedFolder(record) || otherAlbums) return copyRecordInto(index, id, folder);
  await moveRecordInto(record, folder);
  return id;
}

export function getGallery({ incremental = false } = {}) {
  return withGallery(toContents, !incremental);
}

/** A detail read shares mutation ordering but never rescans every photo. */
export function getGalleryPhotoDetails(id: string) {
  const next = queue.then(async () => {
    const index = await loadIndex();
    const record = findPhoto(index, id);
    const photo = toPhoto(id, record, index.albums.filter((album) => album.photoIds.includes(id)).map((album) => album.id));
    return { root: getGalleryRoot(), photos: [photo], albums: toContents({ ...index, photos: { [id]: record }, albums: index.albums.map((album) => ({ ...album, photoIds: album.photoIds.filter((photoId) => photoId === id) })) }).albums };
  });
  queue = next.catch(() => undefined);
  return next;
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
      if (!index.photos[id]) continue;
      // A photo in a shared album stays there; the new album gets a copy.
      album.photoIds.push(inSharedFolder(index.photos[id]) ? await copyRecordInto(index, id, folder) : (await moveRecordInto(index.photos[id], folder), id));
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
    const shared = await sharedFolder(getGalleryRoot(), album.folder);
    if (shared) {
      // The folder is the host's; only the name everyone sees changes.
      if (shared.role !== "owner") throw new StorageError("Only the album's owner can rename it.", 403);
      await updateSharedAlbum(shared.projectId, { name: albumName }).catch((error: unknown) => { throw sharingError(error); });
      forgetHostAlbums();
      album.name = albumName;
      return toContents(index);
    }
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
    const album = findAlbum(index, id);
    if (sharedAlbumMarker(getGalleryRoot(), album.folder)) {
      throw new StorageError("This album is shared. Stop sharing it, or leave it, before deleting it.", 409);
    }
    index.albums = index.albums.filter((entry) => entry.id !== id);
    return toContents(index);
  });
}

/**
 * Add photos to or remove them from an existing album; files do not move.
 * A shared album's photos are the files in its folder: added photos are
 * copied in, and removed ones move out to the top of the gallery, so they
 * stay in this gallery while leaving the album for everyone.
 */
export function updateAlbumPhotos(id: string, { add = [], remove = [] }: { add?: string[]; remove?: string[] }) {
  return withGallery(async (index) => {
    const album = findAlbum(index, id);
    if (await assertCanChangeFolder(getGalleryRoot(), album.folder)) {
      const added: string[] = [];
      for (const photoId of new Set(add)) {
        if (!index.photos[photoId] || album.photoIds.includes(photoId)) continue;
        added.push(await placeRecordIn(index, photoId, album.folder, { exceptAlbumId: album.id }));
      }
      for (const photoId of new Set(remove)) {
        const record = index.photos[photoId];
        if (record && folderOf(record.path) === album.folder) await moveRecordInto(record, "");
      }
      const removed = new Set(remove);
      album.photoIds = [...new Set([...album.photoIds.filter((photoId) => !removed.has(photoId)), ...added])];
      return toContents(index);
    }
    const removed = new Set(remove);
    const added: string[] = [];
    for (const photoId of new Set(add)) {
      const record = index.photos[photoId];
      if (!record || album.photoIds.includes(photoId)) continue;
      // A local album must own a copy that survives shared deletion or revocation.
      if (inSharedFolder(record)) {
        await mkdir(path.join(getGalleryRoot(), album.folder), { recursive: true });
        added.push(await copyRecordInto(index, photoId, album.folder));
      } else added.push(photoId);
    }
    album.photoIds = [...new Set([...album.photoIds.filter((photoId) => !removed.has(photoId)), ...added])];
    return toContents(index);
  });
}

export function setPhotosStarred(ids: string[], starred: boolean) {
  return withGallery((index) => {
    for (const id of ids) if (index.photos[id]) index.photos[id].starred = starred || undefined;
    return toContents(index);
  });
}

/** Thumbnails are keyed by the file's identity, inside `root` (the gallery or the archive). */
async function thumbnailPathFor(relative: string, root = getGalleryRoot(), size = THUMBNAIL_SIZE) {
  const stats = await stat(path.join(root, ...relative.split("/")));
  return path.join(root, THUMBNAILS_DIR, thumbnailName(relative, stats, size));
}

export function deletePhotos(ids: string[]) {
  return withGallery(async (index) => {
    let deleted = 0;
    const unique = [...new Set(ids)];
    // A shared album's photo is deleted for everyone: check every role first.
    for (const folder of new Set(unique.map((id) => index.photos[id]).filter(Boolean).map((record) => folderOf(record.path)))) {
      if (folder) await assertCanChangeFolder(getGalleryRoot(), folder);
    }
    for (const id of unique) {
      const record = index.photos[id];
      if (!record) continue;
      await rm(absolutePath(record.path), { force: true });
      await removeOriginal(record);
      await deletePhotoInk(inkInGallery(id));
      delete index.photos[id];
      deleted += 1;
    }
    for (const album of index.albums) album.photoIds = album.photoIds.filter((id) => index.photos[id]);
    return { deleted, gallery: toContents(index) };
  });
}

function toArchiveContents(index: GalleryIndex): ArchiveContents {
  const albumIds = new Set(index.albums.map((album) => album.id));
  const photos = Object.entries(index.archive).map(([id, record]) => ({
    ...toPhoto(id, record, record.albumIds.filter((albumId) => albumIds.has(albumId))),
    path: `${PROTECTED_DIR}/${record.path}`,
    name: record.path,
    // The folder it returns to when restored.
    folder: record.folder,
    archivedAt: record.archivedAt,
  }));
  return { photos, deletedPhotoIds: deletionNotices.get(index) };
}

/** Move an unedited original between the gallery's and the archive's backup folders. */
async function moveOriginal(name: string, fromRoot: string, toRoot: string) {
  const source = path.join(fromRoot, ORIGINALS_DIR, name);
  if (!(await pathExists(source))) return undefined;
  await mkdir(path.join(toRoot, ORIGINALS_DIR), { recursive: true });
  await moveFileIfExists(source, path.join(toRoot, ORIGINALS_DIR, name));
  return name;
}

/** Drop archive entries whose files were removed by hand, and notice files changed by hand. */
async function reconcileArchive(index: GalleryIndex) {
  for (const [id, record] of Object.entries(index.archive)) {
    const stats = await stat(path.join(protectedRoot(), record.path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stats?.isFile()) {
      if (record.original) await rm(path.join(protectedRoot(), ORIGINALS_DIR, record.original), { force: true });
      await deletePhotoInk(inkInArchive(id));
      delete index.archive[id];
    } else if (record.mtimeMs !== stats.mtimeMs || record.size !== stats.size) {
      Object.assign(record, { mtimeMs: stats.mtimeMs, size: stats.size }, await imageSize(path.join(protectedRoot(), record.path)));
    }
  }
}

/**
 * Send photos to the Protected Archive. They leave the gallery, its albums and
 * its thumbnail cache, and are only listed again once the archive is unlocked.
 */
export function archivePhotos(ids: string[]) {
  return withGallery(async (index) => {
    let archived = 0;
    for (const id of new Set(ids)) {
      const record = index.photos[id];
      if (record && folderOf(record.path)) assertNotSharedFolder(getGalleryRoot(), folderOf(record.path), "archive");
    }
    for (const id of new Set(ids)) {
      const record = index.photos[id];
      if (!record) continue;
      await mkdir(protectedRoot(), { recursive: true });
      const destination = await findAvailableFilePath(protectedRoot(), path.posix.basename(record.path));
      await movePath(absolutePath(record.path), destination.path);
      const original = record.original ? await moveOriginal(record.original, getGalleryRoot(), protectedRoot()) : undefined;
      await movePhotoInk(inkInGallery(id), inkInArchive(id));
      index.archive[id] = {
        ...record,
        path: destination.name,
        original,
        archivedAt: new Date().toISOString(),
        folder: folderOf(record.path),
        albumIds: index.albums.filter((album) => album.photoIds.includes(id)).map((album) => album.id),
      };
      delete index.photos[id];
      archived += 1;
    }
    for (const album of index.albums) album.photoIds = album.photoIds.filter((id) => index.photos[id]);
    return { archived, gallery: toContents(index) };
  });
}

export function getArchive() {
  return withGallery(toArchiveContents, true);
}

/** Put archived photos back in the folder and albums they came from, where those still exist. */
export function restoreArchivedPhotos(ids: string[]) {
  return withGallery(async (index) => {
    let restored = 0;
    for (const id of new Set(ids)) {
      const record = index.archive[id];
      if (!record) continue;
      const folder = record.folder && isVisibleEntry(record.folder) && await pathExists(path.join(getGalleryRoot(), record.folder)) ? record.folder : "";
      const destination = await findAvailableFilePath(path.join(getGalleryRoot(), folder), record.path);
      await movePath(path.join(protectedRoot(), record.path), destination.path);
      const restoredRecord: PhotoRecord & Partial<ArchivedRecord> = {
        ...record,
        path: folder ? `${folder}/${destination.name}` : destination.name,
        original: record.original ? await moveOriginal(record.original, protectedRoot(), getGalleryRoot()) : undefined,
      };
      await movePhotoInk(inkInArchive(id), inkInGallery(id));
      delete restoredRecord.archivedAt;
      delete restoredRecord.folder;
      delete restoredRecord.albumIds;
      index.photos[id] = restoredRecord;
      for (const album of index.albums) if (record.albumIds.includes(album.id) && !album.photoIds.includes(id)) album.photoIds.push(id);
      delete index.archive[id];
      restored += 1;
    }
    return { restored, gallery: toContents(index), archive: toArchiveContents(index) };
  });
}

/** Delete archived photos from disk for good. */
export function deleteArchivedPhotos(ids: string[]) {
  return withGallery(async (index) => {
    let deleted = 0;
    for (const id of new Set(ids)) {
      const record = index.archive[id];
      if (!record) continue;
      await rm(path.join(protectedRoot(), record.path), { force: true });
      if (record.original) await rm(path.join(protectedRoot(), ORIGINALS_DIR, record.original), { force: true });
      await deletePhotoInk(inkInArchive(id));
      delete index.archive[id];
      deleted += 1;
    }
    return { deleted, archive: toArchiveContents(index) };
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
    // A new photo in a shared album is shared with its members.
    if (folder && await assertCanChangeFolder(getGalleryRoot(), folder) && path.extname(safeName).toLowerCase() === ".svg") {
      throw new StorageError("Shared albums take PNG, JPEG, WebP and GIF photos.", 415);
    }
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
    const { format, extension } = editedPhotoFormat(record.path);
    const shared = await sharedFolder(getGalleryRoot(), folderOf(record.path));
    const canChange = !shared || shared.role === "owner" || shared.role === "editor";
    if (shared && mode === "replace") {
      if (!canChange) throw new StorageError("You can view this shared album but not edit its photos. Save the edits as a copy instead.", 403);
      if (extension !== path.extname(record.path).toLowerCase()) throw new StorageError("Edited GIFs become PNGs; in a shared album, save the edits as a copy instead.", 409);
    }
    const body = await renderEditedPhoto(absolutePath(record.path), edits, format);

    if (mode === "copy") {
      // A member who cannot add photos to the shared album gets the copy in their own gallery.
      const folder = canChange ? folderOf(record.path) : "";
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
      if (canChange) for (const album of index.albums) if (album.photoIds.includes(id)) album.photoIds.push(copyId);
      // The copy keeps the photo's ink, moved with the crop and turns.
      await copyPhotoInk(inkInGallery(id), inkInGallery(copyId), destination.path, edits);
      return { id: copyId, gallery: toContents(index) };
    }

    const current = absolutePath(record.path);
    if (!record.original) {
      const alreadyEdited = shared?.album?.photos.find((photo) => photo.name.toLowerCase() === path.posix.basename(record.path).toLowerCase())?.edited;
      // Another member's edit already has its original on the host. Do not
      // save the intermediate version as an "original", or require a download to edit offline.
      if (!alreadyEdited) {
        const backupName = `${id}${path.extname(record.path).toLowerCase()}`;
        await mkdir(path.join(getGalleryRoot(), ORIGINALS_DIR), { recursive: true });
        await copyFile(current, path.join(getGalleryRoot(), ORIGINALS_DIR, backupName));
        record.original = backupName;
      }
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
    // Ink stays a layer: its view takes the edit's turns and crop (gallery-ink.ts).
    await photoEditedInPlace(inkInGallery(id), absolutePath(nextRelative), edits);
    // The album's members see what was done (the watcher shares the edited file).
    if (shared) {
      void updateSharedAlbum(shared.projectId, { photos: [{ name: path.posix.basename(nextRelative), edits: edits as unknown as Record<string, unknown> }] })
        .then(forgetHostAlbums, () => undefined);
    }
    return { id, gallery: toContents(index) };
  });
}

/** Put back the photo as it was before its first edit. */
export function revertPhoto(id: string) {
  return withGallery(async (index) => {
    const record = findPhoto(index, id);
    const shared = await assertCanChangeFolder(getGalleryRoot(), folderOf(record.path));
    const previousOriginal = record.original;
    let original = previousOriginal;
    const albumPhoto = shared?.album?.photos.find((photo) => photo.name.toLowerCase() === path.posix.basename(record.path).toLowerCase());
    if (shared && albumPhoto?.edited) {
      // The album's original is authoritative, including for backups made by older clients.
      const local = original && albumPhoto.originalHash ? await readFile(path.join(getGalleryRoot(), ORIGINALS_DIR, original)).catch(() => null) : null;
      if (!local || createHash("sha256").update(local).digest("hex") !== albumPhoto.originalHash) {
        const fetched = await fetchSharedOriginal(shared.projectId, path.posix.basename(record.path)).catch((error: unknown) => { throw sharingError(error); });
        original = fetched.original;
      }
    }
    if (!original) throw new StorageError("This photo has no earlier version.");
    const backup = path.join(getGalleryRoot(), ORIGINALS_DIR, original);
    const restored = withExtension(record.path, path.extname(original));
    await copyFile(backup, absolutePath(restored));
    if (restored !== record.path) await rm(absolutePath(record.path), { force: true });
    await rm(backup, { force: true });
    if (previousOriginal && previousOriginal !== original) await removeOriginal(record);
    const stats = await stat(absolutePath(restored));
    Object.assign(record, { path: restored, original: undefined, size: stats.size, mtimeMs: stats.mtimeMs }, await imageSize(absolutePath(restored)));
    await photoReverted(inkInGallery(id), absolutePath(restored));
    return toContents(index);
  });
}

type PhotoFile = { name: string; relative: string; absolute: string };

async function readPhotoFile(photo: PhotoFile) {
  return {
    name: photo.name,
    body: await readFile(photo.absolute),
    contentType: CONTENT_TYPES[path.extname(photo.name).toLowerCase()] ?? "application/octet-stream",
  };
}

const renderingThumbnails = new Map<string, Promise<{ name: string; body: Buffer; contentType: string }>>();
let activeThumbnailRenders = 0;
const thumbnailRenderWaiters: Array<() => void> = [];

async function renderThumbnail(photo: PhotoFile, target: string, size: number) {
  if (activeThumbnailRenders >= 2) await new Promise<void>((resolve) => thumbnailRenderWaiters.push(resolve));
  else activeThumbnailRenders++;
  try {
    const body = await sharp(photo.absolute, { animated: false }).rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body).catch(() => undefined);
    return { name: photo.name, body, contentType: "image/webp" };
  } finally {
    const next = thumbnailRenderWaiters.shift();
    if (next) next(); else activeThumbnailRenders--;
  }
}

async function readThumbnail(photo: PhotoFile, root: string, size = THUMBNAIL_SIZE) {
  // Vector images are already small and scale cleanly.
  if (path.extname(photo.name).toLowerCase() === ".svg") return readPhotoFile(photo);
  const target = await thumbnailPathFor(photo.relative, root, size);
  try {
    return { name: photo.name, body: await readFile(target), contentType: "image/webp" };
  } catch {
    const pending = renderingThumbnails.get(target);
    if (pending) return pending;
    const task = renderThumbnail(photo, target, size).finally(() => renderingThumbnails.delete(target));
    renderingThumbnails.set(target, task);
    return task;
  }
}

export async function readGalleryPhoto(photoPath: string) {
  return readPhotoFile(resolvePhotoPath(photoPath));
}

/** Thumbnails are cached by the file's identity on disk, so edits made anywhere show up. */
export async function readGalleryThumbnail(photoPath: string, requestedSize = THUMBNAIL_SIZE) {
  const photo = resolvePhotoPath(photoPath);
  const root = getGalleryRoot();
  return queuedThumbnail(() => readThumbnail(photo, root, galleryImageSize(requestedSize)));
}

/** Validate an archived photo's file name from a request. */
function resolveArchivedPath(name: string): PhotoFile {
  if (typeof name !== "string") throw new StorageError("Photo path is invalid.");
  const safeName = assertSafeUserSegment(name, "Photo name");
  if (!GALLERY_EXTENSIONS.has(path.extname(safeName).toLowerCase())) throw new StorageError("Only images are kept in the gallery.");
  return { name: safeName, relative: safeName, absolute: path.join(protectedRoot(), safeName) };
}

/** Archived photos are read only through the archive's own route, which checks it is unlocked. */
export async function readArchivedPhoto(name: string) {
  return readPhotoFile(resolveArchivedPath(name));
}

/** Archive thumbnails are cached inside the archive folder, never beside the gallery's. */
export async function readArchivedThumbnail(name: string, requestedSize = THUMBNAIL_SIZE) {
  const photo = resolveArchivedPath(name);
  const root = protectedRoot();
  return queuedThumbnail(() => readThumbnail(photo, root, galleryImageSize(requestedSize)));
}

async function streamPhotoFile(photo: PhotoFile, signal?: AbortSignal) {
  // Open before returning the response so missing files remain normal API errors.
  const handle = await open(photo.absolute, "r");
  try {
    const stats = await handle.stat();
    const stream = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true, signal });
    const body = Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } }) as ReadableStream<Uint8Array>;
    return { name: photo.name, body, size: stats.size, contentType: CONTENT_TYPES[path.extname(photo.name).toLowerCase()] ?? "application/octet-stream" };
  } catch (error) { await handle.close(); throw error; }
}

export function streamGalleryPhoto(photoPath: string, signal?: AbortSignal) {
  return streamPhotoFile(resolvePhotoPath(photoPath), signal);
}

export function streamArchivedPhoto(name: string, signal?: AbortSignal) {
  return streamPhotoFile(resolveArchivedPath(name), signal);
}

// ------------------------------------------------------------ sharing (collaboration)

export type ShareOptions = {
  /** Album name members see; defaults to the album's (or the photo's) name. */
  name?: string;
  keepLocation?: boolean;
  sharePrompts?: boolean;
  invitations?: InviteRequest[];
};

/** Hands a prepared folder to the collab host, then sends the invitations. */
async function shareFolder(folder: string, details: Array<{ name: string; prompt?: string; model?: string }>, options: ShareOptions & { name: string; direct?: boolean }) {
  try {
    const result = await shareAlbumOnHost({
      folder,
      name: options.name,
      direct: options.direct === true,
      keepLocation: options.keepLocation === true,
      sharePrompts: options.sharePrompts === true,
      photos: details.map((photo) => (options.sharePrompts ? photo : { name: photo.name })),
    });
    const invited: string[] = [];
    const failed: Array<{ email: string; error: string }> = [];
    for (const invitation of options.invitations ?? []) {
      try {
        await inviteToProject(result.projectId, invitation);
        invited.push(invitation.email);
      } catch (error) {
        failed.push({ email: invitation.email, error: error instanceof Error ? error.message : "The invitation could not be sent." });
      }
    }
    forgetHostAlbums();
    return { ...result, invited, failed };
  } catch (error) {
    throw sharingError(error);
  }
}

/**
 * Share an album. Its photos are gathered into its folder first: moved when
 * they belong to no other album, copied otherwise, so other albums keep
 * theirs. Location details are removed by the host, in the folder, unless
 * the album keeps them.
 */
export async function shareGalleryAlbum(albumId: string, options: ShareOptions = {}) {
  const prepared = await withGallery(async (index) => {
    const album = findAlbum(index, albumId);
    if (sharedAlbumMarker(getGalleryRoot(), album.folder)) throw new StorageError("This album is already shared.", 409);
    await mkdir(path.join(getGalleryRoot(), album.folder), { recursive: true });
    const selected = new Set(album.photoIds);
    // Local membership is independent of disk placement. Photos removed from
    // this album must leave its folder before the host starts watching it.
    for (const [id, record] of Object.entries(index.photos)) {
      if (!selected.has(id) && folderOf(record.path) === album.folder && albumImageType(path.posix.basename(record.path))) {
        await moveRecordInto(record, "");
      }
    }
    const ids: string[] = [];
    for (const id of album.photoIds) {
      if (!index.photos[id]) continue;
      ids.push(await placeRecordIn(index, id, album.folder, { exceptAlbumId: album.id }));
    }
    album.photoIds = ids;
    const details = ids.map((id) => index.photos[id]).map((record) => ({ name: path.posix.basename(record.path), prompt: record.prompt, model: record.model }));
    return { folder: album.folder, name: album.name, details };
  });
  const result = await shareFolder(prepared.folder, prepared.details, { ...options, name: options.name?.trim() || prepared.name });
  return { ...result, gallery: await getGallery() };
}

/** Share one photo on its own: a copy goes into a new album folder only that photo is in. */
export async function shareGalleryPhoto(photoId: string, options: ShareOptions = {}) {
  const prepared = await withGallery(async (index) => {
    const record = findPhoto(index, photoId);
    if (path.extname(record.path).toLowerCase() === ".svg") throw new StorageError("Vector images cannot be shared. Share a PNG, JPEG, WebP or GIF photo.", 415);
    const name = path.posix.basename(record.path, path.extname(record.path));
    const folder = await freeFolderName(assertSafeUserSegment(`${name} (shared)`, "Album name"));
    await mkdir(path.join(getGalleryRoot(), folder));
    index.folders.push(folder);
    const copyId = await copyRecordInto(index, photoId, folder);
    index.albums.push({ id: randomUUID(), name: folder, folder, createdAt: new Date().toISOString(), photoIds: [copyId] });
    const copy = index.photos[copyId];
    return { folder, name, details: [{ name: path.posix.basename(copy.path), prompt: copy.prompt, model: copy.model }] };
  });
  let result;
  try {
    result = await shareFolder(prepared.folder, prepared.details, { ...options, name: options.name?.trim() || prepared.name, direct: true });
  } catch (error) {
    // Nothing was shared: the copy and its folder go again (unless the host already marked the folder).
    await withGallery(async (index) => {
      if (sharedAlbumMarker(getGalleryRoot(), prepared.folder)) return;
      await rm(path.join(getGalleryRoot(), prepared.folder), { recursive: true, force: true });
      index.albums = index.albums.filter((album) => album.folder !== prepared.folder);
    }).catch(() => undefined);
    throw error;
  }
  return { ...result, gallery: await getGallery() };
}

/** Copies photos out of shared albums into this gallery, where they stay whatever happens to the album. */
// ---- Ink (gallery-ink.ts) ------------------------------------------------------
//
// Reads and saves look the photo up in the index without the full gallery
// scan withGallery makes: ink is saved every few seconds while drawing.

/** A gallery photo's file and ink. Archived photos' ink stays behind the archive's lock: not here. */
async function inkTarget(id: string) {
  const index = await loadIndex();
  const record = index.photos[id];
  if (!record) throw new StorageError("Photo not found.", 404);
  return { location: inkInGallery(id), absolute: absolutePath(record.path), edited: Boolean(record.original), record };
}

/** Shares the gallery's queue without a scan, so ink cannot race a move, edit or delete. */
function withGalleryInk<T>(id: string, work: (target: Awaited<ReturnType<typeof inkTarget>>) => Promise<T>): Promise<T> {
  const next = queue.then(async () => work(await inkTarget(id)));
  queue = next.catch(() => undefined);
  return next;
}

export function readGalleryPhotoInk(id: string) {
  return withGalleryInk(id, (target) => readPhotoInk(target.location, target.absolute));
}

export function writeGalleryPhotoInk(id: string, ops: unknown) {
  return withGalleryInk(id, (target) => {
    if (path.extname(target.record.path).toLowerCase() === ".svg") throw new StorageError("Vector images cannot be drawn on here.");
    return writePhotoInk(target.location, target.absolute, target.edited, ops);
  });
}

export function resolveGalleryPhotoInk(id: string, action: "keep" | "discard") {
  return withGalleryInk(id, async (target) => {
    await resolveChangedPhotoInk(target.location, target.absolute, action);
    return readPhotoInk(target.location, target.absolute);
  });
}

/** The photo with its ink drawn on, for saving elsewhere; the photo is not changed. */
export function exportGalleryPhotoWithInk(id: string) {
  return withGalleryInk(id, async (target) => {
    const { format, extension } = editedPhotoFormat(target.record.path);
    const body = await renderPhotoWithInk(target.location, target.absolute, format);
    if (!body) throw new StorageError("This photo has no ink.", 404);
    const stem = path.posix.basename(target.record.path, path.extname(target.record.path));
    return { name: `${stem} (with ink)${extension}`, body, contentType: CONTENT_TYPES[extension] ?? "application/octet-stream" };
  });
}

/**
 * Draws the ink into the photo itself, as an edit: the first original is kept
 * so Revert brings the photo back without it. The ink layer is then cleared.
 */
export function flattenGalleryPhotoInk(id: string) {
  return withGallery(async (index) => {
    const record = findPhoto(index, id);
    if (await sharedFolder(getGalleryRoot(), folderOf(record.path))) throw new StorageError("Ink cannot be drawn into a shared album's photo. Export it with ink instead.", 409);
    const { format, extension } = editedPhotoFormat(record.path);
    const body = await renderPhotoWithInk(inkInGallery(id), absolutePath(record.path), format);
    if (!body) throw new StorageError("This photo has no ink.", 404);
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
    await deletePhotoInk(inkInGallery(id));
    return toContents(index);
  });
}

export function savePhotosToGallery(ids: string[]) {
  return withGallery(async (index) => {
    const saved: string[] = [];
    for (const id of new Set(ids)) {
      const record = index.photos[id];
      if (!record || !inSharedFolder(record)) continue;
      saved.push(await copyRecordInto(index, id, ""));
    }
    return { saved, gallery: toContents(index) };
  });
}
