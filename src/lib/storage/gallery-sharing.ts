// Shared albums, as the gallery sees them (collaboration).
//
// A shared album is a gallery folder that the collab host keeps in sync: its
// photos are the album's photos. The folder's marker says it is shared (read
// here, synchronously, like a shared notebook's); the host knows the rest
// (role, captions, who added what). The gallery index stays the gallery's
// own: stars, prompts and the Protected Archive never leave this device.
//
// Files in a shared folder may be added, edited and removed by Libera like
// any gallery photo: the host's watcher turns those changes into album
// changes. So the gallery only has to refuse what the member's role does
// not allow, and to copy (not move) photos out of a shared folder.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { LocalAlbum } from "@/lib/collab/local-api";
import { CollabHostError, isCollabEnabled, listSharedAlbums } from "@/lib/collab/host-client";
import type { GalleryAlbumSharing, GalleryContents, GallerySharingRole } from "@/lib/image-generation";
import { canChangeSharedPhotos } from "@/lib/image-generation";
import { StorageError } from "@/lib/storage/errors";

/** The marker the collab host writes in a shared folder (electron/collab/notebooks/state.ts). */
const SHARED_MARKER_FILE = ".libera-shared.json";
const MARKER_MAX_AGE_MS = 2000;

type Marker = { projectId: string; manifestDocId: string; kind?: string; revoked?: boolean };

const markerCache = new Map<string, { identity: string; checkedAt: number; marker: Marker | null }>();

/** The marker of a gallery folder that is a shared album, or null. */
export function sharedAlbumMarker(galleryRoot: string, folder: string): Marker | null {
  if (!folder || folder.startsWith(".") || /[\\/\0]/.test(folder)) return null;
  const file = path.join(galleryRoot, folder, SHARED_MARKER_FILE);
  let identity: string;
  try {
    const stats = statSync(file);
    identity = `${stats.ino}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    markerCache.delete(file);
    return null;
  }
  const now = Date.now();
  const cached = markerCache.get(file);
  if (cached && cached.identity === identity && now - cached.checkedAt < MARKER_MAX_AGE_MS) return cached.marker;
  let marker: Marker | null = null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Marker;
    marker = value && typeof value.projectId === "string" && value.kind === "album" && !value.revoked ? value : null;
  } catch {
    marker = null;
  }
  markerCache.set(file, { identity, checkedAt: now, marker });
  return marker;
}

let albumsCache: Promise<LocalAlbum[]> | null = null;

/** Coalesce concurrent reads, but never reuse a completed snapshot after a host event or mutation. */
export function hostAlbums(): Promise<LocalAlbum[]> {
  if (!isCollabEnabled()) return Promise.resolve([]);
  if (albumsCache) return albumsCache;
  const albums = listSharedAlbums().catch(() => [] as LocalAlbum[]).finally(() => {
    if (albumsCache === albums) albumsCache = null;
  });
  albumsCache = albums;
  return albums;
}

/** Forget the cached host answer (after this process changed an album). */
export function forgetHostAlbums() {
  albumsCache = null;
}

export type SharedFolder = { projectId: string; manifestDocId: string; role: GallerySharingRole; album: LocalAlbum | null };

/** The sharing of a gallery folder, or null when it is not a shared album. */
export async function sharedFolder(galleryRoot: string, folder: string): Promise<SharedFolder | null> {
  const marker = sharedAlbumMarker(galleryRoot, folder);
  if (!marker) return null;
  const album = (await hostAlbums()).find((entry) => entry.projectId === marker.projectId) ?? null;
  // Without the host's answer, nothing may change: the role is unknown.
  return { projectId: marker.projectId, manifestDocId: marker.manifestDocId, role: album && !album.revoked ? album.role : "viewer", album };
}

const ROLE_MESSAGES: Record<string, string> = {
  change: "You can view this shared album but not change its photos.",
  archive: "Photos in a shared album cannot go to the Protected Archive. Save the photo to your gallery first.",
};

/** Throws 403 unless the folder is not shared or the member's role may change its photos. */
export async function assertCanChangeFolder(galleryRoot: string, folder: string) {
  const shared = await sharedFolder(galleryRoot, folder);
  if (shared && !canChangeSharedPhotos(shared)) {
    throw new StorageError(shared.album ? ROLE_MESSAGES.change : "The collaboration service is not running, so this shared album cannot be changed right now.", 403);
  }
  return shared;
}

export function assertNotSharedFolder(galleryRoot: string, folder: string, action: "archive") {
  if (sharedAlbumMarker(galleryRoot, folder)) throw new StorageError(ROLE_MESSAGES[action], 409);
}

/**
 * Adds sharing details to gallery contents: each shared album gets its
 * role, its members' name for it and its cover; each of its photos gets its
 * caption and who added it.
 */
export async function withSharing(contents: GalleryContents): Promise<GalleryContents> {
  const albums = await hostAlbums();
  const markers = new Map(contents.albums.map((album) => [album.id, sharedAlbumMarker(contents.root, album.folder)]));
  if (![...markers.values()].some(Boolean)) return contents;
  const photosByFolder = new Map<string, GalleryContents["photos"]>();
  for (const photo of contents.photos) photosByFolder.set(photo.folder, [...(photosByFolder.get(photo.folder) ?? []), photo]);
  const photoSharing = new Map<string, NonNullable<GalleryContents["photos"][number]["shared"]>>();
  const nextAlbums = contents.albums.map((album) => {
    const marker = markers.get(album.id);
    if (!marker) return album;
    const hosted = albums.find((entry) => entry.projectId === marker.projectId) ?? null;
    const sharing: GalleryAlbumSharing = {
      projectId: marker.projectId,
      manifestDocId: marker.manifestDocId,
      role: hosted && !hosted.revoked ? hosted.role : "viewer",
      direct: hosted?.direct ?? false,
      keepLocation: hosted?.keepLocation ?? false,
      sharePrompts: hosted?.sharePrompts ?? false,
      ...(hosted ? {} : { unavailable: true }),
    };
    const byName = new Map((hosted?.photos ?? []).map((photo) => [photo.name.toLowerCase(), photo]));
    const folderPhotos = photosByFolder.get(album.folder) ?? [];
    let coverId = album.coverId;
    for (const photo of folderPhotos) {
      const details = byName.get(photo.name.toLowerCase());
      photoSharing.set(photo.id, {
        projectId: sharing.projectId,
        albumId: album.id,
        manifestDocId: sharing.manifestDocId,
        role: sharing.role,
        edited: details?.edited ?? false,
        ...(details?.fileId ? { fileId: details.fileId } : {}),
        ...(details?.caption ? { caption: details.caption } : {}),
        ...(details?.addedBy ? { addedBy: details.addedBy } : {}),
      });
      if (hosted?.cover && photo.name.toLowerCase() === hosted.cover.toLowerCase()) coverId = photo.id;
    }
    return { ...album, ...(hosted ? { name: hosted.name } : {}), coverId, shared: sharing };
  });
  const nextPhotos = contents.photos.map((photo) => {
    const shared = photoSharing.get(photo.id);
    if (!shared) return photo;
    const hosted = albums.find((entry) => entry.projectId === shared.projectId);
    const details = hosted?.photos.find((entry) => entry.name.toLowerCase() === photo.name.toLowerCase());
    return {
      ...photo,
      shared,
      // A member sees the prompt only when the album shares prompts.
      ...(details?.prompt && !photo.prompt ? { prompt: details.prompt, model: details.model } : {}),
      edited: photo.edited || (shared.edited && canChangeSharedPhotos(shared)),
    };
  });
  return { ...contents, albums: nextAlbums, photos: nextPhotos };
}

/** Host errors as storage errors, for gallery routes. */
export function sharingError(error: unknown): unknown {
  if (error instanceof CollabHostError) return new StorageError(error.message, error.status >= 400 && error.status < 600 ? error.status : 502);
  return error;
}
